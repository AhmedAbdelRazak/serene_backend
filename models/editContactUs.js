/** @format */

const mongoose = require("mongoose");

const contactSchema = new mongoose.Schema(
	{
		business_hours: {
			type: String,
			required: true,
		},
		business_hours_Arabic: {
			type: String,
		},

		address: {
			type: String,
			required: true,
		},
		address_Arabic: {
			type: String,
		},
		phone: {
			type: String,
			required: true,
		},
		email: {
			type: String,
			required: true,
		},
		header_1: {
			type: String,
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

module.exports = mongoose.model("Contact", contactSchema);
