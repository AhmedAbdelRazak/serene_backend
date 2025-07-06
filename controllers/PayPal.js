/* ---------------------------------------------------------------------------
   PayPal Controller – July 2025 • no stub‑order • card & wallet
--------------------------------------------------------------------------- */

"use strict";

/* ───────────── 1 Deps & env ───────────── */
const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const Joi = require("joi");
const { v4: uuid } = require("uuid");

const IS_PROD = /prod/i.test(process.env.NODE_ENV);

// pick the correct pair *explicitly*
const clientId = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;
const secretKey = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;

if (!clientId || !secretKey) {
	throw new Error(
		`PayPal credentials missing for ${IS_PROD ? "LIVE" : "SANDBOX"} environment`
	);
}

const env = IS_PROD
	? new paypal.core.LiveEnvironment(clientId, secretKey)
	: new paypal.core.SandboxEnvironment(clientId, secretKey);

const ppClient = new paypal.core.PayPalHttpClient(env);

/* ───────────── 2 App helpers ───────────── */
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

/* ───────────── 3 Validation ───────────── */
const orderSchema = Joi.object({
	customerDetails: Joi.object({
		name: Joi.string().min(2).max(60).required(),
		email: Joi.string().email().required(),
		phone: Joi.string()
			.pattern(/^\+?\d{10,15}$/)
			.required(),
		address: Joi.string().min(5).required(),
		city: Joi.string().min(2).required(),
		state: Joi.string().min(2).required(),
		zipcode: Joi.string().min(3).required(),
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

/* ───────────── 4 Utilities ───────────── */
const safeClone = (o) => JSON.parse(JSON.stringify(o));

/** Purchase‑unit helper */
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

/* ═════════════ 5 Client token ═════════════ */
exports.generateClientToken = async (_req, res) => {
	try {
		const { data } = await axios.post(
			`${
				IS_PROD
					? "https://api-m.paypal.com"
					: "https://api-m.sandbox.paypal.com"
			}/v1/identity/generate-token`,
			{},
			{ auth: { username: clientId, password: secretKey } }
		);
		res.json({ clientToken: data.client_token });
	} catch (e) {
		console.error(e);
		res.status(500).json({ error: "Failed to generate client token" });
	}
};

/* ═════════════ 9 Webhook (optional) ═════════════ */
exports.webhook = async (req, res) => {
	try {
		const { event_type: type, resource } = req.body;

		if (type === "PAYMENT.CAPTURE.COMPLETED") {
			const orderId = resource.supplementary_data?.related_ids?.order_id;
			const order = await Order.findOne({ paypalOrderId: orderId });

			if (order && order.paymentStatus !== "Paid") {
				order.paymentStatus = "Paid";
				order.status = "In Process";
				order.paymentDetails = resource;
				await order.save();
				await postPaymentFulfilment(order);
			}
		}

		/* You can branch for REFUNDED / DENIED etc. later if you wish */

		res.json({ received: true });
	} catch (e) {
		console.error("Webhook error:", e);
		res.status(500).json({ error: "Webhook failed" });
	}
};

/* ═════════════ 6 Create PayPal order (wallet & card) ═════════════ */
exports.createOrder = async (req, res) => {
	try {
		const { orderData } = req.body || {};
		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) return res.status(400).json({ error: stockIssue });

		const invoice = await generateUniqueInvoiceNumber();

		/* Build request */
		const ppReq = new paypal.orders.OrdersCreateRequest();
		ppReq.headers["PayPal-Request-Id"] = `ord-${uuid()}`;
		ppReq.prefer("return=representation");
		ppReq.requestBody({
			intent: "CAPTURE",
			purchase_units: [buildPU(orderData, invoice)],
			payer: {
				// pre‑fill billing form
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

/* ═════════════ 7 Capture – create Order doc after payment ═════════════ */
exports.captureOrder = async (req, res) => {
	try {
		const { paypalOrderId, orderData, provisionalInvoice } = req.body || {};
		if (!paypalOrderId || !orderData) {
			return res.status(400).json({ error: "Missing order data or orderId" });
		}

		/* 1. Capture funds from PayPal */
		const capReq = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
		capReq.requestBody({});
		const { result } = await ppClient.execute(capReq);

		if (result.status !== "COMPLETED") {
			/* Anything other than COMPLETED is a payment‑flow problem, not our bug   */
			return res.status(402).json({
				// 402 = Payment Required – makes sense here
				error: "Payment not completed",
				paypalStatus: result.status,
				details: result,
			});
		}

		/* 2. Persist the order */
		const invoice = provisionalInvoice || (await generateUniqueInvoiceNumber());
		const order = await Order.create({
			...orderData,
			invoiceNumber: invoice,
			paypalOrderId,
			status: "In Process",
			paymentStatus: "Paid",
			paymentDetails: safeClone(result),
			createdVia: "PayPal‑Wallet",
		});

		/* 3. Respond first – then do fulfilment asynchronously */
		res.json({ success: true, order: convertBigIntToString(order.toObject()) });
		postPaymentFulfilment(order).catch((err) =>
			console.error("Post‑payment fulfilment error:", err)
		);
	} catch (e) {
		/* PayPal SDK errors always have .statusCode and .message */
		if (e?.statusCode) {
			return res.status(402).json({
				error: e.message || "Payment error",
				details: e,
			});
		}
		console.error(e);
		res.status(500).json({ error: "Unexpected server error" });
	}
};

/* ═════════════ 8 Helper after payment ═════════════ */
async function postPaymentFulfilment(orderDoc) {
	await postOrderToPrintify(orderDoc).catch((e) =>
		console.error("Printify:", e)
	);
	await updateStock(orderDoc).catch((e) => console.error("Stock    :", e));

	sendOrderConfirmationEmail(orderDoc).catch((e) => console.error("Email:", e));
	sendOrderConfirmationSMS(orderDoc).catch((e) => console.error("SMS  :", e));
}

/* ═════════════ 7‑bis  Card‑only flow – one call for the whole payment ═════════════ */
exports.cardPay = async (req, res) => {
	try {
		const { orderData, card } = req.body || {};

		/* --- Step 0: validate --------------------------------------------------- */
		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		const cardSchema = Joi.object({
			number: Joi.string().creditCard().required(),
			expiry: Joi.string()
				.pattern(/^\d{4}-\d{2}$/)
				.required(), // "YYYY-MM"
			security_code: Joi.string()
				.pattern(/^\d{3,4}$/)
				.required(),
			name: Joi.string().min(2).required(),
			billing_address: Joi.object({
				address_line_1: Joi.string().required(),
				admin_area_2: Joi.string().required(), // city
				admin_area_1: Joi.string().required(), // state
				postal_code: Joi.string().required(),
				country_code: Joi.string().length(2).required(),
			}).required(),
		});
		const { error: cardErr } = cardSchema.validate(card || {}, {
			abortEarly: false,
		});
		if (cardErr) return res.status(400).json({ error: cardErr.details });

		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) return res.status(400).json({ error: stockIssue });

		/* --- Step 1: create the PayPal order ----------------------------------- */
		const invoice = await generateUniqueInvoiceNumber();
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

		/* --- Step 2: confirm the payment source (card details) ----------------- */
		const confirmReq = new paypal.orders.OrdersConfirmPaymentSourceRequest(
			createRes.id
		);
		confirmReq.requestBody({ payment_source: { card } });
		const { result: confirmRes } = await ppClient.execute(confirmReq);

		if (!["APPROVED", "COMPLETED"].includes(confirmRes.status)) {
			// If payer_action_required you should surface the redirect/link to the client
			return res.status(402).json({
				error: "Card confirmation failed",
				paypalStatus: confirmRes.status,
				details: confirmRes,
			});
		}

		/* --- Step 3: capture ---------------------------------------------------- */
		const capReq = new paypal.orders.OrdersCaptureRequest(createRes.id);
		capReq.requestBody({});
		const { result: captureRes } = await ppClient.execute(capReq);

		if (captureRes.status !== "COMPLETED") {
			return res.status(402).json({
				error: "Payment not completed",
				paypalStatus: captureRes.status,
				details: captureRes,
			});
		}

		/* --- Step 4: store order & fulfil -------------------------------------- */
		const order = await Order.create({
			...orderData,
			invoiceNumber: invoice,
			paypalOrderId: createRes.id,
			status: "In Process",
			paymentStatus: "Paid",
			paymentDetails: safeClone(captureRes),
			createdVia: "PayPal‑Card",
		});

		res.json({ success: true, order: convertBigIntToString(order.toObject()) });

		postPaymentFulfilment(order).catch((err) =>
			console.error("Post‑payment fulfilment error:", err)
		);
	} catch (e) {
		if (e?.statusCode) {
			return res.status(402).json({ error: e.message, details: e });
		}
		console.error(e);
		res.status(500).json({ error: "Server error during card payment" });
	}
};
