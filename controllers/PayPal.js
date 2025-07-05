/* ---------------------------------------------------------------------------
   PayPal Controller – July‑2025
   Mirrors Stripe logic: stub‑order first, delete on failure, finalise on success
   --------------------------------------------------------------------------- */

"use strict";

/* ─────────────────────────────  1. Deps & config  ───────────────────────── */
const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const Joi = require("joi");
const { v4: uuidv4 } = require("uuid");

/* choose environment */
const IS_PROD = /prod/i.test(process.env.NODE_ENV);
const clientId = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;
const clientSecret = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;

function ppEnvironment() {
	return IS_PROD
		? new paypal.core.LiveEnvironment(clientId, clientSecret)
		: new paypal.core.SandboxEnvironment(clientId, clientSecret);
}
const ppClient = new paypal.core.PayPalHttpClient(ppEnvironment());

/* ─────────────────────  2. Local helpers & existing utils  ─────────────── */
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

/* ─────────────────────  3. Input validation (Joi)  ─────────────────────── */
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
	}).required(),
	productsNoVariable: Joi.array().items(Joi.object()).required(),
	chosenProductQtyWithVariables: Joi.array().items(Joi.object()).required(),
	chosenShippingOption: Joi.object({
		carrierName: Joi.string().required(),
		shippingPrice: Joi.number().positive().required(),
	}).required(),
	totalAmount: Joi.number().positive().required(),
	totalAmountAfterDiscount: Joi.number().positive().allow(null),
	totalOrderQty: Joi.number().integer().positive().required(),
}).unknown(true);

/* ─────────────────────────────  4. Minor utils  ─────────────────────────── */
const normalisePhone = (raw) =>
	raw.startsWith("+") ? raw : `+1${raw.replace(/\D/g, "")}`.slice(0, 12);

