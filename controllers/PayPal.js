/*********************************************************************
 *  controllers/PayPal.js ‑ Jul‑2025 • card + wallet • safe capture
 *********************************************************************/

"use strict";

/* ───────────────────────── 1 Deps & environment ───────────────────────── */
const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const Joi = require("joi");
const axiosRetryPkg = require("axios-retry");
const axiosRetry =
	axiosRetryPkg.default || // v5 ESM build
	axiosRetryPkg.axiosRetry || // v5 named export
	axiosRetryPkg; // v4 classic
const { v4: uuid } = require("uuid");

const IS_PROD = /prod/i.test(process.env.NODE_ENV);
const clientId = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;
const secretKey = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;
if (!clientId || !secretKey) throw new Error("PayPal creds missing");

const env = IS_PROD
	? new paypal.core.LiveEnvironment(clientId, secretKey)
	: new paypal.core.SandboxEnvironment(clientId, secretKey);
const ppClient = new paypal.core.PayPalHttpClient(env);

/* ───────────────────────── 2 Internal helpers / models ─────────────────── */
const {
	checkStockAvailability,
	generateUniqueInvoiceNumber,
	updateStock,
	postOrderToPrintify,
	sendOrderConfirmationEmail,
	sendOrderConfirmationSMS,
	convertBigIntToString,
} = require("./HelperFunctions");
const { Order } = require("../models/order");

/* ───────────────────────── 3 Validation schema ─────────────────────────── */
const orderSchema = Joi.object({
	customerDetails: Joi.object({
		name: Joi.string().min(2).required(),
		email: Joi.string().email().required(),
		phone: Joi.string()
			.pattern(/^\+?\d{10,15}$/)
			.required(),
		address: Joi.string().required(),
		city: Joi.string().required(),
		state: Joi.string().required(),
		zipcode: Joi.string().required(),
		userId: Joi.string().optional(),
	}).required(),
	productsNoVariable: Joi.array().items(Joi.object()).required(),
	chosenProductQtyWithVariables: Joi.array().items(Joi.object()).required(),
	chosenShippingOption: Joi.object({
		carrierName: Joi.string().required(),
		shippingPrice: Joi.number().positive().required(),
	})
		.unknown(true)
		.required(),
	totalAmount: Joi.number().positive().required(),
	totalAmountAfterDiscount: Joi.number().positive().allow(null),
	totalOrderQty: Joi.number().integer().positive().required(),
}).unknown(true);

/* ───────────────────────── 4 Utility fns ──────────────────────────────── */
const safeClone = (o) => JSON.parse(JSON.stringify(o));

const buildPU = (data, invoice) => ({
	reference_id: `tmp-${invoice}`,
	invoice_id: invoice,
	description: `Serene Jannat – Order ${invoice}`,
	amount: {
		currency_code: "USD",
		value: Number(data.totalAmountAfterDiscount ?? data.totalAmount).toFixed(2),
	},
	shipping: {
		name: { full_name: data.customerDetails.name },
		address: {
			address_line_1: data.customerDetails.address,
			admin_area_2: data.customerDetails.city,
			admin_area_1: data.customerDetails.state,
			postal_code: data.customerDetails.zipcode,
			country_code: "US",
		},
	},
});

/* one in‑memory cache – good enough for a single Node instance */
let cachedClientToken = null;
let cachedClientTokenExp = 0; // epoch ms

/* attach retry helper only once */
const ax = axios.create({ timeout: 12_000 }); // 12 s hard timeout
axiosRetry(ax, {
	retries: 3,
	retryDelay: (c) => 400 * 2 ** c, // 0.4 s, 0.8 s, 1.6 s
	retryCondition: (err) =>
		err.code === "ECONNRESET" ||
		err.code === "ETIMEDOUT" ||
		axiosRetry.isNetworkError(err),
});

/* ───────────────────────── 5 Client‑token ─────────────────────────────── */
exports.generateClientToken = async (_req, res) => {
	try {
		/* ➊ serve from cache ( PayPal tokens last 9 h in practice ) */
		if (cachedClientToken && Date.now() < cachedClientTokenExp) {
			return res.json({ clientToken: cachedClientToken, cached: true });
		}

		/* ➋ fetch a fresh one – with automatic retry on connection resets */
		const { data } = await ax.post(
			`${
				IS_PROD
					? "https://api-m.paypal.com"
					: "https://api-m.sandbox.paypal.com"
			}/v1/identity/generate-token`,
			{}, // empty JSON body
			{
				auth: { username: clientId, password: secretKey },
				headers: { "Content-Type": "application/json" },
			}
		);

		/* ➌ cache & return */
		cachedClientToken = data.client_token;
		cachedClientTokenExp = Date.now() + 1000 * 60 * 60 * 8; // 8 h
		res.json({ clientToken: cachedClientToken });
	} catch (e) {
		console.error("PayPal client‑token error:", e);
		res
			.status(503) // Service Unavailable
			.json({
				error: "PayPal is temporarily unreachable. Please try again shortly.",
			});
	}
};

