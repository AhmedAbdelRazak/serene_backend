/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const couponSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			trim: true,
			unique: true,
			uppercase: true,
			required: "Nmae is required",
			minlength: [6, "Too short"],
			maxlength: [25, "Too long"],
		},
		expiry: {
			type: Date,
			required: true,
		},
		discount: {
			type: Number,
			requred: true,
		},
		store: { type: ObjectId, ref: "StoreManagement", default: null },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Coupon", couponSchema);