const buildPurchaseUnit = (order, invoiceNumber) => ({
	reference_id: order._id.toString(),
	invoice_id: invoiceNumber,
	description: `Serene Jannat – Order ${invoiceNumber}`,
	amount: {
		currency_code: "USD",
		value: (order.totalAmountAfterDiscount || order.totalAmount).toFixed(2),
	},
});

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  5.  GENERATE CLIENT TOKEN  (for JS‑SDK / Fastlane)                     ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
exports.generateClientToken = async (_req, res) => {
	try {
		const tokenResp = await axios.post(
			`${
				IS_PROD
					? "https://api-m.paypal.com"
					: "https://api-m.sandbox.paypal.com"
			}/v1/identity/generate-token`,
			{},
			{ auth: { username: clientId, password: clientSecret } }
		);
		res.json({ clientToken: tokenResp.data.client_token });
	} catch (err) {
		console.error("PayPal client‑token error:", err?.response?.data || err);
		res.status(500).json({ error: "Failed to generate client token" });
	}
};

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  6.  CREATE ORDER  (stub + PayPal Order)                                ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
exports.createOrder = async (req, res) => {
	console.log("▶︎  POST /paypal/create-order");

	const { orderData } = req.body || {};
	const { error } = orderSchema.validate(orderData || {}, {
		abortEarly: false,
	});
	if (error) return res.status(400).json({ error: error.details });

	/* stock */
	const stockIssue = await checkStockAvailability(orderData);
	if (stockIssue) return res.status(400).json({ error: stockIssue });

	const invoiceNumber = await generateUniqueInvoiceNumber();
	let order = await Order.create({
		...orderData,
		invoiceNumber,
		status: "Awaiting Payment",
		paymentStatus: "Pending",
		createdVia: "PayPal‑Checkout",
	});

	/* Build PayPal Order */
	const ppRequest = new paypal.orders.OrdersCreateRequest();
	ppRequest.headers["PayPal-Request-Id"] = `order-${order._id}-${uuidv4()}`; // idempotency
	ppRequest.prefer("return=representation");
	ppRequest.requestBody({
		intent: "CAPTURE",
		purchase_units: [buildPurchaseUnit(order, invoiceNumber)],
		application_context: {
			brand_name: "Serene Jannat",
			user_action: "PAY_NOW",
			shipping_preference: "NO_SHIPPING",
		},
	});

	try {
		const ppResp = await ppClient.execute(ppRequest);
		const { id: paypalOrderId } = ppResp.result;

		/* save PayPal ID on stub for lookup during capture / web‑hook */
		await Order.findByIdAndUpdate(order._id, { paypalOrderId });

		return res.json({ paypalOrderId });
	} catch (err) {
		console.error("PayPal create‑order error:", err?.statusCode, err?.message);
		await Order.findByIdAndDelete(order._id); // cleanup
		return res.status(500).json({ error: "Failed to create PayPal order" });
	}
};

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  7.  CAPTURE ORDER  (called after payer approves PayPal pop‑up)         ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
exports.captureOrder = async (req, res) => {
	console.log("▶︎  POST /paypal/capture-order");
	const { paypalOrderId } = req.body || {};
	if (!paypalOrderId)
		return res.status(400).json({ error: "Missing order ID" });

	/* find stub order */
	let order = await Order.findOne({ paypalOrderId });
	if (!order) return res.status(404).json({ error: "Local order not found" });

	const captureRequest = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
	captureRequest.requestBody({}); // empty body as per API spec

	try {
		const captureResp = await ppClient.execute(captureRequest);
		const status = captureResp.result.status;
		if (status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${status})`);

		await finalisePaidOrder(order, captureResp.result);
		order = await Order.findById(order._id);
		return res.json({
			success: true,
			order: convertBigIntToString(order.toObject()),
		});
	} catch (err) {
		console.error("PayPal capture error:", err?.statusCode, err?.message);
		await Order.findByIdAndDelete(order._id);
		return res.status(402).json({ error: "Payment not completed" });
	}
};

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  8.  CARD‑ONLY PAYMENT (Advanced Credit/Debit Card, no redirect)        ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
exports.cardPay = async (req, res) => {
	console.log("▶︎  POST /paypal/card-pay");

	const { orderData, paymentSource } = req.body || {};
	if (!paymentSource)
		return res.status(400).json({ error: "Missing card token" });

	const { error } = orderSchema.validate(orderData || {}, {
		abortEarly: false,
	});
	if (error) return res.status(400).json({ error: error.details });

	/* stock check */
	const stockIssue = await checkStockAvailability(orderData);
	if (stockIssue) return res.status(400).json({ error: stockIssue });

	const invoiceNumber = await generateUniqueInvoiceNumber();
	let order = await Order.create({
		...orderData,
		invoiceNumber,
		status: "Awaiting Payment",
		paymentStatus: "Pending",
		createdVia: "PayPal‑Card",
	});

	/* build OrdersCreate with payment_source.card */
	const ppRequest = new paypal.orders.OrdersCreateRequest();
	ppRequest.headers["PayPal-Request-Id"] = `card-${order._id}-${uuidv4()}`;
	ppRequest.requestBody({
		intent: "CAPTURE",
		purchase_units: [buildPurchaseUnit(order, invoiceNumber)],
		payment_source: { card: paymentSource },
	});

	try {
		const createResp = await ppClient.execute(ppRequest);
		const orderId = createResp.result.id;

		const captureReq = new paypal.orders.OrdersCaptureRequest(orderId);
		captureReq.requestBody({});
		const captureResp = await ppClient.execute(captureReq);

		const status = captureResp.result.status;
		if (status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${status})`);

		await finalisePaidOrder(order, captureResp.result);
		order = await Order.findById(order._id);
		return res.json({
			success: true,
			order: convertBigIntToString(order.toObject()),
		});
	} catch (err) {
		console.error("PayPal card‑pay error:", err?.statusCode, err?.message);
		await Order.findByIdAndDelete(order._id);
		return res.status(402).json({ error: "Card payment failed" });
	}
};

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  9.  WEB‑HOOK  (handles async capture & denial)                         ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
exports.webhook = async (req, res) => {
	const event = req.body;
	const eventType = event.event_type;

	/* secure your webhook by validating the signature — omitted for brevity */

	if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
		const capture = event.resource;
		const orderId = capture.supplementary_data?.related_ids?.order_id;
		const localOrder = await Order.findOne({ paypalOrderId: orderId });
		if (localOrder) await finalisePaidOrder(localOrder, capture);
		return res.status(200).json({ received: true });
	}

	if (
		eventType === "PAYMENT.CAPTURE.DENIED" ||
		eventType === "PAYMENT.CAPTURE.REFUNDED" ||
		eventType === "CHECKOUT.ORDER.CANCELLED"
	) {
		const orderId =
			event.resource?.supplementary_data?.related_ids?.order_id ||
			event.resource?.id;
		await Order.findOneAndDelete({ paypalOrderId: orderId });
		return res.status(200).json({ received: true });
	}

	res.status(200).json({ received: true });
};

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║ 10.  Shared fulfilment helper                                          ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
async function finalisePaidOrder(orderDoc, paymentDetails) {
	if (orderDoc.paymentStatus === "Paid") return; // idempotent

	orderDoc.paymentStatus = "Paid";
	orderDoc.status = "In Process";
	orderDoc.paymentDetails = paymentDetails;
	await orderDoc.save();

	await postOrderToPrintify(orderDoc).catch((e) =>
		console.error("Printify err:", e)
	);
	await updateStock(orderDoc).catch((e) => console.error("Stock upd err:", e));

	sendOrderConfirmationEmail(orderDoc).catch((e) =>
		console.error("email err:", e)
	);
	sendOrderConfirmationSMS(orderDoc).catch((e) => console.error("sms err:", e));
}
