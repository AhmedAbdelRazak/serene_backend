const express = require("express");
const router = express.Router();
const {
	createCheckoutSession,
	webhook,
} = require("../controllers/stripeController");

router.post("/checkout-session", createCheckoutSession);

/* Stripe requires the raw body for webhook validation */
router.post("/webhook", express.raw({ type: "application/json" }), webhook);

module.exports = router;
