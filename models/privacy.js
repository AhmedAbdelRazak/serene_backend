/** @format */

const mongoose = require("mongoose");

const SereneJannatPrivacyPolicy = new mongoose.Schema(
	{
		termsAndConditionEnglish: {
			type: String,
			trim: true,
		},

		returnsAndExchange: {
			type: String,
			trim: true,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model(
	"SereneJannatPrivacyPolicy",
	SereneJannatPrivacyPolicy
);
