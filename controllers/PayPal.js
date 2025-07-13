/*********************************************************************
 *  controllers/PayPal.js  •  Jul‑2025
 *  Wallet + Card Fields (3‑D Secure)  —  Seller‑Protection compliant
 *********************************************************************/

"use strict";

/* ───────────────────────── 1. Deps & environment ───────────────────────── */
const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const Joi = require("joi");
const axiosRetryRaw = require("axios-retry"); // works v3‑v5
const axiosRetry =
	axiosRetryRaw.default || axiosRetryRaw.axiosRetry || axiosRetryRaw;

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

/* ───────────────────────── 2. Internal helpers / models ─────────────────── */
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

/* ───────────────────────── 3. Validation schema ─────────────────────────── */
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

/* ───────────────────────── 4. Utility fns ──────────────────────────────── */
const safeClone = (o) => JSON.parse(JSON.stringify(o));

const buildPU = (data, invoice) => ({
	reference_id: `tmp-${invoice}`,
	invoice_id: invoice,
	description: `Serene Jannat – Order ${invoice}`,
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
		axiosRetry.isNetworkError?.(err),
});

/* ╔══════════════════════════════════════════════════════════════════╗
   ║ 5.  Client‑token  (JS SDK needs this for Card Fields + 3‑DS)    ║
   ╚══════════════════════════════════════════════════════════════════╝ */
exports.generateClientToken = async (_req, res) => {
	try {
		/* ➊ serve from cache */
		if (cachedClientToken && Date.now() < cachedClientTokenExp) {
			return res.json({ clientToken: cachedClientToken, cached: true });
		}

		/* ➋ fetch a fresh one */
		const { data } = await ax.post(
			`${
				IS_PROD
					? "https://api-m.paypal.com"
					: "https://api-m.sandbox.paypal.com"
			}/v1/identity/generate-token`,
			{},
			{
				auth: { username: clientId, password: secretKey },
				headers: { "Content-Type": "application/json" },
			}
		);

		/* ➌ cache & return (PayPal tokens last ±9 h) */
		cachedClientToken = data.client_token;
		cachedClientTokenExp = Date.now() + 1000 * 60 * 60 * 8; // 8 h
		res.json({ clientToken: cachedClientToken });
	} catch (e) {
		console.error("PayPal client‑token error:", e);
		res.status(503).json({
			error: "PayPal is temporarily unreachable. Please try again shortly.",
		});
	}
};

/* ╔══════════════════════════════════════════════════════════════════╗
   ║ 6.  Create Order  (wallet & Card Fields)                        ║
   ╚══════════════════════════════════════════════════════════════════╝ */
exports.createOrder = async (req, res) => {
	try {
		const { orderData, cmid /* PayPal‑Client‑Metadata‑Id */ } = req.body || {};

		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		const stockErr = await checkStockAvailability(orderData);
		if (stockErr) return res.status(400).json({ error: stockErr });

		const invoice = await generateUniqueInvoiceNumber();

		const ppReq = new paypal.orders.OrdersCreateRequest();
		ppReq.headers["PayPal-Request-Id"] = `ord-${uuid()}`;
		if (cmid) ppReq.headers["PayPal-Client-Metadata-Id"] = cmid;
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
				phone: {
					phone_type: "MOBILE",
					phone_number: { national_number: orderData.customerDetails.phone },
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

/* ╔══════════════════════════════════════════════════════════════════╗
   ║ 7.  Capture Order  (wallet & Card Fields onApprove)             ║
   ╚══════════════════════════════════════════════════════════════════╝ */
exports.captureOrder = async (req, res) => {
	const { paypalOrderId, orderData, cmid, provisionalInvoice } = req.body || {};
	if (!paypalOrderId || !orderData) {
		return res.status(400).json({ error: "Missing order data or orderId" });
	}

	/* helper that actually calls PayPal */
	const captureCall = async () => {
		const capReq = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
		if (cmid) capReq.headers["PayPal-Client-Metadata-Id"] = cmid;
		capReq.requestBody({});
		return ppClient.execute(capReq);
	};

	let result;
	try {
		({ result } = await captureCall());
	} catch (err) {
		/* If already captured, fall back to GET */
		if (err?.statusCode === 422 && /ORDER_ALREADY_CAPTURED/.test(err.message)) {
			const getReq = new paypal.orders.OrdersGetRequest(paypalOrderId);
			if (cmid) getReq.headers["PayPal-Client-Metadata-Id"] = cmid;
			({ result } = await ppClient.execute(getReq));
		} else {
			console.error("Capture error:", err);
			await cleanProvisional(provisionalInvoice);
			return res
				.status(503)
				.json({
					error: "PayPal is temporarily unavailable. Please try again.",
				});
		}
	}

	const capture = result?.purchase_units?.[0]?.payments?.captures?.[0] || {};
	if (capture.status !== "COMPLETED") {
		await cleanProvisional(provisionalInvoice);
		return res
			.status(402)
			.json({ error: "PAYMENT_DECLINED", details: capture });
	}

	/* ── Stock, DB, fulfilment ─────────────────────────────────────── */
	await updateStock(orderData);

	const order = await Order.create({
		...orderData,
		invoiceNumber: provisionalInvoice,
		paypalOrderId,
		status: "In Process",
		paymentStatus: "Paid",
		paymentDetails: safeClone(result),
		sellerProtection: capture.seller_protection?.status ?? "UNKNOWN",
		createdVia:
			capture?.payment_source?._type === "CARD"
				? "PayPal‑Card"
				: "PayPal‑Wallet",
	});

	res.json({ success: true, order: convertBigIntToString(order.toObject()) });

	postPaymentFulfilment(order).catch(console.error);
};

/* ╔══════════════════════════════════════════════════════════════════╗
   ║ 8.  Webhook (optional)                                          ║
   ╚══════════════════════════════════════════════════════════════════╝ */
exports.webhook = async (req, res) => {
	try {
		const { event_type: type, resource } = req.body;
		if (type === "PAYMENT.CAPTURE.COMPLETED") {
			const orderId = resource?.supplementary_data?.related_ids?.order_id;
			const order = await Order.findOne({ paypalOrderId: orderId });
			if (order && order.paymentStatus !== "Paid") {
				order.paymentStatus = "Paid";
				order.status = "In Process";
				order.paymentDetails = safeClone(resource);
				order.sellerProtection =
					resource.seller_protection?.status ?? "UNKNOWN";
				await order.save();

				postPaymentFulfilment(order).catch(console.error);
			}
		}
		res.json({ received: true });
	} catch (e) {
		console.error("Webhook error:", e);
		res.status(500).json({ error: "Webhook failed" });
	}
};

/* ╔══════════════════════════════════════════════════════════════════╗
   ║ 9.  Post‑payment bundle (fulfil, notify)                        ║
   ╚══════════════════════════════════════════════════════════════════╝ */
async function postPaymentFulfilment(order) {
	try {
		await postOrderToPrintify(order);
		await sendOrderConfirmationEmail(order);
		await sendOrderConfirmationSMS(order);
	} catch (e) {
		console.error("Fulfilment error:", e);
	}
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║ 10. Cleanup helper                                              ║
   ╚══════════════════════════════════════════════════════════════════╝ */
async function cleanProvisional(invoice) {
	if (!invoice) return;
	await Order.deleteOne({ invoiceNumber: invoice }).catch(console.error);
}

/* =================================================================== */
/*  🛈  /cardPay endpoint removed intentionally:                        */
/*      Card Fields in the browser tokenises PAN + enforces 3‑DS.      */
/* =================================================================== */
