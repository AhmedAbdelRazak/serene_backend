const express = require("express");
const router = express.Router();
const ppCtrl = require("../controllers/PayPal");

/* JS‑SDK client‑token */
router.post("/paypal/client-token", ppCtrl.generateClientToken);

/* Wallet / Venmo / Pay Later */
router.post("/paypal/create-order", ppCtrl.createOrder);
router.post("/paypal/capture-order", ppCtrl.captureOrder);

/* Optional card‑only flow — enable when you really use it */
/* router.post("/paypal/card-pay",      ppCtrl.cardPay);   */

/* Web‑hook */
router.post(
	"/paypal/webhook",
	express.json({ type: "application/json" }),
	ppCtrl.webhook
);

module.exports = router;
