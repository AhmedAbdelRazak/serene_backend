/** @format */

const mongoose = require("mongoose");

const adsSchema = new mongoose.Schema(
	{
		ad_Name: {
			type: Array,
			default: [],
		},
		ad_Name_Arabic: {
			type: Array,
			default: [],
		},
		show_ad: {
			type: Boolean,
			default: false,
		},
	},
	{ timestamps: true },
);

module.exports = mongoose.model("Ads", adsSchema);
