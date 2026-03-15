/** @format */

const mongoose = require("mongoose");

const webVitalSchema = new mongoose.Schema(
	{
		metric: {
			type: String,
			required: true,
			trim: true,
			uppercase: true,
		},
		reportId: {
			type: String,
			trim: true,
			maxlength: 120,
			default: "",
		},
		path: {
			type: String,
			required: true,
			trim: true,
			maxlength: 320,
			index: true,
		},
		pageGroup: {
			type: String,
			required: true,
			trim: true,
			maxlength: 80,
			index: true,
		},
		href: {
			type: String,
			trim: true,
			maxlength: 500,
			default: "",
		},
		value: {
			type: Number,
			required: true,
		},
		delta: {
			type: Number,
			default: 0,
		},
		rating: {
			type: String,
			trim: true,
			maxlength: 32,
			default: "unknown",
		},
		navigationType: {
			type: String,
			trim: true,
			maxlength: 32,
			default: "",
		},
		effectiveConnectionType: {
			type: String,
			trim: true,
			maxlength: 24,
			default: "",
		},
		deviceMemory: {
			type: Number,
			default: null,
		},
		hardwareConcurrency: {
			type: Number,
			default: null,
		},
		userAgent: {
			type: String,
			trim: true,
			maxlength: 320,
			default: "",
		},
		attribution: {
			type: mongoose.Schema.Types.Mixed,
			default: null,
		},
	},
	{ timestamps: true },
);

webVitalSchema.index({ metric: 1, pageGroup: 1, createdAt: -1 });
webVitalSchema.index({ path: 1, metric: 1, createdAt: -1 });

module.exports = mongoose.model("WebVital", webVitalSchema);
