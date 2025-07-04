const express = require("express");
const router = express.Router();
const { createCheckoutSession } = require("../controllers/stripeController");

router.post("/stripe/checkout-session", createCheckoutSession);

module.exports = router;
