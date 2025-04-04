/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const storeManagement = new mongoose.Schema(
	{
		loyaltyPointsAward: {
			type: Number,
			maxlength: 32,
		},

		discountPercentage: {
			type: Number,
			trim: true,
		},

		storePhone: {
			type: String,
			trim: true,
		},

		storeAddress: {
			type: String,
			trim: true,
		},

		onlineServicesFees: {
			type: Number,
			trim: true,
		},

		transactionFeePercentage: {
			type: Number,
			trim: true,
		},
		purchaseTaxes: {
			type: Number,
			trim: true,
		},
		freeShippingLimit: {
			type: Number,
			trim: true,
		},
		discountOnFirstPurchase: {
			type: Number,
			trim: true,
		},
		storeLogo: {
			type: Object,
			default: {
				public_id: "",
				url: "",
			},
		},

		storeAboutUsBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
				paragraph: "",
			},
		},

		addStoreName: {
			type: String,
			default: "",
		},

		daysStoreClosed: {
			type: Array,
			trim: true,
		},

		activatePayOnDelivery: {
			type: Boolean,
			default: false,
		},

		activatePickupInStore: {
			type: Boolean,
			default: false,
		},

		activatePayOnline: {
			type: Boolean,
			default: true,
		},

		activeStoreByAdmin: {
			type: Boolean,
			default: false,
		},

		activeStoreBySeller: {
			type: Boolean,
			default: true,
		},

		storeMainBrand: {
			type: Boolean,
			default: false,
		},

		belongsTo: {
			type: ObjectId,
			ref: "User",
			default: "663539b4eb1a090ebd349d65",
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("StoreManagement", storeManagement);
