/** @format */

const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
	{
		categoryName: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
			lowercase: true,
		},
		categoryName_Arabic: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
			lowercase: true,
		},
		categorySlug: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		categorySlug_Arabic: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
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

module.exports = mongoose.model("Category", categorySchema);