/* ───────────────────────── 6 Create order (wallet & card) ─────────────── */
exports.createOrder = async (req, res) => {
	try {
		const { orderData } = req.body || {};
		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		const stockErr = await checkStockAvailability(orderData);
		if (stockErr) return res.status(400).json({ error: stockErr });

		const invoice = await generateUniqueInvoiceNumber();

		const ppReq = new paypal.orders.OrdersCreateRequest();
		ppReq.headers["PayPal-Request-Id"] = `ord-${uuid()}`;
		ppReq.prefer("return=representation");
		ppReq.requestBody({
			intent: "CAPTURE",
			purchase_units: [buildPU(orderData, invoice)],
			payer: {
				email_address: orderData.customerDetails.email,
				name: {
					given_name: orderData.customerDetails.name.split(" ")[0],
					surname:
						orderData.customerDetails.name.split(" ").slice(1).join(" ") ||
						"Customer",
				},
				address: {
					address_line_1: orderData.customerDetails.address,
					admin_area_2: orderData.customerDetails.city,
					admin_area_1: orderData.customerDetails.state,
					postal_code: orderData.customerDetails.zipcode,
					country_code: "US",
				},
			},
			application_context: {
				brand_name: "Serene Jannat",
				user_action: "PAY_NOW",
				shipping_preference: "SET_PROVIDED_ADDRESS",
			},
		});

		const { result } = await ppClient.execute(ppReq);
		res.json({ paypalOrderId: result.id, provisionalInvoice: invoice });
	} catch (e) {
		console.error(e);
		res.status(500).json({ error: "Failed to create PayPal order" });
	}
};

/* ───────────────────────── 7 Capture (wallet flow) ────────────────────── */
exports.captureOrder = async (req, res) => {
	const { paypalOrderId, orderData, provisionalInvoice } = req.body || {};
	if (!paypalOrderId || !orderData) {
		return res.status(400).json({ error: "Missing order data or orderId" });
	}

	/* helper that actually calls PayPal */
	const tryCapture = async () => {
		const capReq = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
		capReq.requestBody({});
		return ppClient.execute(capReq); // may throw HttpError
	};

	/* ── 1 : retry up‑to 3 × on 5xx / INTERNAL_SERVICE_ERROR ─────────── */
	let result, lastErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			({ result } = await tryCapture());
			break; // success → exit loop
		} catch (err) {
			lastErr = err;

			/* only retry on 5xx or INTERNAL_SERVICE_ERROR */
			const is5xx = err?.statusCode && err.statusCode >= 500;
			const issue =
				err?.message?.includes("INTERNAL_SERVICE_ERROR") ||
				err?.message?.includes("INTERNAL_SERVER_ERROR");

			if (!is5xx && !issue) break; // do not retry 4xx etc.

			/* PayPal suggests waiting 0.5‑1 s before retrying */
			await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
		}
	}

	if (!result) {
		console.error("Capture error after retries:", lastErr);
		await cleanProvisional(provisionalInvoice);
		return res
			.status(503)
			.json({ error: "PayPal is temporarily unavailable. Please try again." });
	}

	const capture = result?.purchase_units?.[0]?.payments?.captures?.[0] || {};
	if (capture.status !== "COMPLETED") {
		await cleanProvisional(provisionalInvoice);
		return res.status(402).json({ error: "CARD_DECLINED", details: capture });
	}

	/* ── 2 : stock, DB, fulfilment ───────────────────────────────────── */
	await updateStock(orderData);
	const order = await Order.create({
		...orderData,
		invoiceNumber: provisionalInvoice,
		paypalOrderId: paypalOrderId,
		status: "In Process",
		paymentStatus: "Paid",
		paymentDetails: safeClone(result),
		createdVia: "PayPal‑Wallet",
	});

	res.json({ success: true, order: convertBigIntToString(order.toObject()) });
	postPaymentFulfilment(order).catch(console.error);
};

