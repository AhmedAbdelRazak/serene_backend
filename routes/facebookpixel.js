/** @format */

const express = require("express");

const router = express.Router();

const {
	triggerFacebookConversionAPI,
} = require("../controllers/facebookpixel");

router.post("/facebookpixel/conversionapi", triggerFacebookConversionAPI);

module.exports = router;
