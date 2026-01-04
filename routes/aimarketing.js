/** @format */

const express = require("express");
const router = express.Router();

const {
	campaignById,
	read,
	listForUser,
	create,
	runDueCampaignAudits,
	refreshAnalytics,
	getActiveProductsAndCategories,
} = require("../controllers/aimarketing");

const { requireSignin, isSeller } = require("../controllers/auth");
const { userById } = require("../controllers/user");

// Create new AI campaign
router.post("/ai/campaign/create/:userId", requireSignin, isSeller, create);

// Read single campaign
router.get("/ai/campaign/:campaignId", requireSignin, read);

// List campaigns for a seller (optionally by storeId query)
router.get("/ai/campaigns/:userId", requireSignin, isSeller, listForUser);

// Refresh analytics snapshot
router.get(
	"/ai/campaign/:campaignId/analytics/refresh/:userId",
	requireSignin,
	isSeller,
	refreshAnalytics
);

// NEW: Active products + distinct categories for campaign creation
router.get(
	"/ai/campaign/products-and-categories/:userId",
	requireSignin,
	isSeller,
	getActiveProductsAndCategories
);

// Cron: run due audits
router.get("/ai/campaigns/run-due-audits", runDueCampaignAudits);

// Params
router.param("campaignId", campaignById);
router.param("userId", userById);

module.exports = router;
