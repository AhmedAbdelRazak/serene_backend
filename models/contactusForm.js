/** @format */

const mongoose = require("mongoose");

const contactUs = new mongoose.Schema(
	{
		name: {
			type: String,
			trim: true,
			required: true,
			maxlength: 32,
		},
		email: {
			type: String,
			trim: true,
			required: true,
		},
		subject: {
			type: String,
			trim: true,
		},
		text: {
			type: String,
			trim: true,
			required: true,
		},
	},
	{ timestamps: true },
);

module.exports = mongoose.model("ContactUs", contactUs);
