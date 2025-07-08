/*********************************************************************
 *  routes/paypal.js
 *********************************************************************/
const express = require("express");
const ctrl = require("../controllers/PayPal");

const router = express.Router();

/*  Client‑side SDK needs this first */
router.post("/paypal/client-token", ctrl.generateClientToken);

/*  Wallet & hosted‑fields card flow (two‑step: create → capture)      */
router.post("/paypal/create-order", ctrl.createOrder);
router.post("/paypal/capture-order", ctrl.captureOrder);

/*  Card‑only “single call” flow if you prefer it on some pages        */
router.post("/paypal/card-pay", ctrl.cardPay);

/*  (Optional) Webhook endpoint – remember to add the route URL in the
    PayPal dashboard and verify the signature in production.          */
router.post("/paypal/webhook", express.json({ type: "*/*" }), ctrl.webhook);

module.exports = router;
