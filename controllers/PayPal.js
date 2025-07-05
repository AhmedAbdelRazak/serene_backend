/* ---------------------------------------------------------------------------
   PayPal Controller – July 2025
   Mirrors Stripe logic: stub‑order first, delete on failure, finalise on success
   --------------------------------------------------------------------------- */

"use strict";

/* ───────────── 1. Deps & config ───────────── */
const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const Joi = require("joi");
const { v4: uuidv4 } = require("uuid");

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

/* ───────────── 2. App helpers ───────────── */
const {
	checkStockAvailability,
	generateUniqueInvoiceNumber,
	updateStock,
	postOrderToPrintify,
	sendOrderConfirmationEmail,
	sendOrderConfirmationSMS,
	convertBigIntToString,
} = require("./HelperFunctions");
const { Order } = require("../models/order"); // ⚠︎ make sure schema has paypalOrderId:String

/* ───────────── 3. Joi schema ───────────── */
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
		userId: Joi.string().optional(), // allowed but not required
	}).required(),

	productsNoVariable: Joi.array().items(Joi.object()).required(),
	chosenProductQtyWithVariables: Joi.array().items(Joi.object()).required(),

	chosenShippingOption: Joi.object({
		carrierName: Joi.string().required(),
		shippingPrice: Joi.number().positive().required(),
	})
		.unknown(true)
		.required(), // accept extra keys

	totalAmount: Joi.number().positive().required(),
	totalAmountAfterDiscount: Joi.number().positive().allow(null),
	totalOrderQty: Joi.number().integer().positive().required(),
}).unknown(true);

/* ───────────── 4. Minor utils ───────────── */
const buildPurchaseUnit = (order, invoice) => ({
	reference_id: order._id.toString(),
	invoice_id: invoice,
	description: `Serene Jannat – Order ${invoice}`,
	amount: {
		currency_code: "USD",
		value: (order.totalAmountAfterDiscount || order.totalAmount).toFixed(2),
	},
});

/* ═════════════ 5. Generate client token ═════════════ */
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
		console.error("PayPal client‑token error:", err?.response?.data || err);
		res.status(500).json({ error: "Failed to generate client token" });
	}
};

/* ═════════════ 6. Create order (stub + PP order) ═════════════ */
exports.createOrder = async (req, res) => {
	console.log("▶︎ POST /paypal/create-order");

	const { orderData } = req.body || {};
	const { error } = orderSchema.validate(orderData || {}, {
		abortEarly: false,
	});
	if (error) return res.status(400).json({ error: error.details });

	const stockIssue = await checkStockAvailability(orderData);
	if (stockIssue) return res.status(400).json({ error: stockIssue });

	const invoice = await generateUniqueInvoiceNumber();
	let order = await Order.create({
		...orderData,
		invoiceNumber: invoice,
		status: "Awaiting Payment",
		paymentStatus: "Pending",
		createdVia: "PayPal‑Checkout",
	});

	const ppReq = new paypal.orders.OrdersCreateRequest();
	ppReq.headers["PayPal-Request-Id"] = `order-${order._id}-${uuidv4()}`;
	ppReq.prefer("return=representation");
	ppReq.requestBody({
		intent: "CAPTURE",
		purchase_units: [buildPurchaseUnit(order, invoice)],
		application_context: {
			brand_name: "Serene Jannat",
			user_action: "PAY_NOW",
			shipping_preference: "NO_SHIPPING",
		},
	});

	try {
		const { result } = await ppClient.execute(ppReq);
		await Order.findByIdAndUpdate(order._id, { paypalOrderId: result.id });
		res.json({ paypalOrderId: result.id });
	} catch (err) {
		console.error("PayPal create‑order error:", err?.statusCode, err?.message);
		await Order.findByIdAndDelete(order._id);
		res.status(500).json({ error: "Failed to create PayPal order" });
	}
};

