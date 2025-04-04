/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const shippingoptionsSchema = new mongoose.Schema(
	{
		carrierName: {
			type: String,
			trim: true,
			required: "Carrier is required",
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
		},
		carrierName_Arabic: {
			type: String,
			trim: true,
			minlength: [2, "Too short"],
			maxlength: [32, "Too long"],
		},
		shippingPrice: {
			type: Number,
			required: "Shipping Price is required",
		},
		shippingPrice_Unit: {
			type: String,
			default: "USD",
		},
		carrierStatus: {
			type: Boolean,
			default: true,
		},

		estimatedDays: {
			type: Number,
		},

		daysShippingClosed: {
			type: Array,
			trim: true,
			default: [],
		},

		cutoffTimes: {
			type: Array,
			trim: true,
			default: ["13:00"],
		},

		store: {
			type: ObjectId,
			ref: "StoreManagement",
			default: "67ef147140130b857c44ba75",
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("ShippingOptions", shippingoptionsSchema);
