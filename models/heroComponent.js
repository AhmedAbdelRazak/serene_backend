/** @format */

const mongoose = require("mongoose");

const heroComponentSchema = new mongoose.Schema(
	{
		heroComponentStatus: {
			type: Boolean,
			default: true,
		},
		thumbnail: {
			type: Array,
		},
		thumbnail2: {
			type: Array,
		},
		thumbnail3: {
			type: Array,
		},
		thumbnail4: {
			type: Array,
		},
		header1: {
			type: String,
		},
		header2: {
			type: String,
		},
		header3: {
			type: String,
		},
		thumbnail_Phone: {
			type: Array,
		},
		thumbnail2_Phone: {
			type: Array,
		},
		thumbnail3_Phone: {
			type: Array,
		},
		thumbnail4_Phone: {
			type: Array,
		},
		hyper_link: {
			type: String,
		},
		hyper_link2: {
			type: String,
		},
		hyper_link3: {
			type: String,
		},
		hyper_link4: {
			type: String,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("HeroComponent", heroComponentSchema);
