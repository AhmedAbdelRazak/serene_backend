/* ---------------------------------------------------------------------------
   controllers/stripeController.js           (single‑call full pipeline)
   --------------------------------------------------------------------------- */

"use strict";

/* ───────── External dependencies ───────── */
const stripe = require("stripe")(
	process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY
);

/* ───────── Internal shared helpers ─────── */
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

/* ════════════════════════════════════════════════════════════════
   POST  /api/stripe/checkout-session
   One single controller – no webhook required
   ════════════════════════════════════════════════════════════════ */
exports.createCheckoutSession = async (req, res) => {
	console.log("▶︎  /api/stripe/checkout-session called");

	try {
		/* ------------------------------------------------------------------ 0 */
		const { orderData, paymentMethodId } = req.body;

		if (!orderData || !orderData.totalAmountAfterDiscount)
			return res.status(400).json({ error: "Missing order data" });

		if (!paymentMethodId)
			return res.status(400).json({ error: "Missing paymentMethodId" });

		/* ------------------------------------------------------------------ 1 */
		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) {
			console.warn("✗ Stock issue:", stockIssue);
			return res.status(400).json({ error: stockIssue });
		}

		/* ------------------------------------------------------------------ 2 */
		const invoiceNumber = await generateUniqueInvoiceNumber();
		const order = await Order.create({
			...orderData,
			invoiceNumber,
			status: "Awaiting Payment",
			paymentStatus: "Pending",
			createdVia: "Stripe‑Direct",
		});
		console.log(`✓ Order stub saved  _id=${order._id}`);

		/* ------------------------------------------------------------------ 3 */
		const amountInCents = Math.round(
			Number(orderData.totalAmountAfterDiscount) * 100
		);

		let paymentIntent;
		try {
			paymentIntent = await stripe.paymentIntents.create({
				amount: amountInCents,
				currency: "usd",
				payment_method: paymentMethodId,
				confirmation_method: "manual",
				confirm: true, // synchronous confirm
				metadata: {
					order_id: order._id.toString(),
					invoice: invoiceNumber,
				},
				receipt_email: order.customerDetails.email,
			});
		} catch (err) {
			console.error("✗ Stripe PI error:", err);
			await Order.findByIdAndDelete(order._id); // rollback
			return res.status(402).json({ error: err.message });
		}

		/* ---- 3‑D Secure required? ---------------------------------------- */
		if (paymentIntent.status === "requires_action") {
			return res.json({
				requiresAction: true,
				clientSecret: paymentIntent.client_secret,
			});
		}

		if (paymentIntent.status !== "succeeded") {
			await Order.findByIdAndDelete(order._id);
			return res
				.status(402)
				.json({ error: "Payment did not succeed. Please try again." });
		}

		console.log("✓ PaymentIntent succeeded id:", paymentIntent.id);

		/* ------------------------------------------------------------------ 4 */
		order.paymentStatus = "Paid";
		order.status = "In Process";
		order.paymentDetails = paymentIntent; // full JSON blob
		await order.save();
		console.log("✓ Order updated to Paid");

		/* ------------------------------------------------------------------ 5 */
		try {
			console.log("→  postOrderToPrintify");
			await postOrderToPrintify(order);
			console.log("✓ Printify fulfilment complete");

			console.log("→  updateStock");
			await updateStock(order);
			console.log("✓ Stock updated");

			sendOrderConfirmationEmail(order).catch((e) =>
				console.error("Email error:", e)
			);
			sendOrderConfirmationSMS(order).catch((e) =>
				console.error("SMS error:", e)
			);
		} catch (fulfilErr) {
			console.error("✗ Fulfilment error AFTER payment:", fulfilErr);
			/* Decide here if you want to trigger a refund automatically. */
		}

		/* ------------------------------------------------------------------ 6 */
		const responseOrder = convertBigIntToString(order.toObject());
		return res.json({ success: true, order: responseOrder });
	} catch (err) {
		console.error("✗ Top‑level Stripe controller error:", err);
		return res.status(500).json({ error: "Server error – please try again." });
	}
};
