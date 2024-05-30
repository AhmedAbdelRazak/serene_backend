/** @format */

const mongoose = require("mongoose");

const genderNameSchema = new mongoose.Schema(
	{
		genderName: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
		},
		genderName_Arabic: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
		},
		genderNameSlug: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		genderNameSlug_Arabic: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		genderName_Arabic: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		genderNameStatus: {
			type: Boolean,
			default: true,
		},
		thumbnail: {
			type: Array,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Gender", genderNameSchema);