/* ═════════════ 7. Capture order (after approval) ═════════════ */
exports.captureOrder = async (req, res) => {
	console.log("▶︎ POST /paypal/capture-order");
	const { paypalOrderId } = req.body || {};
	if (!paypalOrderId)
		return res.status(400).json({ error: "Missing order ID" });

	let order = await Order.findOne({ paypalOrderId });
	if (!order) return res.status(404).json({ error: "Local order not found" });

	const captureReq = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
	captureReq.requestBody({});

	try {
		const { result } = await ppClient.execute(captureReq);
		if (result.status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${result.status})`);

		const clean = JSON.parse(JSON.stringify(result)); // ← clone

		await finalisePaidOrder(order, clean);
		order = await Order.findById(order._id);
		res.json({ success: true, order: convertBigIntToString(order.toObject()) });
	} catch (err) {
		console.error("PayPal capture error:", err?.statusCode, err?.message);
		await Order.findByIdAndDelete(order._id);
		res.status(402).json({ error: "Payment not completed" });
	}
};

/* ═════════════ 8. Card‑only (Advanced Credit & Debit) ═════════════ */
exports.cardPay = async (req, res) => {
	console.log("▶︎ POST /paypal/card-pay");
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
	let order = await Order.create({
		...orderData,
		invoiceNumber: invoice,
		status: "Awaiting Payment",
		paymentStatus: "Pending",
		createdVia: "PayPal‑Card",
	});

	/* create + capture in one shot */
	const ppReq = new paypal.orders.OrdersCreateRequest();
	ppReq.headers["PayPal-Request-Id"] = `card-${order._id}-${uuidv4()}`;
	ppReq.requestBody({
		intent: "CAPTURE",
		purchase_units: [buildPurchaseUnit(order, invoice)],
		payment_source: { card: paymentSource },
	});

	try {
		const { result: created } = await ppClient.execute(ppReq);
		const captureReq = new paypal.orders.OrdersCaptureRequest(created.id);
		captureReq.requestBody({});
		const { result: captured } = await ppClient.execute(captureReq);

		if (captured.status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${captured.status})`);

		const clean = JSON.parse(JSON.stringify(captured));
		await finalisePaidOrder(order, clean);
		order = await Order.findById(order._id);
		res.json({ success: true, order: convertBigIntToString(order.toObject()) });
	} catch (err) {
		console.error("PayPal card‑pay error:", err?.statusCode, err?.message);
		await Order.findByIdAndDelete(order._id);
		res.status(402).json({ error: "Card payment failed" });
	}
};

/* ═════════════ 9. Web‑hook (async events) ═════════════ */
exports.webhook = async (req, res) => {
	const event = req.body;
	const type = event.event_type;

	if (type === "PAYMENT.CAPTURE.COMPLETED") {
		const capture = JSON.parse(JSON.stringify(event.resource));
		const orderId = capture.supplementary_data?.related_ids?.order_id;
		const localOrd = await Order.findOne({ paypalOrderId: orderId });
		if (localOrd) await finalisePaidOrder(localOrd, capture);
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
			event.resource?.supplementary_data?.related_ids?.order_id ||
			event.resource?.id;
		await Order.findOneAndDelete({ paypalOrderId: orderId });
		return res.json({ received: true });
	}

	res.json({ received: true });
};

/* ═════════════ 10. Fulfilment helper ═════════════ */
async function finalisePaidOrder(orderDoc, paymentJSON) {
	if (orderDoc.paymentStatus === "Paid") return; // idempotent

	orderDoc.paymentStatus = "Paid";
	orderDoc.status = "In Process";
	orderDoc.paymentDetails = paymentJSON;
	await orderDoc.save();

	await postOrderToPrintify(orderDoc).catch((e) =>
		console.error("Printify:", e)
	);
	await updateStock(orderDoc).catch((e) => console.error("Stock:", e));

	sendOrderConfirmationEmail(orderDoc).catch((e) =>
		console.error("E‑mail:", e)
	);
	sendOrderConfirmationSMS(orderDoc).catch((e) => console.error("SMS:", e));
}
