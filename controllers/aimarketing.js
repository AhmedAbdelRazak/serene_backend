/** @format */

const mongoose = require("mongoose");
const OpenAI = require("openai");
const axios = require("axios");

const AiMarketingCampaign = require("../models/aimarketing");
const Product = require("../models/product");
const User = require("../models/user");

// ========== OpenAI client ==========

const openai = new OpenAI({
	apiKey: process.env.CHATGPT_API_TOKEN,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1";

// ========== RunwayML config ==========

const RUNWAY_API_KEY = process.env.RUNWAYML_API_SECRET;
const RUNWAY_BASE_URL =
	process.env.RUNWAY_BASE_URL || "https://api.dev.runwayml.com";
const RUNWAY_API_VERSION = process.env.RUNWAY_API_VERSION || "2024-11-06";
const RUNWAY_DEFAULT_MODEL = process.env.RUNWAY_MODEL || "gen4_turbo";
const RUNWAY_DEFAULT_RATIO = process.env.RUNWAY_RATIO || "1280:720";
const RUNWAY_DEFAULT_DURATION_SECONDS = Number(
	process.env.RUNWAY_DURATION_SECONDS || 5
);

// ========== Jamendo config ==========

const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID;

// ========== Optional external integrations (loaded dynamically) ==========

/**
 * GA4 Data API (server‑to‑server via service account).
 */
let BetaAnalyticsDataClient = null;
let ga4Client = null;

try {
	const gaData = require("@google-analytics/data");
	BetaAnalyticsDataClient = gaData.BetaAnalyticsDataClient;
	console.log(
		"[AI MARKETING] @google-analytics/data loaded – GA4 integration enabled."
	);
} catch (err) {
	console.warn(
		"[AI MARKETING] @google-analytics/data not installed; GA4 integration disabled. " +
			"Install with: npm install @google-analytics/data"
	);
}

/**
 * Google Ads API
 */
let GoogleAdsApi = null;
let GoogleAdsEnums = null;
let GoogleAdsResources = null;
let GoogleAdsResourceNames = null;
let googleAdsToMicros = null;
let googleAdsClient = null;

try {
	const googleAdsLib = require("google-ads-api");
	GoogleAdsApi = googleAdsLib.GoogleAdsApi;
	GoogleAdsEnums = googleAdsLib.enums;
	GoogleAdsResources = googleAdsLib.resources;
	GoogleAdsResourceNames = googleAdsLib.ResourceNames;
	googleAdsToMicros = googleAdsLib.toMicros;
	console.log(
		"[AI MARKETING] google-ads-api loaded – Google Ads integration enabled."
	);
} catch (err) {
	console.warn(
		"[AI MARKETING] google-ads-api not installed; Google Ads integration disabled. " +
			"Install with: npm install google-ads-api"
	);
}

// ========== Integration configuration from env ==========

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || "449133373";

const GOOGLE_ADS_CONFIG = {
	developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
	clientId: process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
	clientSecret:
		process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
	refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
	customerId: process.env.GOOGLE_ADS_CUSTOMER_ID,
	loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null,
};

function getOpenAIModel() {
	return OPENAI_MODEL;
}

function getGoogleAdsCustomer() {
	if (!GoogleAdsApi) {
		console.log(
			"[AI MARKETING] getGoogleAdsCustomer(): google-ads-api library not available; skipping."
		);
		return null;
	}

	const {
		developerToken,
		clientId,
		clientSecret,
		refreshToken,
		customerId,
		loginCustomerId,
	} = GOOGLE_ADS_CONFIG;

	console.log("[AI MARKETING] getGoogleAdsCustomer(): env snapshot", {
		hasDeveloperToken: !!developerToken,
		hasClientId: !!clientId,
		hasClientSecret: !!clientSecret,
		hasRefreshToken: !!refreshToken,
		customerId,
		loginCustomerId,
	});

	if (
		!developerToken ||
		!clientId ||
		!clientSecret ||
		!refreshToken ||
		!customerId
	) {
		console.warn(
			"[AI MARKETING] getGoogleAdsCustomer(): Google Ads env vars missing; skipping. " +
				"Required: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID " +
				"+ client id/secret (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)."
		);
		return null;
	}

	if (!googleAdsClient) {
		console.log(
			"[AI MARKETING] getGoogleAdsCustomer(): creating GoogleAdsApi client instance."
		);
		googleAdsClient = new GoogleAdsApi({
			client_id: clientId,
			client_secret: clientSecret,
			developer_token: developerToken,
		});
	}

	console.log(
		"[AI MARKETING] getGoogleAdsCustomer(): returning Customer handle."
	);
	return googleAdsClient.Customer({
		customer_id: customerId,
		refresh_token: refreshToken,
		login_customer_id: loginCustomerId || undefined,
	});
}

// ==========================
// Utility helpers
// ==========================

function computeNextAuditAt(campaign, fromDate = new Date()) {
	const minutesFromSchedule =
		campaign.schedule && campaign.schedule.auditFrequencyMinutes;
	const minutesFromAutomation =
		campaign.automationSettings &&
		campaign.automationSettings.auditIntervalHours != null
			? campaign.automationSettings.auditIntervalHours * 60
			: null;

	const minutes = minutesFromSchedule || minutesFromAutomation || 180; // default 3h

	const next = new Date(fromDate.getTime() + minutes * 60 * 1000);
	console.log("[AI MARKETING] computeNextAuditAt ->", {
		from: fromDate,
		minutes,
		next,
	});
	return next;
}

/**
 * Build product summary + return populated products for prompts.
 */
async function buildProductSummary(productIds) {
	console.log(
		"[AI MARKETING] buildProductSummary(): productIds =",
		productIds.map(String)
	);

	const products = await Product.find({
		_id: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) },
	})
		.populate("category", "categoryName categoryName_Arabic")
		.populate("gender", "genderName")
		.lean();

	console.log(
		"[AI MARKETING] buildProductSummary(): fetched products length =",
		products.length
	);

	if (!products.length) {
		throw new Error("No products found for the given productIds");
	}

	let totalPrice = 0;
	let podCount = 0;
	let nonPodCount = 0;
	const categories = new Set();
	const genders = new Set();

	products.forEach((p) => {
		const price = p.priceAfterDiscount || p.price || 0;
		totalPrice += price;

		if (p.isPrintifyProduct) {
			podCount++;
		} else {
			nonPodCount++;
		}

		if (p.category && p.category.categoryName) {
			categories.add(p.category.categoryName);
		}
		if (p.gender && p.gender.genderName) {
			genders.add(p.gender.genderName);
		}
	});

	const avgPrice = totalPrice / products.length;

	const summary = {
		totalProducts: products.length,
		podCount,
		nonPodCount,
		avgPrice,
		avgMarginEstimate: null,
		categories: Array.from(categories),
		genders: Array.from(genders),
	};

	console.log(
		"[AI MARKETING] buildProductSummary(): summary =",
		JSON.stringify(summary, null, 2)
	);

	return { products, summary };
}

/**
 * Ensure we always have at least one Google Ads channel and default targeting = US/EN
 */
function ensureChannelDefaults(campaignData) {
	console.log(
		"[AI MARKETING] ensureChannelDefaults(): before =",
		JSON.stringify(
			{
				channelsCount: Array.isArray(campaignData.channels)
					? campaignData.channels.length
					: 0,
			},
			null,
			2
		)
	);

	const budgetInterval = campaignData.budgetInterval;

	if (!Array.isArray(campaignData.channels) || !campaignData.channels.length) {
		console.log(
			"[AI MARKETING] ensureChannelDefaults(): no channels provided – creating default Google Ads channel."
		);
		campaignData.channels = [
			{
				platform: "google_ads",
				enabled: true,
				objective: "sales",
				optimizationGoal: "roas",
				budget: budgetInterval,
				geoLocations: ["US"],
				excludedGeoLocations: [],
				languages: ["en"],
				audienceDescription:
					"Default ecommerce shoppers, broad but skewed to people interested in home decor & shopping.",
				placements: ["search"],
				devices: ["mobile", "desktop"],
				status: "not_created",
				metadata: {
					currentDailyBudget: budgetInterval.min,
				},
				externalIds: {},
			},
		];
	} else {
		campaignData.channels = campaignData.channels.map((channel) => {
			const ch = { ...channel };

			if (!ch.platform) ch.platform = "google_ads";
			if (ch.enabled === undefined) ch.enabled = true;
			if (!Array.isArray(ch.geoLocations) || ch.geoLocations.length === 0) {
				ch.geoLocations = ["US"];
			}
			if (!Array.isArray(ch.languages) || ch.languages.length === 0) {
				ch.languages = ["en"];
			}
			if (!ch.budget || ch.budget.min == null || ch.budget.max == null) {
				ch.budget = budgetInterval;
			}
			if (!Array.isArray(ch.devices) || ch.devices.length === 0) {
				ch.devices = ["mobile", "desktop"];
			}
			if (!Array.isArray(ch.placements) || ch.placements.length === 0) {
				ch.placements = ["search"];
			}
			if (!ch.metadata) ch.metadata = {};
			if (ch.metadata.currentDailyBudget == null) {
				ch.metadata.currentDailyBudget = ch.budget.min || budgetInterval.min;
			}
			if (!ch.externalIds) ch.externalIds = {};
			if (!ch.status) ch.status = "not_created";
			if (!ch.objective) ch.objective = "sales";

			return ch;
		});
	}

	console.log(
		"[AI MARKETING] ensureChannelDefaults(): after =",
		JSON.stringify(campaignData.channels, null, 2)
	);
}

/**
 * Ensure we always have a goal stack stored under campaign.meta.goals
 */
function ensureDefaultGoals(campaign) {
	if (!campaign.meta) campaign.meta = {};

	if (!Array.isArray(campaign.meta.goals) || campaign.meta.goals.length === 0) {
		const startingBudget = campaign.budgetInterval
			? campaign.budgetInterval.min
			: 0;

		campaign.meta.goals = [
			{
				id: "data_collection",
				name: "Collect initial data",
				status: "active",
				order: 1,
				target: {
					minImpressions: 1000,
					minSpend: Math.max(startingBudget * 2, 10),
				},
				progress: {},
			},
			{
				id: "first_conversion",
				name: "Get first key conversion",
				status: "pending",
				order: 2,
				target: {
					minConversions: 1,
				},
				progress: {},
			},
			{
				id: "hit_target_performance",
				name: "Hit performance targets (ROAS / CPA)",
				status: "pending",
				order: 3,
				target: {
					minConversions: 5,
					minRoas:
						(campaign.optimizationRules &&
							campaign.optimizationRules.targetRoas) ||
						2,
				},
				progress: {},
			},
			{
				id: "scale",
				name: "Scale budget while maintaining performance",
				status: "pending",
				order: 4,
				target: {
					minDaysStable: 3,
				},
				progress: {},
			},
		];

		console.log(
			"[AI MARKETING] ensureDefaultGoals(): initialized default goals stack."
		);
	}

	console.log(
		"[AI MARKETING] ensureDefaultGoals(): goals =",
		JSON.stringify(campaign.meta.goals, null, 2)
	);

	return campaign.meta.goals;
}

/**
 * Evaluate current goal progress and advance if ready.
 */
