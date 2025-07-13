/*********************************************************************
 *  Exposes all PayPal endpoints used by the React checkout
 *********************************************************************/

const express = require("express");
const ctrl = require("../controllers/PayPal");

const router = express.Router();

/* ───────────────────────────── 1. Client token ────────────────────────── */
/*  JS‑SDK loads first → browser asks for a client‑token so Card Fields
    can initialise and obtain 3‑D Secure liability‑shift.                  */
router.post("/paypal/client-token", ctrl.generateClientToken);

/* ───────────────────────────── 2. Two‑step checkout ───────────────────── */
/*  a) create‑order      – called from PayPalButtons/CardFields `createOrder`
    b) capture‑order     – called from `onApprove` after user authorises    */
router.post("/paypal/create-order", ctrl.createOrder);
router.post("/paypal/capture-order", ctrl.captureOrder);

/* ───────────────────────────── 3. Webhook (optional) ──────────────────── */
/*  Add the URL you expose below to PayPal Dashboard → Webhooks.
    If you plan to verify the signature you must capture the *raw* body.   */
router.post(
	"/paypal/webhook",
	express.json({ type: "*/*" }), // use raw‑body middleware if verifying
	ctrl.webhook
);

module.exports = router;
