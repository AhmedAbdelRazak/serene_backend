/** @format */

const mongoose = require("mongoose");

const sizesSchema = new mongoose.Schema(
	{
		size: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
			lowercase: true,
		},
	},
	{ timestamps: true },
);

module.exports = mongoose.model("Sizes", sizesSchema);