function evaluateGoalsAndProgress(goals, analytics, now = new Date()) {
	if (!goals || !goals.length) {
		return { activeGoal: null, updatedGoals: goals, goalChanged: false };
	}

	const updated = goals.map((g) => ({ ...g }));
	let goalChanged = false;

	const getActiveGoalIndex = () =>
		updated.findIndex((g) => g.status === "active");
	let idx = getActiveGoalIndex();
	if (idx === -1) {
		idx = updated.findIndex((g) => g.status === "pending");
		if (idx !== -1) {
			updated[idx].status = "active";
		}
	}

	if (idx === -1) {
		return { activeGoal: null, updatedGoals: updated, goalChanged: false };
	}

	const activeGoal = updated[idx];
	const spend = analytics.cost || 0;
	const impressions = analytics.impressions || 0;
	const conversions =
		analytics.purchases || analytics.conversions || analytics.sessions || 0;
	const roas = analytics.roas || 0;

	let completed = false;

	switch (activeGoal.id) {
		case "data_collection": {
			const { minImpressions = 1000, minSpend = 10 } = activeGoal.target || {};
			if (impressions >= minImpressions || spend >= minSpend) {
				completed = true;
			}
			activeGoal.progress = { impressions, spend };
			break;
		}
		case "first_conversion": {
			const { minConversions = 1 } = activeGoal.target || {};
			if (conversions >= minConversions) {
				completed = true;
			}
			activeGoal.progress = { conversions };
			break;
		}
		case "hit_target_performance": {
			const { minConversions = 5, minRoas = 2 } = activeGoal.target || {};
			if (conversions >= minConversions && roas >= minRoas) {
				completed = true;
			}
			activeGoal.progress = { conversions, roas };
			break;
		}
		case "scale": {
			activeGoal.progress = { conversions, roas };
			break;
		}
		default:
			break;
	}

	if (completed && activeGoal.id !== "scale") {
		updated[idx].status = "completed";
		updated[idx].completedAt = now;
		goalChanged = true;

		const nextIdx = updated.findIndex((g) => g.status === "pending");
		if (nextIdx !== -1) {
			updated[nextIdx].status = "active";
		}
	}

	return {
		activeGoal: updated.find((g) => g.status === "active") || null,
		updatedGoals: updated,
		goalChanged,
	};
}

/**
 * Safely calculate a new daily budget.
 */
function calculateNewDailyBudget(current, campaign) {
	if (!campaign.budgetInterval) return current;

	const { min, max } = campaign.budgetInterval;
	const rules = campaign.optimizationRules || {};
	const maxIncreasePercent =
		rules.maxDailyBudgetIncreasePercent != null
			? rules.maxDailyBudgetIncreasePercent
			: 30;

	let allowedUpper = max;

	if (current <= 5) {
		allowedUpper = Math.min(max, 10);
	} else if (current <= 10) {
		allowedUpper = Math.min(max, 20);
	} else if (current > 10 && current < 20) {
		allowedUpper = Math.min(max, 20);
	} else {
		allowedUpper = current;
	}

	const candidate = current * (1 + maxIncreasePercent / 100);
	let newBudget = Math.min(candidate, allowedUpper);

	if (newBudget < min) newBudget = min;
	if (newBudget <= current) return current;

	return newBudget;
}

/**
 * Rule-based performance evaluation (non-AI).
 */
function evaluatePerformance(campaign, analytics, activeGoal) {
	const rules = campaign.optimizationRules || {};
	const result = {
		shouldIncreaseBudget: false,
		shouldDecreaseBudget: false,
		shouldCancel: false,
		reason: [],
	};

	const spend = analytics.cost || 0;
	const impressions = analytics.impressions || 0;
	const conversions =
		analytics.purchases || analytics.conversions || analytics.sessions || 0;
	const revenue = analytics.revenue || 0;
	const roas = revenue && spend ? revenue / spend : 0;

	const now = new Date();
	const start = campaign.schedule ? campaign.schedule.startDate : null;
	const hoursRunning =
		start instanceof Date ? (now - start) / (1000 * 60 * 60) : 0;

	const minSpend =
		rules.minSpendBeforeEvaluation != null
			? rules.minSpendBeforeEvaluation
			: 10;
	const minImpressions = 500;

	if (spend < minSpend || impressions < minImpressions) {
		result.reason.push(
			`Not enough data yet (spend ${spend.toFixed(
				2
			)}, impressions ${impressions}). Staying in learning.`
		);
		return result;
	}

	const lowPerfHours =
		rules.lowPerformanceWindowHours != null
			? rules.lowPerformanceWindowHours
			: 72;

	if (
		rules.autoStopOnLowPerformance !== false &&
		hoursRunning >= lowPerfHours &&
		conversions === 0
	) {
		result.shouldCancel = true;
		result.reason.push(
			`No conversions after ${hoursRunning.toFixed(
				1
			)}h and spend ${spend.toFixed(
				2
			)}. Marked for cancellation (low performance).`
		);
		return result;
	}

	if (rules.targetRoas && roas) {
		if (roas >= rules.targetRoas * 1.2 && conversions >= 3) {
			result.shouldIncreaseBudget = true;
			result.reason.push(
				`ROAS ${roas.toFixed(2)} is significantly above target ${
					rules.targetRoas
				}. Eligible for scaling.`
			);
		} else if (roas < rules.targetRoas * 0.5 && conversions < 2) {
			result.shouldDecreaseBudget = true;
			result.reason.push(
				`ROAS ${roas.toFixed(2)} is far below target ${
					rules.targetRoas
				}. Considering budget decrease.`
			);
		}
	}

	if (rules.maxCpa && conversions > 0) {
		const cpa = spend / conversions;
		if (cpa > rules.maxCpa * 1.5) {
			result.shouldDecreaseBudget = true;
			result.reason.push(
				`CPA ${cpa.toFixed(2)} is way above max CPA ${rules.maxCpa}.`
			);
		}
	}

	if (
		activeGoal &&
		["data_collection", "first_conversion"].includes(activeGoal.id)
	) {
		if (result.shouldIncreaseBudget) {
			result.reason.push(
				"Goal is still early-stage; will not aggressively increase budget yet."
			);
			result.shouldIncreaseBudget = false;
		}
		if (result.shouldDecreaseBudget) {
			result.reason.push(
				"Goal is still early-stage; mild underperformance will not reduce budget yet."
			);
			result.shouldDecreaseBudget = false;
		}
	}

	return result;
}

// ==========================
// GA4 + Analytics helpers
// ==========================

async function fetchGA4Analytics() {
	console.log("[AI MARKETING] fetchGA4Analytics(): invoked.");

	if (!BetaAnalyticsDataClient || !GA4_PROPERTY_ID) {
		console.log(
			"[AI MARKETING] fetchGA4Analytics(): GA4 client or property id missing; skipping."
		);
		return null;
	}

	if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
		console.log(
			"[AI MARKETING] fetchGA4Analytics(): GOOGLE_APPLICATION_CREDENTIALS not set – skipping GA4 Analytics."
		);
		return null;
	}

	try {
		if (!ga4Client) {
			ga4Client = new BetaAnalyticsDataClient();
			console.log(
				"[AI MARKETING] fetchGA4Analytics(): GA4 client initialized."
			);
		}

		console.log(
			"[AI MARKETING] fetchGA4Analytics(): running GA4 report for property",
			GA4_PROPERTY_ID
		);

		const [response] = await ga4Client.runReport({
			property: `properties/${GA4_PROPERTY_ID}`,
			dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
			metrics: [
				{ name: "sessions" },
				{ name: "totalUsers" },
				{ name: "eventCount" },
				{ name: "conversions" },
				{ name: "purchaseRevenue" },
				{ name: "ecommercePurchases" },
			],
		});

		console.log(
			"[AI MARKETING] fetchGA4Analytics(): GA4 rows count =",
			response.rows ? response.rows.length : 0
		);

		if (!response.rows || !response.rows.length) {
			return null;
		}

		const row = response.rows[0];
		const metricValue = (idx) =>
			row.metricValues[idx] ? Number(row.metricValues[idx].value || 0) : 0;

		const sessions = metricValue(0);
		const totalUsers = metricValue(1);
		const eventCount = metricValue(2);
		const conversions = metricValue(3);
		const revenue = metricValue(4);
		const purchases = metricValue(5);

		const analytics = {
			source: "ga4",
			sessions,
			totalUsers,
			eventCount,
			conversions,
			purchases: purchases || conversions,
			revenue,
		};

		console.log(
			"[AI MARKETING] fetchGA4Analytics(): summary =",
			JSON.stringify(analytics, null, 2)
		);

		return analytics;
	} catch (err) {
		console.error(
			"[AI MARKETING] fetchGA4Analytics(): error from GA4 Data API:",
			err.message
		);
		return null;
	}
}

/**
 * Pull Google Ads metrics for the external campaign ids attached to this AI campaign.
 */
async function fetchGoogleAdsMetricsForCampaign(campaign) {
	console.log(
		"[AI MARKETING] fetchGoogleAdsMetricsForCampaign(): invoked for campaign",
		String(campaign._id || "")
	);

	const customer = getGoogleAdsCustomer();
	if (!customer) {
		console.log(
			"[AI MARKETING] fetchGoogleAdsMetricsForCampaign(): Google Ads not configured; skipping."
		);
		return null;
	}

	const googleChannels = (campaign.channels || []).filter(
		(ch) =>
			ch.platform === "google_ads" &&
			ch.enabled !== false &&
			ch.externalIds &&
			ch.externalIds.campaignId
	);

	if (!googleChannels.length) {
		console.log(
			"[AI MARKETING] fetchGoogleAdsMetricsForCampaign(): no external Google Ads campaign IDs; skipping."
		);
		return null;
	}

	const campaignIds = googleChannels
		.map((ch) => Number(ch.externalIds.campaignId))
		.filter((id) => !Number.isNaN(id));

	if (!campaignIds.length) {
		console.log(
			"[AI MARKETING] fetchGoogleAdsMetricsForCampaign(): campaignIds list empty after parsing; skipping."
		);
		return null;
	}

	try {
		const rows = await customer.report({
			entity: "campaign",
			attributes: ["campaign.id", "campaign.name"],
			metrics: [
				"metrics.impressions",
				"metrics.clicks",
				"metrics.cost_micros",
				"metrics.conversions",
				"metrics.conversions_value",
			],
			constraints: {
				"campaign.id": campaignIds,
			},
		});

		let impressions = 0;
		let clicks = 0;
		let costMicros = 0;
		let conversions = 0;
		let convValue = 0;

		for (const row of rows || []) {
			impressions += Number(row.metrics.impressions || 0);
			clicks += Number(row.metrics.clicks || 0);
			costMicros += Number(row.metrics.cost_micros || 0);
			conversions += Number(row.metrics.conversions || 0);
			convValue += Number(row.metrics.conversions_value || 0);
		}

		const cost = costMicros / 1e6;
		const analytics = {
			source: "google_ads",
			impressions,
			clicks,
			cost,
			conversions,
			revenue: convValue,
			roas: cost > 0 ? convValue / cost : 0,
			campaignIds,
		};

		console.log(
			"[AI MARKETING] fetchGoogleAdsMetricsForCampaign(): summary =",
			JSON.stringify(analytics, null, 2)
		);

		return analytics;
	} catch (err) {
		console.error(
			"[AI MARKETING] fetchGoogleAdsMetricsForCampaign(): error:",
			err.message
		);
		return null;
	}
}

/**
 * Fetch analytics for campaign (GA4 + Google Ads if available).
 */
