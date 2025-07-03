/* ---------------------------------------------------------------------------
   controllers/stripeController.js
   ---------------------------------------------------------------------------
   Stripe Checkout + Webhook flow (1 : 1 replacement for the former Square code)

   – createCheckoutSession   → POST /api/stripe/checkout-session
   – webhook                → POST /api/stripe/webhook   (⚠️  RAW body)

   * All downstream helpers live in controllers/HelperFunctions.js
   * Order schema is unchanged; we only swap the payment‑provider layer.
   --------------------------------------------------------------------------- */

"use strict";

/* ─────────────── External libs ─────────────── */
const stripe = require("stripe")(
	process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY
);

/* ─────────────── Internal helpers ─────────────── */
const {
	checkStockAvailability,
	generateUniqueInvoiceNumber,
	updateStock,
	postOrderToPrintify,
	sendOrderConfirmationEmail,
	sendOrderConfirmationSMS,
} = require("./HelperFunctions");

const { Order } = require("../models/order");

/* ════════════════════════════════════════════════════════════════
   POST  /api/stripe/checkout-session
   ════════════════════════════════════════════════════════════════ */
exports.createCheckoutSession = async (req, res) => {
	try {
		/* ------------------------------------------------------------------
       0)  Payload from the React checkout wizard
           { orderData: { …exactly what used to hit /api/order/create } }
       ------------------------------------------------------------------ */
		const { orderData } = req.body;

		if (!orderData || !orderData.totalAmountAfterDiscount) {
			return res.status(400).json({ error: "Missing order data" });
		}

		/* 1) Stock guard (same helper as before) */
		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) return res.status(400).json({ error: stockIssue });

		/* 2) Persist an “Awaiting Payment” order */
		const invoiceNumber = await generateUniqueInvoiceNumber();
		const order = await Order.create({
			...orderData,
			invoiceNumber,
			status: "Awaiting Payment",
			paymentStatus: "Pending",
			createdVia: "Stripe‑Checkout",
		});

		/* 3) Build Stripe line‑items (= visual breakdown on Stripe receipt) */
		const lineItems = [];

		// plain products
		order.productsNoVariable.forEach((p) =>
			lineItems.push({
				quantity: p.ordered_quantity,
				price_data: {
					currency: "usd",
					unit_amount: Math.round(p.price * 100), // cents
					product_data: { name: p.name },
				},
			})
		);

		// variant products
		order.chosenProductQtyWithVariables.forEach((p) =>
			lineItems.push({
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

		// shipping as its own line
		lineItems.push({
			quantity: 1,
			price_data: {
				currency: "usd",
				unit_amount: Math.round(order.chosenShippingOption.shippingPrice * 100),
				product_data: {
					name: `Shipping – ${order.chosenShippingOption.carrierName}`,
				},
			},
		});

		/* 4) Create the Checkout Session */
		const session = await stripe.checkout.sessions.create({
			mode: "payment",
			customer_email: order.customerDetails.email,
			line_items: lineItems,
			payment_intent_data: {
				metadata: {
					order_id: order._id.toString(),
					invoice: invoiceNumber,
				},
			},
			metadata: {
				order_id: order._id.toString(),
				invoice: invoiceNumber,
			},
			billing_address_collection: "required",
			shipping_address_collection: { allowed_countries: ["US"] },
			allow_promotion_codes: false,
			success_url: `${process.env.CLIENT_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${process.env.CLIENT_URL}/cart?canceled=1`,
		});

		/* 5) Send URL back → React will redirect */
		res.json({ url: session.url });
	} catch (err) {
		console.error("Stripe‑session error:", err);
		res
			.status(500)
			.json({ error: "Unable to start payment. Please try again." });
	}
};

/* ════════════════════════════════════════════════════════════════
   POST  /api/stripe/webhook   (NO body‑parser: express.raw)
   Stripe sends many events – we only care about checkout.session.completed
   ════════════════════════════════════════════════════════════════ */
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
		console.error("Webhook signature failed:", err.message);
		return res.status(400).send(`Webhook Error: ${err.message}`);
	}

	/* ───  Process successful payments ─── */
	if (event.type === "checkout.session.completed") {
		const session = event.data.object;
		const orderId = session.metadata.order_id; // we set this earlier

		try {
			const order = await Order.findById(orderId);
			if (!order) throw new Error("Order not found");

			/* A) Pull the fully‑expanded PaymentIntent (charges, card brand, receipt…) */
			const intent = await stripe.paymentIntents.retrieve(
				session.payment_intent,
				{
					expand: ["charges", "latest_charge.balance_transaction"],
				}
			);

			/* B) Persist rich paymentDetails (Square‑level parity) */
			order.paymentStatus = "Paid";
			order.status = "In Process";
			order.paymentDetails = intent; // full PI JSON blob – plenty for audits / refunds
			await order.save();

			/* C) Fulfilment pipeline (unchanged from Square flow) */
			await postOrderToPrintify(order);
			await updateStock(order);
			sendOrderConfirmationEmail(order).catch(console.error);
			sendOrderConfirmationSMS(order).catch(console.error);

			console.log(`✅ Order ${order._id} fully processed via Stripe webhook`);
		} catch (err) {
			console.error("❌ Post‑payment processing failed:", err);
			// optional: create administrative alert / auto‑refund
		}
	}

	/* Stripe requires a 2xx quickly */
	res.json({ received: true });
};
