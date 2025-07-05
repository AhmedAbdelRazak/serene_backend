/* ---------------------------------------------------------------------------
   PayPal routes – plug into app with `app.use("/api", require("./routes/paypal"));`
   --------------------------------------------------------------------------- */

const express = require("express");
const router = express.Router();
const ppCtrl = require("../controllers/PayPal");

/* generate JS‑SDK client token */
router.post("/paypal/client-token", ppCtrl.generateClientToken);

/* “Pay with PayPal” (pop‑up / redirect) */
router.post("/paypal/create-order", ppCtrl.createOrder);
router.post("/paypal/capture-order", ppCtrl.captureOrder);

/* Advanced Card / Fastlane card‑only (no redirect) */
router.post("/paypal/card-pay", ppCtrl.cardPay);

/* Web‑hook endpoint (set this URL in PayPal dashboard) */
router.post(
	"/paypal/webhook",
	express.json({ type: "application/json" }),
	ppCtrl.webhook
);

module.exports = router;