async function fetchAnalyticsForCampaign(campaign) {
	console.log(
		"[AI MARKETING] fetchAnalyticsForCampaign(): start for campaign",
		String(campaign._id || "")
	);

	try {
		const [ga4, googleAds] = await Promise.all([
			fetchGA4Analytics(),
			fetchGoogleAdsMetricsForCampaign(campaign),
		]);

		const impressions = googleAds ? googleAds.impressions : 0;
		const clicks = googleAds ? googleAds.clicks : 0;
		const cost = googleAds ? googleAds.cost : 0;
		const gaRevenue = ga4 ? ga4.revenue || 0 : 0;
		const adsRevenue = googleAds ? googleAds.revenue || 0 : 0;
		const revenue = Math.max(gaRevenue, adsRevenue);
		const sessions = ga4 ? ga4.sessions || 0 : 0;
		const purchasesGa = ga4 ? ga4.purchases || ga4.conversions || 0 : 0;
		const conversionsAds = googleAds ? googleAds.conversions || 0 : 0;
		const purchases = Math.max(purchasesGa, conversionsAds);

		const ctr = impressions > 0 ? clicks / impressions : 0;
		const conversionRate = sessions > 0 ? purchases / sessions : 0;
		const roas = cost > 0 ? revenue / cost : 0;

		const merged = {
			source: "combined",
			periodStart: campaign.schedule?.startDate || new Date(),
			periodEnd: new Date(),
			impressions,
			clicks,
			sessions,
			purchases,
			revenue,
			cost,
			roas,
			ctr,
			conversionRate,
			byPlatform: {
				ga4,
				googleAds,
			},
		};

		console.log(
			"[AI MARKETING] fetchAnalyticsForCampaign(): merged analytics =",
			JSON.stringify(
				{
					impressions: merged.impressions,
					clicks: merged.clicks,
					sessions: merged.sessions,
					purchases: merged.purchases,
					revenue: merged.revenue,
					cost: merged.cost,
					roas: merged.roas,
					ctr: merged.ctr,
					conversionRate: merged.conversionRate,
				},
				null,
				2
			)
		);

		return merged;
	} catch (err) {
		console.error("[AI MARKETING] fetchAnalyticsForCampaign(): error", err);
		return (
			campaign.lastAnalyticsSnapshot || {
				source: "internal_error_fallback",
				periodStart: campaign.schedule?.startDate || new Date(),
				periodEnd: new Date(),
				impressions: 0,
				clicks: 0,
				sessions: 0,
				purchases: 0,
				revenue: 0,
				cost: 0,
				roas: 0,
				ctr: 0,
				conversionRate: 0,
			}
		);
	}
}

// ==========================
// AI / external services helpers
// ==========================

/**
 * Use OpenAI to generate hooks / angles / copy for the campaign.
 */
async function generateInitialCreativesForCampaign(
	campaign,
	products,
	analytics
) {
	try {
		console.log(
			"[AI MARKETING] generateInitialCreativesForCampaign(): calling OpenAI..."
		);

		const model = getOpenAIModel();

		const productLines = products
			.slice(0, 10)
			.map((p) => {
				const price = p.priceAfterDiscount || p.price || "";
				return `- ${p.productName} (${price} ${p.price_unit || ""})`;
			})
			.join("\n");

		const podNote = campaign.isPODCampaign
			? "Some of these products are print-on-demand. Emphasize uniqueness, customization, and limited availability. Avoid promising instant shipping if it conflicts with POD production times."
			: "";

		const language =
			(campaign.creativeStrategy &&
				(campaign.creativeStrategy.language ||
					(campaign.creativeStrategy.languages &&
						campaign.creativeStrategy.languages[0]))) ||
			"en";

		const tone =
			(campaign.creativeStrategy && campaign.creativeStrategy.tone) ||
			(campaign.creativeStrategy && campaign.creativeStrategy.toneOfVoice) ||
			"default";

		const brandVoice =
			(campaign.creativeStrategy && campaign.creativeStrategy.brandVoice) ||
			"Modern, trustworthy ecommerce brand.";

		const primaryCta =
			(campaign.creativeStrategy &&
				campaign.creativeStrategy.primaryCallToAction) ||
			"Shop now";

		console.log(
			"[AI MARKETING] generateInitialCreativesForCampaign(): OpenAI model + language/tone",
			{ model, language, tone }
		);

		const performanceHint = analytics
			? `We currently have ${analytics.impressions} impressions, ${analytics.clicks} clicks, and ROAS of ${analytics.roas}. Focus on click-through and purchase intent.`
			: "";

		const messages = [
			{
				role: "system",
				content:
					"You are a world-class performance marketer and copywriter. You write high-converting ad copy for Google Ads. Respond ONLY with valid JSON.",
			},
			{
				role: "user",
				content: `
We are creating a multi-variant campaign for an ecommerce store.

Brand voice: ${brandVoice}
Tone: ${tone}
Primary call-to-action: ${primaryCta}
Default market: United States (EN).
${performanceHint}

Products:
${productLines}

${podNote}

Please return JSON with the following shape:
{
  "angles": ["... up to 4 angles ..."],
  "hooks": ["... up to 6 strong hooks ..."],
  "primary_texts": ["... up to 6 primary ad texts (max ~150 chars each) ..."],
  "headlines": ["... up to 10 headlines (max ~30 chars each) ..."],
  "descriptions": ["... up to 6 descriptions (max ~90 chars each) ..."]
}
Do NOT include any other top-level keys.
`,
			},
		];

		const completion = await openai.chat.completions.create({
			model,
			response_format: { type: "json_object" },
			messages,
			temperature: 0.7,
		});

		const content = completion.choices[0].message.content || "{}";

		console.log(
			"[AI MARKETING] generateInitialCreativesForCampaign(): raw OpenAI JSON string length =",
			content.length
		);

		let data;
		try {
			data = JSON.parse(content);
		} catch (err) {
			console.error(
				"[AI MARKETING] generateInitialCreativesForCampaign(): error parsing OpenAI JSON:",
				err
			);
			return campaign;
		}

		if (!campaign.creativeStrategy) {
			campaign.creativeStrategy = {};
		}
		if (!campaign.creativeStrategy.hooks) campaign.creativeStrategy.hooks = [];
		if (!campaign.creativeStrategy.angles)
			campaign.creativeStrategy.angles = [];

		if (Array.isArray(data.hooks)) {
			campaign.creativeStrategy.hooks = data.hooks;
		}
		if (Array.isArray(data.angles)) {
			campaign.creativeStrategy.angles = data.angles;
		}

		if (!campaign.copy) {
			campaign.copy = {
				primaryTexts: [],
				headlines: [],
				descriptions: [],
				callToActions: ["SHOP_NOW"],
			};
		} else {
			if (!Array.isArray(campaign.copy.primaryTexts)) {
				campaign.copy.primaryTexts = [];
			}
			if (!Array.isArray(campaign.copy.headlines)) {
				campaign.copy.headlines = [];
			}
			if (!Array.isArray(campaign.copy.descriptions)) {
				campaign.copy.descriptions = [];
			}
			if (!Array.isArray(campaign.copy.callToActions)) {
				campaign.copy.callToActions = ["SHOP_NOW"];
			}
		}

		const pushCopyVariants = (targetArray, texts, type) => {
			if (!Array.isArray(texts)) return;
			texts.forEach((text) => {
				if (!text || typeof text !== "string") return;
				targetArray.push({
					platform: "universal",
					text,
					language,
					tone: tone === "default" ? "neutral" : tone,
					generatedBy: "ai",
					performanceLabel: "unknown",
					type,
				});
			});
		};

		pushCopyVariants(
			campaign.copy.primaryTexts,
			data.primary_texts || [],
			"primary_text"
		);
		pushCopyVariants(campaign.copy.headlines, data.headlines || [], "headline");
		pushCopyVariants(
			campaign.copy.descriptions,
			data.descriptions || [],
			"description"
		);

		if (
			!campaign.copy.callToActions ||
			campaign.copy.callToActions.length === 0
		) {
			campaign.copy.callToActions = ["SHOP_NOW"];
		}

		campaign.creativeAssets = campaign.creativeAssets || [];

		const addAsset = (text, assetType) => {
			if (!text || typeof text !== "string") return;
			campaign.creativeAssets.push({
				type: assetType,
				source: "openai_text",
				text,
				language,
				status: "ready",
			});
		};

		(data.primary_texts || []).forEach((t) => addAsset(t, "primary_text"));
		(data.headlines || []).forEach((t) => addAsset(t, "headline"));
		(data.descriptions || []).forEach((t) => addAsset(t, "description"));

		console.log(
			"[AI MARKETING] generateInitialCreativesForCampaign(): created",
			{
				primaryTexts: campaign.copy.primaryTexts.length,
				headlines: campaign.copy.headlines.length,
				descriptions: campaign.copy.descriptions.length,
				creativeAssets: campaign.creativeAssets.length,
			}
		);

		return campaign;
	} catch (err) {
		console.error(
			"[AI MARKETING] generateInitialCreativesForCampaign(): error:",
			err
		);
		return campaign;
	}
}

// ==========================
// Runway helpers & video generation
// ==========================

function resolveProductThumbnailUrl(product) {
	try {
		const thumbArr = product.thumbnailImage;
		if (!Array.isArray(thumbArr) || !thumbArr.length) {
			console.log(
				"[AI MARKETING] resolveProductThumbnailUrl(): no thumbnailImage array for product",
				String(product._id || product.id || product)
			);
			return null;
		}

		const first = thumbArr[0];
		console.log(
			"[AI MARKETING] resolveProductThumbnailUrl(): raw thumbnailImage[0] =",
			JSON.stringify(first, null, 2)
		);

		let candidate = null;

		if (Array.isArray(first.images) && first.images.length > 0) {
			const img0 = first.images[0];
			candidate = img0.cloudinary_url || img0.url || null;
		} else if (first.cloudinary_url || first.url) {
			candidate = first.cloudinary_url || first.url;
		} else if (typeof first === "string") {
			candidate = first;
		}

		if (!candidate) {
			console.warn(
				"[AI MARKETING] resolveProductThumbnailUrl(): could not resolve candidate URL for product",
				String(product._id || product.id || product)
			);
			return null;
		}

		console.log(
			"[AI MARKETING] resolveProductThumbnailUrl(): resolved candidate imageUrl =",
			candidate
		);

		if (!/^https:\/\//i.test(candidate)) {
			console.warn(
				"[AI MARKETING] resolveProductThumbnailUrl(): candidate URL is not HTTPS; Runway requires HTTPS. URL =",
				candidate
			);
			return null;
		}

		return candidate;
	} catch (err) {
		console.error(
			"[AI MARKETING] resolveProductThumbnailUrl(): error while resolving thumbnail",
			err
		);
		return null;
	}
}

async function pollRunwayTask(taskId, label = "image_to_video") {
	const url = `${RUNWAY_BASE_URL}/v1/tasks/${taskId}`;
	console.log("[AI MARKETING] pollRunwayTask(): start", { taskId, url, label });

	const MAX_POLLS = 60;
	const DELAY_MS = 2000;

	for (let i = 1; i <= MAX_POLLS; i++) {
		await new Promise((r) => setTimeout(r, DELAY_MS));
		const { data } = await axios.get(url, {
			headers: {
				Authorization: `Bearer ${RUNWAY_API_KEY}`,
				"X-Runway-Version": RUNWAY_API_VERSION,
			},
		});

		const status = data.status;
		console.log(
			"[AI MARKETING] pollRunwayTask(): poll attempt",
			i,
			"status =",
			status
		);

		if (status === "SUCCEEDED") {
			const outputUrl =
				Array.isArray(data.output) && data.output.length
					? data.output[0]
					: null;
			console.log(
				"[AI MARKETING] pollRunwayTask(): SUCCEEDED with outputUrl =",
				outputUrl
			);
			return { status: "SUCCEEDED", outputUrl, raw: data };
		}
		if (status === "FAILED") {
			console.warn(
				"[AI MARKETING] pollRunwayTask(): FAILED task for label",
				label,
				"data =",
				JSON.stringify(data, null, 2)
			);
			return { status: "FAILED", outputUrl: null, raw: data };
		}
	}

	console.warn(
		"[AI MARKETING] pollRunwayTask(): TIMEOUT after",
		MAX_POLLS,
		"attempts for task",
		taskId
	);
	return { status: "TIMEOUT", outputUrl: null, raw: null };
}

/**
 * Create high‑quality, product-aware video(s) + images for the campaign via Runway.
 */
