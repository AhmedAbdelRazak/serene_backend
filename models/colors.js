/** @format */

const mongoose = require("mongoose");

const colorsSchema = new mongoose.Schema(
	{
		color: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
			lowercase: true,
		},
		hexa: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
			lowercase: true,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Colors", colorsSchema);
