/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const subcategorySchema = new mongoose.Schema(
	{
		SubcategoryName: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
			lowercase: true,
		},
		SubcategoryName_Arabic: {
			type: String,
			trim: true,
			required: "Name is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
			lowercase: true,
		},
		SubcategorySlug: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		SubcategorySlug_Arabic: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		subCategoryStatus: {
			type: Boolean,
			default: true,
		},
		categoryId: {
			type: ObjectId,
			ref: "Category",
			required: true,
		},
		thumbnail: {
			type: Array,
		},
	},
	{ timestamps: true },
);

module.exports = mongoose.model("Subcategory", subcategorySchema);