async function ensureRunwayVideosForCampaign(campaign, products, actions) {
	console.log(
		"[AI MARKETING] ensureRunwayVideosForCampaign(): start for campaign",
		String(campaign._id || "")
	);

	if (!RUNWAY_API_KEY) {
		console.log(
			"[AI MARKETING] ensureRunwayVideosForCampaign(): RUNWAYML_API_SECRET not set – skipping video generation."
		);
		return campaign;
	}

	console.log(
		"[AI MARKETING] ensureRunwayVideosForCampaign(): config snapshot",
		JSON.stringify(
			{
				hasApiKey: !!RUNWAY_API_KEY,
				apiKeyPreview: RUNWAY_API_KEY
					? `key_${RUNWAY_API_KEY.slice(0, 3)}...${RUNWAY_API_KEY.slice(
							-4
					  )} (len=${RUNWAY_API_KEY.length})`
					: null,
				baseUrl: RUNWAY_BASE_URL,
				endpoint: `${RUNWAY_BASE_URL}/v1/image_to_video`,
				apiVersion: RUNWAY_API_VERSION,
				model: RUNWAY_DEFAULT_MODEL,
				ratio: RUNWAY_DEFAULT_RATIO,
				durationSeconds: RUNWAY_DEFAULT_DURATION_SECONDS,
			},
			null,
			2
		)
	);

	const productsToGenerate =
		products && products.length ? products : campaign.products || [];

	console.log(
		"[AI MARKETING] ensureRunwayVideosForCampaign(): products to generate for =",
		productsToGenerate.map((p) => ({
			id: String(p._id || p.id || p),
			name: p.productName || p.name,
		}))
	);

	if (!Array.isArray(campaign.creativeAssets)) {
		campaign.creativeAssets = [];
	}
	if (!Array.isArray(campaign.videos)) {
		campaign.videos = [];
	}
	if (!Array.isArray(campaign.images)) {
		campaign.images = [];
	}

	for (const product of productsToGenerate) {
		const productId = String(product._id || product.id || product);
		const productName = product.productName || product.name || "Product";

		console.log(
			"[AI MARKETING] ensureRunwayVideosForCampaign(): processing product",
			{ id: productId, name: productName }
		);

		const imageUrl = resolveProductThumbnailUrl(product);
		if (!imageUrl) {
			console.warn(
				"[AI MARKETING] ensureRunwayVideosForCampaign(): no HTTPS thumbnail for product – skipping Runway.",
				productId
			);
			continue;
		}

		try {
			const thumbArr = product.thumbnailImage || [];
			const first = thumbArr[0];
			if (Array.isArray(first?.images)) {
				first.images.forEach((img) => {
					const u = img.cloudinary_url || img.url;
					if (!u) return;
					if (!campaign.images.some((i) => i.url === u)) {
						campaign.images.push({
							product: product._id || productId,
							url: u,
							altText: productName,
							aspectRatio: "",
							source: "product_image",
							generatedBy: "system",
							tags: [],
						});
					}
				});
			} else if (imageUrl) {
				if (!campaign.images.some((i) => i.url === imageUrl)) {
					campaign.images.push({
						product: product._id || productId,
						url: imageUrl,
						altText: productName,
						aspectRatio: "",
						source: "product_image",
						generatedBy: "system",
						tags: [],
					});
				}
			}
			console.log(
				"[AI MARKETING] ensureRunwayVideosForCampaign(): top-level images[] length now =",
				campaign.images.length
			);
		} catch (imgErr) {
			console.warn(
				"[AI MARKETING] ensureRunwayVideosForCampaign(): error while enriching images for product",
				productId,
				imgErr
			);
		}

		const categoryName =
			(product.category && product.category.categoryName) || "";
		const lowerName = productName.toLowerCase();
		const lowerCat = categoryName.toLowerCase();

		let scenePrompt = "";

		if (
			/outdoor|garden|birdhouse|yard|patio|balcony/.test(lowerName + lowerCat)
		) {
			scenePrompt =
				"Beautiful outdoor garden setting at golden hour, birds fluttering around, gentle camera dolly around the product.";
		} else if (/candle|lantern|lamp|light/i.test(lowerName + lowerCat)) {
			scenePrompt =
				"Cozy indoor table scene at dusk, warm candlelight, slow close-up as a hand lights the candle and the ambient light glows.";
		} else if (/mug|cup|coffee|tea/i.test(lowerName + lowerCat)) {
			scenePrompt =
				"Modern kitchen countertop, shallow depth of field, steam rising from the mug, hand reaches in to pick it up.";
		} else if (/bowl|vase|decor|home decor/i.test(lowerName + lowerCat)) {
			scenePrompt =
				"Elegant living room shelf styling, soft daylight, slow parallax movement around the decor piece.";
		} else {
			scenePrompt =
				"Premium lifestyle scene that fits the product, cinematic lighting and smooth camera motion showcasing the item.";
		}

		const promptText =
			`High-converting short video ad for ${productName}. ` +
			scenePrompt +
			" Focus clearly on the real-world product, 16:9 framing, cinematic, detailed, natural motion, no text overlays.";

		const payload = {
			model: RUNWAY_DEFAULT_MODEL,
			promptImage: imageUrl,
			promptText,
			ratio: RUNWAY_DEFAULT_RATIO,
			duration: RUNWAY_DEFAULT_DURATION_SECONDS,
		};

		const headers = {
			Authorization: `Bearer ${RUNWAY_API_KEY}`,
			"Content-Type": "application/json",
			"X-Runway-Version": RUNWAY_API_VERSION,
		};

		console.log(
			"[AI MARKETING] ensureRunwayVideosForCampaign(): sending Runway request",
			{
				endpoint: `${RUNWAY_BASE_URL}/v1/image_to_video`,
				payload,
				headers: {
					Authorization: `Bearer key_...(${RUNWAY_API_KEY.length})`,
					"Content-Type": headers["Content-Type"],
					"X-Runway-Version": headers["X-Runway-Version"],
				},
			}
		);

		let taskId = null;
		let outputUrl = null;
		let taskStatus = "UNKNOWN";
		let rawTask = null;

		try {
			const { data, status, statusText } = await axios.post(
				`${RUNWAY_BASE_URL}/v1/image_to_video`,
				payload,
				{ headers }
			);

			console.log(
				"[AI MARKETING] ensureRunwayVideosForCampaign(): Runway response summary",
				{
					status,
					statusText,
					dataKeys: Object.keys(data || {}),
					data,
				}
			);

			taskId = data.id;
			if (taskId) {
				const pollResult = await pollRunwayTask(taskId, "image_to_video");
				taskStatus = pollResult.status;
				outputUrl = pollResult.outputUrl;
				rawTask = pollResult.raw;
			}
		} catch (err) {
			console.error(
				"[AI MARKETING] ensureRunwayVideosForCampaign(): Runway error for product",
				productId,
				err.response ? err.response.data || err.response.status : err.message
			);
		}

		const creativeAsset = {
			type: "video",
			source: "runway_video",
			product: product._id || productId,
			url: outputUrl || null,
			thumbnailUrl: imageUrl,
			durationSeconds: RUNWAY_DEFAULT_DURATION_SECONDS,
			meta: {
				runwayTaskId: taskId,
				runwayStatus: taskStatus,
				runwayModel: RUNWAY_DEFAULT_MODEL,
				runwayRatio: RUNWAY_DEFAULT_RATIO,
				baseUrl: RUNWAY_BASE_URL,
				apiVersion: RUNWAY_API_VERSION,
				rawTask: rawTask || (taskId ? { id: taskId } : null),
			},
			status: outputUrl ? "ready" : "pending_generation",
		};

		campaign.creativeAssets.push(creativeAsset);

		if (outputUrl) {
			campaign.videos.push({
				product: product._id || productId,
				url: outputUrl,
				thumbnailUrl: imageUrl,
				durationSeconds: RUNWAY_DEFAULT_DURATION_SECONDS,
				aspectRatio: "",
				source: "runwayml",
				status: "pending",
				errorMessage: "",
			});
		}

		console.log(
			"[AI MARKETING] ensureRunwayVideosForCampaign(): asset added to campaign.creativeAssets",
			creativeAsset
		);
		console.log(
			"[AI MARKETING] ensureRunwayVideosForCampaign(): top-level videos[] length now =",
			campaign.videos.length
		);
	}

	console.log(
		"[AI MARKETING] ensureRunwayVideosForCampaign(): done. creativeAssets length =",
		campaign.creativeAssets.length,
		" videos length =",
		campaign.videos.length
	);

	if (actions) {
		actions.push({
			kind: "runway_generation",
			description: "Generated or attempted video creatives via Runway.",
			details: {
				creativeAssetsCount: campaign.creativeAssets.length,
				videosCount: campaign.videos.length,
				imagesCount: campaign.images.length,
			},
			success: true,
		});
	}

	return campaign;
}

/**
 * Jamendo music selection.
 */
async function ensureJamendoTrackForCampaign(campaign, actions) {
	console.log(
		"[AI MARKETING] ensureJamendoTrackForCampaign(): start for campaign",
		String(campaign._id || "")
	);

	const safeActions = Array.isArray(actions) ? actions : [];

	if (!JAMENDO_CLIENT_ID) {
		console.log(
			"[AI MARKETING] ensureJamendoTrackForCampaign(): JAMENDO_CLIENT_ID not set – skipping."
		);
		return campaign;
	}

	if (
		campaign.musicTracks &&
		campaign.musicTracks.some((a) => a.type === "music")
	) {
		console.log(
			"[AI MARKETING] ensureJamendoTrackForCampaign(): music asset already present – skipping."
		);
		return campaign;
	}

	try {
		console.log(
			"[AI MARKETING] ensureJamendoTrackForCampaign(): calling Jamendo API..."
		);

		const resp = await axios.get("https://api.jamendo.com/v3.0/tracks", {
			params: {
				client_id: JAMENDO_CLIENT_ID,
				format: "json",
				limit: 1,
				order: "popularity_total",
				tags: "instrumental,background",
				include: "musicinfo",
			},
		});

		const track =
			resp.data &&
			resp.data.results &&
			resp.data.results.length &&
			resp.data.results[0];

		if (!track) {
			console.log(
				"[AI MARKETING] ensureJamendoTrackForCampaign(): no track returned."
			);
			return campaign;
		}

		const asset = {
			type: "music",
			source: "jamendo_music",
			url: track.audio,
			meta: {
				jamendoTrackId: track.id,
				name: track.name,
				artistName: track.artist_name,
				downloadUrl: track.audiodownload,
				license: track.license_ccurl,
			},
			status: "ready",
		};

		campaign.creativeAssets = campaign.creativeAssets || [];
		campaign.creativeAssets.push(asset);

		campaign.musicTracks = campaign.musicTracks || [];
		campaign.musicTracks.push({
			url: track.audio,
			source: "jamendo",
			status: "ready",
			meta: {
				jamendoTrackId: track.id,
				name: track.name,
				artistName: track.artist_name,
			},
		});

		safeActions.push({
			kind: "create_creative",
			platform: "jamendo",
			description: `Attached Jamendo track "${track.name}" as background music.`,
			details: { jamendoTrackId: track.id },
			success: true,
		});

		console.log(
			"[AI MARKETING] ensureJamendoTrackForCampaign(): track attached:",
			track.name
		);

		return campaign;
	} catch (err) {
		console.error(
			"[AI MARKETING] ensureJamendoTrackForCampaign(): error fetching track:",
			err.message
		);
		safeActions.push({
			kind: "create_creative",
			platform: "jamendo",
			description: "Failed to fetch Jamendo music track.",
			details: { error: err.message },
			success: false,
		});
		return campaign;
	}
}

/**
 * Ask OpenAI to look at analytics + campaign config and propose an action.
 */
