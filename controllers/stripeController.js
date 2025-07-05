/* ---------------------------------------------------------------------------
   Stripe Controller – July‑2025  (Square‑style flow, but with Stripe)
   --------------------------------------------------------------------------- */

"use strict";

/* ─────────────────────────────  1. Deps & config  ───────────────────────── */
const stripe = require("stripe")(
	process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY,
	{ apiVersion: "2023-10-16" }
);
const Joi = require("joi");
const { v4: uuidv4 } = require("uuid");

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

/* ─────────────────────  2. Joi schema for basic safety  ─────────────────── */
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

/* ────────────────────────────  3. Small helpers  ────────────────────────── */
const normalisePhone = (raw) =>
	raw.startsWith("+") ? raw : `+1${raw.replace(/\D/g, "")}`.slice(0, 12);

const safeDescriptor = (str) =>
	str.replace(/[^A-Za-z0-9*+.\- ]/g, "").slice(0, 22) || "SERENEJAN";

const buildShippingObject = (order) => ({
	name: order.customerDetails.name,
	phone: normalisePhone(order.customerDetails.phone),
	address: {
		line1: order.customerDetails.address,
		city: order.customerDetails.city,
		state: order.customerDetails.state,
		postal_code: order.customerDetails.zipcode,
		country: "US",
	},
});

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  4.  CREATE CHECKOUT / DIRECT CHARGE                                    ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
exports.createCheckoutSession = async (req, res) => {
	console.log("▶︎  /api/stripe/checkout-session");

	/* A) extract & validate */
	const { orderData, paymentMethodId } = req.body || {};
	const { error } = orderSchema.validate(orderData || {}, {
		abortEarly: false,
	});
	if (error) return res.status(400).json({ error: error.details });

	/* B) stock */
	const stockIssue = await checkStockAvailability(orderData);
	if (stockIssue) return res.status(400).json({ error: stockIssue });

	/* C) invoice & stub order (status = Awaiting Payment) */
	const invoiceNumber = await generateUniqueInvoiceNumber();
	const descriptor = safeDescriptor("SJ GIFTS");
	const idempotencyKey = `order-${uuidv4()}`;

	let order = await Order.create({
		...orderData,
		invoiceNumber,
		status: "Awaiting Payment",
		paymentStatus: "Pending",
		createdVia: paymentMethodId ? "Stripe‑Direct" : "Stripe‑Checkout",
	});

	const shipping = buildShippingObject(order);
	const metadata = { order_id: order._id.toString(), invoice: invoiceNumber };

	/* =======================================================================
     1) DIRECT CHARGE   (Stripe Link → PaymentIntent.confirm())
     ======================================================================= */
	if (paymentMethodId) {
		try {
			const amountCents = Math.round(
				Number(order.totalAmountAfterDiscount || order.totalAmount) * 100
			);

			const pi = await stripe.paymentIntents.create(
				{
					amount: amountCents,
					currency: "usd",
					payment_method: paymentMethodId,
					confirmation_method: "manual",
					confirm: true,
					description: `Serene Jannat – Order ${invoiceNumber}`,
					shipping,
					statement_descriptor_suffix: descriptor,
					metadata,
					receipt_email: order.customerDetails.email,
				},
				{ idempotencyKey }
			);

			if (pi.status === "requires_action")
				return res.json({
					requiresAction: true,
					clientSecret: pi.client_secret,
				});

			if (pi.status !== "succeeded") throw new Error(pi.status);

			/* retrieve expanded PI for card brand / last‑4 */
			const fullPI = await stripe.paymentIntents.retrieve(pi.id, {
				expand: ["payment_method", "charges.data.payment_method_details"],
			});

			await finalisePaidOrder(order, fullPI); // step 5‑→8
			order = await Order.findById(order._id); // refetch with updates
			return res.json({
				success: true,
				order: convertBigIntToString(order.toObject()),
			});
		} catch (err) {
			/* payment failed → delete stub */
			await Order.findByIdAndDelete(order._id);
			const msg =
				err?.raw?.message ||
				err.message ||
				"Card declined. Please use a different payment method.";
			return res.status(402).json({ error: msg });
		}
	}

	/* =======================================================================
     2) HOSTED CHECKOUT   (Stripe Checkout + Link / cards)
     ======================================================================= */
	try {
		const lineItems = buildLineItems(order);

		const session = await stripe.checkout.sessions.create(
			{
				mode: "payment",
				customer_email: order.customerDetails.email,
				line_items: lineItems,
				/* visible in Checkout UI */
				shipping_address_collection: { allowed_countries: ["US", "CA"] },
				phone_number_collection: { enabled: true },
				/* goes into the PaymentIntent */
				payment_intent_data: {
					description: `Serene Jannat – Order ${invoiceNumber}`,
					shipping,
					statement_descriptor_suffix: descriptor,
					metadata,
				},
				/* also copy onto the Session itself so we can retrieve */
				metadata,
				success_url: `${process.env.CLIENT_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
				cancel_url: `${process.env.CLIENT_URL}/cart?canceled=1`,
			},
			{ idempotencyKey }
		);

		return res.json({ url: session.url });
	} catch (err) {
		/* if Checkout could not be started → delete stub */
		await Order.findByIdAndDelete(order._id);
		const msg =
			err?.raw?.message ||
			err.message ||
			"Unable to start Stripe Checkout. Please try again.";
		return res.status(500).json({ error: msg });
	}
};

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  5.  WEB‑HOOK                                                          ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
exports.webhook = async (req, res) => {
	const sig = req.headers["stripe-signature"];
	let event;
	try {
		event = stripe.webhooks.constructEvent(
			req.body,
			sig,
			process.env.STRIPE_WEBHOOK_SECRET
		);
	} catch (err) {
		console.error("⚠️  Webhook signature failed:", err.message);
		return res.status(400).send(`Webhook Error: ${err.message}`);
	}

	const { type } = event;

	/* ─── PAYMENT SUCCEEDED ─────────────────────────────────────────────── */
	if (type === "checkout.session.completed") {
		const session = event.data.object;
		const orderId = session.metadata?.order_id;
		const invoiceN = session.metadata?.invoice;

		console.log(`▶︎  checkout.session.completed  order=${orderId}`);

		try {
			const order = await Order.findById(orderId);
			if (!order) throw new Error("Order stub not found");

			const intent = await stripe.paymentIntents.retrieve(
				session.payment_intent,
				{
					expand: ["charges", "payment_method"],
				}
			);

			await finalisePaidOrder(order, intent);
			console.log(`✔︎  Order ${orderId} finalised (invoice ${invoiceN})`);
		} catch (e) {
			console.error("🚨  Finalise error:", e);
		}

		return res.json({ received: true });
	}

	/* ─── PAYMENT FAILED ────────────────────────────────────────────────── */
	if (type === "payment_intent.payment_failed") {
		const intent = event.data.object;
		const orderId = intent.metadata?.order_id;
		if (orderId) {
			await Order.findByIdAndDelete(orderId);
			console.log(`ℹ︎  Stub order ${orderId} removed due to failed payment`);
		}
		return res.json({ received: true });
	}

	/* ─── CHECKOUT SESSION EXPIRED ──────────────────────────────────────── */
	if (type === "checkout.session.expired") {
		const session = event.data.object;
		const orderId = session.metadata?.order_id;
		if (orderId) {
			await Order.findByIdAndDelete(orderId);
			console.log(`ℹ︎  Stub order ${orderId} removed (Checkout expired)`);
		}
		return res.json({ received: true });
	}

	/* default fast‑path */
	res.json({ received: true });
};

/* ╔═════════════════════════════════════════════════════════════════════════╗
   ║  6.  Helper functions                                                  ║
   ╚═════════════════════════════════════════════════════════════════════════╝ */
function buildLineItems(order) {
	const arr = [];

	order.productsNoVariable.forEach((p) =>
		arr.push({
			quantity: p.ordered_quantity,
			price_data: {
				currency: "usd",
				unit_amount: Math.round(p.price * 100),
				product_data: { name: p.name },
			},
		})
	);

	order.chosenProductQtyWithVariables.forEach((p) =>
		arr.push({
			quantity: p.ordered_quantity,
			price_data: {
				currency: "usd",
				unit_amount: Math.round(p.price * 100),
				product_data: {
					name: `${p.name} – ${p.chosenAttributes.color}/${p.chosenAttributes.size}`,
				},
			},
		})
	);

	arr.push({
		quantity: 1,
		price_data: {
			currency: "usd",
			unit_amount: Math.round(order.chosenShippingOption.shippingPrice * 100),
			product_data: {
				name: `Shipping – ${order.chosenShippingOption.carrierName}`,
			},
		},
	});

	return arr;
}

async function finalisePaidOrder(orderDoc, paymentIntent) {
	/* avoid double‑processing */
	if (orderDoc.paymentStatus === "Paid") return;

	orderDoc.paymentStatus = "Paid";
	orderDoc.status = "In Process";
	orderDoc.paymentDetails = paymentIntent;
	await orderDoc.save();

	console.log("   → postOrderToPrintify()");
	await postOrderToPrintify(orderDoc);

	console.log("   → updateStock()");
	await updateStock(orderDoc);

	sendOrderConfirmationEmail(orderDoc).catch((e) =>
		console.error("e‑mail err:", e)
	);
	sendOrderConfirmationSMS(orderDoc).catch((e) => console.error("SMS err:", e));
}
