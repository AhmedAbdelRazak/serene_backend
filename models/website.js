/** @format */

const mongoose = require("mongoose");

const websiteBasicSetupSchema = new mongoose.Schema(
	{
		sereneJannatLogo: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		homeMainBanners: {
			type: Array,
			trim: true,
			default: [
				{
					public_id: "",
					url: "",
					textOnImage: "",
					buttonOnImage: "",
					backgroundColorButton: "",
					redirectingURLOnClick: "",
				},
			],
		},

		homePageSections: {
			type: Array,
			trim: true,
			default: [
				{
					sectionNumber: "",
					public_id: "",
					url: "",
					textOnImage: "",
					buttonOnImage: "",
					backgroundColorButton: "",
					redirectingURLOnClick: "",
				},
			],
		},

		contactUsPage: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
				paragraph: "",
				phone: "",
				email: "",
			},
		},

		aboutUsBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
				paragraph: "",
			},
		},

		termsAndCondition: {
			type: String,
			trim: true,
		},

		termsAndCondition_B2B: {
			type: String,
			trim: true,
		},

		returnsAndRefund: {
			type: String,
			trim: true,
		},

		aiAgentToRespond: {
			type: Boolean,
			default: false,
		},

		deactivateOrderCreation: {
			type: Boolean,
			default: false,
		},

		deactivateChatResponse: {
			type: Boolean,
			default: false,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("WebsiteBasicSetup", websiteBasicSetupSchema);