async function askOpenAIForOptimization(campaign, analytics) {
	try {
		const model = getOpenAIModel();

		const smallCampaignView = {
			id: String(campaign._id),
			name: campaign.name,
			objective: campaign.objective || "sales",
			budget: campaign.budget,
			schedule: campaign.schedule,
			targetAudience: campaign.targetAudience || {},
			isPODCampaign: !!campaign.isPODCampaign,
			platforms: campaign.platforms || {},
		};

		const messages = [
			{
				role: "system",
				content:
					"You are a senior performance marketing strategist. You must output STRICT JSON (no comments) with a recommended action for the campaign.",
			},
			{
				role: "user",
				content: `
We have a campaign with the following config:

${JSON.stringify(smallCampaignView, null, 2)}

And the following recent analytics snapshot (GA4 + Google Ads):

${JSON.stringify(
	{
		impressions: analytics.impressions,
		clicks: analytics.clicks,
		ctr: analytics.ctr,
		sessions: analytics.sessions,
		conversions: analytics.purchases || analytics.conversions || 0,
		revenue: analytics.revenue,
		cost: analytics.cost,
		roas: analytics.roas,
		conversionRate: analytics.conversionRate,
	},
	null,
	2
)}

Your job:
1. Decide ONE main action: 
   - "none" (keep learning / leave as is)
   - "increase_budget"
   - "decrease_budget"
   - "pause_campaign"
   - "cancel_campaign"
2. If there is clearly not enough data (very low impressions/sessions and 0 conversions),
   you MUST choose "none" and rely on best-practice suggestions instead of cutting budgets.
3. Suggest new dailyMin/dailyMax budget if you choose increase/decrease.
4. Suggest 1-3 changes for creatives and 1-3 changes for audience/targeting.

Return ONLY valid JSON with this shape:
{
  "action": "none" | "increase_budget" | "decrease_budget" | "pause_campaign" | "cancel_campaign",
  "reason": "short explanation",
  "budgetRecommendation": {
    "dailyMin": number | null,
    "dailyMax": number | null
  },
  "creativeSuggestions": ["..."],
  "audienceSuggestions": ["..."],
  "notes": "any extra detailed explanation for the audit log"
}
`,
			},
		];

		console.log("[AI MARKETING] askOpenAIForOptimization(): calling OpenAI...");

		const completion = await openai.chat.completions.create({
			model,
			response_format: { type: "json_object" },
			messages,
			temperature: 0.3,
		});

		const content = completion.choices[0].message.content;
		let decision;
		try {
			decision = JSON.parse(content);
		} catch (err) {
			console.error(
				"[AI MARKETING] askOpenAIForOptimization(): JSON parse error:",
				err
			);
			return null;
		}

		console.log(
			"[AI MARKETING] askOpenAIForOptimization(): decision =",
			decision
		);

		return decision;
	} catch (err) {
		console.error(
			"[AI MARKETING] askOpenAIForOptimization(): OpenAI error:",
			err
		);
		return null;
	}
}

// ==========================
// Google Ads platform sync
// ==========================

/**
 * Ensure there is a corresponding Google Ads campaign for this AI campaign.
 *
 * Returns { createdAny: boolean, lastError: Error | null }
 */
async function ensurePlatformCampaignsExist(
	campaign,
	actions = [],
	channelConfigsOverride = null
) {
	console.log(
		"[AI MARKETING] ensurePlatformCampaignsExist(): invoked for campaign",
		String(campaign._id || "")
	);

	const customer = getGoogleAdsCustomer();
	let createdAny = false;
	let lastError = null;

	if (!customer) {
		console.log(
			"[AI MARKETING] ensurePlatformCampaignsExist(): Google Ads not configured; skipping."
		);
		if (actions) {
			actions.push({
				kind: "google_ads_skipped",
				platform: "google_ads",
				description:
					"Google Ads configuration missing; could not create external campaign.",
				success: false,
				details: { reason: "missing_google_ads_env" },
			});
		}
		return {
			createdAny: false,
			lastError: new Error("missing_google_ads_env"),
		};
	}

	// Prefer explicit override if provided; otherwise use campaign.channels.
	let baseChannels =
		Array.isArray(channelConfigsOverride) && channelConfigsOverride.length
			? channelConfigsOverride
			: Array.isArray(campaign.channels) && campaign.channels.length
			? campaign.channels
			: [];

	// If still empty, inject a default Google Ads channel using current budget.
	if (!baseChannels.length) {
		console.log(
			"[AI MARKETING] ensurePlatformCampaignsExist(): no channels passed; injecting default Google Ads channel from campaign budget."
		);

		const tmpConfig = {
			budgetInterval: campaign.budgetInterval || {
				min:
					campaign.budget && campaign.budget.dailyMin != null
						? campaign.budget.dailyMin
						: 5,
				max:
					campaign.budget && campaign.budget.dailyMax != null
						? campaign.budget.dailyMax
						: 10,
				currency: campaign.currency || "USD",
				type: "daily",
			},
			channels: campaign.channels || [],
		};

		ensureChannelDefaults(tmpConfig);
		baseChannels = tmpConfig.channels;
		campaign.channels = tmpConfig.channels;

		console.log(
			"[AI MARKETING] ensurePlatformCampaignsExist(): created default channels =",
			JSON.stringify(baseChannels, null, 2)
		);
	}

	console.log(
		"[AI MARKETING] ensurePlatformCampaignsExist(): raw channelConfigs length =",
		Array.isArray(baseChannels) ? baseChannels.length : 0
	);

	const channels = (baseChannels || []).filter(
		(ch) =>
			ch &&
			ch.platform === "google_ads" &&
			ch.enabled !== false &&
			!(ch.externalIds && ch.externalIds.campaignId)
	);

	console.log(
		"[AI MARKETING] ensurePlatformCampaignsExist(): eligible google_ads channels =",
		JSON.stringify(channels, null, 2)
	);

	if (!channels.length) {
		console.log(
			"[AI MARKETING] ensurePlatformCampaignsExist(): no eligible google_ads channels to create."
		);

		campaign.platforms = campaign.platforms || {};
		campaign.platforms.googleAds = campaign.platforms.googleAds || {
			enabled: true,
			adGroupIds: [],
			status: "not_created",
		};

		return {
			createdAny: false,
			lastError: new Error("no_eligible_channels"),
		};
	}

	for (const channel of channels) {
		const channelBudget = channel.budget || {};
		const dailyBudget =
			channelBudget.min ||
			(campaign.budget && campaign.budget.dailyMin) ||
			(campaign.budgetInterval && campaign.budgetInterval.min) ||
			5;

		const currency =
			campaign.currency ||
			(campaign.budget && campaign.budget.currency) ||
			"USD";

		const finalUrl = process.env.STORE_BASE_URL || "https://serenejannat.com";

		console.log(
			"[AI MARKETING] ensurePlatformCampaignsExist(): building Google Ads campaign with",
			{
				dailyBudget,
				currency,
				finalUrl,
				channelObjective: channel.objective,
				geoLocations: channel.geoLocations,
				languages: channel.languages,
			}
		);

		try {
			// 1) Budget (pass array to avoid entities.map error in google-ads-api)
			const budgetResource = new GoogleAdsResources.CampaignBudget({
				name: `${
					campaign.name || "AI Campaign"
				} – Daily ${dailyBudget} ${currency}`,
				amount_micros: googleAdsToMicros(dailyBudget),
				delivery_method: GoogleAdsEnums.BudgetDeliveryMethod.STANDARD,
			});

			const budgetResult = await customer.campaignBudgets.create([
				budgetResource,
			]);
			const budgetResourceName =
				budgetResult.results && budgetResult.results[0]
					? budgetResult.results[0].resource_name
					: null;

			console.log(
				"[AI MARKETING] ensurePlatformCampaignsExist(): budget created",
				{
					dailyBudget,
					currency,
					budgetResourceName,
				}
			);

			// 2) Campaign
			const campaignResource = new GoogleAdsResources.Campaign({
				name:
					campaign.name ||
					`AI Campaign ${new Date().toISOString().slice(0, 10)}`,
				status: GoogleAdsEnums.CampaignStatus.PAUSED,
				advertising_channel_type: GoogleAdsEnums.AdvertisingChannelType.SEARCH,
				campaign_budget: budgetResourceName,
				manual_cpc: { enhanced_cpc_enabled: true },
				network_settings: {
					target_google_search: true,
					target_search_network: true,
					target_partner_search_network: false,
					target_content_network: false,
				},
				targeting_setting: {
					target_restrictions: [
						{
							targeting_dimension: GoogleAdsEnums.TargetingDimension.AUDIENCE,
							bid_only: false,
						},
					],
				},
			});

			if (campaign.schedule) {
				if (campaign.schedule.startDate) {
					const d = new Date(campaign.schedule.startDate);
					const y = d.getUTCFullYear();
					const m = String(d.getUTCMonth() + 1).padStart(2, "0");
					const day = String(d.getUTCDate()).padStart(2, "0");
					campaignResource.start_date = `${y}-${m}-${day}`;
				}
				if (campaign.schedule.endDate) {
					const d = new Date(campaign.schedule.endDate);
					const y = d.getUTCFullYear();
					const m = String(d.getUTCMonth() + 1).padStart(2, "0");
					const day = String(d.getUTCDate()).padStart(2, "0");
					campaignResource.end_date = `${y}-${m}-${day}`;
				}
			}

			const campaignResult = await customer.campaigns.create([
				campaignResource,
			]);
			const campaignCreated =
				campaignResult.results && campaignResult.results[0]
					? campaignResult.results[0]
					: null;
			const campaignResourceName = campaignCreated
				? campaignCreated.resource_name
				: null;
			const googleAdsCampaignId = campaignResourceName
				? campaignResourceName.split("/").pop()
				: null;

			console.log(
				"[AI MARKETING] ensurePlatformCampaignsExist(): campaign created",
				{
					campaignResourceName,
					googleAdsCampaignId,
				}
			);

			// 3) Ad group
			const adGroupResource = new GoogleAdsResources.AdGroup({
				name: `${campaign.name || "AI Ad Group"} – Main`,
				status: GoogleAdsEnums.AdGroupStatus.ENABLED,
				campaign: campaignResourceName,
				type: GoogleAdsEnums.AdGroupType.SEARCH_STANDARD,
				cpc_bid_micros: googleAdsToMicros(
					Math.max(0.5, Math.min(2.0, dailyBudget / 5))
				),
			});

			const adGroupResult = await customer.adGroups.create([adGroupResource]);
			const adGroupCreated =
				adGroupResult.results && adGroupResult.results[0]
					? adGroupResult.results[0]
					: null;
			const adGroupResourceName = adGroupCreated
				? adGroupCreated.resource_name
				: null;
			const googleAdsAdGroupId = adGroupResourceName
				? adGroupResourceName.split("/").pop()
				: null;

			console.log(
				"[AI MARKETING] ensurePlatformCampaignsExist(): ad group created",
				{
					adGroupResourceName,
					googleAdsAdGroupId,
				}
			);

			// 4) Responsive Search Ad — use more assets (up to 15 headlines / 4 descriptions)
			const headlines =
				(campaign.copy &&
					Array.isArray(campaign.copy.headlines) &&
					campaign.copy.headlines.filter((h) => h && h.text).slice(0, 15)) ||
				[];

			const descriptions =
				(campaign.copy &&
					Array.isArray(campaign.copy.descriptions) &&
					campaign.copy.descriptions.filter((d) => d && d.text).slice(0, 4)) ||
				[];

			console.log(
				"[AI MARKETING] ensurePlatformCampaignsExist(): using copy for RSA",
				{
					headlines: headlines.map((h) => h.text),
					descriptions: descriptions.map((d) => d.text),
				}
			);

			const rsAd = new GoogleAdsResources.Ad({
				responsive_search_ad: {
					headlines:
						headlines.length > 0
							? headlines.map((h) => ({
									text: h.text,
							  }))
							: [{ text: campaign.name || "New Collection" }],
					descriptions:
						descriptions.length > 0
							? descriptions.map((d) => ({
									text: d.text,
							  }))
							: [
									{
										text: "Discover unique pieces curated just for you.",
									},
							  ],
				},
				final_urls: [finalUrl],
			});

			const adGroupAdResource = new GoogleAdsResources.AdGroupAd({
				status: GoogleAdsEnums.AdGroupAdStatus.PAUSED,
				ad_group: adGroupResourceName,
				ad: rsAd,
			});

			const adGroupAdResult = await customer.adGroupAds.create([
				adGroupAdResource,
			]);

			console.log("[AI MARKETING] ensurePlatformCampaignsExist(): ad created", {
				adGroupAdResult,
			});

			createdAny = true;

			channel.externalIds = channel.externalIds || {};
			channel.externalIds.campaignId = googleAdsCampaignId;
			channel.externalIds.campaignResourceName = campaignResourceName;
			channel.externalIds.budgetResourceName = budgetResourceName;
			channel.externalIds.adGroupResourceName = adGroupResourceName;
			channel.status = "active";

			campaign.platforms = campaign.platforms || {};
			campaign.platforms.googleAds = campaign.platforms.googleAds || {
				enabled: true,
				adGroupIds: [],
				status: "not_created",
			};

			const pg = campaign.platforms.googleAds;

			pg.enabled = true;
			pg.status = "active";
			if (!Array.isArray(pg.adGroupIds)) pg.adGroupIds = [];
			if (googleAdsAdGroupId && !pg.adGroupIds.includes(googleAdsAdGroupId)) {
				pg.adGroupIds.push(googleAdsAdGroupId);
			}
			pg.campaignId = googleAdsCampaignId;
			pg.campaignResourceName = campaignResourceName;
			pg.budgetResourceName = budgetResourceName;
			pg.adGroupResourceName = adGroupResourceName;

			console.log(
				"[AI MARKETING] ensurePlatformCampaignsExist(): updated platforms.googleAds =",
				JSON.stringify(pg, null, 2)
			);

			if (actions) {
				actions.push({
					kind: "create_campaign",
					platform: "google_ads",
					description: "Created Google Ads Search campaign with RSA.",
					success: true,
					details: {
						campaignId: googleAdsCampaignId,
						campaignResourceName,
						budgetResourceName,
						adGroupResourceName,
						adGroupId: googleAdsAdGroupId,
						dailyBudget,
						currency,
						finalUrl,
					},
				});
			}
		} catch (err) {
			console.error(
				"[AI MARKETING] ensurePlatformCampaignsExist(): error creating Google Ads campaign:",
				err.message || err
			);
			lastError = err;

			if (actions) {
				actions.push({
					kind: "create_campaign",
					platform: "google_ads",
					description:
						"Failed to create Google Ads campaign via API. See logs for details.",
					success: false,
					details: {
						error: err.message || String(err),
					},
				});
			}
		}
	}

	console.log(
		"[AI MARKETING] ensurePlatformCampaignsExist(): finished; platforms.googleAds snapshot =",
		JSON.stringify(campaign.platforms && campaign.platforms.googleAds, null, 2)
	);

	return { createdAny, lastError };
}

