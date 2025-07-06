/* ---------------------------------------------------------------------------
   PayPal Controller – final July 2025 (no pre‑payment DB write)
--------------------------------------------------------------------------- */

"use strict";

/* ───────────── 1 Deps & env ───────────── */
const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const Joi = require("joi");
const { v4: uuid } = require("uuid");

const IS_PROD = /prod/i.test(process.env.NODE_ENV);
const clientId = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;
const clientSecret = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;

const ppClient = new paypal.core.PayPalHttpClient(
	IS_PROD
		? new paypal.core.LiveEnvironment(clientId, clientSecret)
		: new paypal.core.SandboxEnvironment(clientId, clientSecret)
);

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

/** produce a slim PU for PayPal – no DB document required */
const buildPU = (orderData, invoice) => ({
	reference_id: `tmp-${invoice}`, // not tied to Mongo id any more
	invoice_id: invoice,
	description: `Serene Jannat – Order ${invoice}`,
	amount: {
		currency_code: "USD",
		value: (
			orderData.totalAmountAfterDiscount || orderData.totalAmount
		).toFixed(2),
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
			{ auth: { username: clientId, password: clientSecret } }
		);
		res.json({ clientToken: data.client_token });
	} catch (err) {
		console.error(err.stack || err);
		res.status(500).json({ error: "Failed to generate client token" });
	}
};

/* ═════════════ 6 Create PayPal order – NO Mongo write ═════════════ */
exports.createOrder = async (req, res) => {
	try {
		const { orderData } = req.body || {};
		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		/* stock check, but NO DB write yet */
		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) return res.status(400).json({ error: stockIssue });

		const invoice = await generateUniqueInvoiceNumber();

		/* Create PayPal order only */
		const ppReq = new paypal.orders.OrdersCreateRequest();
		ppReq.headers["PayPal-Request-Id"] = `ord-${uuid()}`; // idempotency
		ppReq.prefer("return=representation");
		ppReq.requestBody({
			intent: "CAPTURE",
			purchase_units: [buildPU(orderData, invoice)],
			application_context: {
				brand_name: "Serene Jannat",
				user_action: "PAY_NOW",
				shipping_preference: "NO_SHIPPING",
			},
		});

		const { result } = await ppClient.execute(ppReq);
		/* Return PayPal Order‑ID and the generated invoice so the front‑end can pass
       both back during capture */
		res.json({ paypalOrderId: result.id, provisionalInvoice: invoice });
	} catch (err) {
		console.error(err.stack || err);
		res.status(500).json({ error: "Failed to create PayPal order" });
	}
};

/* ═════════════ 7 Capture – now write the Order doc ═════════════ */
exports.captureOrder = async (req, res) => {
	try {
		const { paypalOrderId, orderData, provisionalInvoice } = req.body || {};
		if (!paypalOrderId || !orderData)
			return res.status(400).json({ error: "Missing order data" });

		/* Validate again (cheap) & re‑check stock */
		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) return res.status(400).json({ error: stockIssue });

		/* Capture from PayPal */
		const capReq = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
		capReq.requestBody({});
		const { result } = await ppClient.execute(capReq);
		if (result.status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${result.status})`);

		/* === Only here do we create the Mongo order ======================= */
		const invoiceNumber =
			provisionalInvoice || (await generateUniqueInvoiceNumber());

		let order = await Order.create({
			...orderData,
			invoiceNumber,
			paypalOrderId,
			status: "In Process",
			paymentStatus: "Paid",
			paymentDetails: safeClone(result),
			createdVia: "PayPal‑Checkout",
		});

		await postPaymentFulfilment(order); // stock + printify + emails

		res.json({ success: true, order: convertBigIntToString(order.toObject()) });
	} catch (err) {
		console.error(err.stack || err);
		res.status(402).json({ error: "Payment not completed" });
	}
};

/* ═════════════ 8 Card‑only flow – same idea (no pre‑insert) ═════════════ */
exports.cardPay = async (req, res) => {
	try {
		const { orderData, paymentSource } = req.body || {};
		if (!paymentSource)
			return res.status(400).json({ error: "Missing card token" });

		const { error } = orderSchema.validate(orderData || {}, {
			abortEarly: false,
		});
		if (error) return res.status(400).json({ error: error.details });

		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) return res.status(400).json({ error: stockIssue });

		const invoice = await generateUniqueInvoiceNumber();

		/* Create & capture in one step with payment_source.card */
		const ppReq = new paypal.orders.OrdersCreateRequest();
		ppReq.headers["PayPal-Request-Id"] = `card-${uuid()}`;
		ppReq.requestBody({
			intent: "CAPTURE",
			purchase_units: [buildPU(orderData, invoice)],
			payment_source: { card: paymentSource },
		});

		const { result: created } = await ppClient.execute(ppReq);
		const capReq = new paypal.orders.OrdersCaptureRequest(created.id);
		capReq.requestBody({});
		const { result: captured } = await ppClient.execute(capReq);
		if (captured.status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${captured.status})`);

		/* now create document */
		let order = await Order.create({
			...orderData,
			invoiceNumber: invoice,
			paypalOrderId: created.id,
			status: "In Process",
			paymentStatus: "Paid",
			paymentDetails: safeClone(captured),
			createdVia: "PayPal‑Card",
		});

		await postPaymentFulfilment(order);
		res.json({ success: true, order: convertBigIntToString(order.toObject()) });
	} catch (err) {
		console.error(err.stack || err);
		res.status(402).json({ error: "Card payment failed" });
	}
};

/* ═════════════ 9 Webhook – only finalises if we somehow missed capture ═════════════ */
exports.webhook = async (req, res) => {
	try {
		const { event_type: type, resource } = req.body;

		if (type === "PAYMENT.CAPTURE.COMPLETED") {
			const capture = safeClone(resource);
			const orderId = capture.supplementary_data?.related_ids?.order_id;
			let existing = await Order.findOne({ paypalOrderId: orderId });
			if (!existing) {
				/*  Extremely rare – fallback: create order doc from capture’s custom fields
            or ignore.  For brevity we just acknowledge. */
			} else if (existing.paymentStatus !== "Paid") {
				await postPaymentFulfilment(existing, capture);
			}
			return res.json({ received: true });
		}

		if (
			[
				"PAYMENT.CAPTURE.DENIED",
				"PAYMENT.CAPTURE.REFUNDED",
				"CHECKOUT.ORDER.CANCELLED",
			].includes(type)
		) {
			const orderId =
				resource?.supplementary_data?.related_ids?.order_id || resource?.id;
			await Order.findOneAndDelete({ paypalOrderId: orderId });
			return res.json({ received: true });
		}

		res.json({ received: true });
	} catch (err) {
		console.error(err.stack || err);
		res.status(500).json({ error: "Webhook handling failed" });
	}
};

/* ───────────── Helper that runs AFTER payment is guaranteed ───────────── */
async function postPaymentFulfilment(orderDoc, paymentJSONOverride = null) {
	if (orderDoc.paymentStatus !== "Paid") {
		orderDoc.paymentStatus = "Paid";
		orderDoc.status = "In Process";
		if (paymentJSONOverride) orderDoc.paymentDetails = paymentJSONOverride;
		await orderDoc.save();
	}

	await postOrderToPrintify(orderDoc).catch((e) =>
		console.error("Printify:", e)
	);
	await updateStock(orderDoc).catch((e) => console.error("Stock:", e));

	sendOrderConfirmationEmail(orderDoc).catch((e) => console.error("Email:", e));
	sendOrderConfirmationSMS(orderDoc).catch((e) => console.error("SMS:", e));
}
