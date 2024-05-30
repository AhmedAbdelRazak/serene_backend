/** @format */

const mongoose = require("mongoose");

const aboutSchema = new mongoose.Schema(
	{
		header_1: {
			type: String,
			required: true,
		},
		header_1_Arabic: {
			type: String,
		},

		description_1: {
			type: String,
			default: "No Description",
		},

		description_1_Arabic: {
			type: String,
			default: "No Description",
		},

		categoryStatus: {
			type: Boolean,
			default: true,
		},

		thumbnail: {
			type: Array,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("About", aboutSchema);