/**
 * Update Google Ads budgets when AI agent decides to change them.
 */
async function updatePlatformBudgets(campaign, channelBudgetUpdates, actions) {
	if (!channelBudgetUpdates.length) return;

	const customer = getGoogleAdsCustomer();
	if (!customer) {
		console.log(
			"[AI MARKETING] updatePlatformBudgets(): Google Ads not configured; skipping."
		);
		return;
	}

	for (const update of channelBudgetUpdates) {
		const { channel, previousBudget, newBudget } = update;

		if (channel.platform !== "google_ads") continue;

		const budgetResourceName =
			channel.externalIds && channel.externalIds.budgetResourceName;
		if (!budgetResourceName) {
			console.log(
				"[AI MARKETING] updatePlatformBudgets(): no budgetResourceName stored; skipping Google Ads call."
			);
		} else {
			try {
				await customer.mutateResources([
					{
						entity: "campaign_budget",
						operation: "update",
						resource: {
							resource_name: budgetResourceName,
							amount_micros: googleAdsToMicros(newBudget),
						},
						update_mask: ["amount_micros"],
					},
				]);
			} catch (err) {
				console.error(
					"[AI MARKETING] updatePlatformBudgets(): error updating Google Ads budget:",
					err.message
				);
			}
		}

		actions.push({
			kind: "update_budget",
			platform: channel.platform,
			description: `Updated daily budget from ${previousBudget} to ${newBudget} (local + Google Ads best-effort).`,
			details: {
				previousBudget,
				newBudget,
				campaignId: channel.externalIds && channel.externalIds.campaignId,
			},
			success: true,
		});

		channel.metadata = channel.metadata || {};
		channel.metadata.currentDailyBudget = newBudget;
	}
}

/**
 * Pause/cancel Google Ads campaigns when AI agent decides to.
 */
async function pauseOrCancelPlatformCampaigns(campaign, reason, actions) {
	const customer = getGoogleAdsCustomer();
	if (!customer) {
		console.log(
			"[AI MARKETING] pauseOrCancelPlatformCampaigns(): Google Ads not configured; skipping."
		);
		return;
	}

	for (const channel of campaign.channels || []) {
		if (!channel.enabled || channel.platform !== "google_ads") continue;

		const campaignResourceName =
			channel.externalIds && channel.externalIds.campaignResourceName;
		if (!campaignResourceName) continue;

		try {
			await customer.mutateResources([
				{
					entity: "campaign",
					operation: "update",
					resource: {
						resource_name: campaignResourceName,
						status: GoogleAdsEnums.CampaignStatus.PAUSED,
					},
					update_mask: ["status"],
				},
			]);

			channel.status = "paused";

			actions.push({
				kind: "cancel_campaign",
				platform: channel.platform,
				description: `Paused campaign on Google Ads (${reason}) (local + Google Ads best-effort).`,
				details: {
					campaignId: channel.externalIds && channel.externalIds.campaignId,
				},
				success: true,
			});
		} catch (err) {
			console.error(
				"[AI MARKETING] pauseOrCancelPlatformCampaigns(): error pausing Google Ads campaign:",
				err.message
			);

			actions.push({
				kind: "cancel_campaign",
				platform: channel.platform,
				description:
					"Failed to pause campaign on Google Ads (local status changed anyway).",
				details: {
					campaignId: channel.externalIds && channel.externalIds.campaignId,
					error: err.message,
				},
				success: false,
			});
		}
	}
}

// ==========================
// Core AUDIT logic
// ==========================

async function runAuditForCampaign(campaign, options = {}) {
	const { runType = "scheduled", triggeredBy = null } = options;

	const actions = [];
	const errors = [];

	const startedAt = new Date();

	console.log(
		"[AI MARKETING] runAuditForCampaign(): start",
		String(campaign._id),
		"runType=",
		runType
	);

	const analyticsBefore =
		(campaign.analytics && campaign.analytics.summary) || null;

	let analyticsNow;
	try {
		analyticsNow = await fetchAnalyticsForCampaign(campaign);
	} catch (err) {
		console.error("Error fetching analytics:", err);
		analyticsNow = analyticsBefore || {
			source: "internal",
			periodStart: campaign.schedule.startDate,
			periodEnd: new Date(),
		};
		errors.push(`Analytics fetch error: ${err.message}`);
	}

	const goals = ensureDefaultGoals(campaign);
	const goalsEval = evaluateGoalsAndProgress(goals, analyticsNow, startedAt);
	campaign.meta.goals = goalsEval.updatedGoals;

	const perfDecision = evaluatePerformance(
		campaign,
		analyticsNow,
		goalsEval.activeGoal
	);

	let aiDecision = null;
	try {
		aiDecision = await askOpenAIForOptimization(campaign, analyticsNow);
	} catch (err) {
		console.error(
			"[AI MARKETING] runAuditForCampaign(): error calling OpenAI optimization:",
			err
		);
		errors.push(`OpenAI optimization error: ${err.message}`);
	}

	let overallAction = "none";

	if (perfDecision.shouldCancel) {
		overallAction = "cancel_campaign";
	} else if (perfDecision.shouldIncreaseBudget) {
		overallAction = "increase_budget";
	} else if (perfDecision.shouldDecreaseBudget) {
		overallAction = "decrease_budget";
	}

	if (aiDecision && aiDecision.action && aiDecision.action !== "none") {
		overallAction = aiDecision.action;
	}

	const channelBudgetUpdates = [];

	if (
		overallAction === "increase_budget" ||
		overallAction === "decrease_budget"
	) {
		for (const channel of campaign.channels || []) {
			if (!channel.enabled) continue;

			const currentBudget =
				(channel.metadata && channel.metadata.currentDailyBudget) ||
				(channel.budget && channel.budget.min) ||
				(campaign.budgetInterval && campaign.budgetInterval.min) ||
				(campaign.budget && campaign.budget.dailyMin) ||
				0;

			let newBudget = currentBudget;

			if (overallAction === "increase_budget") {
				const ruleBased = calculateNewDailyBudget(currentBudget, campaign);
				const aiSuggestedMin =
					aiDecision &&
					aiDecision.budgetRecommendation &&
					aiDecision.budgetRecommendation.dailyMin != null
						? aiDecision.budgetRecommendation.dailyMin
						: null;
				const aiSuggestedMax =
					aiDecision &&
					aiDecision.budgetRecommendation &&
					aiDecision.budgetRecommendation.dailyMax != null
						? aiDecision.budgetRecommendation.dailyMax
						: null;

				if (aiSuggestedMin != null && aiSuggestedMax != null) {
					newBudget = Math.min(
						Math.max(ruleBased, aiSuggestedMin),
						aiSuggestedMax
					);
				} else {
					newBudget = ruleBased;
				}
			} else if (overallAction === "decrease_budget") {
				const rules = campaign.optimizationRules || {};
				const decreasePercent =
					rules.maxDailyBudgetDecreasePercent != null
						? rules.maxDailyBudgetDecreasePercent
						: 30;
				const candidate = currentBudget * (1 - decreasePercent / 100);
				const minBudget =
					(campaign.budgetInterval && campaign.budgetInterval.min) ||
					(campaign.budget && campaign.budget.dailyMin) ||
					currentBudget;
				newBudget = Math.max(candidate, minBudget);
			}

			if (newBudget !== currentBudget) {
				channelBudgetUpdates.push({
					channel,
					previousBudget: currentBudget,
					newBudget,
				});
			}
		}

		if (channelBudgetUpdates.length) {
			await updatePlatformBudgets(campaign, channelBudgetUpdates, actions);

			if (!campaign.budget) campaign.budget = {};
			const lastUpdate = channelBudgetUpdates[channelBudgetUpdates.length - 1];
			campaign.budget.currentDaily = lastUpdate.newBudget;
		}
	}

	if (
		overallAction === "pause_campaign" ||
		overallAction === "cancel_campaign"
	) {
		await pauseOrCancelPlatformCampaigns(
			campaign,
			"Lack of performance based on rules/AI decision",
			actions
		);

		if (!campaign.lifecycle) campaign.lifecycle = {};
		if (overallAction === "cancel_campaign") {
			campaign.lifecycle.status = "cancelled_by_ai";
		} else {
			campaign.lifecycle.status = "paused";
		}

		if (campaign.automationSettings) {
			campaign.automationSettings.enabled = false;
		}
	}

	const finishedAt = new Date();

	campaign.analytics = campaign.analytics || {};
	campaign.analytics.summary = analyticsNow;
	if (!campaign.analytics.byPlatform) {
		campaign.analytics.byPlatform = {};
	}
	if (analyticsNow.byPlatform) {
		campaign.analytics.byPlatform = {
			...campaign.analytics.byPlatform,
			...analyticsNow.byPlatform,
		};
	}

	if (!campaign.schedule) campaign.schedule = {};
	campaign.schedule.lastAuditAt = finishedAt;
	campaign.schedule.nextAuditAt = computeNextAuditAt(campaign, finishedAt);

	const summaryParts = [];

	if (goalsEval.goalChanged) summaryParts.push("Goal progressed.");
	if (overallAction === "increase_budget")
		summaryParts.push("Budget increased on at least one channel.");
	if (overallAction === "decrease_budget")
		summaryParts.push("Budget decreased on at least one channel.");
	if (overallAction === "pause_campaign")
		summaryParts.push("Campaign paused based on AI decision.");
	if (overallAction === "cancel_campaign")
		summaryParts.push("Campaign cancelled by AI due to low performance.");
	if (!summaryParts.length) {
		summaryParts.push("Audit completed with no major changes.");
	}

	const metricsSnapshot = {
		impressions: analyticsNow.impressions || 0,
		clicks: analyticsNow.clicks || 0,
		ctr: analyticsNow.ctr || 0,
		cost: analyticsNow.cost || 0,
		cpc: analyticsNow.cpc || 0,
		conversions: analyticsNow.purchases || analyticsNow.conversions || 0,
		conversionRate: analyticsNow.conversionRate || 0,
		revenue: analyticsNow.revenue || 0,
		roas: analyticsNow.roas || 0,
		addToCarts: analyticsNow.addToCarts || 0,
		purchases: analyticsNow.purchases || 0,
	};

	const logEntry = {
		timestamp: finishedAt,
		triggeredBy:
			triggeredBy || (runType === "scheduled" ? "cron" : "user_or_ai"),
		eventType:
			runType === "scheduled"
				? "scheduled_audit"
				: runType === "manual"
				? "manual_audit"
				: "initial_setup_audit",
		summary: summaryParts.join(" "),
		metricsSnapshot,
		platformMetrics: analyticsNow.byPlatform || {},
		decision: {
			action: overallAction,
			reason: [
				...(perfDecision.reason || []),
				aiDecision && aiDecision.reason ? aiDecision.reason : "",
			]
				.filter(Boolean)
				.join(" "),
			rulesDecision: perfDecision,
			aiDecision: aiDecision || null,
		},
		changes: {
			budgetUpdates: channelBudgetUpdates.map((u) => ({
				platform: u.channel.platform,
				previous: u.previousBudget,
				next: u.newBudget,
			})),
			status: campaign.lifecycle ? campaign.lifecycle.status : undefined,
			notes:
				(aiDecision && aiDecision.notes) ||
				"Audit performed using GA4 + Google Ads metrics + rule-based logic + OpenAI.",
		},
		pausedAdIds: [],
		createdAdIds: [],
		error: errors.length ? errors.join("; ") : null,
	};

	campaign.auditLogs = campaign.auditLogs || [];
	campaign.auditLogs.push(logEntry);

	await campaign.save();

	console.log(
		"[AI MARKETING] runAuditForCampaign(): finished with action =",
		overallAction
	);

	return { campaign, auditLogEntry: logEntry };
}

