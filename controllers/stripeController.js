/* ---------------------------------------------------------------------------
   Stripe Controller – July‑2025  (hosted + direct, with webhook)
   --------------------------------------------------------------------------- */

"use strict";
const stripe = require("stripe")(
	process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY
);

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

/* ────────────────────────────────────────────────────────────── */
/*  A)  Checkout entry point                                      */
/* ────────────────────────────────────────────────────────────── */
exports.createCheckoutSession = async (req, res) => {
	console.log("▶︎  /api/stripe/checkout-session called");

	try {
		const { orderData, paymentMethodId } = req.body || {};
		if (!orderData)
			return res.status(400).json({ error: "Missing order data" });

		/* 1) stock */
		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) return res.status(400).json({ error: stockIssue });

		/* 2) stub order */
		const invoiceNumber = await generateUniqueInvoiceNumber();
		const order = await Order.create({
			...orderData,
			invoiceNumber,
			status: "Awaiting Payment",
			paymentStatus: "Pending",
			createdVia: paymentMethodId ? "Stripe‑Direct" : "Stripe‑Checkout",
		});

		/* ───── DIRECT CHARGE ───── */
		if (paymentMethodId) {
			const cents = Math.round(
				Number(order.totalAmountAfterDiscount || order.totalAmount) * 100
			);

			const pi = await stripe.paymentIntents.create({
				amount: cents,
				currency: "usd",
				payment_method: paymentMethodId,
				confirmation_method: "manual",
				confirm: true,
				metadata: { order_id: order._id.toString(), invoice: invoiceNumber },
				receipt_email: order.customerDetails.email,
			});

			if (pi.status === "requires_action")
				return res.json({
					requiresAction: true,
					clientSecret: pi.client_secret,
				});

			if (pi.status !== "succeeded") {
				await Order.findByIdAndDelete(order._id);
				return res.status(402).json({ error: "Payment unsuccessful" });
			}

			await finalisePaidOrder(order, pi);
			return res.json({
				success: true,
				order: convertBigIntToString(order.toObject()),
			});
		}

		/* ───── HOSTED CHECKOUT ───── */
		const lineItems = buildLineItems(order);
		const session = await stripe.checkout.sessions.create({
			mode: "payment",
			customer_email: order.customerDetails.email,
			line_items: lineItems,
			metadata: { order_id: order._id.toString(), invoice: invoiceNumber },
			success_url:
				process.env.CLIENT_URL + "/dashboard?session_id={CHECKOUT_SESSION_ID}",
			cancel_url: process.env.CLIENT_URL + "/cart?canceled=1",
		});

		return res.json({ url: session.url }); // React expects `url`
	} catch (err) {
		console.error("✗ createCheckoutSession error:", err);
		return res.status(500).json({ error: "Server error" });
	}
};

/* ────────────────────────────────────────────────────────────── */
/*  B)  Web‑hook (raw body!)                                      */
/* ────────────────────────────────────────────────────────────── */
/* controllers/stripeController.js  (only the webhook part) */

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

	/* we only care about the payment being completed */
	if (event.type !== "checkout.session.completed") {
		return res.json({ received: true }); // fast‑path for all others
	}

	const session = event.data.object;
	const orderId = session.metadata?.order_id;
	const invoiceN = session.metadata?.invoice;

	console.log(`▶︎  checkout.session.completed  order=${orderId}`);

	try {
		/* ------------------------------------------------------------------ 1 */
		const order = await Order.findById(orderId);
		if (!order) throw new Error("Order document not found");

		/* ------------------------------------------------------------------ 2 */
		let intent;
		try {
			intent = await stripe.paymentIntents.retrieve(session.payment_intent, {
				expand: ["charges", "payment_method"],
			});
			console.log("   ✓ PaymentIntent retrieved:", intent.id);
		} catch (piErr) {
			console.error("   ✗ PI retrieval failed, falling back to session object");
			intent = session; // minimal fallback (still has amount, currency…)
		}

		order.paymentStatus = "Paid";
		order.status = "In Process";
		order.paymentDetails = intent;

		await order.save();
		console.log("   ✓ Order marked Paid & saved", order._id);

		/* ------------------------------------------------------------------ 3 */
		try {
			await postOrderToPrintify(order);
			console.log("   ✓ Printify order(s) created");
		} catch (printErr) {
			console.error("   ✗ Printify failed – order left for manual fulfilment");
			console.error("     ", printErr?.response?.data || printErr);
			// DON’T throw – customer has already paid
		}

		/* ------------------------------------------------------------------ 4 */
		try {
			await updateStock(order);
			console.log("   ✓ Local stock updated");
		} catch (stockErr) {
			console.error("   ✗ Stock update failed:", stockErr);
		}

		/* ------------------------------------------------------------------ 5 */
		sendOrderConfirmationEmail(order).catch((e) =>
			console.error("   ✗ Email error:", e)
		);
		sendOrderConfirmationSMS(order).catch((e) =>
			console.error("   ✗ SMS error:", e)
		);

		console.log(`✔︎  Post‑payment pipeline finished  (invoice ${invoiceN})`);
	} catch (fatal) {
		console.error("🚨  webhook fatal:", fatal);
		// optional: trigger ops alert / refund
	}

	res.json({ received: true });
};

/* ────────────────────────────────────────────────────────────── */
/*  C)  Helpers                                                  */
/* ────────────────────────────────────────────────────────────── */
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
	/* guard‑clause: avoid double‑processing */
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
