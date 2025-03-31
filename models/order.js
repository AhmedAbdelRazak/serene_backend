/** @format */

const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
	{
		productsNoVariable: Array, // ordered products with no varaibles
		chosenProductQtyWithVariables: Array, // ordered products WITH variables
		exhchangedProductsNoVariable: Array, // Only if an exchange, this array of object is the same as productsNoVariable field with the same elements in the object but it should only add the old product that should be exchanged with
		exchangedProductQtyWithVariables: Array, // Same as chosenProductQtyWithVariables with the same elements and everything but should contain only the old product that was exchanged
		customerDetails: {},
		totalOrderQty: Number, // This should be based on the total ordered_qty in productsNoVariable & chosenProductQtyWithVariables
		status: String,
		onHoldStatus: String,
		totalAmount: Number, // Should be updated during all order updates if necessary
		totalAmountAfterDiscount: Number, // It will be always the same as totalAmount during order update
		orderTakerDiscount: Number,
		employeeData: {},
		totalOrderedQty: Number, //should be the same as totalOrderQty
		chosenShippingOption: {},
		orderSource: String,
		oldProducts: {
			type: Array,
			default: [],
		},
		newProducts: {
			type: Array,
			default: [],
		},
		appliedCoupon: {
			type: Object,
			default: {},
		},
		returnStatus: String,
		shipDate: Date,
		returnDate: Date,
		orderCreationDate: Date,
		trackingNumber: String,
		invoiceNumber: {
			type: String,
			default: "Not Added",
		},
		OTNumber: {
			type: String,
			default: "Not Added",
		},
		sendSMS: Boolean,
		freeShipping: Boolean,
		shippingFees: Number,
		appliedShippingFees: Number,
		totalAmountAfterExchange: Number,

		printifyOrderDetails: {
			type: Object,
			default: {},
		},

		returnedItems: {
			type: Array,
			default: [],
		},
		returnAmount: Number,
		refundMethod: String,
		paymentStatus: String,
		exchangeTrackingNumber: String,
		refundNumber: String,
		reasonForReturn: String,
		orderComment: String,
		updateStatus: String, // Should take a string that explain what updates took place for a given order or
		paymentDetails: {
			type: Object,
			default: {},
		},
		forAI: {},
		privacyPolicyAgreement: {
			type: Boolean,
			default: false,
		},

		orderExpenses: {
			type: Object,
			default: {},
		},
	},
	{ timestamps: true }
);

const Order = mongoose.model("Order", OrderSchema);

module.exports = { Order };