// ==========================
// EXPRESS CONTROLLERS
// ==========================

/**
 * Param middleware: :campaignId
 */
exports.campaignById = async (req, res, next, id) => {
	try {
		const campaign = await AiMarketingCampaign.findById(id)
			.populate("createdBy", "_id name email")
			.populate("store")
			.populate("products")
			.exec();

		if (!campaign) {
			return res.status(404).json({ error: "Campaign not found" });
		}

		req.campaign = campaign;
		next();
	} catch (err) {
		console.error("campaignById error:", err);
		return res.status(400).json({ error: "Invalid campaign ID" });
	}
};

/**
 * GET /ai/campaign/:campaignId
 */
exports.read = (req, res) => {
	return res.json(req.campaign);
};

/**
 * GET /ai/campaigns/:userId?storeId=...
 * List campaigns for a user (and optionally a store)
 */
exports.listForUser = async (req, res) => {
	const userId = req.params.userId;
	const { storeId } = req.query;

	const query = {
		createdBy: userId,
	};
	if (storeId && mongoose.Types.ObjectId.isValid(storeId)) {
		query.store = storeId;
	}

	try {
		const campaigns = await AiMarketingCampaign.find(query)
			.sort({ createdAt: -1 })
			.exec();

		res.json(campaigns);
	} catch (err) {
		console.error("Error listing campaigns:", err);
		res.status(500).json({ error: "Error listing campaigns" });
	}
};

/**
 * POST /ai/campaign/create/:userId
 *
 * Flow:
 *   1) Build campaignData, set defaults.
 *   2) Generate media (Runway, images).
 *   3) Generate copy (OpenAI).
 *   4) Optional Jamendo music.
 *   5) Try to create Google Ads campaign.
 *   6) Only if Google Ads succeeds -> save MongoDB campaign.
 */
exports.create = async (req, res) => {
	try {
		const owner = req.profile || req.user || null;
		if (!owner) {
			console.error(
				"[AI MARKETING] create(): no user attached to request (req.profile/req.user missing)"
			);
			return res.status(401).json({ error: "User not attached to request" });
		}

		console.log("[AI MARKETING] create(): start. userId =", String(owner._id));

		const {
			name,
			description,
			productIds,
			budgetInterval,
			schedule,
			channels,
			creativeStrategy,
			optimizationRules,
			storeId,
		} = req.body;

		console.log(
			"[AI MARKETING] create(): payload summary",
			JSON.stringify(
				{
					name,
					productIdsCount: Array.isArray(productIds) ? productIds.length : 0,
					budgetInterval,
					storeId,
				},
				null,
				2
			)
		);

		if (!Array.isArray(productIds) || productIds.length === 0) {
			console.warn(
				"[AI MARKETING] create(): productIds missing or empty – abort."
			);
			return res
				.status(400)
				.json({ error: "productIds array is required and cannot be empty" });
		}

		const { products, summary } = await buildProductSummary(productIds);
		console.log(
			"[AI MARKETING] create(): buildProductSummary returned products=",
			products.length,
			" summary=",
			summary
		);

		const minBudget =
			budgetInterval && budgetInterval.min != null
				? Number(budgetInterval.min)
				: 5;
		const maxBudget =
			budgetInterval && budgetInterval.max != null
				? Number(budgetInterval.max)
				: 10;
		const budgetCurrency = (budgetInterval && budgetInterval.currency) || "USD";
		const budgetType = (budgetInterval && budgetInterval.type) || "daily";

		console.log("[AI MARKETING] create(): normalized budget", {
			minBudget,
			maxBudget,
			budgetCurrency,
			budgetType,
		});

		const campaignData = {
			name:
				name ||
				`AI Campaign ${new Date().toISOString().slice(0, 10)} (${
					summary.totalProducts
				} products)`,
			description: description || "",

			createdBy: owner._id,
			store: storeId || (products[0] && products[0].store),
			products: productIds,
			isPODCampaign: summary.podCount > 0,

			objective: "sales",
			currency: budgetCurrency,

			budget: {
				dailyMin: minBudget,
				dailyMax: maxBudget,
				currentDaily: minBudget,
				lifetimeCap: 0,
				biddingStrategy: "auto",
				pacing: "standard",
			},

			budgetInterval: {
				min: minBudget,
				max: maxBudget,
				currency: budgetCurrency,
				type: budgetType,
			},

			schedule: {
				startDate: (schedule && schedule.startDate) || new Date(),
				endDate:
					(schedule && schedule.endDate) ||
					new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
				timeZone:
					(schedule && (schedule.timeZone || schedule.timezone)) ||
					"America/New_York",
				endBehaviour: (schedule && schedule.endBehaviour) || "pause",
				auditFrequencyMinutes:
					(schedule && schedule.auditFrequencyMinutes) || 180,
			},

			targetAudience: {
				ageRange: { min: 18, max: 65 },
				remarketing: {
					websiteVisitors: false,
					productViewers: false,
					cartAbandoners: false,
					pastPurchasers: false,
				},
				languages: [],
				genders: [],
				interests: [],
				behaviors: [],
				keywords: [],
				locations: [],
			},

			creativeStrategy: {
				language: (creativeStrategy && creativeStrategy.language) || "en",
				toneOfVoice:
					(creativeStrategy && creativeStrategy.toneOfVoice) || "friendly",
				useProductImages:
					creativeStrategy && creativeStrategy.useProductImages !== undefined
						? creativeStrategy.useProductImages
						: true,
				useLifestyleMockups:
					creativeStrategy && creativeStrategy.useLifestyleMockups !== undefined
						? creativeStrategy.useLifestyleMockups
						: true,
				variantsPerPlatform:
					(creativeStrategy && creativeStrategy.variantsPerPlatform) || 3,
				preferVideoForPOD:
					creativeStrategy && creativeStrategy.preferVideoForPOD !== undefined
						? creativeStrategy.preferVideoForPOD
						: summary.podCount > 0,
				brandVoice:
					creativeStrategy && creativeStrategy.brandVoice
						? creativeStrategy.brandVoice
						: "Modern, trustworthy ecommerce brand.",
				languages: (creativeStrategy && creativeStrategy.languages) || ["en"],
				tone: (creativeStrategy && creativeStrategy.tone) || "friendly",
				primaryCallToAction:
					(creativeStrategy && creativeStrategy.primaryCallToAction) ||
					"Shop now",
				secondaryCallToAction:
					creativeStrategy && creativeStrategy.secondaryCallToAction,
				hooks: [],
				angles: [],
			},

			objectiveRules: optimizationRules || {},
			optimizationRules: optimizationRules || {},

			analytics: {
				summary: null,
				byPlatform: {},
			},

			integrationConfig: {
				openai: {
					model: OPENAI_MODEL,
					useEnvToken: true,
				},
				googleAds: { useEnvCredentials: true },
				googleAnalytics: {},
				runwayml: { useEnvToken: true },
				jamendo: { useEnvCredentials: true },
			},

			automationSettings: {
				enabled: true,
				auditIntervalHours: 3,
				minImpressionsBeforeOptimize: 500,
				minClicksBeforeOptimize: 20,
				learningPhaseHours: 24,
				allowCampaignRecreation: true,
				maxRecreationCount: 3,
				minHoursBetweenRecreations: 24,
			},

			lifecycle: {
				status: "draft",
				totalRecreationCount: 0,
			},

			copy: {
				primaryTexts: [],
				headlines: [],
				descriptions: [],
				callToActions: ["SHOP_NOW"],
			},

			platforms: {
				googleAds: {
					enabled: true,
					adGroupIds: [],
					status: "not_created",
				},
			},

			creativeAssets: [],
			images: [],
			videos: [],
			musicTracks: [],
			auditLogs: [],
			meta: {
				productSummary: summary,
			},
			channels: channels || [],
		};

		console.log(
			"[AI MARKETING] create(): base campaignData created",
			JSON.stringify(
				{
					name: campaignData.name,
					store: campaignData.store,
					productsCount: campaignData.products.length,
				},
				null,
				2
			)
		);

		// Make sure we have at least one Google Ads channel on campaignData.
		ensureChannelDefaults(campaignData);

		let campaign = new AiMarketingCampaign(campaignData);
		console.log(
			"[AI MARKETING] create(): new AiMarketingCampaign instance created with _id",
			String(campaign._id)
		);

		ensureDefaultGoals(campaign);

		const actions = [];

		// 1) MEDIA FIRST: videos & images (Runway, product images)
		campaign = await ensureRunwayVideosForCampaign(campaign, products, actions);

		// 2) COPY: primary texts, headlines, descriptions
		console.log("[AI MARKETING] create(): fetching initial analytics...");
		const initialAnalytics = await fetchAnalyticsForCampaign(campaign);
		campaign.analytics.summary = initialAnalytics;

		campaign = await generateInitialCreativesForCampaign(
			campaign,
			products,
			initialAnalytics
		);
		console.log(
			"[AI MARKETING] create(): after generateInitialCreativesForCampaign; creativeAssets length =",
			campaign.creativeAssets ? campaign.creativeAssets.length : 0
		);

		// 3) Optional background music from Jamendo
		campaign = await ensureJamendoTrackForCampaign(campaign, actions);

		// 4 / 5 / 6) GOOGLE ADS: build & post campaign (NO Mongo save yet)
		const googleAdsResult = await ensurePlatformCampaignsExist(
			campaign,
			actions
		);

		const googleAdsCreated = googleAdsResult && googleAdsResult.createdAny;

		if (!googleAdsCreated) {
			console.error(
				"[AI MARKETING] create(): Google Ads campaign was NOT created; aborting MongoDB save."
			);
			return res.status(502).json({
				error: "Failed to create Google Ads campaign",
				details:
					googleAdsResult && googleAdsResult.lastError
						? googleAdsResult.lastError.message
						: "Google Ads API did not return a created campaign. Check backend logs.",
			});
		}

		console.log(
			"[AI MARKETING] create(): ensurePlatformCampaignsExist finished; platforms.googleAds =",
			JSON.stringify(
				campaign.platforms && campaign.platforms.googleAds,
				null,
				2
			)
		);

		// 7) FINAL bookkeeping & audit log
		const now = new Date();
		campaign.schedule.nextAuditAt = computeNextAuditAt(campaign, now);
		if (!campaign.lifecycle) campaign.lifecycle = {};
		campaign.lifecycle.status = "active";

		console.log("[AI MARKETING] create(): media snapshot before final save =", {
			creativeAssetsCount: campaign.creativeAssets
				? campaign.creativeAssets.length
				: 0,
			imagesCount: campaign.images ? campaign.images.length : 0,
			videosCount: campaign.videos ? campaign.videos.length : 0,
			sampleImage:
				campaign.images && campaign.images[0]
					? {
							product: String(campaign.images[0].product || ""),
							url: campaign.images[0].url,
					  }
					: null,
			sampleVideo:
				campaign.videos && campaign.videos[0]
					? {
							product: String(campaign.videos[0].product || ""),
							url: campaign.videos[0].url,
							thumbnailUrl: campaign.videos[0].thumbnailUrl,
					  }
					: null,
			googleAds:
				campaign.platforms && campaign.platforms.googleAds
					? campaign.platforms.googleAds
					: null,
		});

		const googleAdsStatus =
			(campaign.platforms &&
				campaign.platforms.googleAds &&
				campaign.platforms.googleAds.status) ||
			"not_created";

		const googleAdsSummary =
			googleAdsStatus === "active"
				? "Google Ads campaign created via API."
				: "Google Ads campaign NOT created – check logs/actions.";

		const auditSummary =
			"Campaign created, creatives generated, " +
			googleAdsSummary +
			" Automation initialized.";

		campaign.auditLogs = campaign.auditLogs || [];
		campaign.auditLogs.push({
			timestamp: now,
			triggeredBy: "ai",
			eventType: "campaign_created",
			summary: auditSummary,
			metricsSnapshot: {
				impressions: initialAnalytics.impressions || 0,
				clicks: initialAnalytics.clicks || 0,
				ctr: initialAnalytics.ctr || 0,
				cost: initialAnalytics.cost || 0,
				cpc: initialAnalytics.cpc || 0,
				conversions:
					initialAnalytics.purchases || initialAnalytics.conversions || 0,
				conversionRate: initialAnalytics.conversionRate || 0,
				revenue: initialAnalytics.revenue || 0,
				roas: initialAnalytics.roas || 0,
				addToCarts: initialAnalytics.addToCarts || 0,
				purchases: initialAnalytics.purchases || 0,
			},
			platformMetrics: initialAnalytics.byPlatform || {},
			decision: {
				action: "none",
				reason:
					"Initial setup completed by AI marketing agent. Future audits will adjust budgets / status.",
			},
			changes: {
				notes:
					"OpenAI copy, Runway video, Jamendo (optional) music, Google Ads campaign created.",
				actions,
			},
			pausedAdIds: [],
			createdAdIds: [],
			error: null,
		});

		// Single, final save – only happens if Google Ads campaign exists
		await campaign.save();
		console.log(
			"[AI MARKETING] create(): final save completed. Campaign is active."
		);

		return res.json(campaign);
	} catch (err) {
		console.error("[AI MARKETING] Error creating AI campaign:", err);
		return res.status(500).json({
			error: "Error creating AI campaign",
			details: err.message,
		});
	}
};

