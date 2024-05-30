/** @format */

const mongoose = require("mongoose");

const parentSchema = new mongoose.Schema(
	{
		parentName: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
		},
		parentName_Arabic: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
		},
		parentNameSlug: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		parentNameSlug_Arabic: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		parentName_Arabic: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		parentNameStatus: {
			type: Boolean,
			default: true,
		},
		thumbnail: {
			type: Array,
		},
	},
	{ timestamps: true },
);

module.exports = mongoose.model("Parent", parentSchema);
