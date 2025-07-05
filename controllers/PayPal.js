/* ---------------------------------------------------------------------------
   PayPal Controller – final July 2025 build
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

const buildPU = (order, invoice) => ({
	reference_id: order._id.toString(),
	invoice_id: invoice,
	description: `Serene Jannat – Order ${invoice}`,
	amount: {
		currency_code: "USD",
		value: (order.totalAmountAfterDiscount || order.totalAmount).toFixed(2),
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

/* ═════════════ 6 Create order ═════════════ */
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
		let order = await Order.create({
			...orderData,
			invoiceNumber: invoice,
			status: "Awaiting Payment",
			paymentStatus: "Pending",
			createdVia: "PayPal‑Checkout",
		});

		const ppReq = new paypal.orders.OrdersCreateRequest();
		ppReq.headers["PayPal-Request-Id"] = `ord-${order._id}-${uuid()}`;
		ppReq.prefer("return=representation");
		ppReq.requestBody({
			intent: "CAPTURE",
			purchase_units: [buildPU(order, invoice)],
			application_context: {
				brand_name: "Serene Jannat",
				user_action: "PAY_NOW",
				shipping_preference: "NO_SHIPPING",
			},
		});

		const { result } = await ppClient.execute(ppReq);
		await Order.findByIdAndUpdate(order._id, { paypalOrderId: result.id });
		res.json({ paypalOrderId: result.id });
	} catch (err) {
		console.error(err.stack || err);
		// best‑effort clean‑up
		if (err && err.order && err.order._id)
			await Order.findByIdAndDelete(err.order._id);
		res.status(500).json({ error: "Failed to create PayPal order" });
	}
};

/* ═════════════ 7 Capture order ═════════════ */
exports.captureOrder = async (req, res) => {
	try {
		const { paypalOrderId } = req.body || {};
		if (!paypalOrderId)
			return res.status(400).json({ error: "Missing order ID" });

		let order = await Order.findOne({ paypalOrderId });
		if (!order) return res.status(404).json({ error: "Local order not found" });

		const capReq = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
		capReq.requestBody({});
		const { result } = await ppClient.execute(capReq);

		if (result.status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${result.status})`);

		await finalisePaidOrder(order, safeClone(result));
		order = await Order.findById(order._id);

		/* build safe response */
		let out;
		try {
			out = convertBigIntToString(order.toObject());
		} catch (_) {
			// if convertBigInt fails for any reason
			out = safeClone(order.toJSON());
		}
		res.json({ success: true, order: out });
	} catch (err) {
		console.error(err.stack || err);
		if (err && err.order && err.order._id)
			await Order.findByIdAndDelete(err.order._id);
		res.status(402).json({ error: "Payment not completed" });
	}
};

/* ═════════════ 8 Card‑only flow ═════════════ */
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
		let order = await Order.create({
			...orderData,
			invoiceNumber: invoice,
			status: "Awaiting Payment",
			paymentStatus: "Pending",
			createdVia: "PayPal‑Card",
		});

		const ppReq = new paypal.orders.OrdersCreateRequest();
		ppReq.headers["PayPal-Request-Id"] = `card-${order._id}-${uuid()}`;
		ppReq.requestBody({
			intent: "CAPTURE",
			purchase_units: [buildPU(order, invoice)],
			payment_source: { card: paymentSource },
		});

		const { result: created } = await ppClient.execute(ppReq);
		const capReq = new paypal.orders.OrdersCaptureRequest(created.id);
		capReq.requestBody({});
		const { result: captured } = await ppClient.execute(capReq);

		if (captured.status !== "COMPLETED")
			throw new Error(`Capture not completed (status ${captured.status})`);

		await finalisePaidOrder(order, safeClone(captured));
		order = await Order.findById(order._id);

		let out;
		try {
			out = convertBigIntToString(order.toObject());
		} catch {
			out = safeClone(order.toJSON());
		}

		res.json({ success: true, order: out });
	} catch (err) {
		console.error(err.stack || err);
		if (err && err.order && err.order._id)
			await Order.findByIdAndDelete(err.order._id);
		res.status(402).json({ error: "Card payment failed" });
	}
};

/* ═════════════ 9 Webhook ═════════════ */
exports.webhook = async (req, res) => {
	try {
		const { event_type: type, resource } = req.body;

		if (type === "PAYMENT.CAPTURE.COMPLETED") {
			const capture = safeClone(resource);
			const orderId = capture.supplementary_data?.related_ids?.order_id;
			const local = await Order.findOne({ paypalOrderId: orderId });
			if (local) await finalisePaidOrder(local, capture);
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

/* ═════════════ 10 Fulfilment helper ═════════════ */
async function finalisePaidOrder(orderDoc, paymentJSON) {
	if (orderDoc.paymentStatus === "Paid") return;

	orderDoc.paymentStatus = "Paid";
	orderDoc.status = "In Process";
	orderDoc.paymentDetails = paymentJSON;
	await orderDoc.save();

	await postOrderToPrintify(orderDoc).catch((e) =>
		console.error("Printify:", e)
	);
	await updateStock(orderDoc).catch((e) => console.error("Stock:", e));

	sendOrderConfirmationEmail(orderDoc).catch((e) => console.error("Email:", e));
	sendOrderConfirmationSMS(orderDoc).catch((e) => console.error("SMS:", e));
}