/**
 * PUT /ai/campaign/:campaignId/audit
 */
exports.runManualAudit = async (req, res) => {
	try {
		const campaign = await AiMarketingCampaign.findById(req.params.campaignId);

		if (!campaign) {
			return res.status(404).json({ error: "Campaign not found" });
		}

		if (
			campaign.automationSettings &&
			campaign.automationSettings.enabled === false
		) {
			console.log(
				"[AI MARKETING] runManualAudit(): automation disabled for this campaign; running manual audit anyway."
			);
		}

		const user = req.profile || req.user || null;

		const { campaign: updated, auditLogEntry } = await runAuditForCampaign(
			campaign,
			{
				runType: "manual",
				triggeredBy: user ? user._id : null,
			}
		);

		return res.json({
			campaign: updated,
			lastAudit: auditLogEntry,
		});
	} catch (err) {
		console.error("Error running manual audit:", err);
		res.status(500).json({ error: "Error running manual audit" });
	}
};

/**
 * Internal endpoint for cron:
 * GET /ai/campaigns/run-due-audits
 */
exports.runDueCampaignAudits = async (req, res) => {
	const now = new Date();
	try {
		const campaigns = await AiMarketingCampaign.find({
			"automationSettings.enabled": true,
			"schedule.nextAuditAt": { $lte: now },
		}).exec();

		const results = [];

		for (const campaign of campaigns) {
			try {
				const { auditLogEntry } = await runAuditForCampaign(campaign, {
					runType: "scheduled",
					triggeredBy: null,
				});

				results.push({
					campaignId: campaign._id,
					status: auditLogEntry.decision.action || "none",
					summary: auditLogEntry.summary,
				});
			} catch (err) {
				console.error(
					`Error running scheduled audit for campaign ${campaign._id}:`,
					err
				);
				results.push({
					campaignId: campaign._id,
					status: "failed",
					error: err.message,
				});
			}
		}

		res.json({
			now,
			processed: results.length,
			results,
		});
	} catch (err) {
		console.error("Error running due audits:", err);
		res.status(500).json({ error: "Error running due audits" });
	}
};

/**
 * PATCH /ai/campaign/:campaignId/status
 * { status: "paused" | "active" | "cancelled_by_user" }
 */
exports.updateStatus = async (req, res) => {
	const { status } = req.body;
	const allowed = ["active", "paused", "cancelled_by_user"];

	if (!allowed.includes(status)) {
		return res.status(400).json({ error: "Invalid status update" });
	}

	try {
		const campaign = await AiMarketingCampaign.findById(req.params.campaignId);

		if (!campaign) {
			return res.status(404).json({ error: "Campaign not found" });
		}

		const oldStatus =
			(campaign.lifecycle && campaign.lifecycle.status) || "unknown";
		if (!campaign.lifecycle) campaign.lifecycle = {};
		campaign.lifecycle.status = status;

		if (campaign.automationSettings) {
			if (status === "cancelled_by_user" || status === "paused") {
				campaign.automationSettings.enabled = false;
			} else if (status === "active") {
				campaign.automationSettings.enabled = true;
			}
		}

		campaign.auditLogs = campaign.auditLogs || [];
		campaign.auditLogs.push({
			timestamp: new Date(),
			triggeredBy: req.profile ? req.profile._id : null,
			eventType: "manual_status_change",
			summary: `Lifecycle status changed from ${oldStatus} to ${status} by user.`,
			metricsSnapshot: (campaign.analytics && campaign.analytics.summary) || {},
			platformMetrics:
				(campaign.analytics && campaign.analytics.summary
					? campaign.analytics.summary.byPlatform
					: {}) || {},
			decision: {
				action: "status_change",
				reason: "Manual status change",
			},
			changes: {
				statusBefore: oldStatus,
				statusAfter: status,
			},
			pausedAdIds: [],
			createdAdIds: [],
			error: null,
		});

		await campaign.save();

		res.json(campaign);
	} catch (err) {
		console.error("Error updating campaign status:", err);
		res.status(500).json({ error: "Error updating campaign status" });
	}
};

/**
 * GET /ai/campaign/:campaignId/analytics/refresh
 * Manually refresh analytics snapshot from GA4 + Google Ads.
 */
exports.refreshAnalytics = async (req, res) => {
	try {
		const campaign = await AiMarketingCampaign.findById(req.params.campaignId);

		if (!campaign) {
			return res.status(404).json({ error: "Campaign not found" });
		}

		const analytics = await fetchAnalyticsForCampaign(campaign);

		campaign.analytics = campaign.analytics || {};
		campaign.analytics.summary = analytics;
		if (!campaign.analytics.byPlatform) {
			campaign.analytics.byPlatform = {};
		}
		if (analytics.byPlatform) {
			campaign.analytics.byPlatform = {
				...campaign.analytics.byPlatform,
				...analytics.byPlatform,
			};
		}

		campaign.auditLogs = campaign.auditLogs || [];
		campaign.auditLogs.push({
			timestamp: new Date(),
			triggeredBy: req.profile ? req.profile._id : null,
			eventType: "manual_analytics_refresh",
			summary: "Analytics snapshot refreshed manually.",
			metricsSnapshot: {
				impressions: analytics.impressions || 0,
				clicks: analytics.clicks || 0,
				ctr: analytics.ctr || 0,
				cost: analytics.cost || 0,
				cpc: analytics.cpc || 0,
				conversions: analytics.purchases || analytics.conversions || 0,
				conversionRate: analytics.conversionRate || 0,
				revenue: analytics.revenue || 0,
				roas: analytics.roas || 0,
			},
			platformMetrics: analytics.byPlatform || {},
			decision: {
				action: "none",
				reason: "Manual analytics refresh (no optimization applied).",
			},
			changes: {
				notes: "Pulled fresh analytics data from GA4 + Google Ads.",
			},
			pausedAdIds: [],
			createdAdIds: [],
			error: null,
		});

		await campaign.save();

		res.json(campaign);
	} catch (err) {
		console.error("Error refreshing analytics:", err);
		res.status(500).json({ error: "Error refreshing analytics" });
	}
};

/**
 * GET /ai/marketing/active-products-and-categories?storeId=...
 */
exports.getActiveProductsAndCategories = async (req, res) => {
	try {
		const { storeId } = req.query;

		const filter = { activeProduct: true };

		if (storeId && mongoose.Types.ObjectId.isValid(storeId)) {
			filter.store = storeId;
		}

		const products = await Product.find(filter)
			.select(
				"productName productName_Arabic price priceAfterDiscount price_unit thumbnailImage category gender activeProduct isPrintifyProduct store"
			)
			.populate("category", "categoryName categoryName_Arabic")
			.populate("gender", "genderName")
			.lean();

		const distinctCategoryMap = new Map();

		for (const p of products) {
			if (p.category && p.category._id) {
				const id = String(p.category._id);
				if (!distinctCategoryMap.has(id)) {
					distinctCategoryMap.set(id, {
						_id: p.category._id,
						categoryName: p.category.categoryName,
						categoryName_Arabic: p.category.categoryName_Arabic,
					});
				}
			}
		}

		const distinctCategories = Array.from(distinctCategoryMap.values());

		return res.json({
			products,
			distinctCategories,
		});
	} catch (err) {
		console.error("Error fetching active products and categories:", err);
		return res
			.status(500)
			.json({ error: "Error fetching active products and categories" });
	}
};