/* ───────────────────────── 8 Card‑only single call flow ──────────────── */
exports.cardPay = async (req, res) => {
	try {
		const { orderData, card } = req.body || {};

		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		const cardSchema = Joi.object({
			number: Joi.string().creditCard().required(),
			expiry: Joi.string()
				.pattern(/^\d{4}-\d{2}$/)
				.required(), // YYYY‑MM
			security_code: Joi.string()
				.pattern(/^\d{3,4}$/)
				.required(),
			name: Joi.string().min(2).required(),
			billing_address: Joi.object({
				address_line_1: Joi.string().required(),
				admin_area_2: Joi.string().required(),
				admin_area_1: Joi.string().required(),
				postal_code: Joi.string().required(),
				country_code: Joi.string().length(2).required(),
			}).required(),
		});
		const { error: cErr } = cardSchema.validate(card || {}, {
			abortEarly: false,
		});
		if (cErr) return res.status(400).json({ error: cErr.details });

		const stockErr = await checkStockAvailability(orderData);
		if (stockErr) return res.status(400).json({ error: stockErr });

		const invoice = await generateUniqueInvoiceNumber();

		/* -- 1  create order ------------------------------------------- */
		const createReq = new paypal.orders.OrdersCreateRequest();
		createReq.headers["PayPal-Request-Id"] = `card-${uuid()}`;
		createReq.prefer("return=representation");
		createReq.requestBody({
			intent: "CAPTURE",
			purchase_units: [buildPU(orderData, invoice)],
			application_context: {
				brand_name: "Serene Jannat",
				user_action: "PAY_NOW",
			},
		});
		const { result: createRes } = await ppClient.execute(createReq);

		/* -- 2  confirm payment‑source (card details) ------------------ */
		const confirmReq = new paypal.orders.OrdersConfirmPaymentSourceRequest(
			createRes.id
		);
		confirmReq.requestBody({ payment_source: { card } });
		const { result: confirmRes } = await ppClient.execute(confirmReq);

		if (!["APPROVED", "COMPLETED"].includes(confirmRes.status)) {
			return res
				.status(402)
				.json({ error: "CARD_DECLINED", details: confirmRes });
		}

		/* -- 3  capture ------------------------------------------------ */
		const capReq = new paypal.orders.OrdersCaptureRequest(createRes.id);
		capReq.requestBody({});
		const { result: capRes } = await ppClient.execute(capReq);

		const capture = capRes?.purchase_units?.[0]?.payments?.captures?.[0] || {};
		if (capture.status !== "COMPLETED") {
			return res.status(402).json({ error: "CARD_DECLINED", details: capture });
		}

		/* -- 4  save order & fulfil ------------------------------------ */
		await updateStock(orderData);
		const order = await Order.create({
			...orderData,
			invoiceNumber: invoice,
			paypalOrderId: createRes.id,
			status: "In Process",
			paymentStatus: "Paid",
			paymentDetails: safeClone(capRes),
			createdVia: "PayPal‑Card",
		});

		res.json({ success: true, order: convertBigIntToString(order.toObject()) });
		postPaymentFulfilment(order).catch(console.error);
	} catch (e) {
		console.error("cardPay error:", e);
		if (e?.statusCode)
			return res.status(402).json({ error: e.message, details: e });
		res.status(500).json({ error: "Server error during card payment" });
	}
};

/* ───────────────────────── 9 Webhook (optional) ───────────────────────── */
exports.webhook = async (req, res) => {
	try {
		const { event_type: type, resource } = req.body;
		if (type === "PAYMENT.CAPTURE.COMPLETED") {
			const orderId = resource?.supplementary_data?.related_ids?.order_id;
			const order = await Order.findOne({ paypalOrderId: orderId });
			if (order && order.paymentStatus !== "Paid") {
				order.paymentStatus = "Paid";
				order.status = "In Process";
				order.paymentDetails = resource;
				await order.save();
				await postPaymentFulfilment(order);
			}
		}
		res.json({ received: true });
	} catch (e) {
		console.error("Webhook error:", e);
		res.status(500).json({ error: "Webhook failed" });
	}
};

/* ───────────────────────── 10 Post‑payment bundle ─────────────────────── */
async function postPaymentFulfilment(order) {
	try {
		await postOrderToPrintify(order);
		await sendOrderConfirmationEmail(order);
		await sendOrderConfirmationSMS(order);
	} catch (e) {
		console.error("Fulfilment error:", e);
	}
}

/* ───────────────────────── 11 Cleanup helper ──────────────────────────── */
async function cleanProvisional(invoice) {
	if (!invoice) return;
	await Order.deleteOne({ invoiceNumber: invoice }).catch(console.error);
}
