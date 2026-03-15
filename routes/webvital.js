/** @format */

const express = require("express");
const router = express.Router();

const {
	captureWebVital,
	getWebVitalsSummary,
} = require("../controllers/webvital");

router.post("/web-vitals", captureWebVital);
router.get("/web-vitals/summary", getWebVitalsSummary);

module.exports = router;
