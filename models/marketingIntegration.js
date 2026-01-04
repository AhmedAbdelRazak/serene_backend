/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Minimal integration model so the AI marketing controller can
 * optionally look up per-account credentials.
 *
 * Right now the controller only *reads* from this model (and only if
 * campaign.integrationAccount is set), so you can start with this and
 * extend later if you want full UI for managing integrations.
 */

const marketingIntegrationSchema = new mongoose.Schema(
	{
		owner: {
			type: ObjectId,
			ref: "User",
			required: true,
		},
		store: {
			type: ObjectId,
			ref: "StoreManagement",
			default: null,
		},

		label: {
			type: String,
			trim: true,
		},

		// ---------- GOOGLE ADS ----------
		googleAds: {
			enabled: { type: Boolean, default: false },
			customerId: { type: String }, // e.g. "123-456-7890"
			loginCustomerId: { type: String }, // MCC / manager id
			refreshToken: { type: String },
			accessToken: { type: String },
			accessTokenExpiresAt: { type: Date },
		},

		// ---------- META (FACEBOOK / INSTAGRAM) ----------
		facebookAds: {
			enabled: { type: Boolean, default: false },
			adAccountId: { type: String }, // e.g. "act_1234567890"
			pageId: { type: String },
			accessToken: { type: String },
			tokenExpiresAt: { type: Date },
		},

		// ---------- GOOGLE ANALYTICS ----------
		googleAnalytics: {
			enabled: { type: Boolean, default: false },
			propertyId: { type: String }, // GA4 property
			measurementId: { type: String },
			apiSecret: { type: String },
		},

		// ---------- RUNWAY ----------
		runwayml: {
			enabled: { type: Boolean, default: false },
			apiKey: { type: String },
		},

		// ---------- JAMENDO ----------
		jamendo: {
			enabled: { type: Boolean, default: false },
			clientId: { type: String },
			clientSecret: { type: String },
		},

		status: {
			type: String,
			enum: ["active", "inactive"],
			default: "active",
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model(
	"MarketingIntegration",
	marketingIntegrationSchema
);
