/** @format */
const mongoose = require("mongoose");

const ActiveCategoriesSchema = new mongoose.Schema(
	{
		categories: [],
		subcategories: [],
		genders: [],
		chosenSeasons: [],
	},
	{ timestamps: true }
);

module.exports = mongoose.model("ActiveCategories", ActiveCategoriesSchema);
