const axios = require("axios");
const crypto = require("crypto");
const Category = require("../models/category");
const Product = require("../models/product");
const slugify = require("slugify");
const Subcategory = require("../models/subcategory");
const Colors = require("../models/colors");
const { Order } = require("../models/order");
const cloudinary = require("cloudinary").v2;
const path = require("path");

// Configure Cloudinary
cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

const localYourDesignHerePath = path.join(
	__dirname,
	"../shopLogo/YourDesignHere.png",
);

const PRINTIFY_TOKEN_ENV_KEYS = [
	"PRINTIFY_API_TOKEN",
	"DESIGN_PRINTIFY_TOKEN",
	"PRINTIFY_TOKEN",
];

function parseJwtExpiryMs(token = "") {
	try {
		const [, payloadPart] = String(token).split(".");
		if (!payloadPart) return null;
		const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(
			Buffer.from(normalized, "base64").toString("utf8"),
		);
		return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}

function resolvePrintifyToken() {
	const candidates = PRINTIFY_TOKEN_ENV_KEYS.map((key) => ({
		key,
		token: process.env[key]?.trim(),
	})).filter((entry) => !!entry.token);

	if (!candidates.length) {
		return {
			token: null,
			error:
				"Missing Printify token. Set PRINTIFY_API_TOKEN, DESIGN_PRINTIFY_TOKEN, or PRINTIFY_TOKEN.",
		};
	}

	const now = Date.now();
	const enriched = candidates.map((entry) => {
		const expMs = parseJwtExpiryMs(entry.token);
		return {
			...entry,
			expMs,
			isExpired: Number.isFinite(expMs) ? expMs <= now : false,
		};
	});

	const validToken = enriched.find((entry) => !entry.isExpired);
	if (validToken) {
		return { token: validToken.token, source: validToken.key, error: null };
	}

	const knownExpirations = enriched
		.filter((entry) => Number.isFinite(entry.expMs))
		.map(
			(entry) =>
				`${entry.key} expired at ${new Date(entry.expMs).toISOString()}`,
		);

	if (knownExpirations.length) {
		return {
			token: null,
			error: `All configured Printify tokens are expired. ${knownExpirations.join(
				"; ",
			)}. Generate a new token in Printify and restart the backend.`,
		};
	}

	return {
		token: enriched[0].token,
		source: enriched[0].key,
		error: null,
	};
}

async function deletePreviewProductById({
	previewProductId,
	shopIdHint,
	printifyToken,
	debugId = "preview-cleanup",
}) {
	if (!previewProductId || !printifyToken) {
		return {
			success: false,
			deleted: false,
			reason: "missing_product_or_token",
		};
	}

	const tryDeleteInShop = async (shopId) => {
		try {
			await axios.delete(
				`https://api.printify.com/v1/shops/${shopId}/products/${previewProductId}.json`,
				{
					headers: {
						Authorization: `Bearer ${printifyToken}`,
						"User-Agent": "NodeJS-App",
					},
				},
			);
			return { success: true, deleted: true, shopId };
		} catch (error) {
			const status = error?.response?.status;
			if (status === 404) {
				return { success: false, deleted: false, shopId, notFound: true };
			}
			throw error;
		}
	};

	if (shopIdHint) {
		const directResult = await tryDeleteInShop(shopIdHint);
		if (directResult.deleted || directResult.notFound) return directResult;
	}

	const shopsResp = await axios.get("https://api.printify.com/v1/shops.json", {
		headers: {
			Authorization: `Bearer ${printifyToken}`,
			"User-Agent": "NodeJS-App",
		},
	});
	const shopIds = Array.isArray(shopsResp.data)
		? shopsResp.data.map((shop) => shop.id).filter(Boolean)
		: [];

	for (const shopId of shopIds) {
		const result = await tryDeleteInShop(shopId);
		if (result.deleted) return result;
	}

	console.log(`[${debugId}] Preview product not found in any shop`, {
		previewProductId,
		triedShopIdHint: shopIdHint || null,
		shopCount: shopIds.length,
	});
	return { success: true, deleted: false, notFound: true };
}

const POD_LIST_PREVIEW_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const POD_LIST_PREVIEW_SHOP_CACHE_TTL_MS = 1000 * 60 * 5; // 5 minutes
const POD_LIST_PREVIEW_MAX_DB_ENTRIES = 12;
const POD_LIST_PREVIEW_CACHE_VERSION = "v23";
const POD_LIST_PREVIEW_STALE_AGE_MS = 1000 * 60 * 60 * 24 * 2; // 48 hours
const POD_LIST_PREVIEW_STALE_CLEANUP_INTERVAL_MS = 1000 * 60 * 15; // 15 minutes
const POD_LIST_PREVIEW_STALE_CLEANUP_MAX_PRODUCTS = 120;
const POD_LIST_PREVIEW_STALE_CLEANUP_MAX_DELETES = 240;

const podListPreviewMemoryCache = new Map();
const podListPreviewInFlight = new Map();
const podCatalogLayoutCache = new Map();
const podListPreviewShopCache = {
	expiresAt: 0,
	shopIds: [],
};
const podListStaleCleanupState = {
	running: false,
	lastRunAt: 0,
	lastSummary: null,
};
let podListStaleCleanupTimer = null;
const POD_CATALOG_LAYOUT_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

const POD_LIST_DEFAULT_OCCASION = "Birthday";
const POD_LIST_OCCASION_OPTIONS = [
	{ value: "Birthday", icon: "\u{1F382}" },
	{ value: "Anniversary", icon: "\u{1F49E}" },
	{ value: "Wedding", icon: "\u{1F48D}" },
	{ value: "Graduation", icon: "\u{1F393}" },
	{ value: "Baby Shower", icon: "\u{1F37C}" },
	{ value: "Bridal Shower", icon: "\u{1F470}" },
	{ value: "Housewarming", icon: "\u{1F3E1}" },
	{ value: "Mother's Day", icon: "\u{1F339}" },
	{ value: "Father's Day", icon: "\u{1F9D4}" },
	{ value: "Valentine's Day", icon: "\u{2764}\u{FE0F}" },
	{ value: "Ramadan", icon: "\u{1F319}" },
	{ value: "Eid", icon: "\u{2728}" },
	{ value: "Christmas", icon: "\u{1F384}" },
	{ value: "Thanksgiving", icon: "\u{1F983}" },
	{ value: "Retirement", icon: "\u{1F334}" },
	{ value: "Get Well Soon", icon: "\u{1F490}" },
	{ value: "New Baby", icon: "\u{1F476}" },
	{ value: "Just Because", icon: "\u{1F381}" },
];

const podListOccasionLookup = new Map(
	POD_LIST_OCCASION_OPTIONS.flatMap((option) => {
		const value = option.value;
		const normalized = value.toLowerCase();
		const slug = value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "");
		return [
			[normalized, value],
			[slug, value],
		];
	}),
);

const podListGiftMessageMap = {
	Birthday: {
		withName: (name) => `Happy Birthday, ${name}!`,
		withoutName: "Happy Birthday!",
	},
	Anniversary: {
		withName: (name) => `Happy Anniversary, ${name}!`,
		withoutName: "Happy Anniversary!",
	},
	Wedding: {
		withName: (name) => `Congrats on your wedding, ${name}!`,
		withoutName: "Congrats on your wedding!",
	},
	Graduation: {
		withName: (name) => `Congrats, ${name} - you did it!`,
		withoutName: "Congrats - you did it!",
	},
	"Baby Shower": {
		withName: (name) => `Celebrating Baby ${name}!`,
		withoutName: "Celebrating a new little one!",
	},
	"Bridal Shower": {
		withName: (name) => `Showered with love, ${name}!`,
		withoutName: "Showered with love!",
	},
	Housewarming: {
		withName: (name) => `Home sweet home, ${name}!`,
		withoutName: "Home sweet home!",
	},
	"Mother's Day": {
		withName: (name) => `Happy Mother's Day, ${name}!`,
		withoutName: "Happy Mother's Day!",
	},
	"Father's Day": {
		withName: (name) => `Happy Father's Day, ${name}!`,
		withoutName: "Happy Father's Day!",
	},
	"Valentine's Day": {
		withName: (name) => `Happy Valentine's Day, ${name}!`,
		withoutName: "Happy Valentine's Day!",
	},
	Ramadan: {
		withName: (name) => `Ramadan Mubarak, ${name}!`,
		withoutName: "Ramadan Mubarak!",
	},
	Eid: {
		withName: (name) => `Eid Mubarak, ${name}!`,
		withoutName: "Eid Mubarak!",
	},
	Christmas: {
		withName: (name) => `Merry Christmas, ${name}!`,
		withoutName: "Merry Christmas!",
	},
	Thanksgiving: {
		withName: (name) => `Grateful for you, ${name}!`,
		withoutName: "Grateful for you!",
	},
	Retirement: {
		withName: (name) => `Happy Retirement, ${name}!`,
		withoutName: "Happy Retirement!",
	},
	"Get Well Soon": {
		withName: (name) => `Get well soon, ${name}!`,
		withoutName: "Get well soon!",
	},
	"New Baby": {
		withName: (name) => `Welcome baby ${name}!`,
		withoutName: "Welcome, little one!",
	},
	"Just Because": {
		withName: (name) => `Made with love for ${name}`,
		withoutName: "Made with love",
	},
};

const POD_LIST_BASE_PRESET = {
	fontFamily: "'Playfair Display', Georgia, serif",
	fontSize: 76,
	fontWeight: "600",
	fontStyle: "normal",
	textColor: "#1f2937",
	textShadowColor: "rgba(15, 23, 42, 0.16)",
	backgroundColor: "#fff7ed",
	panelGradientStart: "#fdfcf8",
	panelGradientEnd: "#efe6dd",
	panelBorderColor: "rgba(123, 79, 40, 0.18)",
	borderRadius: 16,
	accentIcon: "\u{1F381}",
	accentTextColor: "#1f2937",
	accentBackgroundColor: "#ffffff",
	accentBackgroundColor2: "#f2ece3",
	accentBorderColor: "rgba(31, 41, 55, 0.15)",
	ornamentLeft: "\u2726",
	ornamentRight: "\u2726",
	ornamentColor: "rgba(120, 80, 40, 0.3)",
};

const POD_LIST_FALLBACK_DESIGN_URL =
	"https://res.cloudinary.com/infiniteapps/image/upload/v1746381000/serene_janat/YourDesignHere2_zl9oqo.png";

const POD_LIST_PRESETS = {
	Birthday: {
		fontFamily: "'Lobster', 'Playfair Display', serif",
		textColor: "#8d3b1f",
		textShadowColor: "rgba(109, 56, 20, 0.3)",
		backgroundColor: "#fff3e8",
		panelGradientStart: "#fff8ef",
		panelGradientEnd: "#ffe9d6",
		panelBorderColor: "rgba(180, 103, 56, 0.34)",
		borderRadius: 26,
		accentIcon: "\u{1F382}",
		accentTextColor: "#8d3b1f",
		accentBackgroundColor: "#fff6ed",
		accentBackgroundColor2: "#ffe8d3",
		accentBorderColor: "rgba(180, 103, 56, 0.35)",
		ornamentLeft: "\u2726",
		ornamentRight: "\u2726",
		ornamentColor: "rgba(180, 103, 56, 0.55)",
	},
	Anniversary: {
		fontFamily: "'Great Vibes', 'Dancing Script', serif",
		textColor: "#8a1f4b",
		textShadowColor: "rgba(111, 28, 56, 0.28)",
		backgroundColor: "#fff1f5",
		panelGradientStart: "#fff8fb",
		panelGradientEnd: "#ffe0ef",
		panelBorderColor: "rgba(177, 64, 112, 0.3)",
		borderRadius: 30,
		accentIcon: "\u{1F49E}",
		accentBackgroundColor: "#fff4f8",
		accentBackgroundColor2: "#ffe3ef",
		accentBorderColor: "rgba(177, 64, 112, 0.34)",
		ornamentLeft: "\u2665",
		ornamentRight: "\u2665",
		ornamentColor: "rgba(177, 64, 112, 0.5)",
	},
	Wedding: {
		fontFamily: "'Great Vibes', 'Dancing Script', serif",
		textColor: "#5a2ca8",
		textShadowColor: "rgba(76, 29, 149, 0.3)",
		backgroundColor: "#f7f2ff",
		panelGradientStart: "#fcf9ff",
		panelGradientEnd: "#ece3ff",
		panelBorderColor: "rgba(106, 67, 176, 0.32)",
		borderRadius: 32,
		accentIcon: "\u{1F48D}",
		accentBackgroundColor: "#faf7ff",
		accentBackgroundColor2: "#e9ddff",
		accentBorderColor: "rgba(106, 67, 176, 0.36)",
		ornamentLeft: "\u2727",
		ornamentRight: "\u2727",
		ornamentColor: "rgba(106, 67, 176, 0.5)",
	},
	Graduation: {
		fontFamily: "'Poppins', Verdana, sans-serif",
		textColor: "#1e3a8a",
		textShadowColor: "rgba(30, 58, 138, 0.26)",
		backgroundColor: "#eef6ff",
		panelGradientStart: "#f8fbff",
		panelGradientEnd: "#deebff",
		panelBorderColor: "rgba(53, 88, 181, 0.3)",
		borderRadius: 18,
		accentIcon: "\u{1F393}",
		accentBackgroundColor: "#f5f9ff",
		accentBackgroundColor2: "#d9e8ff",
		accentBorderColor: "rgba(53, 88, 181, 0.34)",
		ornamentLeft: "\u2726",
		ornamentRight: "\u2726",
		ornamentColor: "rgba(53, 88, 181, 0.48)",
	},
	"Baby Shower": {
		fontFamily: "'Dancing Script', 'Playfair Display', serif",
		textColor: "#1d4e89",
		textShadowColor: "rgba(29, 78, 137, 0.24)",
		backgroundColor: "#ecfeff",
		panelGradientStart: "#f6feff",
		panelGradientEnd: "#dff7ff",
		panelBorderColor: "rgba(62, 138, 182, 0.3)",
		borderRadius: 24,
		accentIcon: "\u{1F37C}",
		accentBackgroundColor: "#f4fdff",
		accentBackgroundColor2: "#dbf3ff",
		accentBorderColor: "rgba(62, 138, 182, 0.33)",
		ornamentLeft: "\u2727",
		ornamentRight: "\u2727",
		ornamentColor: "rgba(62, 138, 182, 0.46)",
	},
	"Bridal Shower": {
		fontFamily: "'Great Vibes', 'Dancing Script', serif",
		textColor: "#6b21a8",
		textShadowColor: "rgba(107, 33, 168, 0.28)",
		backgroundColor: "#faf5ff",
		panelGradientStart: "#fefbff",
		panelGradientEnd: "#f0e2ff",
		panelBorderColor: "rgba(125, 76, 191, 0.3)",
		borderRadius: 28,
		accentIcon: "\u{1F470}",
		accentBackgroundColor: "#fcf8ff",
		accentBackgroundColor2: "#ecddff",
		accentBorderColor: "rgba(125, 76, 191, 0.34)",
		ornamentLeft: "\u273f",
		ornamentRight: "\u273f",
		ornamentColor: "rgba(125, 76, 191, 0.46)",
	},
	Housewarming: {
		fontFamily: "'Cormorant Garamond', Georgia, serif",
		textColor: "#78350f",
		textShadowColor: "rgba(120, 53, 15, 0.26)",
		backgroundColor: "#fffbeb",
		panelGradientStart: "#fffdf4",
		panelGradientEnd: "#fcebc6",
		panelBorderColor: "rgba(168, 119, 42, 0.31)",
		borderRadius: 20,
		accentIcon: "\u{1F3E1}",
		accentBackgroundColor: "#fffdf2",
		accentBackgroundColor2: "#f8ebcb",
		accentBorderColor: "rgba(168, 119, 42, 0.35)",
		ornamentLeft: "\u2726",
		ornamentRight: "\u2726",
		ornamentColor: "rgba(168, 119, 42, 0.5)",
	},
	"Mother's Day": {
		fontFamily: "'Great Vibes', 'Dancing Script', serif",
		textColor: "#9d174d",
		textShadowColor: "rgba(157, 23, 77, 0.28)",
		backgroundColor: "#fdf2f8",
		panelGradientStart: "#fff7fb",
		panelGradientEnd: "#ffdceb",
		panelBorderColor: "rgba(189, 62, 125, 0.3)",
		borderRadius: 30,
		accentIcon: "\u{1F339}",
		accentBackgroundColor: "#fff7fb",
		accentBackgroundColor2: "#ffd9ea",
		accentBorderColor: "rgba(189, 62, 125, 0.35)",
		ornamentLeft: "\u273f",
		ornamentRight: "\u273f",
		ornamentColor: "rgba(189, 62, 125, 0.5)",
	},
	"Father's Day": {
		fontFamily: "'Poppins', Verdana, sans-serif",
		textColor: "#0f172a",
		textShadowColor: "rgba(15, 23, 42, 0.26)",
		backgroundColor: "#f1f5f9",
		panelGradientStart: "#f9fbfd",
		panelGradientEnd: "#e2eaf4",
		panelBorderColor: "rgba(70, 94, 124, 0.28)",
		borderRadius: 16,
		accentIcon: "\u{1F9D4}",
		accentBackgroundColor: "#f8fbff",
		accentBackgroundColor2: "#e3ecf7",
		accentBorderColor: "rgba(70, 94, 124, 0.32)",
		ornamentLeft: "\u2726",
		ornamentRight: "\u2726",
		ornamentColor: "rgba(70, 94, 124, 0.46)",
	},
	"Valentine's Day": {
		fontFamily: "'Great Vibes', 'Dancing Script', serif",
		textColor: "#881337",
		textShadowColor: "rgba(136, 19, 55, 0.28)",
		backgroundColor: "#fff1f2",
		panelGradientStart: "#fff7f9",
		panelGradientEnd: "#ffdce5",
		panelBorderColor: "rgba(176, 45, 89, 0.31)",
		borderRadius: 32,
		accentIcon: "\u{2764}\u{FE0F}",
		accentBackgroundColor: "#fff8fb",
		accentBackgroundColor2: "#ffd8e5",
		accentBorderColor: "rgba(176, 45, 89, 0.35)",
		ornamentLeft: "\u2665",
		ornamentRight: "\u2665",
		ornamentColor: "rgba(176, 45, 89, 0.52)",
	},
	Ramadan: {
		fontFamily: "'Cormorant Garamond', 'Amiri', Georgia, serif",
		fontStyle: "normal",
		fontWeight: "700",
		textColor: "#14532d",
		textShadowColor: "rgba(20, 83, 45, 0.26)",
		backgroundColor: "#ecfdf5",
		panelGradientStart: "#f7fff9",
		panelGradientEnd: "#d7f8e7",
		panelBorderColor: "rgba(38, 130, 78, 0.29)",
		borderRadius: 24,
		textSizeBoost: 1.16,
		iconScaleBoost: 1.12,
		panelScaleX: 1.07,
		panelScaleY: 1.09,
		accentIcon: "\u{1F319}",
		accentBackgroundColor: "#f5fff8",
		accentBackgroundColor2: "#d4f6e2",
		accentBorderColor: "rgba(38, 130, 78, 0.33)",
		ornamentLeft: "\u2727",
		ornamentRight: "\u2727",
		ornamentColor: "rgba(38, 130, 78, 0.46)",
	},
	Eid: {
		fontFamily: "'Playfair Display', 'Dancing Script', serif",
		textColor: "#4c1d95",
		textShadowColor: "rgba(76, 29, 149, 0.28)",
		backgroundColor: "#f5f3ff",
		panelGradientStart: "#fbfaff",
		panelGradientEnd: "#e8ddff",
		panelBorderColor: "rgba(105, 67, 173, 0.3)",
		borderRadius: 30,
		accentIcon: "\u{2728}",
		accentBackgroundColor: "#faf8ff",
		accentBackgroundColor2: "#e7ddff",
		accentBorderColor: "rgba(105, 67, 173, 0.34)",
		ornamentLeft: "\u2728",
		ornamentRight: "\u2728",
		ornamentColor: "rgba(105, 67, 173, 0.48)",
	},
	Christmas: {
		fontFamily: "'Cormorant Garamond', Georgia, serif",
		fontWeight: "600",
		textColor: "#174b34",
		textShadowColor: "rgba(20, 83, 45, 0.18)",
		backgroundColor: "#f0fdf4",
		panelGradientStart: "#f4fbf6",
		panelGradientEnd: "#dfece3",
		panelBorderColor: "rgba(29, 87, 60, 0.22)",
		borderRadius: 18,
		accentIcon: "\u{1F384}",
		accentBackgroundColor: "#f6fbf7",
		accentBackgroundColor2: "#dfece3",
		accentBorderColor: "rgba(29, 87, 60, 0.22)",
		ornamentLeft: "\u2736",
		ornamentRight: "\u2736",
		ornamentColor: "rgba(29, 87, 60, 0.32)",
	},
	Thanksgiving: {
		fontFamily: "'Cormorant Garamond', 'Times New Roman', serif",
		textColor: "#7c2d12",
		textShadowColor: "rgba(124, 45, 18, 0.28)",
		backgroundColor: "#fff7ed",
		panelGradientStart: "#fffaf1",
		panelGradientEnd: "#ffe8ce",
		panelBorderColor: "rgba(167, 103, 49, 0.31)",
		borderRadius: 20,
		accentIcon: "\u{1F983}",
		accentBackgroundColor: "#fff9f0",
		accentBackgroundColor2: "#ffe6c7",
		accentBorderColor: "rgba(167, 103, 49, 0.35)",
		ornamentLeft: "\u2726",
		ornamentRight: "\u2726",
		ornamentColor: "rgba(167, 103, 49, 0.5)",
	},
	Retirement: {
		fontFamily: "'Playfair Display', Georgia, serif",
		textColor: "#0f172a",
		textShadowColor: "rgba(15, 23, 42, 0.24)",
		backgroundColor: "#f8fafc",
		panelGradientStart: "#fdfefe",
		panelGradientEnd: "#e6edf5",
		panelBorderColor: "rgba(96, 117, 142, 0.28)",
		borderRadius: 22,
		accentIcon: "\u{1F334}",
		accentBackgroundColor: "#fcfeff",
		accentBackgroundColor2: "#e6eef7",
		accentBorderColor: "rgba(96, 117, 142, 0.33)",
		ornamentLeft: "\u2727",
		ornamentRight: "\u2727",
		ornamentColor: "rgba(96, 117, 142, 0.45)",
	},
	"Get Well Soon": {
		fontFamily: "'Poppins', Verdana, sans-serif",
		textColor: "#166534",
		textShadowColor: "rgba(22, 101, 52, 0.24)",
		backgroundColor: "#f0fdf4",
		panelGradientStart: "#f8fff9",
		panelGradientEnd: "#dcf7e3",
		panelBorderColor: "rgba(54, 140, 83, 0.28)",
		borderRadius: 20,
		accentIcon: "\u{1F490}",
		accentBackgroundColor: "#f7fff9",
		accentBackgroundColor2: "#d8f3df",
		accentBorderColor: "rgba(54, 140, 83, 0.33)",
		ornamentLeft: "\u2727",
		ornamentRight: "\u2727",
		ornamentColor: "rgba(54, 140, 83, 0.44)",
	},
	"New Baby": {
		fontFamily: "'Dancing Script', 'Playfair Display', serif",
		textColor: "#0c4a6e",
		textShadowColor: "rgba(12, 74, 110, 0.24)",
		backgroundColor: "#eff6ff",
		panelGradientStart: "#f8fbff",
		panelGradientEnd: "#dcecff",
		panelBorderColor: "rgba(68, 135, 182, 0.28)",
		borderRadius: 26,
		accentIcon: "\u{1F476}",
		accentBackgroundColor: "#f7fbff",
		accentBackgroundColor2: "#dbeaff",
		accentBorderColor: "rgba(68, 135, 182, 0.32)",
		ornamentLeft: "\u2728",
		ornamentRight: "\u2728",
		ornamentColor: "rgba(68, 135, 182, 0.45)",
	},
	"Just Because": {
		fontFamily: "'Playfair Display', Georgia, serif",
		textColor: "#334155",
		textShadowColor: "rgba(51, 65, 85, 0.22)",
		backgroundColor: "#f8fafc",
		panelGradientStart: "#fdfefe",
		panelGradientEnd: "#e8eef5",
		panelBorderColor: "rgba(105, 123, 149, 0.28)",
		borderRadius: 18,
		accentIcon: "\u{1F381}",
		accentBackgroundColor: "#fcfdff",
		accentBackgroundColor2: "#e7edf6",
		accentBorderColor: "rgba(105, 123, 149, 0.32)",
		ornamentLeft: "\u2726",
		ornamentRight: "\u2726",
		ornamentColor: "rgba(105, 123, 149, 0.44)",
	},
};

const POD_LIST_EMOJI_ICON_CACHE = new Map();
const POD_LIST_TWEMOJI_BASE_URL =
	"https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg";

function normalizePodListOccasion(value) {
	if (!value || typeof value !== "string") return POD_LIST_DEFAULT_OCCASION;
	let decoded = String(value);
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		decoded = String(value);
	}
	const trimmed = decoded.trim();
	if (!trimmed) return POD_LIST_DEFAULT_OCCASION;
	return (
		podListOccasionLookup.get(trimmed.toLowerCase()) ||
		POD_LIST_DEFAULT_OCCASION
	);
}

function sanitizePodListName(value) {
	if (typeof value !== "string") return "";
	let decoded = String(value);
	try {
		decoded = decodeURIComponent(decoded.replace(/\+/g, "%20"));
	} catch {
		decoded = String(value).replace(/\+/g, " ");
	}
	const normalized = decoded
		.replace(/\+/g, " ")
		.replace(/[\r\n\t]/g, " ")
		.trim();
	return normalized.slice(0, 40);
}

function buildPodListGiftMessage(occasion, name) {
	const safeOccasion = normalizePodListOccasion(occasion);
	const safeName = sanitizePodListName(name);
	const template = podListGiftMessageMap[safeOccasion];
	if (!template) {
		return safeName ? `Made with love for ${safeName}` : "Made with love";
	}
	return safeName ? template.withName(safeName) : template.withoutName;
}

function getPodListPreset(occasion) {
	const safeOccasion = normalizePodListOccasion(occasion);
	return {
		...POD_LIST_BASE_PRESET,
		...(POD_LIST_PRESETS[safeOccasion] || {}),
	};
}

function normalizePodListProductName(product = {}) {
	return String(product?.productName || product?.title || "").toLowerCase();
}

function getPodListProductKind(product = {}) {
	const normalizedName = normalizePodListProductName(product);
	const isApparel =
		normalizedName.includes("t-shirt") ||
		normalizedName.includes("tee") ||
		(normalizedName.includes("shirt") &&
			!normalizedName.includes("sweatshirt"));
	const isHoodieLike =
		normalizedName.includes("hoodie") ||
		normalizedName.includes("sweatshirt") ||
		normalizedName.includes("pullover");
	const isMug = normalizedName.includes("mug");
	const isTote = normalizedName.includes("tote");
	const isWeekender =
		normalizedName.includes("weekender") || normalizedName.includes("bag");
	const isPillow = normalizedName.includes("pillow");
	const isMagnet = normalizedName.includes("magnet");
	const isCandle = normalizedName.includes("candle");
	if (isApparel) return "apparel";
	if (isHoodieLike) return "hoodie";
	if (isMug) return "mug";
	if (isTote) return "tote";
	if (isWeekender) return "bag";
	if (isPillow) return "pillow";
	if (isMagnet) return "magnet";
	if (isCandle) return "candle";
	return "default";
}

function shouldUseFrontendSyncedPodListAsset(product = {}) {
	const kind = getPodListProductKind(product);
	return kind === "pillow" || kind === "magnet" || kind === "candle";
}

function getPodListEditorSurfaceConfig(product = {}, positionInput = "") {
	const kind = getPodListProductKind(product);
	const position = normalizePrintAreaPosition(positionInput || "front");
	const byKind = {
		pillow: {
			front: { widthRatio: 42, heightRatio: 42, clampInset: 2 },
		},
		magnet: {
			front: { widthRatio: 76, heightRatio: 76, clampInset: 1 },
		},
		candle: {
			front: { widthRatio: 40, heightRatio: 44, clampInset: 2 },
		},
		default: {
			front: { widthRatio: 60, heightRatio: 75, clampInset: 3 },
		},
	};
	const kindConfig = byKind[kind] || byKind.default;
	return kindConfig[position] || kindConfig.front || byKind.default.front;
}

function resolvePodListSafeBounds(
	containerWidth,
	containerHeight,
	insetPercent = 0,
) {
	const width = Math.max(0, Number(containerWidth) || 0);
	const height = Math.max(0, Number(containerHeight) || 0);
	const safeInsetPercent = Math.max(
		0,
		Math.min(45, Number(insetPercent) || 0),
	);
	const insetX = (width * safeInsetPercent) / 100;
	const insetY = (height * safeInsetPercent) / 100;
	return {
		minX: insetX,
		minY: insetY,
		maxX: Math.max(insetX, width - insetX),
		maxY: Math.max(insetY, height - insetY),
	};
}

function clampPodListElementPositionWithinBounds(
	x,
	y,
	width,
	height,
	bounds,
) {
	const safeWidth = Math.max(24, Number(width) || 0);
	const safeHeight = Math.max(24, Number(height) || 0);
	const minX = Number(bounds?.minX) || 0;
	const minY = Number(bounds?.minY) || 0;
	const maxX = Math.max(minX, (Number(bounds?.maxX) || 0) - safeWidth);
	const maxY = Math.max(minY, (Number(bounds?.maxY) || 0) - safeHeight);
	return {
		x: Math.max(minX, Math.min(maxX, Number(x) || 0)),
		y: Math.max(minY, Math.min(maxY, Number(y) || 0)),
	};
}

function clampPodListElementRectWithinBounds(rect = {}, bounds) {
	const minX = Number(bounds?.minX) || 0;
	const minY = Number(bounds?.minY) || 0;
	const maxX = Number(bounds?.maxX) || minX;
	const maxY = Number(bounds?.maxY) || minY;
	const limitWidth = Math.max(24, maxX - minX);
	const limitHeight = Math.max(24, maxY - minY);
	const width = Math.max(
		24,
		Math.min(limitWidth, Math.max(24, Number(rect.width) || 24)),
	);
	const height = Math.max(
		24,
		Math.min(limitHeight, Math.max(24, Number(rect.height) || 24)),
	);
	const point = clampPodListElementPositionWithinBounds(
		rect.x,
		rect.y,
		width,
		height,
		bounds,
	);
	return {
		x: point.x,
		y: point.y,
		width,
		height,
	};
}

function resolvePodListAutoDesignGeometry(product = {}, preset = {}) {
	const kind = getPodListProductKind(product);
	const baseByKind = {
		pillow: {
			messageWidthRatio: 0.96,
			messageHeightRatio: 0.95,
			iconSizeRatio: 0.112,
			iconOverlapPx: 44,
			maxMessageHeight: 360,
			maxIconSize: 60,
		},
		magnet: {
			messageWidthRatio: 0.985,
			messageHeightRatio: 0.955,
			iconSizeRatio: 0.138,
			iconOverlapPx: 22,
			maxMessageHeight: 560,
			maxIconSize: 68,
		},
		candle: {
			messageWidthRatio: 0.98,
			messageHeightRatio: 0.9,
			iconSizeRatio: 0.13,
			iconOverlapPx: 34,
			maxMessageHeight: 284,
			maxIconSize: 58,
		},
		default: {
			messageWidthRatio: 0.52,
			messageHeightRatio: 0.2,
			iconSizeRatio: 0.076,
			iconOverlapPx: 6,
			maxMessageHeight: 92,
			maxIconSize: 48,
		},
	};
	const geometryOverrides =
		preset && typeof preset === "object" && preset.geometryOverrides
			? preset.geometryOverrides
			: {};
	const base = baseByKind[kind] || baseByKind.default;
	const numberOrFallback = (value, fallback) => {
		const num = Number(value);
		return Number.isFinite(num) ? num : fallback;
	};
	return {
		kind,
		messageWidthRatio: Math.max(
			0.34,
			Math.min(
				kind === "candle" ? 0.98 : kind === "magnet" ? 0.99 : 0.95,
				numberOrFallback(
					geometryOverrides.messageWidthRatio,
					base.messageWidthRatio,
				),
			),
		),
		messageHeightRatio: Math.max(
			0.1,
			Math.min(
				kind === "candle" ? 0.92 : kind === "magnet" ? 0.97 : 0.84,
				numberOrFallback(
					geometryOverrides.messageHeightRatio,
					base.messageHeightRatio,
				),
			),
		),
		iconSizeRatio: Math.max(
			0.05,
			Math.min(
				0.16,
				numberOrFallback(geometryOverrides.iconSizeRatio, base.iconSizeRatio),
			),
		),
		iconOverlapPx: numberOrFallback(
			geometryOverrides.iconOverlapPx,
			base.iconOverlapPx,
		),
		maxMessageHeight: Math.max(
			74,
			Math.min(
				kind === "candle" ? 300 : kind === "magnet" ? 560 : 320,
				numberOrFallback(
					geometryOverrides.maxMessageHeight,
					base.maxMessageHeight,
				),
			),
		),
		maxIconSize: Math.max(
			44,
			Math.min(
				84,
				numberOrFallback(geometryOverrides.maxIconSize, base.maxIconSize),
			),
		),
	};
}

function getPodListCaptureProjection(product = {}, positionInput = "") {
	const kind = getPodListProductKind(product);
	const position = normalizePrintAreaPosition(positionInput || "front");
	if (kind === "pillow" && position === "front") {
		return {
			x: 0.25,
			y: 0.5,
			scale: 0.56,
		};
	}
	return null;
}

function getPodListPlaceholderAspectRatio(placeholder = null) {
	const explicitRatio = Number(placeholder?.aspect_ratio || 0);
	if (explicitRatio > 0) return explicitRatio;
	const width = Number(placeholder?.width || 0);
	const height = Number(placeholder?.height || 0);
	if (width > 0 && height > 0) {
		return width / height;
	}
	return 0;
}

function getPodListApproxTextWidthPx(text = "", fontSizePx = 16, fontFamily = "") {
	const family = String(fontFamily || "").toLowerCase();
	const baseFactor = family.includes("great vibes")
		? 0.64
		: family.includes("dancing script")
			? 0.62
			: family.includes("lobster")
				? 0.68
				: family.includes("poppins")
					? 0.56
					: family.includes("playfair") || family.includes("cormorant")
						? 0.58
						: 0.55;
	let total = 0;
	for (const char of String(text || "")) {
		if (char === " ") {
			total += fontSizePx * 0.28;
			continue;
		}
		if (/[A-Z]/.test(char)) {
			total += fontSizePx * (baseFactor + 0.08);
			continue;
		}
		if (/[.,!?'’:-]/.test(char)) {
			total += fontSizePx * 0.24;
			continue;
		}
		total += fontSizePx * baseFactor;
	}
	return total;
}

function wrapPodListMessageToWidth({
	message = "",
	maxWidthPx = 280,
	fontSizePx = 32,
	fontFamily = "",
	maxLines = 3,
}) {
	const words = String(message || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!words.length) return ["Made with love"];
	const safeMaxLines = Math.max(1, Number(maxLines) || 3);
	const lines = [];
	let current = "";

	for (const word of words) {
		const tentative = current ? `${current} ${word}` : word;
		if (
			!current ||
			getPodListApproxTextWidthPx(tentative, fontSizePx, fontFamily) <=
				maxWidthPx
		) {
			current = tentative;
			continue;
		}
		lines.push(current);
		current = word;
	}
	if (current) lines.push(current);
	if (lines.length <= safeMaxLines) return lines;

	const merged = lines.slice(0, safeMaxLines);
	merged[safeMaxLines - 1] = lines.slice(safeMaxLines - 1).join(" ");
	return merged;
}

function getPodListCombinedBounds(elements = []) {
	const safeElements = Array.isArray(elements) ? elements.filter(Boolean) : [];
	if (!safeElements.length) return null;
	const minX = Math.min(...safeElements.map((item) => Number(item.x) || 0));
	const minY = Math.min(...safeElements.map((item) => Number(item.y) || 0));
	const maxX = Math.max(
		...safeElements.map(
			(item) => (Number(item.x) || 0) + Math.max(0, Number(item.width) || 0),
		),
	);
	const maxY = Math.max(
		...safeElements.map(
			(item) => (Number(item.y) || 0) + Math.max(0, Number(item.height) || 0),
		),
	);
	return {
		x: minX,
		y: minY,
		width: Math.max(0, maxX - minX),
		height: Math.max(0, maxY - minY),
	};
}

function getPodListNormalizedContentBounds(
	elements = [],
	containerWidth = 0,
	containerHeight = 0,
) {
	const safeWidth = Math.max(1, Number(containerWidth) || 1);
	const safeHeight = Math.max(1, Number(containerHeight) || 1);
	const combinedBounds = getPodListCombinedBounds(elements);
	if (!(combinedBounds?.width > 0) || !(combinedBounds?.height > 0)) return null;
	const padX = Math.max(2, Math.round(combinedBounds.width * 0.02));
	const padY = Math.max(2, Math.round(combinedBounds.height * 0.04));
	const x = Math.max(
		0,
		Math.min(safeWidth - 1, Math.round(combinedBounds.x - padX)),
	);
	const y = Math.max(
		0,
		Math.min(safeHeight - 1, Math.round(combinedBounds.y - padY)),
	);
	const right = Math.max(
		x + 1,
		Math.min(safeWidth, Math.round(combinedBounds.x + combinedBounds.width + padX)),
	);
	const bottom = Math.max(
		y + 1,
		Math.min(
			safeHeight,
			Math.round(combinedBounds.y + combinedBounds.height + padY),
		),
	);
	return {
		x: x / safeWidth,
		y: y / safeHeight,
		width: Math.max(1, right - x) / safeWidth,
		height: Math.max(1, bottom - y) / safeHeight,
		pixelBounds: {
			x,
			y,
			width: Math.max(1, right - x),
			height: Math.max(1, bottom - y),
		},
	};
}

function getPodListProjectedPanelRect({
	sourceWidth = 0,
	sourceHeight = 0,
	targetAspectRatio = 0,
	projection = null,
} = {}) {
	const safeSourceWidth = Math.max(1, Number(sourceWidth) || 1);
	const safeSourceHeight = Math.max(1, Number(sourceHeight) || 1);
	const safeTargetAspectRatio = Number(targetAspectRatio) || 0;
	const safeProjectionScale = Math.max(0.08, Number(projection?.scale) || 0);
	if (!projection || !(safeTargetAspectRatio > 0) || !(safeProjectionScale > 0)) {
		return {
			left: 0,
			top: 0,
			width: 1,
			height: 1,
		};
	}
	const sourceAspectRatio = safeSourceWidth / safeSourceHeight;
	const width = safeProjectionScale;
	const height =
		(width * safeTargetAspectRatio) / Math.max(0.08, sourceAspectRatio);
	return {
		left: Number(projection?.x || 0.5) - width / 2,
		top: Number(projection?.y || 0.5) - height / 2,
		width,
		height,
	};
}

function buildPodListPlacementAssetFromBounds({
	normalizedBounds = null,
	canvasWidth = 0,
	canvasHeight = 0,
	placementMode = "direct-wrap",
	targetAspectRatio = 0,
	projection = null,
} = {}) {
	if (
		!normalizedBounds ||
		!(Number(normalizedBounds.width) > 0) ||
		!(Number(normalizedBounds.height) > 0)
	) {
		return null;
	}
	const bounds = {
		x: Math.max(0, Math.min(1, Number(normalizedBounds.x) || 0)),
		y: Math.max(0, Math.min(1, Number(normalizedBounds.y) || 0)),
		width: Math.max(0, Math.min(1, Number(normalizedBounds.width) || 0)),
		height: Math.max(0, Math.min(1, Number(normalizedBounds.height) || 0)),
	};
	if (placementMode === "direct-wrap") {
		return {
			placementParams: {
				x: Math.max(0, Math.min(1, bounds.x + bounds.width / 2)),
				y: Math.max(0, Math.min(1, bounds.y + bounds.height / 2)),
				scale: Math.max(0.18, Math.min(2.6, bounds.width)),
				angle: 0,
			},
			designCoversPrintArea: false,
			isFullPrintAreaCapture: false,
			forceSourcePlacement: true,
		};
	}
	const panelRect = getPodListProjectedPanelRect({
		sourceWidth: canvasWidth,
		sourceHeight: canvasHeight,
		targetAspectRatio,
		projection,
	});
	return {
		placementParams: {
			x: Math.max(
				0,
				Math.min(
					1,
					panelRect.left + (bounds.x + bounds.width / 2) * panelRect.width,
				),
			),
			y: Math.max(
				0,
				Math.min(
					1,
					panelRect.top + (bounds.y + bounds.height / 2) * panelRect.height,
				),
			),
			scale: Math.max(
				0.18,
				Math.min(2.6, panelRect.width * bounds.width),
			),
			angle: 0,
		},
		designCoversPrintArea: false,
		isFullPrintAreaCapture: false,
		forceSourcePlacement: true,
	};
}

function getPodListTwemojiCodepoints(emoji = "") {
	return Array.from(String(emoji || ""))
		.map((char) => char.codePointAt(0))
		.filter((codePoint) => Number.isFinite(codePoint) && codePoint !== 0xfe0f)
		.map((codePoint) => codePoint.toString(16))
		.join("-");
}

async function getPodListEmojiAssetDataUri(emoji = "") {
	const safeEmoji = String(emoji || "").trim();
	if (!safeEmoji) return null;
	if (POD_LIST_EMOJI_ICON_CACHE.has(safeEmoji)) {
		return POD_LIST_EMOJI_ICON_CACHE.get(safeEmoji);
	}
	const codepoints = getPodListTwemojiCodepoints(safeEmoji);
	if (!codepoints) {
		POD_LIST_EMOJI_ICON_CACHE.set(safeEmoji, null);
		return null;
	}
	try {
		const response = await axios.get(
			`${POD_LIST_TWEMOJI_BASE_URL}/${codepoints}.svg`,
			{
				responseType: "text",
				timeout: 15000,
			},
		);
		const dataUri = `data:image/svg+xml;base64,${Buffer.from(
			String(response.data || ""),
		).toString("base64")}`;
		POD_LIST_EMOJI_ICON_CACHE.set(safeEmoji, dataUri);
		return dataUri;
	} catch (error) {
		console.warn("[pod-list-emoji] Failed loading emoji asset", {
			emoji: safeEmoji,
			codepoints,
			status: error?.response?.status || null,
			message: error?.message,
		});
		POD_LIST_EMOJI_ICON_CACHE.set(safeEmoji, null);
		return null;
	}
}

function normalizePrintAreaPosition(value = "") {
	return String(value || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_");
}

function formatCatalogPlaceholder(placeholder = {}) {
	const width = Number(placeholder?.width);
	const height = Number(placeholder?.height);
	return {
		position: normalizePrintAreaPosition(placeholder?.position || ""),
		decoration_method: String(placeholder?.decoration_method || "").trim(),
		width: Number.isFinite(width) ? width : null,
		height: Number.isFinite(height) ? height : null,
		aspect_ratio:
			Number.isFinite(width) && Number.isFinite(height) && height > 0
				? width / height
				: null,
	};
}

function getMockupCameraLabel(image = {}) {
	const explicit = String(
		image?.camera_label || image?.cameraLabel || "",
	).trim();
	if (explicit) return explicit.toLowerCase();
	const src = String(image?.src || "");
	try {
		const url = new URL(src);
		const queryLabel = String(
			url.searchParams.get("camera_label") || "",
		).trim();
		if (queryLabel) return queryLabel.toLowerCase();
	} catch {}
	const fallbackMatch = src.toLowerCase().match(/camera_label=([a-z0-9_-]+)/i);
	return fallbackMatch?.[1] || "";
}

function getPreferredPreviewCameraLabels(product = {}, positionInput = "") {
	const kind = getPodListProductKind(product);
	const position = normalizePrintAreaPosition(positionInput);

	if (position.includes("back")) return ["back"];
	if (position.includes("left_sleeve"))
		return ["left", "left-front", "left-back"];
	if (position.includes("right_sleeve"))
		return ["right", "right-front", "right-back"];
	if (position.includes("neck")) return ["front"];

	if (kind === "mug") {
		return ["front", "right", "left", "angled-1", "angled-2"];
	}
	if (kind === "bag") {
		return ["front"];
	}
	if (kind === "tote") {
		return position.includes("back") ? ["back"] : ["front"];
	}
	if (kind === "pillow" || kind === "magnet" || kind === "candle") {
		return ["front"];
	}
	if (kind === "apparel" || kind === "hoodie") {
		return position.includes("back")
			? ["back"]
			: ["front", "lifestyle", "model", "wearing"];
	}
	return ["front"];
}

function scorePodListPlaceholder(placeholder = {}, product = {}) {
	const position = String(placeholder?.position || "").toLowerCase();
	const hasImage =
		Array.isArray(placeholder?.images) && placeholder.images.length > 0;
	const kind = getPodListProductKind(product);
	let score = 0;

	if (hasImage) score += 4;
	if (position.includes("front")) score += 12;
	if (position.includes("center")) score += 7;
	if (position.includes("default")) score += 4;
	if (position.includes("full")) score += 5;
	if (position.includes("back")) score -= 6;
	if (position.includes("sleeve")) score -= 8;
	if (position.includes("neck")) score -= 7;

	if (kind === "mug") {
		if (position.includes("wrap")) score += 8;
		if (position.includes("front")) score += 7;
		if (position.includes("left") || position.includes("right")) score -= 2;
	}

	if (kind === "apparel" || kind === "hoodie") {
		if (position.includes("front")) score += 8;
		if (position.includes("center")) score += 5;
		if (position.includes("left_chest") || position.includes("right_chest"))
			score -= 6;
		if (position.includes("pocket")) score -= 5;
	}

	if (
		kind === "tote" ||
		kind === "bag" ||
		kind === "pillow" ||
		kind === "magnet"
	) {
		if (position.includes("front")) score += 8;
	}

	return score;
}

function pickBestPodListPlaceholder(placeholders = [], product = {}) {
	const safe = Array.isArray(placeholders) ? placeholders : [];
	if (!safe.length) return null;
	const kind = getPodListProductKind(product);
	let candidates = [...safe];
	if (
		kind === "apparel" ||
		kind === "hoodie" ||
		kind === "bag" ||
		kind === "pillow" ||
		kind === "candle"
	) {
		const frontPreferred = candidates.filter((placeholder) => {
			const position = String(placeholder?.position || "").toLowerCase();
			return (
				position.includes("front") ||
				position.includes("center") ||
				position.includes("default") ||
				position.includes("full")
			);
		});
		if (frontPreferred.length) {
			candidates = frontPreferred;
		}
	}
	return candidates.sort(
		(a, b) =>
			scorePodListPlaceholder(b, product) - scorePodListPlaceholder(a, product),
	)[0];
}

function getPodListPlacementDefaults(product = {}, positionInput = "") {
	const kind = getPodListProductKind(product);
	const position = String(positionInput || "").toLowerCase();
	let base;

	switch (kind) {
		case "apparel":
			base = { x: 0.5, y: 0.39, scale: 1.18, angle: 0 };
			break;
		case "hoodie":
			base = { x: 0.5, y: 0.37, scale: 1.16, angle: 0 };
			break;
		case "tote":
			base = { x: 0.5, y: 0.47, scale: 1.26, angle: 0 };
			break;
		case "bag":
			base = { x: 0.5, y: 0.16, scale: 0.64, angle: 0 };
			break;
		case "mug":
			base = { x: 0.5, y: 0.5, scale: 0.86, angle: 0 };
			break;
		case "pillow":
			base = { x: 0.25, y: 0.5, scale: 0.56, angle: 0 };
			break;
		case "magnet":
			base = { x: 0.5, y: 0.5, scale: 0.9, angle: 0 };
			break;
		case "candle":
			base = { x: 0.5, y: 0.5, scale: 1.72, angle: 0 };
			break;
		default:
			base = { x: 0.5, y: 0.5, scale: 1.02, angle: 0 };
	}

	if (position.includes("left_chest")) {
		return {
			x: 0.38,
			y: 0.34,
			scale: Math.min(0.64, base.scale * 0.58),
			angle: 0,
		};
	}
	if (position.includes("right_chest")) {
		return {
			x: 0.62,
			y: 0.34,
			scale: Math.min(0.64, base.scale * 0.58),
			angle: 0,
		};
	}
	if (position.includes("sleeve")) {
		return {
			x: position.includes("left") ? 0.23 : 0.77,
			y: 0.38,
			scale: Math.min(0.48, base.scale * 0.44),
			angle: 0,
		};
	}
	if (position.includes("back")) {
		return {
			...base,
			y: Math.min(0.5, base.y + 0.02),
			scale: base.scale * 0.95,
		};
	}
	return base;
}

function getPodPreviewPlacementBoost(product = {}, positionInput = "") {
	const kind = getPodListProductKind(product);
	const position = String(positionInput || "").toLowerCase();
	let boost = 1.22;

	if (kind === "apparel") boost = 1.58;
	else if (kind === "hoodie") boost = 1.52;
	else if (kind === "tote") boost = 1.32;
	else if (kind === "bag") boost = 1;
	else if (kind === "mug") boost = 1.24;
	else if (kind === "pillow") boost = 1.0;
	else if (kind === "magnet") boost = 1.2;
	else if (kind === "candle") boost = 1.26;

	if (
		position.includes("left_chest") ||
		position.includes("right_chest") ||
		position.includes("sleeve")
	) {
		boost *= 0.8;
	}
	if (position.includes("back")) {
		boost *= 0.9;
	}

	return Math.max(1, Math.min(1.9, boost));
}

function getPodListOccasionScaleBoost(occasion = "", product = {}) {
	const safeOccasion = normalizePodListOccasion(occasion);
	if (safeOccasion !== "Ramadan") return 1;
	const kind = getPodListProductKind(product);
	let boost = 1.1;
	if (kind === "apparel") boost = 1.14;
	else if (kind === "hoodie") boost = 1.14;
	else if (kind === "tote") boost = 1.1;
	else if (kind === "bag") boost = 1.04;
	else if (kind === "mug") boost = 1.08;
	else if (kind === "pillow" || kind === "magnet") boost = 1.04;
	else if (kind === "candle") boost = 1.18;
	return Math.max(1, Math.min(1.6, boost));
}

function getFullPrintAreaPreviewScale(product = {}, positionInput = "") {
	return 1;
}

function resolvePodListPlacementFromSource({
	sourceImage,
	placementDefaults,
	forceSourcePlacement = false,
}) {
	const sourceX = Number(sourceImage?.x);
	const sourceY = Number(sourceImage?.y);
	const sourceScale = Number(sourceImage?.scale);
	const sourceAngle = Number(sourceImage?.angle);
	const hasValidSourcePlacement =
		Number.isFinite(sourceX) &&
		Number.isFinite(sourceY) &&
		Number.isFinite(sourceScale) &&
		sourceX >= 0 &&
		sourceX <= 1 &&
		sourceY >= 0 &&
		sourceY <= 1 &&
		sourceScale >= 0.18 &&
		sourceScale <= 2.6;
	const baseScale = Number(placementDefaults.scale || 0.88);
	const sourceNearExpectedArea =
		forceSourcePlacement ||
		(hasValidSourcePlacement &&
			Math.abs(sourceX - Number(placementDefaults.x || 0.5)) <= 0.2 &&
			Math.abs(sourceY - Number(placementDefaults.y || 0.5)) <= 0.22);
	const minAcceptedScale = forceSourcePlacement
		? 0.18
		: Math.max(0.42, baseScale * 0.9);
	const maxAcceptedScale = forceSourcePlacement
		? 2.6
		: Math.max(1.26, baseScale * 1.16);
	const sourcePlacementIsTooSmall =
		hasValidSourcePlacement && sourceScale < minAcceptedScale;
	const sourcePlacementIsTooLarge =
		hasValidSourcePlacement && sourceScale > maxAcceptedScale;
	const useSourcePlacement =
		hasValidSourcePlacement &&
		sourceNearExpectedArea &&
		!sourcePlacementIsTooSmall &&
		!sourcePlacementIsTooLarge;
	const finalX = useSourcePlacement
		? sourceX
		: Number(placementDefaults.x || 0.5);
	const finalY = useSourcePlacement
		? sourceY
		: Number(placementDefaults.y || 0.5);
	const finalScale = useSourcePlacement
		? Math.min(maxAcceptedScale, Math.max(minAcceptedScale, sourceScale))
		: baseScale;
	const finalAngle = useSourcePlacement
		? Number.isFinite(sourceAngle)
			? sourceAngle
			: 0
		: Number(placementDefaults.angle || 0);

	return {
		finalX,
		finalY,
		finalScale,
		finalAngle,
		hasValidSourcePlacement,
		sourceNearExpectedArea,
		sourcePlacementIsTooSmall,
		sourcePlacementIsTooLarge,
		minAcceptedScale,
		maxAcceptedScale,
		useSourcePlacement,
		sourcePlacement: {
			x: Number.isFinite(sourceX) ? sourceX : null,
			y: Number.isFinite(sourceY) ? sourceY : null,
			scale: Number.isFinite(sourceScale) ? sourceScale : null,
			angle: Number.isFinite(sourceAngle) ? sourceAngle : null,
		},
	};
}

function getPodListDesignLayout(product = {}) {
	const kind = getPodListProductKind(product);
	switch (kind) {
		case "apparel":
			return {
				canvasWidth: 1400,
				canvasHeight: 920,
				maxCharsPerLine: 15,
				maxLines: 2,
				lineHeight: 92,
				textFontSize: 98,
				textBaseY: 544,
				textX: 700,
				iconCx: 700,
				iconCy: 300,
				iconR: 50,
				iconFontSize: 44,
				panelX: 270,
				panelY: 372,
				panelWidth: 860,
				panelHeight: 246,
				panelRadius: 56,
				panelStrokeWidth: 6,
			};
		case "hoodie":
			return {
				canvasWidth: 1480,
				canvasHeight: 980,
				maxCharsPerLine: 15,
				maxLines: 2,
				lineHeight: 92,
				textFontSize: 96,
				textBaseY: 572,
				textX: 740,
				iconCx: 740,
				iconCy: 322,
				iconR: 52,
				iconFontSize: 46,
				panelX: 286,
				panelY: 404,
				panelWidth: 908,
				panelHeight: 252,
				panelRadius: 58,
				panelStrokeWidth: 6,
			};
		case "tote":
			return {
				canvasWidth: 1380,
				canvasHeight: 1060,
				maxCharsPerLine: 15,
				maxLines: 2,
				lineHeight: 88,
				textFontSize: 90,
				textBaseY: 620,
				textX: 690,
				iconCx: 690,
				iconCy: 340,
				iconR: 46,
				iconFontSize: 42,
				panelX: 264,
				panelY: 448,
				panelWidth: 852,
				panelHeight: 236,
				panelRadius: 52,
				panelStrokeWidth: 6,
			};
		case "bag":
			return {
				canvasWidth: 1460,
				canvasHeight: 1040,
				maxCharsPerLine: 15,
				maxLines: 2,
				lineHeight: 86,
				textFontSize: 88,
				textBaseY: 602,
				textX: 730,
				iconCx: 730,
				iconCy: 332,
				iconR: 46,
				iconFontSize: 42,
				panelX: 286,
				panelY: 432,
				panelWidth: 888,
				panelHeight: 230,
				panelRadius: 50,
				panelStrokeWidth: 6,
			};
		case "mug":
			return {
				canvasWidth: 1320,
				canvasHeight: 980,
				maxCharsPerLine: 19,
				maxLines: 2,
				lineHeight: 86,
				textFontSize: 84,
				textBaseY: 560,
				textX: 660,
				iconCx: 660,
				iconCy: 326,
				iconR: 46,
				iconFontSize: 40,
				panelX: 320,
				panelY: 430,
				panelWidth: 680,
				panelHeight: 238,
				panelRadius: 54,
				panelStrokeWidth: 5,
			};
		case "pillow":
			return {
				canvasWidth: 1600,
				canvasHeight: 1600,
				maxCharsPerLine: 10,
				maxLines: 3,
				lineHeight: 112,
				textFontSize: 112,
				textBaseY: 842,
				textX: 800,
				iconCx: 800,
				iconCy: 468,
				iconR: 48,
				iconFontSize: 34,
				panelX: 224,
				panelY: 220,
				panelWidth: 1152,
				panelHeight: 1160,
				panelRadius: 104,
				panelStrokeWidth: 6,
				ornamentYRatio: 0.55,
				ornamentInsetRatio: 0.16,
				ornamentStyle: "diamond",
			};
		case "magnet":
			return {
				canvasWidth: 1600,
				canvasHeight: 1600,
				maxCharsPerLine: 10,
				maxLines: 3,
				lineHeight: 126,
				textFontSize: 132,
				textBaseY: 852,
				textX: 800,
				iconCx: 800,
				iconCy: 430,
				iconR: 52,
				iconFontSize: 38,
				panelX: 172,
				panelY: 150,
				panelWidth: 1256,
				panelHeight: 1268,
				panelRadius: 92,
				panelStrokeWidth: 6,
				ornamentYRatio: 0.55,
				ornamentInsetRatio: 0.17,
				ornamentStyle: "diamond",
			};
		case "candle":
			return {
				canvasWidth: 1480,
				canvasHeight: 1120,
				maxCharsPerLine: 10,
				maxLines: 3,
				lineHeight: 120,
				textFontSize: 104,
				textBaseY: 650,
				textX: 740,
				iconCx: 740,
				iconCy: 360,
				iconR: 42,
				iconFontSize: 30,
				panelX: 124,
				panelY: 120,
				panelWidth: 1232,
				panelHeight: 876,
				panelRadius: 92,
				panelStrokeWidth: 7,
				ornamentYRatio: 0.55,
				ornamentInsetRatio: 0.18,
				ornamentStyle: "diamond",
			};
		default:
			return {
				canvasWidth: 1640,
				canvasHeight: 1240,
				maxCharsPerLine: 22,
				maxLines: 2,
				lineHeight: 96,
				textFontSize: 84,
				textBaseY: 678,
				textX: 820,
				iconCx: 820,
				iconCy: 326,
				iconR: 58,
				iconFontSize: 52,
				panelX: 268,
				panelY: 458,
				panelWidth: 1104,
				panelHeight: 228,
				panelRadius: 58,
				panelStrokeWidth: 6,
			};
	}
}

function escapeForSvg(text = "") {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function buildPodListDiamondOrnamentSvg({
	x = 0,
	y = 0,
	size = 18,
	fill = "rgba(120, 80, 40, 0.42)",
}) {
	const safeX = Math.round(Number(x) || 0);
	const safeY = Math.round(Number(y) || 0);
	const safeSize = Math.max(8, Math.round(Number(size) || 18));
	const half = safeSize / 2;
	const dotOffset = Math.round(safeSize * 0.86);
	const dotRadius = Math.max(2, Math.round(safeSize * 0.18));
	return `<g fill="${fill}">
		<rect x="${safeX - half}" y="${safeY - half}" width="${safeSize}" height="${safeSize}" rx="${Math.max(1, Math.round(safeSize * 0.14))}" ry="${Math.max(1, Math.round(safeSize * 0.14))}" transform="rotate(45 ${safeX} ${safeY})"/>
		<circle cx="${safeX - dotOffset}" cy="${safeY}" r="${dotRadius}"/>
		<circle cx="${safeX + dotOffset}" cy="${safeY}" r="${dotRadius}"/>
	</g>`;
}

function splitPodListSvgLines(message, maxCharsPerLine = 22, maxLines = 3) {
	const safeMaxChars = Math.max(6, Number(maxCharsPerLine) || 22);
	const safeMaxLines = Math.max(1, Number(maxLines) || 3);
	const words = String(message || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!words.length) return ["Made with love"];

	const wrapByCharLimit = (limit) => {
		const safeLimit = Math.max(6, Number(limit) || safeMaxChars);
		const wrapped = [];
		let current = "";
		for (const word of words) {
			const tentative = current ? `${current} ${word}` : word;
			if (!current || tentative.length <= safeLimit) {
				current = tentative;
				continue;
			}
			wrapped.push(current);
			current = word;
		}
		if (current) wrapped.push(current);
		return wrapped;
	};

	const initialLines = wrapByCharLimit(safeMaxChars);
	if (initialLines.length <= safeMaxLines) {
		return initialLines;
	}

	// Keep full message by expanding line capacity before any truncation.
	const totalChars = words.join(" ").length;
	let adaptiveLimit = Math.max(
		safeMaxChars,
		Math.ceil(totalChars / safeMaxLines),
	);
	let adaptiveLines = initialLines;
	const maxAdaptiveLimit = Math.max(
		adaptiveLimit,
		safeMaxChars * 4,
		totalChars,
	);
	while (
		adaptiveLines.length > safeMaxLines &&
		adaptiveLimit <= maxAdaptiveLimit
	) {
		adaptiveLines = wrapByCharLimit(adaptiveLimit);
		if (adaptiveLines.length <= safeMaxLines) {
			return adaptiveLines;
		}
		adaptiveLimit += 1;
	}

	// Final fallback: preserve all text by merging the remaining content into
	// the last line instead of adding ellipsis.
	const mergedLines = adaptiveLines.slice(0, safeMaxLines);
	mergedLines[safeMaxLines - 1] = adaptiveLines
		.slice(safeMaxLines - 1)
		.join(" ");
	return mergedLines;
}

function buildPodListDesignSvgDataUri({ message, preset, product }) {
	const safeIcon = escapeForSvg(
		preset.svgAccentIcon || preset.accentIcon || "\u2726",
	);
	const safeTextColor = escapeForSvg(preset.textColor || "#1f2937");
	const safeBackgroundColor = escapeForSvg(preset.backgroundColor || "#fff7ed");
	const safePanelGradientStart = escapeForSvg(
		preset.panelGradientStart || preset.backgroundColor || "#fff7ed",
	);
	const safePanelGradientEnd = escapeForSvg(
		preset.panelGradientEnd || preset.backgroundColor || "#ffe7d6",
	);
	const safePanelBorderColor = escapeForSvg(
		preset.panelBorderColor ||
			preset.accentBorderColor ||
			"rgba(31, 41, 55, 0.2)",
	);
	const safeTextShadowColor = escapeForSvg(
		preset.textShadowColor || "rgba(15, 23, 42, 0.22)",
	);
	const safeAccentTextColor = escapeForSvg(preset.accentTextColor || "#1f2937");
	const safeAccentBackgroundColor = escapeForSvg(
		preset.accentBackgroundColor || "#ffffff",
	);
	const safeAccentBackgroundColor2 = escapeForSvg(
		preset.accentBackgroundColor2 || preset.accentBackgroundColor || "#f3f4f6",
	);
	const safeBorderColor = escapeForSvg(
		preset.accentBorderColor || "rgba(31, 41, 55, 0.18)",
	);
	const safeOrnamentLeft = escapeForSvg(preset.ornamentLeft || "\u2726");
	const safeOrnamentRight = escapeForSvg(preset.ornamentRight || "\u2726");
	const safeOrnamentColor = escapeForSvg(
		preset.ornamentColor || "rgba(120, 80, 40, 0.42)",
	);
	const safeFontFamily = escapeForSvg(preset.fontFamily || "Georgia, serif");
	const safeIconFontFamily = escapeForSvg(
		preset.iconFontFamily ||
			preset.fontFamily ||
			"'Segoe UI Symbol', 'Apple Symbols', 'Arial Unicode MS', serif",
	);
	const safeFontWeight = escapeForSvg(String(preset.fontWeight || "700"));
	const safeFontStyle = escapeForSvg(preset.fontStyle || "normal");
	const layout = getPodListDesignLayout(product);
	const canvasWidth = Number(layout.canvasWidth) || 1600;
	const canvasHeight = Number(layout.canvasHeight) || 1600;
	const textSizeBoost = Number.isFinite(Number(preset.textSizeBoost))
		? Number(preset.textSizeBoost)
		: 1;
	const iconScaleBoost = Number.isFinite(Number(preset.iconScaleBoost))
		? Number(preset.iconScaleBoost)
		: 1;
	const panelScaleX = Number.isFinite(Number(preset.panelScaleX))
		? Number(preset.panelScaleX)
		: 1;
	const panelScaleY = Number.isFinite(Number(preset.panelScaleY))
		? Number(preset.panelScaleY)
		: 1;
	const lineHeightScale = Number.isFinite(Number(preset.lineHeightScale))
		? Number(preset.lineHeightScale)
		: 1;
	const borderRadius = Number.isFinite(Number(preset.borderRadius))
		? Number(preset.borderRadius)
		: 18;
	const baseMaxCharsPerLine = Number(layout.maxCharsPerLine) || 22;
	const maxLines = Number(layout.maxLines) || 2;
	const rawTextLines = splitPodListSvgLines(
		String(message || "Made with love"),
		baseMaxCharsPerLine,
		maxLines,
	);
	const textLines = rawTextLines.map((line) => escapeForSvg(line));
	const longestLineCharCount = rawTextLines.reduce(
		(max, line) => Math.max(max, String(line || "").length),
		0,
	);
	const lineCompressionScale =
		longestLineCharCount > baseMaxCharsPerLine
			? Math.max(
					0.62,
					baseMaxCharsPerLine /
						Math.max(baseMaxCharsPerLine, longestLineCharCount),
				)
			: 1;
	const baseLineHeight = Number(layout.lineHeight) || 132;
	const lineHeight = Math.max(
		58,
		Math.round(baseLineHeight * lineHeightScale * lineCompressionScale),
	);
	const basePanelX = Number(layout.panelX) || Math.round(canvasWidth * 0.06);
	const basePanelY = Number(layout.panelY) || Math.round(canvasHeight * 0.36);
	const basePanelWidth =
		Number(layout.panelWidth) || Math.round(canvasWidth - basePanelX * 2);
	const basePanelHeight =
		Number(layout.panelHeight) || Math.round(canvasHeight * 0.46);
	const panelWidth = Math.min(
		Math.round(canvasWidth * 0.94),
		Math.max(260, Math.round(basePanelWidth * panelScaleX)),
	);
	const panelHeight = Math.min(
		Math.round(canvasHeight * 0.72),
		Math.max(120, Math.round(basePanelHeight * panelScaleY)),
	);
	const panelX = Math.round((canvasWidth - panelWidth) / 2);
	const panelY = Math.max(
		0,
		Math.round(basePanelY - (panelHeight - basePanelHeight) * 0.45),
	);
	const baseTextBaseY =
		Number(layout.textBaseY) || Math.round(canvasHeight * 0.58);
	const textBaseY = Math.round(
		baseTextBaseY +
			(panelY - basePanelY) +
			Math.round((panelHeight - basePanelHeight) * 0.24),
	);
	const startY = textBaseY - ((textLines.length - 1) * lineHeight) / 2;
	const textX = Number(layout.textX) || Math.round(canvasWidth / 2);
	const iconCx = Number(layout.iconCx) || Math.round(canvasWidth / 2);
	const baseIconR = Number(layout.iconR) || Math.round(canvasWidth * 0.07);
	const iconR = Math.max(34, Math.round(baseIconR * iconScaleBoost));
	const baseIconCy = Number(layout.iconCy) || Math.round(canvasHeight * 0.3);
	const iconCy = Math.max(
		iconR + 10,
		Math.round(baseIconCy - (iconR - baseIconR) * 0.42),
	);
	const iconFontSize = Math.max(
		24,
		Math.round(
			(Number(layout.iconFontSize) || Math.round(baseIconR * 0.95)) *
				iconScaleBoost,
		),
	);
	const panelStrokeWidth = Number(layout.panelStrokeWidth) || 8;
	const panelRadius = Math.max(
		30,
		Math.min(180, Number(layout.panelRadius || borderRadius * 2.4)),
	);
	const textFontSize = Math.max(
		42,
		Math.round(
			(Number(layout.textFontSize) || 116) *
				textSizeBoost *
				lineCompressionScale,
		),
	);
	const ornamentInsetRatio = Number.isFinite(Number(layout.ornamentInsetRatio))
		? Math.max(0.02, Math.min(0.24, Number(layout.ornamentInsetRatio)))
		: null;
	const ornamentInsetPx = Number.isFinite(Number(layout.ornamentInsetPx))
		? Math.max(24, Number(layout.ornamentInsetPx))
		: null;
	const ornamentInset =
		ornamentInsetPx ||
		(ornamentInsetRatio !== null
			? Math.max(34, Math.round(panelWidth * ornamentInsetRatio))
			: Math.max(38, Math.round(panelWidth * 0.05)));
	const ornamentY = Number.isFinite(Number(layout.ornamentYRatio))
		? panelY +
			Math.round(
				panelHeight *
					Math.max(0.16, Math.min(0.84, Number(layout.ornamentYRatio))),
			)
		: panelY + panelHeight - Math.max(24, Math.round(panelHeight * 0.18));
	const ornamentLeftX = panelX + ornamentInset;
	const ornamentRightX = panelX + panelWidth - ornamentInset;
	const ornamentSize = Math.max(14, Math.round(textFontSize * 0.16));
	const ornamentMarkup =
		layout.ornamentStyle === "diamond"
			? `${buildPodListDiamondOrnamentSvg({
					x: ornamentLeftX,
					y: ornamentY,
					size: ornamentSize,
					fill: safeOrnamentColor,
				})}
				${buildPodListDiamondOrnamentSvg({
					x: ornamentRightX,
					y: ornamentY,
					size: ornamentSize,
					fill: safeOrnamentColor,
				})}`
			: `<text x="${ornamentLeftX}" y="${ornamentY}" text-anchor="middle" dominant-baseline="middle" style="font-family: ${safeFontFamily}; font-size: ${Math.max(34, Math.round(textFontSize * 0.34))}px; font-weight: 700; fill: ${safeOrnamentColor};">${safeOrnamentLeft}</text>
	<text x="${ornamentRightX}" y="${ornamentY}" text-anchor="middle" dominant-baseline="middle" style="font-family: ${safeFontFamily}; font-size: ${Math.max(34, Math.round(textFontSize * 0.34))}px; font-weight: 700; fill: ${safeOrnamentColor};">${safeOrnamentRight}</text>`;
	const textTspans = textLines
		.map((line, index) => {
			const dy = index === 0 ? 0 : lineHeight;
			return `<tspan x="${textX}" dy="${dy}">${line}</tspan>`;
		})
		.join("");

	const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
	<defs>
		<linearGradient id="panelGrad" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" stop-color="${safePanelGradientStart}"/>
			<stop offset="100%" stop-color="${safePanelGradientEnd}"/>
		</linearGradient>
		<linearGradient id="iconGrad" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" stop-color="${safeAccentBackgroundColor}"/>
			<stop offset="100%" stop-color="${safeAccentBackgroundColor2}"/>
		</linearGradient>
		<filter id="softShadow" x="-20%" y="-20%" width="140%" height="150%">
			<feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#0f172a" flood-opacity="0.22"/>
		</filter>
		<filter id="titleShadow" x="-25%" y="-25%" width="150%" height="150%">
			<feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="${safeTextShadowColor}" flood-opacity="0.65"/>
		</filter>
	</defs>
	<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="transparent"/>
	<rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="${panelRadius}" ry="${panelRadius}" fill="url(#panelGrad)" stroke="${safePanelBorderColor}" stroke-width="${panelStrokeWidth}" filter="url(#softShadow)"/>
	<circle cx="${iconCx}" cy="${iconCy}" r="${iconR}" fill="url(#iconGrad)" stroke="${safeBorderColor}" stroke-width="${Math.max(6, Math.round(panelStrokeWidth * 0.9))}" filter="url(#softShadow)"/>
	<text x="${iconCx}" y="${iconCy}" text-anchor="middle" dominant-baseline="middle" style="font-family: ${safeIconFontFamily}; font-size: ${iconFontSize}px; font-weight: 700; fill: ${safeAccentTextColor};">${safeIcon}</text>
	${ornamentMarkup}
	<text x="${textX}" y="${startY}" text-anchor="middle" filter="url(#titleShadow)" style="font-family: ${safeFontFamily}; font-size: ${textFontSize}px; font-weight: ${safeFontWeight}; font-style: ${safeFontStyle}; fill: ${safeTextColor}; letter-spacing: -0.02em;">${textTspans}</text>
</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function buildFrontendSyncedPodListDesignAsset({
	message,
	preset,
	product,
	sourcePlaceholder = null,
	sourcePosition = "front",
}) {
	const kind = getPodListProductKind(product);
	if (!shouldUseFrontendSyncedPodListAsset(product)) {
		return {
			dataUri: buildPodListDesignSvgDataUri({ message, preset, product }),
			placementAsset: null,
		};
	}

	const surface = getPodListEditorSurfaceConfig(product, sourcePosition);
	const widthRatio = Math.max(1, Number(surface?.widthRatio) || 1);
	const heightRatio = Math.max(1, Number(surface?.heightRatio) || 1);
	const canvasWidth = kind === "candle" ? 360 : 420;
	const canvasHeight = Math.max(
		kind === "candle" ? 396 : 420,
		Math.round((canvasWidth * heightRatio) / widthRatio),
	);
	const safeBounds = resolvePodListSafeBounds(
		canvasWidth,
		canvasHeight,
		Number(surface?.clampInset) || 0,
	);
	const safeStartX = safeBounds.minX;
	const safeStartY = safeBounds.minY;
	const safeWidth = Math.max(120, safeBounds.maxX - safeBounds.minX);
	const safeHeight = Math.max(90, safeBounds.maxY - safeBounds.minY);
	const geometry = resolvePodListAutoDesignGeometry(product, preset);
	const isPillowDesign = kind === "pillow";
	const isMagnetDesign = kind === "magnet";
	const isCandleDesign = kind === "candle";
	const widthCapRatio = isPillowDesign ? 0.95 : isMagnetDesign ? 0.95 : 0.98;
	const minMessageWidth = isPillowDesign ? 270 : isMagnetDesign ? 258 : 304;
	const minMessageHeight = isPillowDesign ? 170 : isMagnetDesign ? 176 : 282;
	const minIconSize = isPillowDesign ? 34 : isMagnetDesign ? 40 : 28;

	let messageWidth = Math.min(
		Math.round(safeWidth * widthCapRatio),
		Math.max(
			minMessageWidth,
			Math.round(safeWidth * geometry.messageWidthRatio),
		),
	);
	let messageHeight = Math.min(
		geometry.maxMessageHeight || 86,
		Math.max(
			minMessageHeight,
			Math.round(safeHeight * geometry.messageHeightRatio),
		),
	);
	let iconSize = Math.min(
		geometry.maxIconSize || 44,
		Math.max(
			minIconSize,
			Math.round(safeWidth * geometry.iconSizeRatio),
		),
	);
	const rawMessageRect = {
		x: safeStartX + Math.round((safeWidth - messageWidth) / 2),
		y: 0,
		width: messageWidth,
		height: messageHeight,
	};
	const rawIconRect = {
		x: safeStartX + Math.round((safeWidth - iconSize) / 2),
		y: 0,
		width: iconSize,
		height: iconSize,
	};
	const minMessageY = isPillowDesign
		? safeStartY
		: safeStartY + Math.max(0, iconSize - geometry.iconOverlapPx);
	const maxMessageY = safeStartY + safeHeight - messageHeight;
	rawMessageRect.y = Math.max(
		minMessageY,
		Math.min(
			Math.max(minMessageY, maxMessageY),
			safeStartY + Math.round((safeHeight - messageHeight) / 2),
		),
	);
	rawIconRect.y = Math.max(
		safeStartY,
		Math.min(
			safeStartY + safeHeight - iconSize,
			isCandleDesign
				? rawMessageRect.y + Math.round(messageHeight * 0.11)
				: isPillowDesign
					? rawMessageRect.y + Math.round(messageHeight * 0.155)
				: rawMessageRect.y + Math.round(messageHeight * 0.195),
		),
	);
	const messageRect = clampPodListElementRectWithinBounds(rawMessageRect, safeBounds);
	const iconRect = clampPodListElementRectWithinBounds(rawIconRect, safeBounds);
	const textFontFactor = isPillowDesign ? 0.188 : isMagnetDesign ? 0.305 : 0.235;
	const textFontMin = isPillowDesign ? 20 : isMagnetDesign ? 20 : 20;
	const textFontMax = isPillowDesign ? 40 : isMagnetDesign ? 52 : 52;
	const iconFontFactor = isPillowDesign ? 0.64 : isMagnetDesign ? 0.72 : 0.7;
	const iconFontMin = isPillowDesign ? 20 : isMagnetDesign ? 20 : 18;
	const iconFontMax = isPillowDesign ? 32 : isMagnetDesign ? 40 : 34;
	let textFontSize = Math.max(
		textFontMin,
		Math.min(
			textFontMax,
			Math.round(messageRect.height * textFontFactor),
		),
	);
	const iconFontSize = Math.max(
		iconFontMin,
		Math.min(iconFontMax, Math.round(iconRect.height * iconFontFactor)),
	);
	const messageGradientStart =
		preset.messageGradientStart || preset.backgroundColor || "#fff7ed";
	const messageGradientEnd =
		preset.messageGradientEnd || preset.backgroundColor || "#fff7ed";
	const iconGradientStart =
		preset.accentBackgroundColor || preset.messageGradientStart || "#ffffff";
	const iconGradientEnd =
		preset.accentBackgroundColor2 ||
		preset.accentBackgroundColor ||
		"#f3f4f6";
	const borderRadius = isCandleDesign ? 30 : isPillowDesign ? 26 : 22;
	const paddingX = Math.max(
		isPillowDesign ? 10 : isMagnetDesign ? 8 : 10,
		Math.min(
			isPillowDesign ? 16 : isMagnetDesign ? 14 : 18,
			Math.round(
				messageRect.width *
					(isPillowDesign ? 0.03 : isMagnetDesign ? 0.028 : 0.034),
			),
		),
	);
	const paddingY = Math.max(
		isPillowDesign ? 8 : isMagnetDesign ? 6 : 8,
		Math.min(
			isPillowDesign ? 12 : isMagnetDesign ? 12 : 14,
			Math.round(
				messageRect.height *
					(isPillowDesign ? 0.05 : isMagnetDesign ? 0.044 : 0.05),
			),
		),
	);
	const lineHeightFactor = isCandleDesign ? 0.96 : 1.01;
	const messageMaxLines = 3;
	let lines = wrapPodListMessageToWidth({
		message,
		maxWidthPx: Math.max(120, messageRect.width - paddingX * 2 - 8),
		fontSizePx: textFontSize,
		fontFamily: preset.fontFamily,
		maxLines: messageMaxLines,
	});
	let attempts = 0;
	while (
		attempts < 10 &&
		(lines.length > messageMaxLines ||
			lines.length * textFontSize * lineHeightFactor >
				messageRect.height - paddingY * 2)
	) {
		textFontSize = Math.max(textFontMin, textFontSize - 2);
		lines = wrapPodListMessageToWidth({
			message,
			maxWidthPx: Math.max(120, messageRect.width - paddingX * 2 - 8),
			fontSizePx: textFontSize,
			fontFamily: preset.fontFamily,
			maxLines: messageMaxLines,
		});
		attempts += 1;
		if (textFontSize === textFontMin) break;
	}
	if (isCandleDesign && lines.length > 2) {
		textFontSize = Math.max(textFontMin, textFontSize - 4);
		lines = wrapPodListMessageToWidth({
			message,
			maxWidthPx: Math.max(120, messageRect.width - paddingX * 2 - 8),
			fontSizePx: textFontSize,
			fontFamily: preset.fontFamily,
			maxLines: messageMaxLines,
		});
	}
	const lineHeightPx = Math.round(textFontSize * lineHeightFactor);
	const textCenterX = messageRect.x + messageRect.width / 2;
	const textCenterY = messageRect.y + messageRect.height * (isCandleDesign ? 0.57 : 0.5);
	const textStartY =
		textCenterY - ((lines.length - 1) * lineHeightPx) / 2 + textFontSize * 0.08;
	const ornamentOffset = Math.min(
		messageRect.width * 0.34,
		Math.max(textFontSize * 1.6, 88),
	);
	const ornamentY = textCenterY + textFontSize * 0.06;
	const ornamentSize = Math.max(18, Math.round(textFontSize * 0.42));
	const emojiDataUri = await getPodListEmojiAssetDataUri(
		preset.accentIcon || "\u2726",
	);
	const emojiSize = Math.max(18, Math.round(iconRect.width * 0.5));
	const emojiX = iconRect.x + (iconRect.width - emojiSize) / 2;
	const emojiY = iconRect.y + (iconRect.height - emojiSize) / 2;
	const safeTextColor = escapeForSvg(preset.textColor || "#1f2937");
	const safeTextShadowColor = escapeForSvg(
		preset.textShadowColor || "rgba(15, 23, 42, 0.22)",
	);
	const safePanelGradientStart = escapeForSvg(messageGradientStart);
	const safePanelGradientEnd = escapeForSvg(messageGradientEnd);
	const safePanelBorderColor = escapeForSvg(
		preset.messageBorderColor ||
			preset.accentBorderColor ||
			"rgba(31, 41, 55, 0.2)",
	);
	const safeAccentTextColor = escapeForSvg(
		preset.accentTextColor || preset.textColor || "#1f2937",
	);
	const safeAccentBackgroundColor = escapeForSvg(iconGradientStart);
	const safeAccentBackgroundColor2 = escapeForSvg(iconGradientEnd);
	const safeBorderColor = escapeForSvg(
		preset.accentBorderColor || "rgba(31, 41, 55, 0.18)",
	);
	const safeOrnamentColor = escapeForSvg(
		preset.ornamentColor || "rgba(120, 80, 40, 0.42)",
	);
	const safeOrnamentLeft = escapeForSvg(preset.ornamentLeft || "\u2726");
	const safeOrnamentRight = escapeForSvg(preset.ornamentRight || "\u2726");
	const safeFontFamily = escapeForSvg(preset.fontFamily || "Georgia, serif");
	const safeFontWeight = escapeForSvg(String(preset.fontWeight || "700"));
	const safeFontStyle = escapeForSvg(preset.fontStyle || "normal");
	const normalizedBounds = getPodListNormalizedContentBounds(
		[messageRect, iconRect],
		canvasWidth,
		canvasHeight,
	);
	const cropBounds =
		normalizedBounds?.pixelBounds || {
			x: 0,
			y: 0,
			width: canvasWidth,
			height: canvasHeight,
		};
	const placementMode = kind === "pillow" ? "projected" : "direct-wrap";
	const placementAsset = buildPodListPlacementAssetFromBounds({
		normalizedBounds,
		canvasWidth,
		canvasHeight,
		placementMode,
		targetAspectRatio:
			getPodListPlaceholderAspectRatio(sourcePlaceholder) ||
			canvasWidth / canvasHeight,
		projection: getPodListCaptureProjection(product, sourcePosition),
	});
	const ornamentMarkup =
		safeOrnamentLeft || safeOrnamentRight
			? `<text x="${Math.round(textCenterX - ornamentOffset)}" y="${Math.round(
					ornamentY,
				)}" text-anchor="middle" dominant-baseline="middle" style="font-family: ${safeFontFamily}; font-size: ${ornamentSize}px; font-weight: 700; fill: ${safeOrnamentColor};">${safeOrnamentLeft}</text>
	<text x="${Math.round(textCenterX + ornamentOffset)}" y="${Math.round(
					ornamentY,
				)}" text-anchor="middle" dominant-baseline="middle" style="font-family: ${safeFontFamily}; font-size: ${ornamentSize}px; font-weight: 700; fill: ${safeOrnamentColor};">${safeOrnamentRight}</text>`
			: "";
	const textTspans = lines
		.map((line, index) => {
			const safeLine = escapeForSvg(line);
			const dy = index === 0 ? 0 : lineHeightPx;
			return `<tspan x="${Math.round(textCenterX)}" dy="${dy}">${safeLine}</tspan>`;
		})
		.join("");
	const iconMarkup = emojiDataUri
		? `<image href="${emojiDataUri}" x="${Math.round(emojiX)}" y="${Math.round(
				emojiY,
			)}" width="${emojiSize}" height="${emojiSize}" preserveAspectRatio="xMidYMid meet"/>`
		: `<text x="${Math.round(iconRect.x + iconRect.width / 2)}" y="${Math.round(
				iconRect.y + iconRect.height / 2,
			)}" text-anchor="middle" dominant-baseline="middle" style="font-family: ${safeFontFamily}; font-size: ${iconFontSize}px; font-weight: 600; fill: ${safeAccentTextColor};">${escapeForSvg(
				preset.accentIcon || "\u2726",
			)}</text>`;
	const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${cropBounds.width}" height="${cropBounds.height}" viewBox="${cropBounds.x} ${cropBounds.y} ${cropBounds.width} ${cropBounds.height}">
	<defs>
		<linearGradient id="panelGrad" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" stop-color="${safePanelGradientStart}"/>
			<stop offset="100%" stop-color="${safePanelGradientEnd}"/>
		</linearGradient>
		<linearGradient id="iconGrad" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" stop-color="${safeAccentBackgroundColor}"/>
			<stop offset="100%" stop-color="${safeAccentBackgroundColor2}"/>
		</linearGradient>
		<filter id="softShadow" x="-25%" y="-25%" width="150%" height="170%">
			<feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#0f172a" flood-opacity="0.18"/>
		</filter>
		<filter id="titleShadow" x="-25%" y="-25%" width="150%" height="150%">
			<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="${safeTextShadowColor}" flood-opacity="0.5"/>
		</filter>
	</defs>
	<rect x="${Math.round(messageRect.x)}" y="${Math.round(messageRect.y)}" width="${Math.round(
		messageRect.width,
	)}" height="${Math.round(messageRect.height)}" rx="${borderRadius}" ry="${borderRadius}" fill="url(#panelGrad)" stroke="${safePanelBorderColor}" stroke-width="${Math.max(
		1,
		Math.round(Number(preset.messageBorderWidth) || 2),
	)}" filter="url(#softShadow)"/>
	<circle cx="${Math.round(iconRect.x + iconRect.width / 2)}" cy="${Math.round(
		iconRect.y + iconRect.height / 2,
	)}" r="${Math.round(iconRect.width / 2)}" fill="url(#iconGrad)" stroke="${safeBorderColor}" stroke-width="${Math.max(
		1,
		Math.round(Number(preset.accentBorderWidth) || 2),
	)}" filter="url(#softShadow)"/>
	${iconMarkup}
	${ornamentMarkup}
	<text x="${Math.round(textCenterX)}" y="${Math.round(textStartY)}" text-anchor="middle" filter="url(#titleShadow)" style="font-family: ${safeFontFamily}; font-size: ${textFontSize}px; font-weight: ${safeFontWeight}; font-style: ${safeFontStyle}; fill: ${safeTextColor}; letter-spacing: ${escapeForSvg(
		preset.letterSpacing || "0.08px",
	)};">${textTspans}</text>
</svg>`;

	return {
		dataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
		placementAsset,
		debug: {
			kind,
			canvasWidth,
			canvasHeight,
			messageRect,
			iconRect,
			cropBounds,
			normalizedBounds,
		},
	};
}

async function buildPodListDesignAsset({
	message,
	preset,
	product,
	sourcePlaceholder = null,
	sourcePosition = "front",
}) {
	if (shouldUseFrontendSyncedPodListAsset(product)) {
		return buildFrontendSyncedPodListDesignAsset({
			message,
			preset,
			product,
			sourcePlaceholder,
			sourcePosition,
		});
	}
	return {
		dataUri: buildPodListDesignSvgDataUri({ message, preset, product }),
		placementAsset: null,
	};
}

function makePodListPreviewCacheKey({ productId, variantId, occasion, name }) {
	const hashInput = JSON.stringify({
		version: POD_LIST_PREVIEW_CACHE_VERSION,
		productId: String(productId || ""),
		variantId: String(variantId || ""),
		occasion: normalizePodListOccasion(occasion),
		name: sanitizePodListName(name),
	});
	const digest = crypto
		.createHash("sha1")
		.update(hashInput)
		.digest("hex")
		.slice(0, 18);
	return `${productId}:${variantId || "na"}:${digest}`;
}

function getCachedPodListPreview(cacheKey) {
	const entry = podListPreviewMemoryCache.get(cacheKey);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		podListPreviewMemoryCache.delete(cacheKey);
		return null;
	}
	return entry.value;
}

function setCachedPodListPreview(cacheKey, value) {
	podListPreviewMemoryCache.set(cacheKey, {
		expiresAt: Date.now() + POD_LIST_PREVIEW_CACHE_TTL_MS,
		value,
	});
}

function scorePreviewImageForList(image = {}, product = {}) {
	let score = 0;
	const pos = String(image.position || image.placeholder || "").toLowerCase();
	const src = String(image.src || "").toLowerCase();
	const kind = getPodListProductKind(product);
	const isWearable = kind === "apparel" || kind === "hoodie";
	const productFacingHint = /(front|center|main|default|hero|primary)/.test(
		`${pos} ${src}`,
	);
	const strictFacingHint =
		/(front|center|main|default|hero|primary|straight|full)/.test(
			`${pos} ${src}`,
		);
	const angledOrCroppedHint =
		/(side|left|right|back|detail|closeup|zoom|corner|crop|angle|tilt|45)/.test(
			`${pos} ${src}`,
		);
	const strongAngledHint =
		/(side|left|right|back|detail|closeup|zoom|corner|crop|angle|tilt|45|perspective)/.test(
			`${pos} ${src}`,
		);

	if (pos.includes("front")) score += 7;
	if (pos.includes("center")) score += 3;
	if (image.is_default) score += 2;
	if (src.includes("front")) score += 1;
	if (pos.includes("back") || src.includes("back")) score -= 4;

	if (isWearable) {
		const lifestyleHint =
			/(lifestyle|model|wear|wearing|person|people|man|woman|male|female|on-model|on_model|studio)/.test(
				`${pos} ${src}`,
			);
		const flatHint = /(flat|blank|template|ghost|isolated|side)/.test(src);
		if (lifestyleHint) score += 14;
		if (flatHint) score -= 6;
		if (!image.is_default) score += 3;
		if (image.is_default) score -= 2;
	}

	if (!isWearable) {
		if (image.is_default) score += 4;
		if (productFacingHint) score += 3;
		if (strictFacingHint) score += 2;
		if (angledOrCroppedHint) score -= 5;
	}

	if (kind === "mug" && pos.includes("wrap")) score += 5;
	if (kind === "tote" || kind === "bag") {
		if (strictFacingHint) score += 10;
		if (image.is_default) score += 4;
		if (strongAngledHint) score -= 18;
	}
	if (kind === "pillow") {
		if (productFacingHint) score += 8;
		if (strictFacingHint) score += 16;
		if (image.is_default) score += 8;
		if (strongAngledHint) score -= 40;
	}
	if (kind === "candle") {
		if (productFacingHint) score += 6;
		if (strictFacingHint) score += 12;
		if (src.includes("label")) score += 10;
		if (image.is_default) score += 6;
		if (strongAngledHint) score -= 14;
	}
	return score;
}

function normalizeVariantId(value) {
	const num = Number(value);
	if (Number.isFinite(num) && num > 0) return num;
	return value;
}

function pickProductFallbackImage(product = {}) {
	const productImages = product?.productAttributes?.[0]?.productImages;
	const thumbnailImages = product?.thumbnailImage?.[0]?.images;
	const printifyImages = product?.printifyProductDetails?.images;
	const candidates = [
		Array.isArray(productImages) ? productImages[0]?.url : null,
		Array.isArray(productImages) ? productImages[0]?.src : null,
		Array.isArray(thumbnailImages) ? thumbnailImages[0]?.url : null,
		Array.isArray(thumbnailImages) ? thumbnailImages[0]?.src : null,
		Array.isArray(printifyImages) ? printifyImages[0]?.src : null,
	];
	return candidates.find(Boolean) || null;
}

function resolvePodListVariantId(product, variantIdInput) {
	const printifyVariants = Array.isArray(
		product?.printifyProductDetails?.variants,
	)
		? product.printifyProductDetails.variants
		: [];
	const requested = normalizeVariantId(variantIdInput);
	if (requested) {
		const hasRequested = printifyVariants.some(
			(variant) => String(variant?.id) === String(requested),
		);
		if (hasRequested) return requested;
	}
	const enabledVariant =
		printifyVariants.find((variant) => variant?.is_enabled) ||
		printifyVariants[0];
	return normalizeVariantId(enabledVariant?.id || requested || null);
}

function normalizePodDefaultDesignImages(images = []) {
	const safeImages = Array.isArray(images) ? images : [];
	const dedupe = new Set();
	const normalized = [];
	for (const image of safeImages) {
		const cloudinaryUrl = String(
			image?.cloudinary_url || image?.cloudinaryUrl || "",
		).trim();
		const url = String(image?.url || image?.src || "").trim();
		const preferredUrl = cloudinaryUrl || url;
		if (!preferredUrl) continue;
		if (dedupe.has(preferredUrl)) continue;
		dedupe.add(preferredUrl);
		const originalCloudinaryUrl = String(
			image?.original_cloudinary_url || image?.originalCloudinaryUrl || "",
		).trim();
		const originalCloudinaryPublicId = String(
			image?.original_cloudinary_public_id ||
				image?.originalCloudinaryPublicId ||
				"",
		).trim();
		normalized.push({
			url,
			public_id: String(image?.public_id || image?.publicId || "").trim(),
			cloudinary_url: cloudinaryUrl,
			cloudinary_public_id: String(
				image?.cloudinary_public_id || image?.cloudinaryPublicId || "",
			).trim(),
			original_cloudinary_url: originalCloudinaryUrl,
			original_cloudinary_public_id: originalCloudinaryPublicId,
		});
	}
	return normalized;
}

function collectPodDefaultDesignEntriesFromAttribute(attribute = {}) {
	return clonePodDefaultDesignEntries(
		Array.isArray(attribute?.defaultDesigns) ? attribute.defaultDesigns : [],
	);
}

function clonePodDefaultDesignEntries(entries = []) {
	const safeEntries = Array.isArray(entries) ? entries : [];
	return safeEntries
		.map((entry) => {
			const rawOccasion = String(
				entry?.occassion || entry?.occasion || "",
			).trim();
			if (!rawOccasion) return null;
			return {
				occassion: normalizePodListOccasion(rawOccasion),
				defaultDesignImages: normalizePodDefaultDesignImages(
					entry?.defaultDesignImages,
				),
			};
		})
		.filter(Boolean);
}

function collectPodDefaultDesignEntriesFromProduct(product = {}) {
	const attributes = Array.isArray(product?.productAttributes)
		? product.productAttributes
		: [];
	const byOccasion = new Map();
	for (const attr of attributes) {
		const entries = Array.isArray(attr?.defaultDesigns)
			? attr.defaultDesigns
			: [];
		for (const entry of entries) {
			const rawOccasion = String(
				entry?.occassion || entry?.occasion || "",
			).trim();
			if (!rawOccasion) continue;
			const occasion = normalizePodListOccasion(rawOccasion);
			const key = occasion.toLowerCase();
			const images = normalizePodDefaultDesignImages(
				entry?.defaultDesignImages,
			);
			if (!images.length) continue;
			const existing = byOccasion.get(key);
			if (
				!existing ||
				images.length > Number(existing?.defaultDesignImages?.length || 0)
			) {
				byOccasion.set(key, {
					occassion: occasion,
					defaultDesignImages: images,
				});
			}
		}
	}
	return POD_LIST_OCCASION_OPTIONS.map((option) =>
		byOccasion.get(option.value.toLowerCase()),
	).filter(Boolean);
}

function buildPodDefaultDesignEntrySignature(entries = []) {
	const safeEntries = clonePodDefaultDesignEntries(entries);
	return safeEntries
		.map((entry) => {
			const occasion = String(entry?.occassion || "")
				.trim()
				.toLowerCase();
			const urls = normalizePodDefaultDesignImages(entry?.defaultDesignImages)
				.map((image) =>
					String(
						image?.cloudinary_url ||
							image?.cloudinaryUrl ||
							image?.url ||
							image?.src ||
							"",
					).trim(),
				)
				.filter(Boolean)
				.join("|");
			return occasion && urls ? `${occasion}:${urls}` : "";
		})
		.filter(Boolean)
		.join("||");
}

function normalizePodSyncToken(value = "") {
	return String(value ?? "")
		.trim()
		.toLowerCase();
}

function buildPrintifyOptionValueMap(options = []) {
	const map = {};
	for (const option of Array.isArray(options) ? options : []) {
		for (const value of Array.isArray(option?.values) ? option.values : []) {
			map[value.id] = {
				type: String(option?.type || option?.name || "")
					.trim()
					.toLowerCase(),
				title: String(value?.title || "").trim(),
				colors: Array.isArray(value?.colors) ? value.colors : [],
			};
		}
	}
	return map;
}

function getVariantOptionSummary(variant = {}, optionValueMap = {}) {
	let color = "";
	let size = "";
	let scent = "";

	for (const valueId of Array.isArray(variant?.options)
		? variant.options
		: []) {
		const option = optionValueMap[valueId];
		if (!option) continue;
		if (!color && option.type.includes("color")) {
			color = String(option?.colors?.[0] || option?.title || "").trim();
			continue;
		}
		if (!size && option.type.includes("size")) {
			size = String(option?.title || "").trim();
			continue;
		}
		if (!scent && option.type.includes("scent")) {
			scent = String(option?.title || "").trim();
		}
	}

	return { color, size, scent };
}

function buildPodVisualGroupKey(
	product = {},
	{ color = "", size = "", scent = "" } = {},
) {
	const colorToken = normalizePodSyncToken(color);

	if (colorToken) {
		return `color:${colorToken}`;
	}
	return "default";
}

function buildPodVisualGroupKeyFromAttribute(product = {}, attribute = {}) {
	return buildPodVisualGroupKey(product, {
		color: attribute?.color,
		size: attribute?.size,
		scent: attribute?.scent,
	});
}

function buildPodDefaultDesignEntryMapByVisualGroup(
	product = {},
	sourceProduct = {},
) {
	const attributes = Array.isArray(product?.productAttributes)
		? product.productAttributes
		: [];
	const byVisualGroup = new Map();
	for (const attribute of attributes) {
		const key = buildPodVisualGroupKeyFromAttribute(sourceProduct, attribute);
		const entries = collectPodDefaultDesignEntriesFromAttribute(attribute);
		if (!entries.length) continue;
		const existing = byVisualGroup.get(key);
		if (
			!existing ||
			entries.reduce(
				(total, entry) =>
					total + Number(entry?.defaultDesignImages?.length || 0),
				0,
			) >
				existing.reduce(
					(total, entry) =>
						total + Number(entry?.defaultDesignImages?.length || 0),
					0,
				)
		) {
			byVisualGroup.set(key, entries);
		}
	}
	return byVisualGroup;
}

function hasDistinctPodDefaultDesignVisualGroups(
	product = {},
	sourceProduct = {},
) {
	const signaturesByGroup = new Map();
	const attributes = Array.isArray(product?.productAttributes)
		? product.productAttributes
		: [];
	for (const attribute of attributes) {
		const key = buildPodVisualGroupKeyFromAttribute(sourceProduct, attribute);
		const signature = buildPodDefaultDesignEntrySignature(
			collectPodDefaultDesignEntriesFromAttribute(attribute),
		);
		if (!signature) continue;
		if (!signaturesByGroup.has(key)) {
			signaturesByGroup.set(key, signature);
		}
	}

	if (signaturesByGroup.size <= 1) {
		return true;
	}

	return new Set([...signaturesByGroup.values()]).size > 1;
}

function buildVariantImageViewKey(image = {}) {
	const cameraLabel = getMockupCameraLabel(image);
	const position = normalizePrintAreaPosition(
		image?.position || image?.placeholder || "",
	);
	const combined = `${cameraLabel} ${position}`.trim();
	if (
		/(lifestyle|model|wear|wearing|person|people|studio|on-model|on_model)/.test(
			combined,
		)
	) {
		return "lifestyle";
	}
	if (/(front|center|main|default|hero|primary|straight|full)/.test(combined)) {
		return "front";
	}
	if (/back/.test(combined)) return "back";
	if (/left/.test(combined)) return "left";
	if (/right/.test(combined)) return "right";
	return (
		combined ||
		String(image?.src || "")
			.trim()
			.toLowerCase()
	);
}

function scorePrintifyVariantImage(
	image = {},
	product = {},
	{ preferredCameraLabels = [] } = {},
) {
	let score = scorePreviewImageForList(image, product);
	const cameraLabel = getMockupCameraLabel(image);
	const metadata = `${cameraLabel} ${String(
		image?.position || image?.placeholder || "",
	).toLowerCase()} ${String(image?.src || "").toLowerCase()}`;

	if (preferredCameraLabels.includes(cameraLabel)) score += 12;
	if (cameraLabel === "front") score += 8;
	if (
		/(lifestyle|model|wear|wearing|person|people|studio|on-model|on_model)/.test(
			metadata,
		)
	) {
		score += 6;
	}
	if (/(detail|closeup|close-up|zoom|crop)/.test(metadata)) score -= 6;
	return score;
}

function selectBestPrintifyVariantImages({
	printifyProduct = {},
	variant = {},
	optionValueMap = {},
	limit = 3,
}) {
	const allImages = Array.isArray(printifyProduct?.images)
		? printifyProduct.images
		: [];
	if (!allImages.length) return [];

	const productVariants = Array.isArray(printifyProduct?.variants)
		? printifyProduct.variants
		: [];
	const variantId = String(variant?.id || "").trim();
	const selection = getVariantOptionSummary(variant, optionValueMap);
	const visualGroupKey = buildPodVisualGroupKey(printifyProduct, selection);
	const relatedVariantIds = new Set(
		productVariants
			.filter((candidate) => {
				if (candidate?.is_enabled === false) return false;
				return (
					buildPodVisualGroupKey(
						printifyProduct,
						getVariantOptionSummary(candidate, optionValueMap),
					) === visualGroupKey
				);
			})
			.map((candidate) => String(candidate?.id || "").trim())
			.filter(Boolean),
	);
	if (variantId) {
		relatedVariantIds.add(variantId);
	}

	const exactMatches = allImages.filter((image) =>
		Array.isArray(image?.variant_ids)
			? image.variant_ids.some((id) => String(id) === variantId)
			: false,
	);
	const visualMatches = allImages.filter((image) =>
		Array.isArray(image?.variant_ids)
			? image.variant_ids.some((id) =>
					relatedVariantIds.has(String(id || "").trim()),
				)
			: false,
	);
	const preferredCameraLabels = getPreferredPreviewCameraLabels(
		printifyProduct,
		"front",
	);

	const chooseFromPool = (pool = [], selected = [], seenUrls = new Set()) => {
		const ranked = [...pool]
			.filter((image) => {
				const src = String(image?.src || "").trim();
				return src && !seenUrls.has(src);
			})
			.map((image, index) => ({
				image,
				index,
				score: scorePrintifyVariantImage(image, printifyProduct, {
					preferredCameraLabels,
				}),
				viewKey: buildVariantImageViewKey(image),
			}))
			.sort(
				(a, b) =>
					b.score - a.score ||
					a.index - b.index ||
					String(a.image?.src || "").localeCompare(String(b.image?.src || "")),
			);

		const viewKeys = new Set(
			selected.map((image) => buildVariantImageViewKey(image)).filter(Boolean),
		);

		for (const candidate of ranked) {
			if (selected.length >= limit) break;
			if (candidate.viewKey && viewKeys.has(candidate.viewKey)) continue;
			selected.push(candidate.image);
			viewKeys.add(candidate.viewKey);
			seenUrls.add(String(candidate.image?.src || "").trim());
		}

		for (const candidate of ranked) {
			if (selected.length >= limit) break;
			const src = String(candidate.image?.src || "").trim();
			if (!src || seenUrls.has(src)) continue;
			selected.push(candidate.image);
			seenUrls.add(src);
		}

		return selected;
	};

	const selected = [];
	const seenUrls = new Set();
	chooseFromPool(exactMatches, selected, seenUrls);
	if (selected.length < limit) {
		chooseFromPool(visualMatches, selected, seenUrls);
	}
	if (selected.length < limit) {
		chooseFromPool(allImages, selected, seenUrls);
	}

	return selected.slice(0, limit);
}

function getPodStoredDefaultDesignEntry(product = {}, occasion = "") {
	const safeOccasion = normalizePodListOccasion(occasion);
	const key = safeOccasion.toLowerCase();
	const entries = collectPodDefaultDesignEntriesFromProduct(product);
	return (
		entries.find(
			(entry) =>
				String(entry?.occassion || "").toLowerCase() === key &&
				Array.isArray(entry?.defaultDesignImages) &&
				entry.defaultDesignImages.length > 0,
		) || null
	);
}

async function fetchPodCatalogVariantLayouts({
	blueprintId,
	printProviderId,
	variantIds = [],
}) {
	const normalizedBlueprintId = String(blueprintId || "").trim();
	const normalizedPrintProviderId = String(printProviderId || "").trim();
	if (!normalizedBlueprintId || !normalizedPrintProviderId) {
		throw new Error(
			"Missing blueprint or print provider for POD catalog layout.",
		);
	}

	const cacheKey = `${normalizedBlueprintId}:${normalizedPrintProviderId}`;
	const cached = podCatalogLayoutCache.get(cacheKey);
	if (cached?.data && Number(cached.expiresAt || 0) > Date.now()) {
		return cached.data;
	}

	const tokenInfo = resolvePrintifyToken();
	if (!tokenInfo.token) {
		throw new Error(tokenInfo.error || "No valid Printify token.");
	}

	const response = await axios.get(
		`https://api.printify.com/v1/catalog/blueprints/${normalizedBlueprintId}/print_providers/${normalizedPrintProviderId}/variants.json?show-out-of-stock=1`,
		{
			headers: {
				Authorization: `Bearer ${tokenInfo.token}`,
				"User-Agent": "NodeJS-App",
			},
		},
	);

	const allowedVariantIdSet = new Set(
		(Array.isArray(variantIds) ? variantIds : [])
			.map((id) => String(id || "").trim())
			.filter(Boolean),
	);
	const sourceVariants = Array.isArray(response?.data?.variants)
		? response.data.variants
		: [];
	const filteredVariants = allowedVariantIdSet.size
		? sourceVariants.filter((variant) =>
				allowedVariantIdSet.has(String(variant?.id || "").trim()),
			)
		: sourceVariants;
	const data = {
		blueprint_id: Number(normalizedBlueprintId) || normalizedBlueprintId,
		print_provider_id:
			Number(normalizedPrintProviderId) || normalizedPrintProviderId,
		variants: filteredVariants.map((variant) => ({
			id: variant?.id ?? null,
			title: String(variant?.title || "").trim(),
			placeholders: (Array.isArray(variant?.placeholders)
				? variant.placeholders
				: []
			)
				.map(formatCatalogPlaceholder)
				.filter((placeholder) => placeholder.position),
		})),
	};

	podCatalogLayoutCache.set(cacheKey, {
		expiresAt: Date.now() + POD_CATALOG_LAYOUT_CACHE_TTL_MS,
		data,
	});
	return data;
}

async function getPrintifyShopIdsCached(printifyToken) {
	if (
		Array.isArray(podListPreviewShopCache.shopIds) &&
		podListPreviewShopCache.shopIds.length > 0 &&
		podListPreviewShopCache.expiresAt > Date.now()
	) {
		return podListPreviewShopCache.shopIds;
	}
	const shopsResp = await axios.get("https://api.printify.com/v1/shops.json", {
		headers: {
			Authorization: `Bearer ${printifyToken}`,
			"User-Agent": "NodeJS-App",
		},
	});
	const shopIds = Array.isArray(shopsResp.data)
		? shopsResp.data.map((shop) => shop.id).filter(Boolean)
		: [];
	podListPreviewShopCache.shopIds = shopIds;
	podListPreviewShopCache.expiresAt =
		Date.now() + POD_LIST_PREVIEW_SHOP_CACHE_TTL_MS;
	return shopIds;
}

function getPersistedPodListPreviews(product) {
	const entries = product?.printifyProductDetails?.listingPreviews;
	if (!Array.isArray(entries)) return [];
	return entries
		.filter((entry) => entry && entry.key && entry.preview_image_url)
		.slice(0, POD_LIST_PREVIEW_MAX_DB_ENTRIES);
}

async function persistPodListPreview({ product, cacheEntry }) {
	const existingEntries = getPersistedPodListPreviews(product).filter(
		(entry) => entry.key !== cacheEntry.key,
	);
	const mergedEntries = [cacheEntry, ...existingEntries];
	const nextEntries = mergedEntries.slice(0, POD_LIST_PREVIEW_MAX_DB_ENTRIES);
	const evictedEntries = mergedEntries
		.slice(POD_LIST_PREVIEW_MAX_DB_ENTRIES)
		.filter((entry) => entry?.preview_product_id);
	await Product.findByIdAndUpdate(product._id, {
		$set: {
			"printifyProductDetails.listingPreviews": nextEntries,
			"printifyProductDetails.latestListingPreviewKey": cacheEntry.key,
			"printifyProductDetails.latestListingPreviewUpdatedAt":
				cacheEntry.generated_at,
		},
	});

	return evictedEntries;
}

function normalizePodListCleanupItems(rawItems) {
	if (!Array.isArray(rawItems)) return [];
	const dedupe = new Set();
	const normalized = [];
	for (const rawItem of rawItems) {
		const previewProductId = String(
			rawItem?.preview_product_id || rawItem?.previewProductId || "",
		).trim();
		if (!previewProductId) continue;
		const shopIdRaw = rawItem?.shop_id ?? rawItem?.shopId ?? null;
		const shopIdHint =
			shopIdRaw === null || shopIdRaw === undefined || shopIdRaw === ""
				? null
				: shopIdRaw;
		const productId = String(
			rawItem?.product_id || rawItem?.productId || "",
		).trim();
		const entry = {
			previewProductId,
			shopIdHint,
			productId: productId || null,
		};
		const dedupeKey = `${entry.previewProductId}|${entry.shopIdHint || ""}|${
			entry.productId || ""
		}`;
		if (dedupe.has(dedupeKey)) continue;
		dedupe.add(dedupeKey);
		normalized.push(entry);
		if (normalized.length >= 600) break;
	}
	return normalized;
}

async function removePersistedPodListPreviewsForProduct({
	productId,
	previewProductIds,
}) {
	if (
		!productId ||
		!Array.isArray(previewProductIds) ||
		!previewProductIds.length
	) {
		return {
			productId: productId || null,
			updated: false,
			reason: "missing_product_or_preview_ids",
		};
	}

	const product = await Product.findById(productId)
		.select("_id printifyProductDetails")
		.lean();
	if (!product) {
		return {
			productId: String(productId),
			updated: false,
			reason: "product_not_found",
		};
	}

	const existingEntries = getPersistedPodListPreviews(product);
	if (!existingEntries.length) {
		return {
			productId: String(productId),
			updated: false,
			reason: "no_listing_previews",
		};
	}

	const previewProductIdSet = new Set(
		previewProductIds.map((id) => String(id || "").trim()).filter(Boolean),
	);
	const nextEntries = existingEntries.filter(
		(entry) =>
			!previewProductIdSet.has(String(entry?.preview_product_id || "").trim()),
	);
	if (nextEntries.length === existingEntries.length) {
		return {
			productId: String(productId),
			updated: false,
			reason: "no_matching_preview_ids",
		};
	}

	const previousLatestKey =
		product?.printifyProductDetails?.latestListingPreviewKey || null;
	const latestStillPresent = nextEntries.some(
		(entry) => String(entry?.key || "") === String(previousLatestKey || ""),
	);
	const nextLatestKey = latestStillPresent
		? previousLatestKey
		: nextEntries[0]?.key;
	const nextLatestUpdatedAt =
		nextEntries.find((entry) => entry?.key === nextLatestKey)?.generated_at ||
		new Date().toISOString();

	await Product.findByIdAndUpdate(productId, {
		$set: {
			"printifyProductDetails.listingPreviews": nextEntries,
			"printifyProductDetails.latestListingPreviewKey": nextLatestKey || null,
			"printifyProductDetails.latestListingPreviewUpdatedAt":
				nextLatestUpdatedAt || null,
		},
	});

	return {
		productId: String(productId),
		updated: true,
		removed: existingEntries.length - nextEntries.length,
		remaining: nextEntries.length,
	};
}

function parsePodListPreviewGeneratedAtMs(entry = {}) {
	const generatedAtMs = Date.parse(String(entry?.generated_at || ""));
	if (Number.isFinite(generatedAtMs)) return generatedAtMs;
	const createdAtMs = Date.parse(String(entry?.created_at || ""));
	if (Number.isFinite(createdAtMs)) return createdAtMs;
	return null;
}

function isPodListPreviewEntryStale(entry = {}, nowMs = Date.now()) {
	if (!entry?.preview_product_id) return false;
	const generatedAtMs = parsePodListPreviewGeneratedAtMs(entry);
	if (!Number.isFinite(generatedAtMs)) return true;
	return nowMs - generatedAtMs >= POD_LIST_PREVIEW_STALE_AGE_MS;
}

async function cleanupStalePodListPreviewProducts({
	reason = "scheduled",
} = {}) {
	if (podListStaleCleanupState.running) {
		return {
			success: false,
			skipped: true,
			reason: "already_running",
		};
	}

	const nowMs = Date.now();
	podListStaleCleanupState.running = true;
	podListStaleCleanupState.lastRunAt = nowMs;
	const debugId = `pod-list-stale-cleanup-${nowMs}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const startedAt = Date.now();
	try {
		const tokenInfo = resolvePrintifyToken();
		if (!tokenInfo.token) {
			return {
				success: false,
				skipped: true,
				reason: "no_token",
				error: tokenInfo.error || "Missing Printify token",
			};
		}

		const products = await Product.find({
			"printifyProductDetails.listingPreviews.0": { $exists: true },
		})
			.select("_id printifyProductDetails")
			.limit(POD_LIST_PREVIEW_STALE_CLEANUP_MAX_PRODUCTS)
			.lean();

		let scannedProducts = 0;
		let staleCandidates = 0;
		let deleteAttempts = 0;
		let deletedCount = 0;
		let notFoundCount = 0;
		let failedCount = 0;
		let dbUpdatedProducts = 0;

		for (const product of products) {
			if (deleteAttempts >= POD_LIST_PREVIEW_STALE_CLEANUP_MAX_DELETES) break;
			scannedProducts += 1;
			const entries = getPersistedPodListPreviews(product);
			if (!entries.length) continue;

			const staleEntries = entries.filter((entry) =>
				isPodListPreviewEntryStale(entry, nowMs),
			);
			if (!staleEntries.length) continue;

			const removablePreviewIds = [];
			for (const staleEntry of staleEntries) {
				if (deleteAttempts >= POD_LIST_PREVIEW_STALE_CLEANUP_MAX_DELETES) break;
				const previewProductId = String(
					staleEntry?.preview_product_id || "",
				).trim();
				if (!previewProductId) continue;
				staleCandidates += 1;
				deleteAttempts += 1;
				try {
					const cleanupResult = await deletePreviewProductById({
						previewProductId,
						shopIdHint: staleEntry?.shop_id || null,
						printifyToken: tokenInfo.token,
						debugId,
					});
					if (cleanupResult?.deleted) deletedCount += 1;
					if (cleanupResult?.notFound) notFoundCount += 1;
					if (cleanupResult?.deleted || cleanupResult?.notFound) {
						removablePreviewIds.push(previewProductId);
					}
				} catch (cleanupError) {
					failedCount += 1;
					console.warn(`[${debugId}] Failed stale preview delete`, {
						productId: String(product?._id || ""),
						previewProductId,
						status: cleanupError?.response?.status || null,
						data: cleanupError?.response?.data || null,
						message: cleanupError?.message,
					});
				}
			}

			if (removablePreviewIds.length) {
				const updateSummary = await removePersistedPodListPreviewsForProduct({
					productId: String(product._id),
					previewProductIds: removablePreviewIds,
				});
				if (updateSummary?.updated) dbUpdatedProducts += 1;
			}
		}

		const summary = {
			success: true,
			reason,
			scannedProducts,
			staleCandidates,
			deleteAttempts,
			deletedCount,
			notFoundCount,
			failedCount,
			dbUpdatedProducts,
			durationMs: Date.now() - startedAt,
		};
		podListStaleCleanupState.lastSummary = summary;
		const verboseCleanupLogs =
			String(
				process.env.POD_LIST_PREVIEW_VERBOSE_CLEANUP_LOGS || "",
			).toLowerCase() === "true";
		const shouldLogSummary =
			verboseCleanupLogs ||
			reason !== "interval" ||
			staleCandidates > 0 ||
			deleteAttempts > 0 ||
			failedCount > 0 ||
			dbUpdatedProducts > 0;
		if (shouldLogSummary) {
			console.log(
				`[${debugId}] Stale POD list preview cleanup summary`,
				summary,
			);
		}
		return summary;
	} catch (error) {
		console.error(`[${debugId}] Stale POD list preview cleanup failed`, {
			status: error?.response?.status || null,
			data: error?.response?.data || null,
			message: error?.message,
		});
		return {
			success: false,
			reason,
			error: error?.message || "unknown_error",
		};
	} finally {
		podListStaleCleanupState.running = false;
	}
}

function startPodListStaleCleanupTimer() {
	if (podListStaleCleanupTimer) return;
	podListStaleCleanupTimer = setInterval(() => {
		cleanupStalePodListPreviewProducts({ reason: "interval" }).catch(
			(cleanupError) => {
				console.warn("Interval stale POD preview cleanup warning:", {
					message: cleanupError?.message,
				});
			},
		);
	}, POD_LIST_PREVIEW_STALE_CLEANUP_INTERVAL_MS);
	if (typeof podListStaleCleanupTimer.unref === "function") {
		podListStaleCleanupTimer.unref();
	}
}

startPodListStaleCleanupTimer();

async function generatePodListPreview({
	product,
	occasion,
	name,
	variantIdInput,
	cacheKey,
	debugId,
	options = {},
}) {
	const {
		returnPreviewImages = false,
		maxPreviewImages = 3,
		uploadPreviewImagesToCloudinary = false,
		previewImagesCloudinaryFolder = "serene_janat/pod_default_designs",
		cleanupPreviewProduct = false,
		cleanupDesignUpload = false,
	} = options || {};
	const safeMaxPreviewImages = Math.max(1, Number(maxPreviewImages) || 3);
	const tokenInfo = resolvePrintifyToken();
	if (!tokenInfo.token) {
		throw new Error(tokenInfo.error || "No valid Printify token.");
	}
	const printifyToken = tokenInfo.token;
	const safeOccasion = normalizePodListOccasion(occasion);
	const safeName = sanitizePodListName(name);
	const message = buildPodListGiftMessage(safeOccasion, safeName);
	const preset = getPodListPreset(safeOccasion);
	const variantId = resolvePodListVariantId(product, variantIdInput);

	if (!variantId) {
		throw new Error("Could not resolve a valid variant ID for POD preview.");
	}

	const printAreas = Array.isArray(product?.printifyProductDetails?.print_areas)
		? product.printifyProductDetails.print_areas
		: [];
	const variantPrintArea =
		printAreas.find(
			(area) =>
				Array.isArray(area?.variant_ids) &&
				area.variant_ids.some((id) => String(id) === String(variantId)),
		) || printAreas[0];
	const sourcePlaceholders = Array.isArray(variantPrintArea?.placeholders)
		? variantPrintArea.placeholders
		: [];
	const sourcePlaceholder =
		pickBestPodListPlaceholder(sourcePlaceholders, product) ||
		sourcePlaceholders[0];
	const sourcePosition = String(sourcePlaceholder?.position || "front");
	const designAsset = await buildPodListDesignAsset({
		message,
		preset,
		product,
		sourcePlaceholder,
		sourcePosition,
	});
	const designSvgDataUri = designAsset?.dataUri;
	if (!designSvgDataUri) {
		throw new Error("Failed building the POD list preview design asset.");
	}
	const designUpload = await cloudinary.uploader.upload(designSvgDataUri, {
		folder: "serene_janat/pod_list_preview_designs",
		resource_type: "image",
	});
	const designPublicId = designUpload?.public_id || null;
	const pngDeliveryUrl = designPublicId
		? cloudinary.url(designPublicId, {
				secure: true,
				resource_type: "image",
				type: "upload",
				format: "png",
				transformation: [{ fetch_format: "png" }],
			})
		: null;
	const designUrlCandidates = [
		...new Set(
			[
				pngDeliveryUrl,
				designUpload?.secure_url || null,
				POD_LIST_FALLBACK_DESIGN_URL,
			].filter(Boolean),
		),
	];
	if (!designUrlCandidates.length) {
		throw new Error("Failed to upload generated design image to Cloudinary.");
	}

	const shopIds = await getPrintifyShopIdsCached(printifyToken);
	if (!shopIds.length) {
		throw new Error("No Printify shops found.");
	}
	const shopIdHint = product?.printifyProductDetails?.shop_id;
	const shopId = shopIds.includes(shopIdHint) ? shopIdHint : shopIds[0];

	console.log(`[${debugId}] Generating POD list preview`, {
		productId: String(product?._id || ""),
		shopId,
		variantId,
		occasion: safeOccasion,
		hasName: Boolean(safeName),
		cacheKey,
	});

	let uploadedImageId = null;
	let selectedDesignImageUrl = null;
	let lastUploadError = null;
	for (const candidateUrl of designUrlCandidates) {
		try {
			console.log(`[${debugId}] Uploading POD list design to Printify`, {
				candidateHost: (() => {
					try {
						return new URL(candidateUrl).host;
					} catch {
						return "invalid-url";
					}
				})(),
			});
			const uploadResp = await axios.post(
				"https://api.printify.com/v1/uploads/images.json",
				{
					file_name: `pod-list-preview-${Date.now()}.png`,
					url: candidateUrl,
				},
				{
					headers: {
						Authorization: `Bearer ${printifyToken}`,
						"Content-Type": "application/json",
						"User-Agent": "NodeJS-App",
					},
				},
			);
			uploadedImageId = uploadResp?.data?.id || null;
			if (uploadedImageId) {
				selectedDesignImageUrl = candidateUrl;
				break;
			}
		} catch (uploadError) {
			lastUploadError = uploadError;
			console.warn(`[${debugId}] Printify design upload candidate failed`, {
				status: uploadError?.response?.status || null,
				data: uploadError?.response?.data || null,
				message: uploadError?.message,
			});
		}
	}
	if (!uploadedImageId) {
		if (lastUploadError) throw lastUploadError;
		throw new Error("Printify image upload did not return an ID.");
	}

	const sourceImage = designAsset?.placementAsset?.forceSourcePlacement
		? designAsset.placementAsset.placementParams
		: Array.isArray(sourcePlaceholder?.images)
			? sourcePlaceholder.images[0]
			: null;
	const placementDefaults = getPodListPlacementDefaults(
		product,
		sourcePosition,
	);
	const placementResult = resolvePodListPlacementFromSource({
		sourceImage,
		placementDefaults,
		forceSourcePlacement: Boolean(
			designAsset?.placementAsset?.forceSourcePlacement,
		),
	});
	const {
		finalX,
		finalY,
		finalScale,
		finalAngle,
		useSourcePlacement,
		sourceNearExpectedArea,
		sourcePlacementIsTooSmall,
		sourcePlacementIsTooLarge,
		sourcePlacement,
	} = placementResult;
	const previewScaleBoost = designAsset?.placementAsset?.forceSourcePlacement
		? 1
		: getPodPreviewPlacementBoost(product, sourcePosition);
	const boostedScale = Boolean(designAsset?.placementAsset?.forceSourcePlacement)
		? Math.min(
				2.6,
				Math.max(0.18, Number(finalScale || placementDefaults.scale || 0.88)),
			)
		: Math.min(
				2.6,
				Math.max(
					0.28,
					Number(finalScale || placementDefaults.scale || 0.88) *
						previewScaleBoost,
				),
			);

	console.log(`[${debugId}] POD list placement resolved`, {
		productId: String(product?._id || ""),
		productName: String(product?.productName || ""),
		variantId,
		sourcePosition,
		availablePositions: sourcePlaceholders.map(
			(item) => item?.position || null,
		),
		useSourcePlacement,
		sourceNearExpectedArea,
		sourcePlacementIsTooSmall,
		sourcePlacementIsTooLarge,
		sourcePlacement,
		defaultPlacement: placementDefaults,
		designAssetPlacement: designAsset?.placementAsset?.placementParams || null,
		usedFrontendSyncedAsset: Boolean(
			designAsset?.placementAsset?.forceSourcePlacement,
		),
		previewScaleBoost,
		finalPlacement: {
			x: finalX,
			y: finalY,
			scale: boostedScale,
			baseScale: finalScale,
			angle: finalAngle,
		},
	});

	const createPayload = {
		title: `POD List Preview - ${product?.productName || "Custom Gift"}`,
		description: "Temporary POD list preview product",
		blueprint_id: product?.printifyProductDetails?.blueprint_id,
		print_provider_id: product?.printifyProductDetails?.print_provider_id,
		variants: [
			{
				id: normalizeVariantId(variantId),
				price: 2500,
				is_enabled: true,
				is_default: true,
			},
		],
		print_areas: [
			{
				variant_ids: [normalizeVariantId(variantId)],
				placeholders: [
					{
						position: sourcePosition,
						images: [
							{
								type: "image/png",
								id: uploadedImageId,
								x: finalX,
								y: finalY,
								scale: boostedScale,
								angle: finalAngle,
							},
						],
					},
				],
			},
		],
		visible: false,
	};

	let previewProductId = null;
	let previewImageUrl = null;
	let previewImageCandidates = [];
	let uploadedPreviewImages = [];

	try {
		const createResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			createPayload,
			{
				headers: {
					Authorization: `Bearer ${printifyToken}`,
					"Content-Type": "application/json",
					"User-Agent": "NodeJS-App",
				},
			},
		);
		previewProductId = createResp?.data?.id;
		if (!previewProductId) {
			throw new Error("Printify preview product was not created.");
		}

		for (let attempt = 0; attempt < 3; attempt++) {
			const previewResp = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products/${previewProductId}.json`,
				{
					headers: {
						Authorization: `Bearer ${printifyToken}`,
						"User-Agent": "NodeJS-App",
					},
				},
			);
			const images = Array.isArray(previewResp?.data?.images)
				? previewResp.data.images
				: [];
			const rankedImages = [...images].sort(
				(a, b) =>
					scorePreviewImageForList(b, product) -
					scorePreviewImageForList(a, product),
			);
			const selected = [
				...new Set(rankedImages.map((image) => image?.src).filter(Boolean)),
			];
			previewImageCandidates = selected;
			const productKind = getPodListProductKind(product);
			const isWearableProduct = ["apparel", "hoodie"].includes(productKind);
			const lifestylePreferred = isWearableProduct
				? rankedImages.find((image) =>
						/(lifestyle|model|wear|wearing|person|people|man|woman|male|female|on-model|on_model|studio)/.test(
							`${String(image?.position || image?.placeholder || "").toLowerCase()} ${String(
								image?.src || "",
							).toLowerCase()}`,
						),
					)?.src || null
				: null;
			const centeredFrontPreferred = ["bag", "pillow", "candle"].includes(
				productKind,
			)
				? rankedImages.find((image) => {
						const metadata = `${String(image?.position || image?.placeholder || "").toLowerCase()} ${String(
							image?.src || "",
						).toLowerCase()}`;
						return (
							/(front|center|main|default|hero|primary|straight|full|label)/.test(
								metadata,
							) &&
							!/(side|left|right|back|detail|closeup|zoom|corner|crop|angle|tilt|45|perspective)/.test(
								metadata,
							)
						);
					})?.src || null
				: null;
			previewImageUrl =
				lifestylePreferred || centeredFrontPreferred || selected[0] || null;
			if (
				previewImageUrl &&
				(!returnPreviewImages || previewImageCandidates.length)
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 550));
		}

		const selectedPreviewImages = previewImageCandidates
			.slice(0, safeMaxPreviewImages)
			.filter(Boolean);

		if (uploadPreviewImagesToCloudinary && selectedPreviewImages.length) {
			for (const src of selectedPreviewImages) {
				try {
					const uploaded = await cloudinary.uploader.upload(src, {
						folder: previewImagesCloudinaryFolder,
						resource_type: "image",
					});
					if (!uploaded?.secure_url) continue;
					uploadedPreviewImages.push({
						url: uploaded.secure_url,
						public_id: uploaded.public_id || "",
						source_url: src,
					});
				} catch (uploadError) {
					console.warn(
						`[${debugId}] Failed uploading preview image to Cloudinary`,
						{
							status: uploadError?.response?.status || null,
							data: uploadError?.response?.data || null,
							message: uploadError?.message,
						},
					);
				}
			}
		}

		const effectivePreviewImageUrl =
			uploadedPreviewImages[0]?.url ||
			previewImageUrl ||
			pickProductFallbackImage(product);
		const effectivePreviewImages = uploadedPreviewImages.length
			? uploadedPreviewImages.map((item) => item.url).filter(Boolean)
			: selectedPreviewImages;

		return {
			previewImageUrl: effectivePreviewImageUrl,
			previewImages: effectivePreviewImages,
			uploadedPreviewImages,
			previewProductId,
			shopId,
			variantId: normalizeVariantId(variantId),
			occasion: safeOccasion,
			name: safeName,
			message,
			designImageUrl:
				selectedDesignImageUrl || designUpload?.secure_url || null,
			designImagePublicId: designPublicId,
			tokenSource: tokenInfo.source || null,
		};
	} finally {
		if (cleanupPreviewProduct && previewProductId) {
			try {
				await deletePreviewProductById({
					previewProductId,
					shopIdHint: shopId,
					printifyToken,
					debugId: `${debugId}-cleanup-generated`,
				});
			} catch (cleanupError) {
				console.warn(`[${debugId}] Failed deleting generated preview product`, {
					previewProductId,
					status: cleanupError?.response?.status || null,
					data: cleanupError?.response?.data || null,
					message: cleanupError?.message,
				});
			}
		}
		if (cleanupDesignUpload && designPublicId) {
			try {
				await cloudinary.uploader.destroy(designPublicId, {
					resource_type: "image",
				});
			} catch (cleanupDesignError) {
				console.warn(`[${debugId}] Failed deleting temporary design upload`, {
					designPublicId,
					message: cleanupDesignError?.message,
				});
			}
		}
	}
}

exports.publishPrintifyProducts = async (req, res) => {
	try {
		console.log("[publish-printify] Fetching shop ID from Printify.");

		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;

		// Fetch the Shop ID dynamically
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			},
		);

		if (!shopResponse.data || shopResponse.data.length === 0) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id; // Use the first shop ID
		console.log(`[publish-printify] Shop ID found: ${shopId}`);

		// Fetch all products from the shop
		const productsResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			},
		);

		if (!productsResponse.data || productsResponse.data.data.length === 0) {
			return res
				.status(404)
				.json({ error: "No products found in Printify shop" });
		}

		const printifyProducts = productsResponse.data.data;

		console.log(
			`[publish-printify] Total products retrieved: ${printifyProducts.length}`,
		);

		// Log product visibility and lock status
		printifyProducts.forEach((product) => {
			console.log(
				`[publish-printify] Product status | title=${product.title} | visible=${product.visible} | locked=${product.is_locked} | id=${product.id}`,
			);
		});

		// Filter products that need publishing (if they failed publishing or are inactive)
		const productsToPublish = printifyProducts
			.filter((product) => !product.visible || product.is_locked) // Publish if not visible OR locked
			.map((product) => product.id);

		if (productsToPublish.length === 0) {
			console.log("[publish-printify] No products need publishing.");
			return res.json({ message: "No products need publishing." });
		}

		console.log(
			`[publish-printify] Publishing ${productsToPublish.length} products.`,
		);

		// Function to publish each product
		const publishResults = await Promise.all(
			productsToPublish.map(async (productId) => {
				try {
					await axios.post(
						`https://api.printify.com/v1/shops/${shopId}/products/${productId}/publish.json`,
						{
							title: true,
							description: true,
							images: true,
							variants: true,
							tags: true,
							keyFeatures: true,
							shipping_template: true,
						},
						{
							headers: {
								Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							},
						},
					);
					console.log(
						`[publish-printify] Successfully published product: ${productId}`,
					);
					return { productId, status: "Published Successfully" };
				} catch (error) {
					console.error(
						`[publish-printify] Error publishing product ${productId}:`,
						error.response?.data || error.message,
					);
					return {
						productId,
						status: "Failed to Publish",
						error: error.message,
					};
				}
			}),
		);

		res.json({
			success: true,
			total_published: publishResults.filter(
				(p) => p.status === "Published Successfully",
			).length,
			total_failed: publishResults.filter(
				(p) => p.status === "Failed to Publish",
			).length,
			details: publishResults,
		});
	} catch (error) {
		console.error(
			"[publish-printify] Error publishing Printify products:",
			error.response?.data || error.message,
		);
		res.status(500).json({ error: "Failed to publish Printify products" });
	}
};

exports.forceRepublishPrintifyProducts = async (req, res) => {
	try {
		console.log("[force-republish-printify] Fetching shop ID from Printify.");

		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;

		// Fetch the Shop ID dynamically
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			},
		);

		if (!shopResponse.data || shopResponse.data.length === 0) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id; // Use the first shop ID
		console.log(`[force-republish-printify] Shop ID found: ${shopId}`);

		// Fetch all products
		const productsResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			},
		);

		if (!productsResponse.data || productsResponse.data.data.length === 0) {
			return res
				.status(404)
				.json({ error: "No products found in Printify shop" });
		}

		const printifyProducts = productsResponse.data.data;

		console.log(
			`[force-republish-printify] Total products retrieved: ${printifyProducts.length}`,
		);

		// Force republish all products by adding a random tag & republishing
		const republishResults = await Promise.all(
			printifyProducts.map(async (product) => {
				try {
					// First, update the product with a new tag
					await axios.put(
						`https://api.printify.com/v1/shops/${shopId}/products/${product.id}.json`,
						{
							tags: [...product.tags, "republish-attempt"], // Adding a new tag
						},
						{
							headers: {
								Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							},
						},
					);

					console.log(
						`[force-republish-printify] Updated product ${product.id} with republish tag`,
					);

					// Now attempt to publish it
					await axios.post(
						`https://api.printify.com/v1/shops/${shopId}/products/${product.id}/publish.json`,
						{
							title: true,
							description: true,
							images: true,
							variants: true,
							tags: true,
							keyFeatures: true,
							shipping_template: true,
						},
						{
							headers: {
								Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							},
						},
					);

					console.log(
						`[force-republish-printify] Successfully republished product: ${product.id}`,
					);
					return { productId: product.id, status: "Republished Successfully" };
				} catch (error) {
					console.error(
						`[force-republish-printify] Error republishing product ${product.id}:`,
						error.response?.data || error.message,
					);
					return {
						productId: product.id,
						status: "Failed to Republish",
						error: error.message,
					};
				}
			}),
		);

		res.json({
			success: true,
			total_republished: republishResults.filter(
				(p) => p.status === "Republished Successfully",
			).length,
			total_failed: republishResults.filter(
				(p) => p.status === "Failed to Republish",
			).length,
			details: republishResults,
		});
	} catch (error) {
		console.error(
			"[force-republish-printify] Error republishing Printify products:",
			error.response?.data || error.message,
		);
		res.status(500).json({ error: "Failed to republish Printify products" });
	}
};

exports.printifyProducts = async (req, res) => {
	try {
		// Fetch the Shop ID from Printify API
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
				},
			},
		);

		// Check if there are shops in the response
		if (shopResponse.data && shopResponse.data.length > 0) {
			const shopId = shopResponse.data[0].id; // Assuming you want the first shop ID

			// Fetch the products for the Shop ID
			const productsResponse = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products.json`,
				{
					headers: {
						Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
					},
				},
			);

			// Check if there are products in the response
			if (productsResponse.data && productsResponse.data.data.length > 0) {
				// Filter products to only include those with is_enabled: true
				const enabledProducts = productsResponse.data.data
					.filter((product) =>
						product.variants.some((variant) => variant.is_enabled),
					)
					.map((product) => ({
						...product,
						variants: product.variants.filter((variant) => variant.is_enabled),
					}));

				return res.json({
					shopId,
					products: enabledProducts,
				});
			} else {
				return res
					.status(404)
					.json({ error: "No products found for the shop" });
			}
		} else {
			return res.status(404).json({ error: "No shops found" });
		}
	} catch (error) {
		console.error("Error fetching products:", error);
		return res.status(500).json({ error: "Error fetching products" });
	}
};

exports.removeAllPrintifyProducts = async (req, res) => {
	try {
		// Remove all products where isPrintifyProduct is true
		const result = await Product.deleteMany({ isPrintifyProduct: true });

		// Respond with the result of the deletion
		return res.json({
			message: "All Printify products have been removed",
			deletedCount: result.deletedCount,
		});
	} catch (error) {
		console.error("Error removing Printify products:", error);
		return res.status(500).json({ error: "Error removing Printify products" });
	}
};

const PER_PAGE = 100; // Printify page size limit

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Helper data & utilities
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const CANCELLABLE_P_STATUSES = new Set([
	"pending",
	"onhold",
	"paymentnotreceived",
	"notsubmitted",
	"draft",
]);

// Printify statuses that mean â€œshipped / finishedâ€
const COMPLETED_P_STATUSES = new Set(["delivered", "fulfilled", "intransit"]);

const normaliseStatus = (str = "") => str.toLowerCase().replace(/[\s_-]/g, "");

const mapPrintifyStatusToLocalStatus = (status = "") => {
	switch (normaliseStatus(status)) {
		case "intransit":
		case "fulfilled":
			return "Shipped";
		case "delivered":
			return "Delivered";
		case "canceled":
			return "Cancelled";
		case "inproduction":
		case "pretransit":
			return "Ready to Ship";
		default:
			return status;
	}
};

async function deleteEphemeralProducts({ shopId, localOrder, authHeaders }) {
	const prodIds =
		localOrder.printifyOrderDetails
			?.map((d) => d.ephemeralProductId)
			.filter(Boolean) || [];

	let removed = 0;
	for (const prodId of prodIds) {
		try {
			await axios.delete(
				`https://api.printify.com/v1/shops/${shopId}/products/${prodId}.json`,
				authHeaders,
			);
			removed++;
		} catch (e) {
			if (e.response?.status === 404) {
				removed++; // already deleted â€“ count as success
			} else {
				// keep running but surface the error in server logs
				console.warn(
					`[Printify] Unable to delete product ${prodId}:`,
					e.response?.data || e.message,
				);
			}
		}
	}
	return removed;
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Main controller
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

exports.printifyOrders = async (req, res) => {
	/* 0. Validate API token */
	const token = process.env.DESIGN_PRINTIFY_TOKEN;
	if (!token) {
		return res.status(500).json({ error: "DESIGN_PRINTIFY_TOKEN missing." });
	}
	const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

	/* 1. Load every local order that references Printify */
	const allOrders = await Order.find({
		"printifyOrderDetails.0.ephemeralOrder.id": { $exists: true },
	});
	const byPrintifyId = new Map();
	allOrders.forEach((o) => {
		const id = o.printifyOrderDetails?.[0]?.ephemeralOrder?.id;
		if (id) byPrintifyId.set(id, o);
	});

	/* 2. Counters */
	let ordersSynced = 0;
	let ordersCancelledAtPrintify = 0;
	let productsDeleted = 0;

	try {
		/* 3. Iterate over every shop owned by the token */
		const { data: shops = [] } = await axios.get(
			"https://api.printify.com/v1/shops.json",
			authHeaders,
		);

		for (const { id: shopId } of shops) {
			/* Paginate through all orders in the shop */
			let page = 1;
			while (true) {
				const { data: { data: pOrders = [] } = {} } = await axios.get(
					`https://api.printify.com/v1/shops/${shopId}/orders.json?page=${page}&per_page=${PER_PAGE}`,
					authHeaders,
				);
				if (!pOrders.length) break; // no more pages
				page++;

				for (const pOrder of pOrders) {
					const localOrder = byPrintifyId.get(pOrder.id);
					if (!localOrder) continue; // no local match

					const normLocal = normaliseStatus(localOrder.status);
					const normPrint = normaliseStatus(pOrder.status);

					/* A) Local order is Cancelled âžœ attempt cancel + delete products */
					if (normLocal === "cancelled") {
						if (
							normPrint !== "canceled" &&
							CANCELLABLE_P_STATUSES.has(normPrint)
						) {
							try {
								await axios.post(
									`https://api.printify.com/v1/shops/${shopId}/orders/${pOrder.id}/cancel.json`,
									{},
									authHeaders,
								);
								ordersCancelledAtPrintify++;
							} catch (e) {
								console.warn(
									`[Printify] Cannot cancel ${pOrder.id}:`,
									e.response?.data || e.message,
								);
							}
						}
						productsDeleted += await deleteEphemeralProducts({
							shopId,
							localOrder,
							authHeaders,
						});
						continue; // done with this order
					}

					/* B) Normal status + tracking synchronisation */
					const updates = {};
					const mappedStatus = mapPrintifyStatusToLocalStatus(pOrder.status);
					if (localOrder.status !== mappedStatus) updates.status = mappedStatus;
					const pTracking = pOrder?.printify_connect?.url || null;
					if (localOrder.trackingNumber !== pTracking)
						updates.trackingNumber = pTracking;

					if (Object.keys(updates).length) {
						await Order.updateOne({ _id: localOrder._id }, { $set: updates });
						ordersSynced++;
					}

					/* C) If Printify marks order completed (delivered/shipped) âžœ delete products */
					if (COMPLETED_P_STATUSES.has(normPrint)) {
						productsDeleted += await deleteEphemeralProducts({
							shopId,
							localOrder,
							authHeaders,
						});
					}
				}
			}
		}

		/* 4. Final concise report */
		return res.json({
			success: true,
			message: "Printify sync completed.",
			ordersSynced,
			ordersCancelledAtPrintify,
			productsDeleted,
		});
	} catch (err) {
		console.error("Error during Printify sync:", err.message);
		if (err.response) console.error("Printify API:", err.response.data);
		return res.status(500).json({ error: "Error syncing Printify orders" });
	}
};

//------------------------------------------------------
// 1) The HELPER function: createTempDesignPreview
//------------------------------------------------------

/**
 * Creates a temporary product referencing "YourDesignHere.png" (centered on the front),
 * fetches the ephemeral preview, uploads that preview to Cloudinary,
 * then deletes the ephemeral product from Printify.
 *
 * Returns { previewUrl, previewPublicId } or throws on error.
 */
//
// 1) createTempDesignPreview
//

async function createTempDesignPreview(
	printifyProduct,
	limitedVariants,
	token,
) {
	//------------------------------------------------------------------
	// Decide how to place the "Your Design" placeholder
	// for each blueprint_id (bags, pillows, mugs, etc.).
	//------------------------------------------------------------------
	const blueprintPlacementMap = {
		// Example: "326" => a certain Weekender Bag
		326: { x: 0.5, y: 0.16, scale: 0.64, angle: 0 },
		// Example: "220" => a certain Pillow
		220: { x: 0.25, y: 0.5, scale: 0.3, angle: 0 },
		// Example mug blueprint ID, if needed:
		911: { x: 0.5, y: 0.5, scale: 0.3, angle: 0 },

		// fallback default
		default: { x: 0.5, y: 0.5, scale: 0.88, angle: 0 },
	};

	function getPlacementForBlueprint(blueprintId) {
		const placement = blueprintPlacementMap[String(blueprintId)];
		return placement || blueprintPlacementMap.default;
	}

	//------------------------------------------------------------------
	// 1) Upload "YourDesignHere.png" to Printify
	//------------------------------------------------------------------
	// const yourDesignUrl =
	// 	"https://res.cloudinary.com/infiniteapps/image/upload/v1746240199/serene_janat/example_designs/YourDesignHere.png";

	const yourDesignUrl =
		"https://res.cloudinary.com/infiniteapps/image/upload/v1746381000/serene_janat/YourDesignHere2_zl9oqo.png";

	let printifyImageId = "";
	try {
		const resp = await axios.post(
			"https://api.printify.com/v1/uploads/images.json",
			{
				url: yourDesignUrl,
				file_name: "YourDesignHere.png",
			},
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			},
		);
		if (!resp.data?.id) {
			throw new Error("No 'id' returned from Printify for YourDesignHere.png");
		}
		printifyImageId = resp.data.id;
	} catch (err) {
		console.error(
			"âŒ Printify Upload Error Full:",
			JSON.stringify(err.response?.data, null, 2),
		);
		throw new Error(
			`Unable to upload 'YourDesignHere.png' to Printify: ${
				err.response?.data?.message || err.message
			}`,
		);
	}

	//------------------------------------------------------------------
	// 2) Create ephemeral product referencing that uploaded image
	//------------------------------------------------------------------
	const ephemeralVariants = limitedVariants.map((v) => ({
		id: v.id,
		enabled: true,
		price: v.price, // price in cents
	}));
	const variantIdsForArea = ephemeralVariants.map((v) => v.id);

	const { x, y, scale, angle } = getPlacementForBlueprint(
		printifyProduct.blueprint_id,
	);

	const createBody = {
		title: `Temp - ${printifyProduct.title} (YourDesignHere)`,
		blueprint_id: printifyProduct.blueprint_id,
		print_provider_id: printifyProduct.print_provider_id,
		variants: ephemeralVariants,
		print_areas: [
			{
				variant_ids: variantIdsForArea,
				placeholders: [
					{
						position: "front",
						images: [
							{
								id: printifyImageId,
								type: "image/png",
								x,
								y,
								scale,
								angle,
							},
						],
					},
				],
			},
		],
	};

	let ephemeralProductId;
	try {
		const createResp = await axios.post(
			`https://api.printify.com/v1/shops/${printifyProduct.__shopId}/products.json`,
			createBody,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			},
		);
		if (!createResp.data?.id) {
			throw new Error("Printify did not return ephemeral product ID.");
		}
		ephemeralProductId = createResp.data.id;
	} catch (err) {
		console.error(
			"âŒ Create ephemeral product error (Full):",
			JSON.stringify(err.response?.data, null, 2),
		);
		throw new Error(
			`Failed to create ephemeral product. Reason: ${
				err.response?.data?.message || err.message
			}`,
		);
	}

	//------------------------------------------------------------------
	// 3) Fetch ephemeral product => get all previews => upload to Cloudinary
	//------------------------------------------------------------------
	let ephemeralDetails;
	try {
		const details = await axios.get(
			`https://api.printify.com/v1/shops/${printifyProduct.__shopId}/products/${ephemeralProductId}.json`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		ephemeralDetails = details.data;
	} catch (err) {
		console.error(
			"âŒ Fetch ephemeral product error:",
			JSON.stringify(err.response?.data, null, 2),
		);
		throw new Error(
			`Failed to fetch ephemeral product ${ephemeralProductId}: ${
				err.response?.data?.message || err.message
			}`,
		);
	}

	const ephemeralImages = ephemeralDetails.images || [];
	if (!ephemeralImages.length) {
		throw new Error("Ephemeral product has no preview images.");
	}

	// We'll map variantId -> { url, public_id } after Cloudinary upload
	const variantIdToCloudImage = {};

	// Each ephemeralImages entry has variant_ids that the image covers
	for (const ephemeralImgObj of ephemeralImages) {
		const { variant_ids = [], src = "" } = ephemeralImgObj;
		if (!src) continue;

		// Upload ephemeral preview to Cloudinary once
		let uploaded;
		try {
			uploaded = await cloudinary.uploader.upload(src, {
				folder: "serene_janat/example_designs",
				resource_type: "image",
			});
		} catch (err) {
			console.error("âŒ Cloudinary upload ephemeral error:", err.message);
			continue;
		}

		// Assign the same uploaded link to all variant_ids in ephemeralImgObj
		for (const vId of variant_ids) {
			if (!variantIdToCloudImage[vId]) {
				variantIdToCloudImage[vId] = {
					url: uploaded.secure_url,
					public_id: uploaded.public_id,
				};
			}
		}
	}

	//------------------------------------------------------------------
	// 4) Delete ephemeral product
	//------------------------------------------------------------------
	try {
		await axios.delete(
			`https://api.printify.com/v1/shops/${printifyProduct.__shopId}/products/${ephemeralProductId}.json`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
	} catch (err) {
		console.warn(
			`Could not delete ephemeral product ${ephemeralProductId}:`,
			err.response?.data || err.message,
		);
	}

	// Return the map from ephemeral variantId -> { url, public_id }
	return variantIdToCloudImage;
}

async function generatePodDefaultDesignEntriesForSync({
	printifyProduct,
	enabledVariants,
	existingProductDoc,
	existingDefaultDesignEntries = [],
	previewVariantId = null,
	forceRegenerate = false,
	occasionList = [],
	debugPrefix = "pod-default-sync",
}) {
	const safeOccasionListRaw = Array.isArray(occasionList) ? occasionList : [];
	const safeOccasionList = [
		...new Set(
			(safeOccasionListRaw.length
				? safeOccasionListRaw
				: POD_LIST_OCCASION_OPTIONS.map((item) => item.value)
			)
				.map((occasion) => normalizePodListOccasion(occasion))
				.filter(Boolean),
		),
	];

	const hasScopedExistingEntries = Array.isArray(existingDefaultDesignEntries);
	const existingEntries = clonePodDefaultDesignEntries(
		hasScopedExistingEntries
			? existingDefaultDesignEntries
			: collectPodDefaultDesignEntriesFromProduct(existingProductDoc || {}),
	);
	const existingByOccasion = new Map(
		existingEntries.map((entry) => [
			String(entry?.occassion || "").toLowerCase(),
			{
				occassion: entry.occassion,
				defaultDesignImages: normalizePodDefaultDesignImages(
					entry?.defaultDesignImages,
				).slice(0, 3),
			},
		]),
	);

	const previewMetaProduct = {
		_id: existingProductDoc?._id || printifyProduct?.id || null,
		productName: printifyProduct?.title || "",
		thumbnailImage: Array.isArray(existingProductDoc?.thumbnailImage)
			? existingProductDoc.thumbnailImage
			: [],
		productAttributes: Array.isArray(existingProductDoc?.productAttributes)
			? existingProductDoc.productAttributes
			: [],
		printifyProductDetails: {
			POD: true,
			blueprint_id: printifyProduct?.blueprint_id,
			print_provider_id: printifyProduct?.print_provider_id,
			shop_id: printifyProduct?.__shopId || null,
			variants: Array.isArray(enabledVariants) ? enabledVariants : [],
			print_areas: Array.isArray(printifyProduct?.print_areas)
				? printifyProduct.print_areas
				: [],
		},
	};

	const resolvedPreviewVariantId = resolvePodListVariantId(
		previewMetaProduct,
		previewVariantId,
	);
	const results = [];
	let generatedCount = 0;
	let reusedCount = 0;

	for (const safeOccasion of safeOccasionList) {
		const occasionKey = safeOccasion.toLowerCase();
		const existing = existingByOccasion.get(occasionKey);
		const existingImages = normalizePodDefaultDesignImages(
			existing?.defaultDesignImages,
		).slice(0, 3);
		if (!forceRegenerate && existingImages.length >= 3) {
			results.push({
				occassion: safeOccasion,
				defaultDesignImages: existingImages,
			});
			reusedCount += 1;
			continue;
		}

		const debugId = `${debugPrefix}-${String(printifyProduct?.id || "unknown")}-${safeOccasion
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "")
			.slice(0, 36)}`;

		try {
			const generated = await generatePodListPreview({
				product: previewMetaProduct,
				occasion: safeOccasion,
				name: "",
				variantIdInput: resolvedPreviewVariantId,
				cacheKey: `sync-default:${String(printifyProduct?.id || "")}:${String(
					resolvedPreviewVariantId || "",
				)}:${safeOccasion}:noname`,
				debugId,
				options: {
					returnPreviewImages: true,
					maxPreviewImages: 3,
					uploadPreviewImagesToCloudinary: true,
					previewImagesCloudinaryFolder: "serene_janat/pod_default_designs",
					cleanupPreviewProduct: true,
					cleanupDesignUpload: true,
				},
			});

			const generatedImages = normalizePodDefaultDesignImages(
				generated?.uploadedPreviewImages,
			).slice(0, 3);
			if (generatedImages.length) {
				results.push({
					occassion: safeOccasion,
					defaultDesignImages: generatedImages,
				});
				generatedCount += 1;
				continue;
			}

			if (existingImages.length) {
				results.push({
					occassion: safeOccasion,
					defaultDesignImages: existingImages,
				});
				reusedCount += 1;
			}
		} catch (defaultGenError) {
			console.warn(`[${debugId}] Failed generating default POD designs`, {
				productId: String(printifyProduct?.id || ""),
				occasion: safeOccasion,
				status: defaultGenError?.response?.status || null,
				data: defaultGenError?.response?.data || null,
				message: defaultGenError?.message,
			});
			if (existingImages.length) {
				results.push({
					occassion: safeOccasion,
					defaultDesignImages: existingImages,
				});
				reusedCount += 1;
			}
		}
	}

	return {
		entries: clonePodDefaultDesignEntries(results).filter(
			(entry) =>
				Array.isArray(entry?.defaultDesignImages) &&
				entry.defaultDesignImages.length > 0,
		),
		generatedCount,
		reusedCount,
	};
}

exports.syncPrintifyProducts = async (req, res) => {
	try {
		//-------------------------------------------------------------------
		// 0. CONFIG CONSTANTS
		//-------------------------------------------------------------------
		const productIdsWithPOD = [
			"679ab3a63029882bb90b0159",
			"679ab2f94d8f4f8a1a088c32",
			"679ab284f6537a44d90232d6",
			"679ab1eed7eb5609e107e949",
			"679ab14d7fc1cdd41f08a20a",
			"679aafdff6537a44d9023235",
			"679aae24f6537a44d90231b7",
			"680a6dbc82aa6fcd4901beaa",
			"680a79254feb8fbd64074b22",
			"680bd2d64feb8fbd6407a02b",
		];

		// Category & Subcategory IDs for POD
		const POD_CATEGORY_ID = "679bb2a7dba50a58933d01eb";
		const POD_SUBCATEGORY_ID = "679bb2bfdba50a58933d0233";

		// Design token from environment
		const DESIGN_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;
		if (!DESIGN_TOKEN) {
			return res
				.status(500)
				.json({ error: "DESIGN_PRINTIFY_TOKEN must be set." });
		}
		// Always backfill default designs on sync:
		// if missing/incomplete we generate, if complete we reuse.
		const shouldGenerateDefaultDesigns = true;
		const forceRegenerateDefaultDesigns = ["1", "true", "yes"].includes(
			String(
				req.body?.forceRegenerateDefaultDesigns ??
					req.query?.forceRegenerateDefaultDesigns ??
					"0",
			)
				.toLowerCase()
				.trim(),
		);
		const defaultDesignOccasions = [
			...new Set(
				POD_LIST_OCCASION_OPTIONS.map((item) => item.value)
					.map((occasion) => normalizePodListOccasion(occasion))
					.filter(Boolean),
			),
		];
		console.log(
			`[sync-printify] Starting sync. generateDefaultDesigns=${shouldGenerateDefaultDesigns} forceRegenerateDefaultDesigns=${forceRegenerateDefaultDesigns} occasionCount=${defaultDesignOccasions.length}`,
		);

		//-------------------------------------------------------------------
		// 1. FETCH CATEGORIES / SUBCATEGORIES
		//-------------------------------------------------------------------
		const categories = await Category.find().sort({ createdAt: -1 });
		const subcategories = await Subcategory.find();
		console.log(
			`[sync-printify] Loaded category data. categories=${categories.length} subcategories=${subcategories.length}`,
		);

		//-------------------------------------------------------------------
		// 2. HELPER: FETCH SHOP + PRODUCTS for the DESIGN token
		//-------------------------------------------------------------------
		const fetchDesignProducts = async (tokenName, token) => {
			const shopRes = await axios.get(
				"https://api.printify.com/v1/shops.json",
				{
					headers: { Authorization: `Bearer ${token}` },
				},
			);
			if (!shopRes.data?.length) {
				console.log(`[${tokenName}] No shops found.`);
				return [];
			}
			const shopId = shopRes.data[0].id;
			console.log(`[${tokenName}] Shop ID found: ${shopId}`);

			const productsRes = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products.json`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			if (!productsRes.data?.data?.length) {
				console.log(`[${tokenName}] No products found in shop ${shopId}`);
				return [];
			}
			console.log(
				`[${tokenName}] Fetched ${productsRes.data.data.length} products`,
			);

			// Attach the shopId so we know which shop to update
			return productsRes.data.data.map((p) => ({ ...p, __shopId: shopId }));
		};

		//-------------------------------------------------------------------
		// 3. FETCH PRODUCTS ONLY FROM DESIGN TOKEN
		//-------------------------------------------------------------------
		console.log(
			"[sync-printify] Fetching products from the design token only.",
		);
		const designProducts = await fetchDesignProducts("DESIGN", DESIGN_TOKEN);
		if (!designProducts.length) {
			return res
				.status(404)
				.json({ error: "No products found from the Printify design shop" });
		}
		const combinedProducts = designProducts;
		console.log(
			`[sync-printify] Ready to process ${combinedProducts.length} Printify products.`,
		);

		//-------------------------------------------------------------------
		// 4. IMAGE UPLOAD HELPER (LIMIT TO 3)
		//-------------------------------------------------------------------
		const uploadImageToCloudinaryLimited = async (
			imagesArray = [],
			limit = 3,
		) => {
			const limitedImages = imagesArray.slice(0, limit);
			const uploadedImages = await Promise.all(
				limitedImages.map(async (img) => {
					try {
						const result = await cloudinary.uploader.upload(img.src, {
							folder: "serene_janat/products",
							resource_type: "image",
						});
						return { public_id: result.public_id, url: result.secure_url };
					} catch (err) {
						console.error("Cloudinary Upload Error:", err.message);
						return null;
					}
				}),
			);
			return uploadedImages.filter(Boolean);
		};

		//-------------------------------------------------------------------
		// 5. HELPER: Distinct color extraction
		//-------------------------------------------------------------------
		function getDistinctColorVariants(variants, optionValueMap) {
			const colorVariantMap = {}; // colorVal -> variant
			for (const v of variants) {
				let colorVal = "";
				for (let valId of v.options || []) {
					if (optionValueMap[valId]?.type?.includes("color")) {
						colorVal =
							optionValueMap[valId].colors?.[0] || optionValueMap[valId].title;
					}
				}
				// store only first variant for each color
				if (colorVal && !colorVariantMap[colorVal]) {
					colorVariantMap[colorVal] = v;
				}
			}
			return Object.values(colorVariantMap);
		}

		//-------------------------------------------------------------------
		// 6. MASTER SYNC HANDLER (CREATE/UPDATE in Mongo; then set â€œDraftâ€)
		//-------------------------------------------------------------------
		async function handleProductSync(productData, variantSKU, printifyProduct) {
			if (!variantSKU) {
				console.warn(
					`[sync-printify] Variant SKU is missing for product: ${printifyProduct.title}`,
				);
				return;
			}

			// A) CREATE or UPDATE in MONGODB
			const existingProduct = await Product.findOne({ productSKU: variantSKU });
			if (existingProduct) {
				existingProduct.productName = productData.productName;
				existingProduct.description = productData.description;
				existingProduct.price = productData.price;
				existingProduct.priceAfterDiscount = productData.priceAfterDiscount;
				existingProduct.MSRPPriceBasic = productData.MSRPPriceBasic;
				existingProduct.quantity = productData.quantity;

				existingProduct.slug = productData.slug;
				existingProduct.slug_Arabic = productData.slug_Arabic;

				existingProduct.category = productData.category;
				existingProduct.subcategory = productData.subcategory;
				existingProduct.gender = productData.gender;
				existingProduct.chosenSeason = productData.chosenSeason;
				existingProduct.isPrintifyProduct = productData.isPrintifyProduct;
				existingProduct.addVariables = productData.addVariables;

				existingProduct.printifyProductDetails =
					productData.printifyProductDetails;

				if (productData.scent) {
					existingProduct.scent = productData.scent;
				}
				if (productData.productAttributes?.length) {
					existingProduct.productAttributes = productData.productAttributes;
				}
				if (productData.thumbnailImage?.[0]?.images?.length) {
					existingProduct.thumbnailImage = productData.thumbnailImage;
				}

				await existingProduct.save();
				console.log(
					`[sync-printify] Updated product in Mongo: ${productData.productName}`,
				);
			} else {
				const newProduct = new Product({
					productSKU: variantSKU,
					...productData,
				});
				await newProduct.save();
				console.log(
					`[sync-printify] Added product in Mongo: ${productData.productName}`,
				);
			}

			// B) Set product to "Draft" in Printify
			try {
				const sourceVariants = Array.isArray(printifyProduct?.variants)
					? printifyProduct.variants
					: [];
				const enabledVariantCount = sourceVariants.filter((v) =>
					Boolean(v?.is_enabled),
				).length;
				const variantSettings = sourceVariants.map((v) => ({
					...v,
					is_enabled: Boolean(v?.is_enabled),
				}));
				const draftPayload = {
					title: printifyProduct.title,
					description: printifyProduct.description,
					visible: false, // draft/unpublished
				};
				if (variantSettings.length && enabledVariantCount <= 100) {
					draftPayload.variants = variantSettings;
				}

				await axios.put(
					`https://api.printify.com/v1/shops/${printifyProduct.__shopId}/products/${printifyProduct.id}.json`,
					draftPayload,
					{
						headers: {
							Authorization: `Bearer ${DESIGN_TOKEN}`,
						},
					},
				);

				console.log(
					`[sync-printify] Set product ${printifyProduct.id} to draft (visible=false).`,
				);
			} catch (draftError) {
				if (draftError?.response?.data?.code === 8251) {
					try {
						await axios.put(
							`https://api.printify.com/v1/shops/${printifyProduct.__shopId}/products/${printifyProduct.id}.json`,
							{
								title: printifyProduct.title,
								description: printifyProduct.description,
								visible: false,
							},
							{
								headers: {
									Authorization: `Bearer ${DESIGN_TOKEN}`,
								},
							},
						);
						console.warn(
							`[sync-printify] Set product ${printifyProduct.id} to draft after 8251 fallback without variants payload.`,
						);
						return;
					} catch (retryDraftError) {
						console.error(
							`[sync-printify] Error setting product ${printifyProduct.id} to draft after fallback:`,
							retryDraftError.response?.data || retryDraftError.message,
						);
						return;
					}
				}
				console.error(
					`[sync-printify] Error setting product ${printifyProduct.id} to draft:`,
					draftError.response?.data || draftError.message,
				);
			}
		}

		//-------------------------------------------------------------------
		// 7. LOOP + PROCESS EACH PRINTIFY PRODUCT
		//-------------------------------------------------------------------
		const failedProducts = [];
		const processedProducts = [];
		const defaultDesignSyncStats = {
			enabled: shouldGenerateDefaultDesigns,
			forceRegenerate: forceRegenerateDefaultDesigns,
			occasionCount: defaultDesignOccasions.length,
			productsGenerated: 0,
			productsReused: 0,
			productsMissing: 0,
			productsFailed: 0,
		};

		for (const [productIndex, printifyProduct] of combinedProducts.entries()) {
			// Determine if product is in the POD list
			const isPOD = productIdsWithPOD.includes(printifyProduct.id);
			console.log(
				`[sync-printify] Processing product ${productIndex + 1}/${combinedProducts.length}: ${printifyProduct.title} | id=${printifyProduct.id} | pod=${isPOD}`,
			);

			// If product is POD => fixed category, else auto-match by tags
			let matchingCategory = null;
			let matchingSubcategories = [];

			if (isPOD) {
				matchingCategory = { _id: POD_CATEGORY_ID };
				matchingSubcategories = [{ _id: POD_SUBCATEGORY_ID }];
			} else {
				matchingCategory = categories.find((cat) =>
					printifyProduct.tags.some(
						(tag) =>
							tag.toLowerCase().includes(cat.categoryName.toLowerCase()) ||
							tag.toLowerCase().includes(cat.categorySlug.toLowerCase()),
					),
				);
				if (matchingCategory) {
					matchingSubcategories = subcategories.filter(
						(sc) =>
							sc.categoryId.toString() === matchingCategory._id.toString(),
					);
				}
			}

			if (!matchingCategory && !isPOD) {
				failedProducts.push(printifyProduct.title);
				console.warn(
					`[sync-printify] Skipped non-POD product with no category match: ${printifyProduct.title}`,
				);
				continue;
			}

			// Build product slug
			const productSlug = slugify(printifyProduct.title, {
				lower: true,
				strict: true,
			});
			const productSlugArabic = slugify(printifyProduct.title, {
				lower: true,
				strict: true,
			});

			const addVariables =
				Array.isArray(printifyProduct.options) &&
				printifyProduct.options.length > 0;

			// Check for enabled variants
			const enabledVariants = (printifyProduct.variants || []).filter(
				(v) => v.is_enabled,
			);
			if (!enabledVariants.length) {
				failedProducts.push(printifyProduct.title);
				console.warn(
					`[sync-printify] No enabled variants found for ${printifyProduct.title}`,
				);
				continue;
			}
			console.log(
				`[sync-printify] Enabled variants for ${printifyProduct.title}: ${enabledVariants.length}`,
			);

			// Build an optionValueMap => { valueId: { type, title, colors? } }
			const optionValueMap = buildPrintifyOptionValueMap(
				printifyProduct.options || [],
			);

			// Sort by size if a size option is present
			const sizeOrdering = [
				"XS",
				"S",
				"M",
				"L",
				"XL",
				"2XL",
				"XXL",
				"3XL",
				"4XL",
				"5XL",
			];
			enabledVariants.sort((a, b) => {
				const getSizeTitle = (v) => {
					for (let valId of v.options || []) {
						if (optionValueMap[valId]?.type?.includes("size")) {
							return optionValueMap[valId].title;
						}
					}
					return "";
				};
				const sizeA = getSizeTitle(a);
				const sizeB = getSizeTitle(b);
				const idxA = sizeOrdering.indexOf(sizeA);
				const idxB = sizeOrdering.indexOf(sizeB);
				if (idxA === -1 && idxB === -1) return 0;
				if (idxA === -1) return 1;
				if (idxB === -1) return -1;
				return idxA - idxB;
			});

			// Top-level product's SKU is from the first variant
			const firstVariantSKU = enabledVariants[0].sku || "NOSKU";
			const existingTopLevel = await Product.findOne({
				productSKU: firstVariantSKU,
			});
			const distinctColorVariants = getDistinctColorVariants(
				enabledVariants,
				optionValueMap,
			);
			const representativeGalleryVariant =
				distinctColorVariants[0] || enabledVariants[0];
			console.log(
				`[sync-printify] Distinct visual color variants for ${printifyProduct.title}: ${distinctColorVariants.length || 1}`,
			);

			//-------------------------------------------------------------------
			// Upload up to 3 ranked images for the top-level
			//-------------------------------------------------------------------
			const topLevelVariantImages = selectBestPrintifyVariantImages({
				printifyProduct,
				variant: representativeGalleryVariant,
				optionValueMap,
				limit: 3,
			});
			let validUploadedImages = await uploadImageToCloudinaryLimited(
				topLevelVariantImages,
				3,
			);
			if (
				!validUploadedImages.length &&
				Array.isArray(existingTopLevel?.thumbnailImage?.[0]?.images)
			) {
				validUploadedImages = existingTopLevel.thumbnailImage[0].images
					.filter((image) => image?.url || image?.src)
					.slice(0, 3);
			}
			console.log(
				`[sync-printify] Top-level gallery images prepared for ${printifyProduct.title}: requested=${topLevelVariantImages.length} uploaded=${validUploadedImages.length}`,
			);

			//-------------------------------------------------------------------
			// Build productData (Mongo fields)
			//-------------------------------------------------------------------
			const topLevelPrintifyPrice = enabledVariants[0].price / 100;
			const productData = {
				productName: printifyProduct.title,
				description: printifyProduct.description || "",
				price: topLevelPrintifyPrice.toFixed(2),
				priceAfterDiscount: topLevelPrintifyPrice.toFixed(2),
				MSRPPriceBasic: topLevelPrintifyPrice.toFixed(2),
				quantity: 20,
				slug: `${productSlug}-${firstVariantSKU}`,
				slug_Arabic: `${productSlugArabic}-${firstVariantSKU}`,
				category: matchingCategory?._id,
				subcategory: matchingSubcategories.map((s) => s._id),
				gender: "6635ab22898104005c96250a", // example only
				chosenSeason: "all",
				thumbnailImage: [{ images: validUploadedImages }],
				isPrintifyProduct: true,
				addVariables: addVariables,
				printifyProductDetails: {
					POD: isPOD,
					id: printifyProduct.id,
					title: printifyProduct.title,
					description: printifyProduct.description,
					tags: printifyProduct.tags,
					options: printifyProduct.options,
					variants: enabledVariants,
					images: printifyProduct.images,
					created_at: printifyProduct.created_at,
					updated_at: printifyProduct.updated_at,
					visible: printifyProduct.visible,
					is_locked: printifyProduct.is_locked,
					blueprint_id: printifyProduct.blueprint_id,
					user_id: printifyProduct.user_id,
					shop_id: printifyProduct.__shopId,
					print_provider_id: printifyProduct.print_provider_id,
					print_areas: printifyProduct.print_areas,
					print_details: printifyProduct.print_details,
					sales_channel_properties: printifyProduct.sales_channel_properties,
					is_printify_express_eligible:
						printifyProduct.is_printify_express_eligible,
					is_printify_express_enabled:
						printifyProduct.is_printify_express_enabled,
					is_economy_shipping_eligible:
						printifyProduct.is_economy_shipping_eligible,
					is_economy_shipping_enabled:
						printifyProduct.is_economy_shipping_enabled,
				},
				productAttributes: [],
			};

			//-------------------------------------------------------------------
			// Build productAttributes array
			//-------------------------------------------------------------------
			const attributeMetas = await Promise.all(
				enabledVariants.map(async (variant) => {
					const {
						color: colorVal,
						size: sizeVal,
						scent: scentVal,
					} = getVariantOptionSummary(variant, optionValueMap);

					const pkParts = [];
					if (sizeVal) pkParts.push(sizeVal);
					if (colorVal) pkParts.push(colorVal);
					if (scentVal) pkParts.push(scentVal);
					const PK = pkParts.length ? pkParts.join("#") : variant.sku;

					const selectedVariantImages = selectBestPrintifyVariantImages({
						printifyProduct,
						variant,
						optionValueMap,
						limit: 3,
					});
					let variantUploadedImages = await uploadImageToCloudinaryLimited(
						selectedVariantImages,
						3,
					);
					if (!variantUploadedImages.length && existingTopLevel) {
						const existingAttr = existingTopLevel.productAttributes?.find(
							(a) => a.SubSKU === variant.sku,
						);
						if (existingAttr?.productImages?.length) {
							variantUploadedImages = existingAttr.productImages
								.filter((image) => image?.url || image?.src)
								.slice(0, 3);
						}
					}

					const priceFromPrintify = variant.price / 100;
					return {
						variant,
						visualGroupKey: buildPodVisualGroupKey(printifyProduct, {
							color: colorVal,
							size: sizeVal,
							scent: scentVal,
						}),
						attribute: {
							PK,
							color: colorVal,
							size: sizeVal,
							scent: scentVal,
							SubSKU: variant.sku,
							quantity: 20,
							price: priceFromPrintify.toFixed(2),
							priceAfterDiscount: priceFromPrintify.toFixed(2),
							MSRP: priceFromPrintify.toFixed(2),
							WholeSalePrice: priceFromPrintify.toFixed(2),
							DropShippingPrice: priceFromPrintify.toFixed(2),
							productImages: variantUploadedImages,
						},
					};
				}),
			);
			productData.productAttributes = attributeMetas.map(
				(entry) => entry.attribute,
			);
			const attributesWithImages = attributeMetas.filter(
				(entry) => Number(entry?.attribute?.productImages?.length || 0) > 0,
			).length;
			console.log(
				`[sync-printify] Variant image upload complete for ${printifyProduct.title}: attributes=${attributeMetas.length} attributesWithImages=${attributesWithImages}`,
			);

			//-------------------------------------------------------------------
			// 8. If product has multiple colors => ephemeral per color
			//    Otherwise => just ephemeral for a single variant.
			//-------------------------------------------------------------------
			let variantIdToCloudImage = {};
			try {
				if (distinctColorVariants.length > 1) {
					//------------------------------------------------
					// MULTIPLE COLORS => ephemeral product per color
					//------------------------------------------------
					variantIdToCloudImage = await createTempDesignPreview(
						printifyProduct,
						// Typically you'd pick a single "representative" size
						// for each color. For simplicity, we use distinctColorVariants
						// as-is. (Optionally filter them if you want only the first size.)
						distinctColorVariants,
						DESIGN_TOKEN,
					);
				} else {
					//------------------------------------------------
					// NO or SINGLE COLOR => ephemeral with just 1 variant
					//------------------------------------------------
					// e.g. we can just pick the first enabled variant
					const singleVariant = enabledVariants[0];
					variantIdToCloudImage = await createTempDesignPreview(
						printifyProduct,
						[singleVariant],
						DESIGN_TOKEN,
					);
				}
			} catch (ephemeralErr) {
				console.error(
					"[sync-printify] Failed generating example-design preview images:",
					ephemeralErr.message,
				);
			}

			//-------------------------------------------------------------------
			// 9. Attach ephemeral preview image(s) to each attribute
			//-------------------------------------------------------------------
			// If multiple colors => we match by color
			// If single color => we have just 1 ephemeral variant => use that for all
			const hasMultipleColors = distinctColorVariants.length > 1;

			for (const attr of productData.productAttributes) {
				if (hasMultipleColors) {
					// find the ephemeral variant with matching color
					const matchingColorVariant = distinctColorVariants.find((dv) => {
						// get dv's color
						let dvColorVal = "";
						for (let valId of dv.options || []) {
							if (optionValueMap[valId]?.type?.includes("color")) {
								dvColorVal =
									optionValueMap[valId].colors?.[0] ||
									optionValueMap[valId].title;
							}
						}
						return dvColorVal === attr.color;
					});
					if (
						matchingColorVariant &&
						variantIdToCloudImage[matchingColorVariant.id]
					) {
						attr.exampleDesignImage = {
							url: variantIdToCloudImage[matchingColorVariant.id].url,
							public_id:
								variantIdToCloudImage[matchingColorVariant.id].public_id,
						};
					}
				} else {
					// single color or no color => just pick the ephemeral result
					// from the single variant we used
					const [onlyVariantId] = Object.keys(variantIdToCloudImage);
					if (onlyVariantId && variantIdToCloudImage[onlyVariantId]) {
						attr.exampleDesignImage = {
							url: variantIdToCloudImage[onlyVariantId].url,
							public_id: variantIdToCloudImage[onlyVariantId].public_id,
						};
					}
				}
			}
			const exampleDesignCount = productData.productAttributes.filter((attr) =>
				Boolean(
					attr?.exampleDesignImage?.url || attr?.exampleDesignImage?.public_id,
				),
			).length;
			console.log(
				`[sync-printify] Example design images assigned for ${printifyProduct.title}: ${exampleDesignCount}/${productData.productAttributes.length}`,
			);

			//-------------------------------------------------------------------
			// 10. Build persisted defaultDesigns (3 images per occasion, no-name)
			//-------------------------------------------------------------------
			let defaultDesignEntries = collectPodDefaultDesignEntriesFromProduct(
				existingTopLevel || {},
			);
			if (isPOD && shouldGenerateDefaultDesigns) {
				const canReuseExistingDesigns =
					!forceRegenerateDefaultDesigns &&
					hasDistinctPodDefaultDesignVisualGroups(
						existingTopLevel || {},
						printifyProduct,
					);
				const existingDefaultDesignsByVisualGroup = canReuseExistingDesigns
					? buildPodDefaultDesignEntryMapByVisualGroup(
							existingTopLevel || {},
							printifyProduct,
						)
					: new Map();
				const defaultDesignsByVisualGroup = new Map();
				let generatedVisualGroups = 0;
				let reusedVisualGroups = 0;
				try {
					console.log(
						`[sync-printify] Building default designs for ${printifyProduct.title}: visualGroups=${new Set(attributeMetas.map((item) => item.visualGroupKey || "default")).size}`,
					);
					for (const attributeMeta of attributeMetas) {
						const visualGroupKey = attributeMeta.visualGroupKey || "default";
						if (defaultDesignsByVisualGroup.has(visualGroupKey)) {
							continue;
						}
						const existingEntriesForGroup =
							existingDefaultDesignsByVisualGroup.get(visualGroupKey) || [];
						const defaultDesignSync =
							await generatePodDefaultDesignEntriesForSync({
								printifyProduct,
								enabledVariants,
								existingProductDoc: existingTopLevel || {},
								existingDefaultDesignEntries: existingEntriesForGroup,
								previewVariantId: attributeMeta.variant?.id || null,
								forceRegenerate: forceRegenerateDefaultDesigns,
								occasionList: defaultDesignOccasions,
								debugPrefix: `pod-default-sync-${visualGroupKey
									.replace(/[^a-z0-9|:-]+/gi, "-")
									.slice(0, 36)}`,
							});
						defaultDesignsByVisualGroup.set(
							visualGroupKey,
							defaultDesignSync.entries,
						);
						console.log(
							`[sync-printify] Default design sync for ${printifyProduct.title} group=${visualGroupKey}: generated=${defaultDesignSync.generatedCount} reused=${defaultDesignSync.reusedCount} entries=${defaultDesignSync.entries.length}`,
						);
						if (defaultDesignSync.generatedCount > 0) {
							generatedVisualGroups += 1;
						} else if (defaultDesignSync.reusedCount > 0) {
							reusedVisualGroups += 1;
						}
					}
					const mergedEntries = [];
					for (const entries of defaultDesignsByVisualGroup.values()) {
						mergedEntries.push(...clonePodDefaultDesignEntries(entries));
					}
					defaultDesignEntries = collectPodDefaultDesignEntriesFromProduct({
						productAttributes: [...productData.productAttributes].map(
							(attribute, index) => ({
								...attribute,
								defaultDesigns:
									defaultDesignsByVisualGroup.get(
										attributeMetas[index]?.visualGroupKey || "default",
									) || [],
							}),
						),
					});
					if (generatedVisualGroups > 0) {
						defaultDesignSyncStats.productsGenerated += 1;
					} else if (reusedVisualGroups > 0 || mergedEntries.length > 0) {
						defaultDesignSyncStats.productsReused += 1;
					} else {
						defaultDesignSyncStats.productsMissing += 1;
					}
					productData.productAttributes = productData.productAttributes.map(
						(attribute, index) => ({
							...attribute,
							defaultDesigns: clonePodDefaultDesignEntries(
								defaultDesignsByVisualGroup.get(
									attributeMetas[index]?.visualGroupKey || "default",
								) || [],
							),
						}),
					);
				} catch (defaultDesignSyncError) {
					defaultDesignSyncStats.productsFailed += 1;
					console.warn(
						`[sync-printify] Failed generating persisted default designs for ${printifyProduct.title}`,
						{
							productId: printifyProduct.id,
							status: defaultDesignSyncError?.response?.status || null,
							data: defaultDesignSyncError?.response?.data || null,
							message: defaultDesignSyncError?.message,
						},
					);
				}
			} else if (defaultDesignEntries.length) {
				defaultDesignSyncStats.productsReused += 1;
			}

			if (
				!productData.productAttributes.some(
					(attribute) =>
						Array.isArray(attribute?.defaultDesigns) &&
						attribute.defaultDesigns.length > 0,
				)
			) {
				const clonedDefaultDesignEntries =
					clonePodDefaultDesignEntries(defaultDesignEntries);
				productData.productAttributes = productData.productAttributes.map(
					(attribute) => ({
						...attribute,
						defaultDesigns: clonePodDefaultDesignEntries(
							clonedDefaultDesignEntries,
						),
					}),
				);
			}

			//-------------------------------------------------------------------
			// 11. Finally, CREATE/UPDATE top-level product & set to draft
			//-------------------------------------------------------------------
			await handleProductSync(productData, firstVariantSKU, printifyProduct);
			processedProducts.push(printifyProduct.id);
			console.log(
				`[sync-printify] Finished product ${productIndex + 1}/${combinedProducts.length}: ${printifyProduct.title}`,
			);
		}

		//-------------------------------------------------------------------
		// 12. FINISH + REPORT
		//-------------------------------------------------------------------
		const recommendations = failedProducts.map((title) => ({
			productTitle: title,
			recommendation: "Check category matching or variant SKUs.",
		}));

		if (failedProducts.length > 0) {
			console.log(
				`[sync-printify] Sync finished with partial failures. processed=${processedProducts.length} failed=${failedProducts.length}`,
			);
			res.status(207).json({
				message: `Products synced with some failures. ${processedProducts.length} products processed, ${failedProducts.length} products failed.`,
				failedProducts,
				recommendations,
				defaultDesignSync: defaultDesignSyncStats,
			});
		} else {
			console.log(
				`[sync-printify] Sync finished successfully. processed=${processedProducts.length}`,
			);
			res.json({
				message: `All Printify products synced successfully. ${processedProducts.length} products processed.`,
				defaultDesignSync: defaultDesignSyncStats,
			});
		}
	} catch (error) {
		console.error("[sync-printify] Error syncing products:", error);
		res.status(500).json({ error: "Error syncing products" });
	}
};

exports.getSpecificPrintifyProducts = async (req, res) => {
	try {
		console.log("[get-specific-printify] Fetching all products from Printify.");

		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;
		if (!DESIGN_PRINTIFY_TOKEN) {
			return res.status(500).json({
				error: "DESIGN_PRINTIFY_TOKEN not set in environment variables.",
			});
		}

		// 1. Fetch Shop ID
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			},
		);

		if (!shopResponse.data || shopResponse.data.length === 0) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id;
		console.log(`[get-specific-printify] Shop ID found: ${shopId}`);

		// 2. Fetch ALL products from the shop
		const productsResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			},
		);

		if (!productsResponse.data || productsResponse.data.data.length === 0) {
			return res
				.status(404)
				.json({ error: "No products found in Printify shop" });
		}

		let allProducts = productsResponse.data.data;
		console.log(
			`[get-specific-printify] Total products retrieved: ${allProducts.length}`,
		);

		// 3. Optional: If ?productIds=xyz,abc is provided, filter
		const republishedProductIds = req.query.productIds
			? req.query.productIds.split(",")
			: null;

		if (republishedProductIds && republishedProductIds.length > 0) {
			console.log(
				`Filtering only products with IDs: ${republishedProductIds.join(", ")}`,
			);

			allProducts = allProducts.filter((product) =>
				republishedProductIds.includes(product.id),
			);
			console.log(
				`[get-specific-printify] Filtered products count: ${allProducts.length}`,
			);
		}

		// 4. Map them to a simplified structure (optional)
		// If you want to return the entire raw product object, skip this `.map(...)`
		// and return `allProducts` directly.
		const mappedProducts = allProducts.map((product) => ({
			id: product.id,
			title: product.title,
			description: product.description || "No description available",
			visible: product.visible,
			is_locked: product.is_locked,
			images: product.images?.map((img) => img.src) || [],
			variants: product.variants?.map((variant) => ({
				id: variant.id,
				title: variant.title,
				price: variant.price / 100, // Convert cents to dollars
				available: variant.is_available,
				is_enabled: variant.is_enabled,
				sku: variant.sku,
			})),
		}));

		// 5. Return all or mapped products
		res.json({
			success: true,
			total_products_returned: mappedProducts.length,
			products: mappedProducts,
		});
	} catch (error) {
		console.error(
			"[get-specific-printify] Error fetching Printify products:",
			error.response?.data || error.message,
		);
		res.status(500).json({ error: "Failed to fetch Printify products" });
	}
};

exports.getSinglePrintifyProductById = async (req, res) => {
	try {
		const { product_id } = req.params;

		// 1. **Validate Product ID**
		if (!product_id) {
			return res.status(400).json({ error: "Product ID is required" });
		}

		// 2. **Retrieve Printify API Token**
		const token = process.env.DESIGN_PRINTIFY_TOKEN;

		if (!token) {
			return res
				.status(500)
				.json({ error: "Printify API Token is not configured" });
		}

		// 3. **Fetch Shop ID Dynamically**
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		);

		// 4. **Validate Shop Response**
		if (
			!shopResponse.data ||
			!Array.isArray(shopResponse.data) ||
			shopResponse.data.length === 0
		) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id; // Use the first shop ID
		console.log(`âœ… Shop ID found: ${shopId}`);

		// 5. **Fetch the Single Product from Printify**
		const productResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products/${product_id}.json`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		);

		const fetchedProduct = productResponse.data;

		// 6. **Validate Product Data**
		if (!fetchedProduct) {
			console.error("âŒ 'fetchedProduct' is undefined");
			return res.status(404).json({ error: "Product not found in Printify" });
		}

		// 7. **Ensure 'variants' is an array**
		if (!Array.isArray(fetchedProduct.variants)) {
			console.error("âŒ 'variants' is not an array", fetchedProduct.variants);
			return res
				.status(500)
				.json({ error: "'variants' data structure is invalid" });
		}

		// 8. **Filter Variants: Only include available and enabled variants**
		const filteredVariants = fetchedProduct.variants.filter(
			(variant) => variant.is_available && variant.is_enabled,
		);
		console.log(
			`ðŸ” Found ${filteredVariants.length} available and enabled variants`,
		);

		// 9. **Check if Any Variants Remain After Filtering**
		if (filteredVariants.length === 0) {
			console.error(
				"âŒ No available and enabled variants found for this product.",
			);
			return res.status(404).json({
				error: "No available and enabled variants found for this product.",
			});
		}

		// 10. **Ensure 'options' is an array**
		if (!Array.isArray(fetchedProduct.options)) {
			console.error("âŒ 'options' is not an array", fetchedProduct.options);
			return res
				.status(500)
				.json({ error: "'options' data structure is invalid" });
		}

		// 11. **Map Option Names to Indices in Variants**
		const optionNameToIndexMap = {};
		fetchedProduct.options.forEach((opt, idx) => {
			if (opt && opt.name) {
				optionNameToIndexMap[opt.name.toLowerCase()] = idx;
			}
		});

		// 12. **Identify the "Colors" Option Index (Optional)**
		const colorOptionIndex = optionNameToIndexMap["colors"];
		const hasColorOption = colorOptionIndex !== undefined;

		if (hasColorOption) {
			console.log("ðŸŽ¨ 'Colors' option found in product options");

			// 13. **Ensure 'variants.options' arrays are valid**
			const availableColorIds = new Set(
				filteredVariants
					.map((variant) => {
						if (!Array.isArray(variant.options)) {
							console.error(
								`âŒ 'options' array missing in variant ID: ${variant.id}`,
							);
							return undefined;
						}
						const colorId = variant.options[colorOptionIndex];
						if (colorId === undefined) {
							console.error(`âŒ Color ID missing in variant ID: ${variant.id}`);
						}
						return colorId;
					})
					.filter((optId) => optId !== undefined),
			);

			console.log(
				`ðŸŽ¨ Available Color IDs: ${[...availableColorIds].join(", ")}`,
			);

			if (availableColorIds.size === 0) {
				console.error(
					"âŒ No available color IDs found after filtering variants",
				);
				return res.status(500).json({
					error: "No available color IDs found after filtering variants",
				});
			}

			// 14. **Filter Colors in Options Based on Available Variants**
			const colorOption = fetchedProduct.options.find(
				(opt) => opt.name.toLowerCase() === "colors",
			);
			if (!colorOption) {
				console.error("âŒ 'Colors' option not found", fetchedProduct.options);
				return res
					.status(500)
					.json({ error: "Colors option not found in product options" });
			}

			if (!Array.isArray(colorOption.values)) {
				console.error(
					"âŒ 'values' is not an array in 'Colors' option",
					colorOption,
				);
				return res
					.status(500)
					.json({ error: "'values' is not an array in 'Colors' option" });
			}

			const filteredColorValues = colorOption.values.filter((color) =>
				availableColorIds.has(color.id),
			);

			if (filteredColorValues.length === 0) {
				console.warn("âš ï¸ No colors available after filtering");
			}

			var filteredOptions = fetchedProduct.options
				.map((opt) => {
					if (opt.name.toLowerCase() === "colors") {
						return {
							...opt,
							values: filteredColorValues,
						};
					}
					return opt; // Keep other options unchanged
				})
				.filter(
					(opt) => opt && Array.isArray(opt.values) && opt.values.length > 0,
				); // Remove nulls and options with no values
		} else {
			console.warn(
				"âš ï¸ 'Colors' option not found. Proceeding without color filtering.",
			);
			// If there is no 'Colors' option, keep all existing options
			var filteredOptions = fetchedProduct.options.filter(
				(opt) => opt && Array.isArray(opt.values) && opt.values.length > 0,
			);
		}

		// 15. **Ensure 'images' is an array**
		if (!Array.isArray(fetchedProduct.images)) {
			console.error("âŒ 'images' is not an array", fetchedProduct.images);
			return res
				.status(500)
				.json({ error: "'images' data structure is invalid" });
		}

		// 16. **Filter Images: Only include images associated with filtered variants**
		const filteredVariantIds = filteredVariants.map((variant) => variant.id);
		const filteredImages = fetchedProduct.images.filter(
			(image) =>
				Array.isArray(image.variant_ids) &&
				image.variant_ids.some((id) => filteredVariantIds.includes(id)),
		);
		console.log(`ðŸ–¼ï¸ Found ${filteredImages.length} associated images`);

		// 17. **Remove Image Limitation**
		const finalImages = filteredImages; // No limit on images

		// 18. **Ensure 'print_areas' is an array**
		if (!Array.isArray(fetchedProduct.print_areas)) {
			console.error(
				"âŒ 'print_areas' is not an array",
				fetchedProduct.print_areas,
			);
			return res
				.status(500)
				.json({ error: "'print_areas' data structure is invalid" });
		}

		// 19. **Filter Print Areas: Only include variant_ids present in filtered variants**
		const filteredPrintAreas = fetchedProduct.print_areas
			.map((printArea) => {
				if (!printArea || !Array.isArray(printArea.variant_ids)) {
					console.error(
						`âŒ Invalid 'printArea' structure: ${JSON.stringify(printArea)}`,
					);
					return null; // Exclude invalid print areas
				}

				const filteredVariantIdsInPrintArea = printArea.variant_ids.filter(
					(id) => filteredVariantIds.includes(id),
				);

				// Ensure 'placeholders' is an array
				let filteredPlaceholders = [];
				if (Array.isArray(printArea.placeholders)) {
					filteredPlaceholders = printArea.placeholders
						.map((placeholder) => {
							if (!placeholder || !Array.isArray(placeholder.images)) {
								console.warn(
									`âš ï¸ Invalid 'placeholder' structure: ${JSON.stringify(
										placeholder,
									)}`,
								);
								return null; // Exclude invalid placeholders
							}

							// You can add more filtering logic here if necessary
							return {
								...placeholder,
								images: placeholder.images.filter(
									(img) => img !== undefined && img !== null,
								),
							};
						})
						.filter(
							(placeholder) => placeholder && placeholder.images.length > 0,
						);
				} else {
					console.warn(
						`âš ï¸ 'placeholders' is not an array in printArea ID: ${printArea.id}`,
					);
				}

				return {
					...printArea,
					variant_ids: filteredVariantIdsInPrintArea,
					placeholders: filteredPlaceholders,
				};
			})
			.filter(
				(printArea) =>
					printArea &&
					printArea.variant_ids.length > 0 &&
					printArea.placeholders.length > 0,
			); // Remove invalid or empty print areas
		console.log(`ðŸ–¨ï¸ Found ${filteredPrintAreas.length} valid print areas`);

		// 20. **Do Not Filter Views Based on Variant IDs**
		const filteredViews = fetchedProduct.views; // Retain all views
		console.log(`ðŸ‘ï¸ Found ${filteredViews.length} views`);

		// 21. **Construct the Modified Product Object**
		const modifiedProduct = {
			...fetchedProduct,
			variants: filteredVariants,
			options: filteredOptions,
			images: finalImages,
			print_areas: filteredPrintAreas,
			views: filteredViews, // Retained all views
		};

		// 22. **Respond to the Frontend**
		return res.json({ success: true, product: modifiedProduct });
	} catch (error) {
		console.error(
			"âŒ Error fetching single Printify product:",
			error.response?.data || error.message,
			error.stack,
		);

		// Determine appropriate status code
		const statusCode = error.response?.status || 500;
		const errorMessage =
			error.response?.data?.message || "Internal server error";

		return res.status(statusCode).json({ error: errorMessage });
	}
};

/**
 * POST /api/printify/create-custom-order
 *
 * 1) Create a new "on-the-fly" product
 * 2) Order that product
 * 3) Delete or disable the product
 */
exports.createCustomPrintifyOrder = async (req, res) => {
	try {
		const tokenInfo = resolvePrintifyToken();
		if (!tokenInfo.token) {
			return res.status(500).json({ error: tokenInfo.error });
		}
		const printifyToken = tokenInfo.token;

		// 0) Extract your custom design data + shipping info from the request body
		const {
			// Product creation data:
			blueprint_id,
			print_provider_id,
			variant_id, // e.g. "Light Blue / 3XL" or some variant integer ID
			quantity,
			print_areas, // e.g. { front: [ { type: "text/plain", x:0.5, y:0.5, input_text:"Hello!" } ] }
			// Order shipping data:
			shipping_method, // 1=standard,2=priority,3=express,4=economy
			address_to,
			// Optional external_id for your order
			external_id,
		} = req.body;

		// 1) Basic validation checks
		if (!blueprint_id || !print_provider_id || !variant_id || !quantity) {
			return res
				.status(400)
				.json({ error: "Missing required fields for product creation." });
		}
		if (
			!address_to ||
			!address_to.first_name ||
			!address_to.last_name ||
			!address_to.country ||
			!address_to.address1 ||
			!address_to.city ||
			!address_to.zip
		) {
			return res
				.status(400)
				.json({ error: "Missing required shipping address fields." });
		}

		// 2) Get your Shop ID from Printify
		//    (If you only have one shop, you can skip this step and store shopId in .env)
		const shopsResp = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${printifyToken}`,
					"User-Agent": "NodeJS-App",
				},
			},
		);
		if (!shopsResp.data?.length) {
			return res.status(404).json({ error: "No Printify shop found." });
		}
		const shopId = shopsResp.data[0].id;

		// 3) CREATE THE PRODUCT
		//    We only enable the single variant we want.
		//    Also note that "blueprint_id" & "print_provider_id" are required for creation.
		//    "print_areas" must follow Printify's structure to place text/images on front/back etc.
		//
		//    Example of "images" array in placeholders:
		//      {
		//        "id": "some-upload-id",
		//        "type": "image/png",
		//        "x": 0.5,
		//        "y": 0.5,
		//        "scale": 1,
		//        "angle": 0
		//      }
		//    Example of "text layer":
		//      {
		//        "id": "text-layer-123",
		//        "type": "text/plain",
		//        "font_family": "Arial",
		//        "font_size": 24,
		//        "font_color": "#000000",
		//        "x": 0.5,
		//        "y": 0.5,
		//        "scale": 1,
		//        "angle": 0,
		//        "input_text": "Hello World"
		//      }
		//
		//    Each placeholder can hold an array of images (layers).
		//    For example: front: [ { ... } ], back: [ { ... } ], etc.

		const createProductPayload = {
			title: "Custom One-Time Product", // set as you like
			description: "User-personalized product",
			blueprint_id,
			print_provider_id,
			// variants: only 1 variant is enabled; others are disabled
			variants: [
				{
					id: variant_id, // the integer ID from the Printify blueprint
					price: 4900, // in cents, e.g. $49.00
					is_enabled: true, // we want to enable only this variant
					is_default: true, // the "main" variant
				},
			],
			print_areas: [
				{
					variant_ids: [variant_id],
					placeholders: Object.entries(print_areas).map(
						([position, layers]) => ({
							position, // e.g. "front"
							images: layers, // an array of images or text layers
						}),
					),
				},
			],
			// optionally set "tags": ["custom", "one-time"]
		};

		const createProductResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			createProductPayload,
			{
				headers: {
					Authorization: `Bearer ${printifyToken}`,
					"Content-Type": "application/json",
					"User-Agent": "NodeJS-App",
				},
			},
		);

		if (!createProductResp.data?.id) {
			return res
				.status(500)
				.json({ error: "Failed to create product on Printify." });
		}
		const newProductId = createProductResp.data.id;

		// 4) CREATE THE ORDER referencing the newly created product
		//    We'll order the single variant the user configured.
		const orderPayload = {
			external_id: external_id || `custom-order-${Date.now()}`,
			line_items: [
				{
					product_id: newProductId, // the product we just created
					variant_id,
					quantity,
				},
			],
			shipping_method: shipping_method || 1, // default to standard
			send_shipping_notification: false,
			address_to,
		};

		const orderResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/orders.json`,
			orderPayload,
			{
				headers: {
					Authorization: `Bearer ${printifyToken}`,
					"Content-Type": "application/json",
					"User-Agent": "NodeJS-App",
				},
			},
		);

		if (!orderResp.data) {
			return res
				.status(500)
				.json({ error: "Failed to create order for the new product." });
		}

		// 5) CLEAN UP: Remove or disable the product so it doesnâ€™t show in your store.
		//    Option A: Delete the product entirely
		try {
			await axios.delete(
				`https://api.printify.com/v1/shops/${shopId}/products/${newProductId}.json`,
				{
					headers: {
						Authorization: `Bearer ${printifyToken}`,
						"User-Agent": "NodeJS-App",
					},
				},
			);
		} catch (err) {
			console.warn(
				"Warning: The order was created, but deleting the product failed:",
				err.response?.data || err.message,
			);
			// not a show-stopper â€” the order is still placed
		}

		// Option B (instead of deleting): Update the product to disable variants
		//    e.g. using PUT /v1/shops/{shop_id}/products/{product_id}.json
		//    to set "is_enabled" = false for all variants. Then it won't appear.
		//    (But it's simpler to just DELETE if truly ephemeral.)

		// 6) Return success (include the order info in response)
		return res.status(201).json({
			message: "Custom product created and order placed successfully.",
			product_id: newProductId,
			order: orderResp.data,
		});
	} catch (error) {
		console.error(
			"Error creating on-the-fly Printify product & order:",
			error?.response?.data || error.message,
		);
		if (error?.response?.status === 401) {
			return res.status(500).json({
				error:
					"Printify authentication failed. Refresh your Printify token and restart the backend.",
			});
		}
		return res.status(500).json({
			error: "Error creating on-the-fly Printify product & order",
		});
	}
};

exports.previewCustomPrintifyDesign = async (req, res) => {
	let previewProductId = null;
	let printifyToken = null;
	let previewShopId = null;
	let shouldCleanupPreviewProduct = true;
	const debugId = `preview-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const startedAt = Date.now();
	try {
		const safeHost = (urlValue) => {
			try {
				if (!urlValue) return null;
				return new URL(urlValue).host;
			} catch {
				return "invalid-url";
			}
		};

		const tokenInfo = resolvePrintifyToken();
		if (!tokenInfo.token) {
			console.error(`[${debugId}] No valid Printify token.`, {
				error: tokenInfo.error,
			});
			return res.status(500).json({ error: tokenInfo.error });
		}
		printifyToken = tokenInfo.token;
		const tokenExpMs = parseJwtExpiryMs(printifyToken);
		console.log(`[${debugId}] /api/preview-custom-design started`, {
			tokenSource: tokenInfo.source || "unknown",
			tokenExpiresAt: tokenExpMs
				? new Date(tokenExpMs).toISOString()
				: "unknown",
			origin: req.headers?.origin || null,
			referer: req.headers?.referer || null,
			userAgent: req.headers?.["user-agent"] || null,
		});

		const {
			blueprint_id,
			print_provider_id,
			variant_id,
			design_image_url,
			bare_design_image_url,
			design_covers_print_area = false,
			design_is_full_print_area_capture = false,
			force_source_placement = false,
			print_areas = [],
			title,
			preferred_position,
		} = req.body || {};
		const requestedPosition = normalizePrintAreaPosition(
			preferred_position || "front",
		);
		console.log(`[${debugId}] Request payload summary`, {
			blueprint_id,
			print_provider_id,
			variant_id,
			title: title || null,
			preferredPosition: requestedPosition || null,
			printAreasCount: Array.isArray(print_areas) ? print_areas.length : 0,
			hasDesignImageUrl: Boolean(design_image_url),
			designImageHost: safeHost(design_image_url),
			hasBareDesignImageUrl: Boolean(bare_design_image_url),
			bareDesignImageHost: safeHost(bare_design_image_url),
			designCoversPrintArea: Boolean(design_covers_print_area),
			designIsFullPrintAreaCapture: Boolean(design_is_full_print_area_capture),
			forceSourcePlacement: Boolean(force_source_placement),
		});
		const previewDesignUrl = bare_design_image_url || design_image_url;

		if (
			!blueprint_id ||
			!print_provider_id ||
			!variant_id ||
			!(design_image_url || bare_design_image_url)
		) {
			return res.status(400).json({
				error:
					"Missing required fields. blueprint_id, print_provider_id, variant_id, and design image are required.",
			});
		}

		console.log(`[${debugId}] Fetching Printify shops...`);
		const shopsResp = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${printifyToken}`,
					"User-Agent": "NodeJS-App",
				},
			},
		);
		if (!shopsResp.data?.length) {
			return res.status(404).json({ error: "No Printify shop found." });
		}
		const shopId = shopsResp.data[0].id;
		previewShopId = shopId;
		const normalizedVariantId = Number(variant_id) || variant_id;
		console.log(`[${debugId}] Shop resolved`, {
			shopCount: shopsResp.data.length,
			shopId,
			normalizedVariantId,
		});

		console.log(`[${debugId}] Uploading design image to Printify...`, {
			imageSource: bare_design_image_url
				? "bare_design_image_url"
				: "design_image_url",
			sourceHost: safeHost(previewDesignUrl),
		});
		const uploadResp = await axios.post(
			"https://api.printify.com/v1/uploads/images.json",
			{
				file_name: `preview-${Date.now()}.png`,
				url: previewDesignUrl,
			},
			{
				headers: {
					Authorization: `Bearer ${printifyToken}`,
					"Content-Type": "application/json",
					"User-Agent": "NodeJS-App",
				},
			},
		);
		const uploadedImageId = uploadResp?.data?.id;
		console.log(`[${debugId}] Printify upload response`, {
			hasUploadId: Boolean(uploadedImageId),
			uploadId: uploadedImageId || null,
		});
		if (!uploadedImageId) {
			return res.status(502).json({
				error: "Failed to upload design image to Printify.",
			});
		}

		const safePrintAreas = Array.isArray(print_areas) ? print_areas : [];
		let variantPrintArea = safePrintAreas.find(
			(area) =>
				Array.isArray(area.variant_ids) &&
				area.variant_ids.some((id) => String(id) === String(variant_id)),
		);
		if (!variantPrintArea && safePrintAreas.length > 0) {
			variantPrintArea = safePrintAreas[0];
		}
		console.log(`[${debugId}] Print area selection`, {
			safePrintAreasCount: safePrintAreas.length,
			matchedVariantPrintArea: Boolean(variantPrintArea),
			matchedPositionCount: Array.isArray(variantPrintArea?.placeholders)
				? variantPrintArea.placeholders.length
				: 0,
		});

		const sourcePlaceholders = Array.isArray(variantPrintArea?.placeholders)
			? variantPrintArea.placeholders
			: [];
		const requestedPlaceholder =
			sourcePlaceholders.find(
				(placeholder) =>
					normalizePrintAreaPosition(placeholder?.position || "") ===
					requestedPosition,
			) || null;
		const preferredPlaceholder =
			requestedPlaceholder ||
			pickBestPodListPlaceholder(sourcePlaceholders, {
				productName: title || "Custom Design",
			}) ||
			sourcePlaceholders[0];
		const preferredPosition = normalizePrintAreaPosition(
			preferredPlaceholder?.position || requestedPosition || "front",
		);
		const sourceImage = Array.isArray(preferredPlaceholder?.images)
			? preferredPlaceholder.images[0]
			: null;
		const coversPrintArea = Boolean(design_covers_print_area);
		const previewProductMeta = { productName: title || "Custom Design" };
		const fullPrintAreaScale = getFullPrintAreaPreviewScale(
			previewProductMeta,
			preferredPosition,
		);
		const placementDefaults = coversPrintArea
			? { x: 0.5, y: 0.5, scale: fullPrintAreaScale, angle: 0 }
			: getPodListPlacementDefaults(previewProductMeta, preferredPosition);
		const placementResult = coversPrintArea
			? {
					finalX: 0.5,
					finalY: 0.5,
					finalScale: fullPrintAreaScale,
					finalAngle: 0,
					hasValidSourcePlacement: false,
					sourceNearExpectedArea: true,
					sourcePlacementIsTooSmall: false,
					sourcePlacementIsTooLarge: false,
					minAcceptedScale: fullPrintAreaScale,
					maxAcceptedScale: fullPrintAreaScale,
					useSourcePlacement: false,
					sourcePlacement: {
						x: null,
						y: null,
						scale: null,
						angle: null,
					},
				}
			: resolvePodListPlacementFromSource({
					sourceImage,
					placementDefaults,
					forceSourcePlacement: Boolean(force_source_placement),
				});
		const previewScaleBoost = coversPrintArea
			? 1
			: force_source_placement
				? 1
				: getPodPreviewPlacementBoost(previewProductMeta, preferredPosition);
		const boostedScale = coversPrintArea
			? fullPrintAreaScale
			: Math.min(
					2.6,
					Math.max(
						0.28,
						Number(
							placementResult.finalScale || placementDefaults.scale || 0.88,
						) * previewScaleBoost,
					),
				);
		const placeholders = [];
		if (preferredPlaceholder) {
			placeholders.push({
				position: preferredPosition,
				images: [
					{
						type: "image/png",
						id: uploadedImageId,
						x: placementResult.finalX,
						y: placementResult.finalY,
						scale: boostedScale,
						angle: placementResult.finalAngle,
					},
				],
			});
		}

		if (!placeholders.length) {
			placeholders.push({
				position: "front",
				images: [
					{
						type: "image/png",
						id: uploadedImageId,
						x: coversPrintArea ? 0.5 : placementDefaults.x || 0.5,
						y: coversPrintArea ? 0.5 : placementDefaults.y || 0.5,
						scale: coversPrintArea
							? fullPrintAreaScale
							: Math.min(
									2.6,
									Math.max(
										0.28,
										Number(placementDefaults.scale || 0.88) * previewScaleBoost,
									),
								),
						angle: 0,
					},
				],
			});
		}
		console.log(`[${debugId}] Placeholder build complete`, {
			placeholderCount: placeholders.length,
			positions: placeholders.map((p) => p.position),
			placementDefaults,
			placementResult,
			coversPrintArea,
			fullPrintAreaScale,
			previewScaleBoost,
			boostedScale,
		});

		const createPayload = {
			title: `Preview - ${title || "Custom Design"}`,
			description: "Temporary preview product",
			blueprint_id,
			print_provider_id,
			variants: [
				{
					id: normalizedVariantId,
					price: 2500,
					is_enabled: true,
					is_default: true,
				},
			],
			print_areas: [
				{
					variant_ids: [normalizedVariantId],
					placeholders,
				},
			],
			visible: false,
		};
		console.log(`[${debugId}] Creating temporary preview product...`, {
			shopId,
			blueprint_id,
			print_provider_id,
			variantId: normalizedVariantId,
			placeholderCount: placeholders.length,
		});

		const createResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			createPayload,
			{
				headers: {
					Authorization: `Bearer ${printifyToken}`,
					"Content-Type": "application/json",
					"User-Agent": "NodeJS-App",
				},
			},
		);
		previewProductId = createResp?.data?.id;
		console.log(`[${debugId}] Temporary product created`, {
			previewProductId: previewProductId || null,
		});
		if (!previewProductId) {
			return res.status(502).json({
				error: "Printify preview product creation failed.",
			});
		}

		let previewImages = [];
		const previewTitle = String(title || "").toLowerCase();
		const isWearablePreview =
			previewTitle.includes("t-shirt") ||
			previewTitle.includes("tee") ||
			(previewTitle.includes("shirt") &&
				!previewTitle.includes("sweatshirt")) ||
			previewTitle.includes("hoodie") ||
			previewTitle.includes("sweatshirt") ||
			previewTitle.includes("pullover");
		const preferredCameraLabels = getPreferredPreviewCameraLabels(
			previewProductMeta,
			preferredPosition,
		);
		const scorePreviewImage = (image = {}) => {
			let score = 0;
			const pos = String(
				image.position || image.placeholder || "",
			).toLowerCase();
			const src = String(image.src || "").toLowerCase();
			const cameraLabel = getMockupCameraLabel(image);
			if (pos.includes("front")) score += 7;
			if (pos.includes("center")) score += 3;
			if (image.is_default) score += 2;
			if (src.includes("front")) score += 1;
			if (pos.includes("back") || src.includes("back")) score -= 4;
			if (preferredCameraLabels.includes(cameraLabel)) score += 18;
			if (
				preferredPosition.includes("front") &&
				/(bottom|inside|open)/.test(cameraLabel)
			) {
				score -= 10;
			}
			if (previewProductMeta?.productName?.toLowerCase().includes("pillow")) {
				if (
					/(zipper|closeup|close-up|detail|corner|side|profile)/.test(
						`${pos} ${src} ${cameraLabel}`,
					)
				) {
					score -= 20;
				}
				if (cameraLabel === "front") score += 10;
				if (image.is_default) score += 6;
				if (/(front|main|default)/.test(`${pos} ${src}`)) score += 6;
			}
			if (isWearablePreview) {
				const lifestyleHint =
					/(lifestyle|model|wear|wearing|person|people|man|woman|male|female|on-model|on_model|studio)/.test(
						`${pos} ${src}`,
					);
				const flatHint = /(flat|blank|template|ghost|isolated|side)/.test(src);
				if (lifestyleHint) score += 14;
				if (flatHint) score -= 6;
				if (!image.is_default) score += 3;
				if (image.is_default) score -= 2;
			}
			return score;
		};
		for (let attempt = 0; attempt < 5; attempt++) {
			console.log(`[${debugId}] Polling preview images`, {
				attempt: attempt + 1,
				previewProductId,
			});
			const previewProductResp = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products/${previewProductId}.json`,
				{
					headers: {
						Authorization: `Bearer ${printifyToken}`,
						"User-Agent": "NodeJS-App",
					},
				},
			);
			const allImages = Array.isArray(previewProductResp?.data?.images)
				? previewProductResp.data.images
				: [];
			const prioritized = [...allImages]
				.sort((a, b) => scorePreviewImage(b) - scorePreviewImage(a))
				.map((image) => image?.src)
				.filter(Boolean);
			previewImages = [...new Set(prioritized)].slice(0, 3);
			console.log(`[${debugId}] Poll result`, {
				attempt: attempt + 1,
				totalImages: Array.isArray(previewProductResp?.data?.images)
					? previewProductResp.data.images.length
					: 0,
				returnedImages: previewImages.length,
			});
			if (previewImages.length >= 3) break;
			await new Promise((resolve) => setTimeout(resolve, 900));
		}
		console.log(`[${debugId}] Preview generation finished`, {
			previewProductId,
			imageCount: previewImages.length,
			durationMs: Date.now() - startedAt,
		});
		shouldCleanupPreviewProduct = false;

		return res.json({
			success: true,
			product_id: previewProductId,
			preview_product_id: previewProductId,
			shop_id: shopId,
			preview_images: previewImages,
		});
	} catch (error) {
		console.error(`[${debugId}] Error generating Printify preview:`, {
			status: error?.response?.status || null,
			data: error?.response?.data || null,
			message: error?.message,
			previewProductId,
			durationMs: Date.now() - startedAt,
		});
		if (error?.response?.status === 401) {
			return res.status(500).json({
				error:
					"Printify authentication failed. Refresh your Printify token and restart the backend.",
			});
		}
		return res.status(500).json({
			error: "Failed to generate preview on Printify.",
		});
	} finally {
		if (shouldCleanupPreviewProduct && previewProductId && printifyToken) {
			try {
				console.log(`[${debugId}] Cleanup start`, {
					previewProductId,
					previewShopId,
				});
				const cleanupResult = await deletePreviewProductById({
					previewProductId,
					shopIdHint: previewShopId,
					printifyToken,
					debugId,
				});
				console.log(`[${debugId}] Cleanup result`, cleanupResult);
			} catch (cleanupError) {
				console.warn(`[${debugId}] Preview cleanup warning:`, {
					status: cleanupError?.response?.status || null,
					data: cleanupError?.response?.data || null,
					message: cleanupError?.message,
					previewProductId,
				});
			}
		} else {
			console.log(`[${debugId}] Cleanup skipped`, {
				shouldCleanupPreviewProduct,
				hasPreviewProductId: Boolean(previewProductId),
				hasPrintifyToken: Boolean(printifyToken),
				durationMs: Date.now() - startedAt,
			});
		}
	}
};

exports.deletePreviewCustomPrintifyDesign = async (req, res) => {
	const debugId = `preview-delete-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	try {
		const { previewProductId } = req.params;
		const shopIdHint = req.body?.shop_id || req.query?.shop_id || null;
		if (!previewProductId) {
			return res.status(400).json({ error: "Missing previewProductId." });
		}

		const tokenInfo = resolvePrintifyToken();
		if (!tokenInfo.token) {
			return res.status(500).json({ error: tokenInfo.error });
		}

		console.log(`[${debugId}] Delete preview product requested`, {
			previewProductId,
			shopIdHint,
		});
		const result = await deletePreviewProductById({
			previewProductId,
			shopIdHint,
			printifyToken: tokenInfo.token,
			debugId,
		});

		return res.json({
			success: true,
			previewProductId,
			deleted: Boolean(result.deleted),
			shopId: result.shopId || shopIdHint || null,
			notFound: Boolean(result.notFound),
		});
	} catch (error) {
		console.error(`[${debugId}] Failed deleting preview product`, {
			status: error?.response?.status || null,
			data: error?.response?.data || null,
			message: error?.message,
		});
		return res.status(500).json({
			error: "Failed to delete preview product from Printify.",
		});
	}
};

exports.getPodPrintAreaLayout = async (req, res) => {
	try {
		const { productId } = req.params;
		if (!productId) {
			return res.status(400).json({ error: "Missing productId." });
		}

		const product = await Product.findById(productId)
			.select("_id productName printifyProductDetails")
			.lean();
		if (!product) {
			return res.status(404).json({ error: "Product not found." });
		}

		const blueprintId = product?.printifyProductDetails?.blueprint_id;
		const printProviderId = product?.printifyProductDetails?.print_provider_id;
		const productVariants = Array.isArray(
			product?.printifyProductDetails?.variants,
		)
			? product.printifyProductDetails.variants
			: [];
		if (!blueprintId || !printProviderId || !productVariants.length) {
			return res.status(400).json({
				error: "Missing Printify blueprint/provider/variant data on product.",
			});
		}

		const catalogLayout = await fetchPodCatalogVariantLayouts({
			blueprintId,
			printProviderId,
			variantIds: productVariants.map((variant) => variant?.id).filter(Boolean),
		});
		const variants = catalogLayout.variants.map((variant) => ({
			id: variant.id,
			title: variant.title,
			placeholders: variant.placeholders,
			placeholderMap: variant.placeholders.reduce(
				(accumulator, placeholder) => {
					if (placeholder?.position) {
						accumulator[placeholder.position] = placeholder;
					}
					return accumulator;
				},
				{},
			),
		}));

		return res.json({
			success: true,
			productId,
			productName: product.productName || "",
			blueprint_id: catalogLayout.blueprint_id,
			print_provider_id: catalogLayout.print_provider_id,
			variants,
		});
	} catch (error) {
		console.error("Failed loading POD print area layout:", {
			status: error?.response?.status || null,
			data: error?.response?.data || null,
			message: error?.message,
		});
		return res.status(500).json({
			error: "Failed to load POD print area layout.",
		});
	}
};

exports.getPodListingPreview = async (req, res) => {
	const debugId = `pod-list-preview-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const startedAt = Date.now();
	try {
		const { productId } = req.params;
		const forceRefresh =
			String(req.query?.force || req.body?.force || "").trim() === "1";
		const safeOccasion = normalizePodListOccasion(
			req.query?.occasion || req.body?.occasion,
		);
		const safeName = sanitizePodListName(
			req.query?.name || req.body?.name || "",
		);
		const requestedVariantId =
			req.query?.variant_id || req.body?.variant_id || null;

		if (!productId) {
			return res.status(400).json({ error: "Missing productId." });
		}

		const product = await Product.findById(productId)
			.select(
				"_id productName productAttributes thumbnailImage printifyProductDetails",
			)
			.lean();
		if (!product) {
			return res.status(404).json({ error: "Product not found." });
		}
		if (!product?.printifyProductDetails?.POD) {
			return res.status(400).json({
				error: "Product is not configured as a POD product.",
			});
		}
		if (
			!product?.printifyProductDetails?.blueprint_id ||
			!product?.printifyProductDetails?.print_provider_id
		) {
			return res.status(400).json({
				error: "Missing Printify blueprint/provider details on product.",
			});
		}
		if (!forceRefresh && !safeName) {
			const storedDefaultDesign = getPodStoredDefaultDesignEntry(
				product,
				safeOccasion,
			);
			const storedDefaultImages = normalizePodDefaultDesignImages(
				storedDefaultDesign?.defaultDesignImages,
			);
			if (storedDefaultImages.length) {
				return res.json({
					success: true,
					source: "stored-default-design",
					product_id: productId,
					preview_image:
						storedDefaultImages[0].cloudinary_url || storedDefaultImages[0].url,
					preview_images: storedDefaultImages.map(
						(item) => item.cloudinary_url || item.url,
					),
					preview_product_id: null,
					shop_id: null,
					occasion: safeOccasion,
					name: safeName,
					message: buildPodListGiftMessage(safeOccasion, safeName),
					duration_ms: Date.now() - startedAt,
				});
			}
		}

		const variantId = resolvePodListVariantId(product, requestedVariantId);
		const cacheKey = makePodListPreviewCacheKey({
			productId,
			variantId,
			occasion: safeOccasion,
			name: safeName,
		});

		if (!forceRefresh) {
			const memoryHit = getCachedPodListPreview(cacheKey);
			if (memoryHit?.preview_image_url) {
				return res.json({
					success: true,
					source: "memory-cache",
					cache_key: cacheKey,
					product_id: productId,
					preview_image: memoryHit.preview_image_url,
					preview_product_id: memoryHit.preview_product_id || null,
					shop_id: memoryHit.shop_id || null,
					occasion: safeOccasion,
					name: safeName,
					message:
						memoryHit.message ||
						buildPodListGiftMessage(safeOccasion, safeName),
					duration_ms: Date.now() - startedAt,
				});
			}

			const dbEntries = getPersistedPodListPreviews(product);
			const dbHit = dbEntries.find((entry) => entry.key === cacheKey);
			if (dbHit?.preview_image_url) {
				setCachedPodListPreview(cacheKey, dbHit);
				return res.json({
					success: true,
					source: "db-cache",
					cache_key: cacheKey,
					product_id: productId,
					preview_image: dbHit.preview_image_url,
					preview_product_id: dbHit.preview_product_id || null,
					shop_id: dbHit.shop_id || null,
					occasion: safeOccasion,
					name: safeName,
					message:
						dbHit.message || buildPodListGiftMessage(safeOccasion, safeName),
					duration_ms: Date.now() - startedAt,
				});
			}
		}

		if (!forceRefresh && podListPreviewInFlight.has(cacheKey)) {
			const sharedResult = await podListPreviewInFlight.get(cacheKey);
			return res.json({
				success: true,
				source: "shared-in-flight",
				cache_key: cacheKey,
				product_id: productId,
				preview_image: sharedResult.preview_image_url,
				preview_product_id: sharedResult.preview_product_id || null,
				shop_id: sharedResult.shop_id || null,
				occasion: safeOccasion,
				name: safeName,
				message:
					sharedResult.message ||
					buildPodListGiftMessage(safeOccasion, safeName),
				duration_ms: Date.now() - startedAt,
			});
		}

		const generationPromise = (async () => {
			const generated = await generatePodListPreview({
				product,
				occasion: safeOccasion,
				name: safeName,
				variantIdInput: requestedVariantId,
				cacheKey,
				debugId,
			});
			const cacheEntry = {
				key: cacheKey,
				occasion: generated.occasion,
				name: generated.name,
				message: generated.message,
				variant_id: generated.variantId,
				preview_image_url: generated.previewImageUrl,
				preview_product_id: generated.previewProductId || null,
				shop_id: generated.shopId || null,
				design_image_url: generated.designImageUrl || null,
				design_image_public_id: generated.designImagePublicId || null,
				generated_at: new Date().toISOString(),
			};
			const evictedPreviewsToCleanup = await persistPodListPreview({
				product,
				cacheEntry,
			});
			setCachedPodListPreview(cacheKey, cacheEntry);

			if (
				Array.isArray(evictedPreviewsToCleanup) &&
				evictedPreviewsToCleanup.length > 0
			) {
				const tokenInfo = resolvePrintifyToken();
				if (tokenInfo.token) {
					Promise.allSettled(
						evictedPreviewsToCleanup.map((entry) =>
							deletePreviewProductById({
								previewProductId: entry.preview_product_id,
								shopIdHint: entry.shop_id || null,
								printifyToken: tokenInfo.token,
								debugId: `${debugId}-cleanup-evicted`,
							}),
						),
					)
						.then((results) => {
							const deletedCount = results.filter(
								(result) =>
									result.status === "fulfilled" && result.value?.deleted,
							).length;
							const failedCount = results.filter(
								(result) => result.status === "rejected",
							).length;
							console.log(`[${debugId}] Evicted POD list preview cleanup`, {
								productId: String(product._id),
								requested: evictedPreviewsToCleanup.length,
								deletedCount,
								failedCount,
							});
						})
						.catch((cleanupError) => {
							console.warn(`[${debugId}] Evicted preview cleanup warning`, {
								productId: String(product._id),
								status: cleanupError?.response?.status || null,
								data: cleanupError?.response?.data || null,
								message: cleanupError?.message,
							});
						});
				}
			}

			return cacheEntry;
		})();

		podListPreviewInFlight.set(cacheKey, generationPromise);
		let generatedEntry;
		try {
			generatedEntry = await generationPromise;
		} finally {
			podListPreviewInFlight.delete(cacheKey);
		}

		return res.json({
			success: true,
			source: "generated",
			cache_key: cacheKey,
			product_id: productId,
			preview_image: generatedEntry.preview_image_url,
			preview_product_id: generatedEntry.preview_product_id || null,
			shop_id: generatedEntry.shop_id || null,
			occasion: generatedEntry.occasion,
			name: generatedEntry.name,
			message: generatedEntry.message,
			duration_ms: Date.now() - startedAt,
		});
	} catch (error) {
		console.error(`[${debugId}] Failed generating POD list preview`, {
			status: error?.response?.status || null,
			data: error?.response?.data || null,
			message: error?.message,
			durationMs: Date.now() - startedAt,
		});
		try {
			const fallbackProduct = await Product.findById(req.params?.productId)
				.select("_id productAttributes thumbnailImage printifyProductDetails")
				.lean();
			const fallbackImage = pickProductFallbackImage(fallbackProduct);
			if (fallbackImage) {
				return res.json({
					success: false,
					source: "fallback-error",
					product_id: req.params?.productId || null,
					preview_image: fallbackImage,
					error:
						error?.response?.data?.errors?.reason ||
						error?.response?.data?.message ||
						error?.message ||
						"Preview generation failed; returned fallback image.",
				});
			}
		} catch (fallbackError) {
			console.warn(`[${debugId}] Failed to resolve fallback preview image`, {
				message: fallbackError?.message,
			});
		}
		return res.status(500).json({
			error: "Failed to generate POD list preview.",
			details: error?.response?.data || error?.message,
		});
	}
};

exports.cleanupPodListPreviewSession = async (req, res) => {
	const debugId = `pod-list-cleanup-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const startedAt = Date.now();
	try {
		const tokenInfo = resolvePrintifyToken();
		if (!tokenInfo.token) {
			return res.status(500).json({ error: tokenInfo.error });
		}

		const cleanupItems = normalizePodListCleanupItems(
			req.body?.items || req.body?.preview_products || [],
		);
		if (!cleanupItems.length) {
			return res.json({
				success: true,
				requested: 0,
				deleted: 0,
				not_found: 0,
				failed: 0,
				duration_ms: Date.now() - startedAt,
			});
		}

		console.log(`[${debugId}] POD list session cleanup requested`, {
			requested: cleanupItems.length,
			hasToken: Boolean(tokenInfo.token),
			tokenSource: tokenInfo.source || null,
		});

		const cleanupResults = await Promise.allSettled(
			cleanupItems.map((item) =>
				deletePreviewProductById({
					previewProductId: item.previewProductId,
					shopIdHint: item.shopIdHint,
					printifyToken: tokenInfo.token,
					debugId,
				}),
			),
		);

		const failures = [];
		let deletedCount = 0;
		let notFoundCount = 0;
		for (let index = 0; index < cleanupResults.length; index++) {
			const result = cleanupResults[index];
			const item = cleanupItems[index];
			if (result.status === "fulfilled") {
				if (result.value?.deleted) deletedCount += 1;
				if (result.value?.notFound) notFoundCount += 1;
				continue;
			}
			failures.push({
				preview_product_id: item.previewProductId,
				shop_id: item.shopIdHint || null,
				product_id: item.productId || null,
				status: result?.reason?.response?.status || null,
				message: result?.reason?.message || "Unknown cleanup error",
			});
		}

		const cleanupIdsByProductId = new Map();
		for (const item of cleanupItems) {
			if (!item.productId) continue;
			const key = String(item.productId);
			if (!cleanupIdsByProductId.has(key)) {
				cleanupIdsByProductId.set(key, new Set());
			}
			cleanupIdsByProductId
				.get(key)
				.add(String(item.previewProductId || "").trim());
		}

		const dbCleanupSummary = [];
		for (const [productId, previewIdSet] of cleanupIdsByProductId.entries()) {
			const summary = await removePersistedPodListPreviewsForProduct({
				productId,
				previewProductIds: [...previewIdSet],
			});
			dbCleanupSummary.push(summary);
		}

		const updatedProducts = dbCleanupSummary.filter(
			(entry) => entry?.updated,
		).length;

		console.log(`[${debugId}] POD list session cleanup finished`, {
			requested: cleanupItems.length,
			deletedCount,
			notFoundCount,
			failedCount: failures.length,
			updatedProducts,
			durationMs: Date.now() - startedAt,
		});

		return res.json({
			success: failures.length === 0,
			requested: cleanupItems.length,
			deleted: deletedCount,
			not_found: notFoundCount,
			failed: failures.length,
			updated_products: updatedProducts,
			failures: failures.slice(0, 50),
			duration_ms: Date.now() - startedAt,
		});
	} catch (error) {
		console.error(`[${debugId}] POD list session cleanup failed`, {
			status: error?.response?.status || null,
			data: error?.response?.data || null,
			message: error?.message,
			durationMs: Date.now() - startedAt,
		});
		return res.status(500).json({
			error: "Failed to clean POD list preview session products.",
		});
	}
};

// Existing helper functions...

// New Function: Webhook Handler (Optional)
exports.printifyWebhook = async (req, res) => {
	try {
		const event = req.body;

		// Verify webhook signature if Printify provides one

		switch (event.event) {
			case "order_status_changed":
				const orderId = event.data.id;
				const newStatus = event.data.status;

				// Update the local order status
				await Order.findOneAndUpdate(
					{ "printifyOrderDetails.id": orderId },
					{ "printifyOrderDetails.status": newStatus },
				);
				break;
			// Handle other events as needed
			default:
				console.log(`Unhandled event type: ${event.event}`);
		}

		res.status(200).send("Webhook received");
	} catch (error) {
		console.error("Error handling Printify webhook:", error);
		res.status(500).send("Webhook error");
	}
};

exports.updatePrintifyProduct = async (req, res) => {
	try {
		const { product_id } = req.params;
		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;

		if (!product_id) {
			return res.status(400).json({ error: "Missing product_id" });
		}
		if (!DESIGN_PRINTIFY_TOKEN) {
			return res.status(500).json({
				error: "DESIGN_PRINTIFY_TOKEN not set in environment variables",
			});
		}

		// 1) Fetch Shop ID
		const shopRes = await axios.get("https://api.printify.com/v1/shops.json", {
			headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
		});
		if (!shopRes.data?.length) {
			return res.status(404).json({ error: "No Printify shops found" });
		}
		const shopId = shopRes.data[0].id;

		// 2) Optionally fetch all library images if you want to filter out invalid 'id' references:
		let validImageIds = new Set();
		try {
			const uploadsRes = await axios.get(
				"https://api.printify.com/v1/uploads.json",
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				},
			);
			for (const libImg of uploadsRes.data?.data || []) {
				validImageIds.add(libImg.id);
			}
		} catch (libErr) {
			// not fatal if we can't fetch library, but we won't remove unknown images
			console.error(
				"Could not fetch library uploads:",
				libErr.response?.data || libErr.message,
			);
		}

		// 3) Grab fields from req.body
		const {
			title,
			description,
			tags,
			options,
			variants,
			images,
			print_areas,
			visible,
			// is_locked is read-only
		} = req.body;

		// 4) Fetch the existing product (to merge with your changes)
		let existingProduct;
		try {
			const existingResp = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products/${product_id}.json`,
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				},
			);
			existingProduct = existingResp.data;
		} catch (errGet) {
			console.error(
				"Failed to fetch existing product:",
				errGet.response?.data || errGet.message,
			);
			return res.status(500).json({
				error: "Failed to fetch existing product before update",
				details: errGet.response?.data || errGet.message,
			});
		}

		// 5) Build finalPayload by merging existing data with new changes
		const finalPayload = {
			title: existingProduct.title,
			description: existingProduct.description,
			tags: existingProduct.tags,
			options: existingProduct.options,
			variants: existingProduct.variants,
			images: existingProduct.images,
			print_areas: existingProduct.print_areas,
			visible: existingProduct.visible,
		};

		if (title !== undefined) finalPayload.title = title;
		if (description !== undefined) finalPayload.description = description;
		if (tags !== undefined) finalPayload.tags = tags;
		if (options !== undefined) finalPayload.options = options;
		if (variants !== undefined) finalPayload.variants = variants;
		if (images !== undefined) finalPayload.images = images;
		if (print_areas !== undefined) finalPayload.print_areas = print_areas;
		if (visible !== undefined) finalPayload.visible = visible;

		// 6) Filter invalid images if needed (avoid code 8253)
		if (Array.isArray(finalPayload.print_areas)) {
			finalPayload.print_areas = finalPayload.print_areas.map((pa) => {
				const placeholders = (pa.placeholders || []).map((ph) => {
					const safeImages = (ph.images || []).filter((img) => {
						// text => keep
						if (img.type === "text") return true;
						// has 'id' => must be in library
						if (typeof img.id === "string" && img.id.trim() !== "") {
							return validImageIds.size > 0 ? validImageIds.has(img.id) : true;
						}
						// else drop
						return false;
					});
					return { ...ph, images: safeImages };
				});
				return { ...pa, placeholders };
			});
		}

		// 7) Ensure all variants appear in at least one print_area's variant_ids (avoid code 8251)
		//    We'll gather the final variant IDs, then check if each is found in any print_area.
		//    If not found, we insert it into the first print_area's variant_ids for safety.
		const finalVariants = finalPayload.variants || [];
		const finalVariantIds = finalVariants.map((v) => v.id);

		if (
			Array.isArray(finalPayload.print_areas) &&
			finalPayload.print_areas.length > 0
		) {
			// let the first print_area handle any missing variant IDs
			const firstPA = finalPayload.print_areas[0];

			finalPayload.print_areas = finalPayload.print_areas.map((pa) => {
				// filter out any variant_ids that are not in finalVariantIds
				// or keep them if your blueprint demands
				const validPAIds = (pa.variant_ids || []).filter((vid) =>
					finalVariantIds.includes(vid),
				);

				return { ...pa, variant_ids: validPAIds };
			});

			// Now we ensure each variant appears in at least one print_area
			for (const vId of finalVariantIds) {
				let foundIt = false;
				for (const pa of finalPayload.print_areas) {
					if (pa.variant_ids.includes(vId)) {
						foundIt = true;
						break;
					}
				}
				// If not found in any print_area => put it in the first one
				if (!foundIt) {
					if (!firstPA.variant_ids.includes(vId)) {
						firstPA.variant_ids.push(vId);
					}
				}
			}
		}

		// 8) Prepare to PUT
		const putUrl = `https://api.printify.com/v1/shops/${shopId}/products/${product_id}.json`;

		async function doUpdate(payload) {
			return axios.put(putUrl, payload, {
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
					"Content-Type": "application/json",
				},
			});
		}

		// 9) Attempt first update
		try {
			const printifyRes = await doUpdate(finalPayload);
			return res.json({
				success: true,
				message: "Printify product updated successfully",
				data: printifyRes.data,
			});
		} catch (firstErr) {
			const errData = firstErr.response?.data;
			const errCode = errData?.code;
			if (errCode !== 8252) {
				// Not locked => fail
				console.error(
					"Error updating product (1st attempt):",
					errData || firstErr.message,
				);
				return res.status(500).json({
					error: "Failed to update Printify product",
					details: errData || firstErr.message,
				});
			}

			// If locked => unlock => retry
			console.log(
				"Product locked. Attempting to unlock via publishing_failed...",
			);
			try {
				await axios.post(
					`https://api.printify.com/v1/shops/${shopId}/products/${product_id}/publishing_failed.json`,
					{ reason: "Manual unlock for editing." },
					{
						headers: {
							Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							"Content-Type": "application/json",
						},
					},
				);
			} catch (unlockErr) {
				console.error(
					"Failed to unlock product:",
					unlockErr.response?.data || unlockErr.message,
				);
				return res.status(500).json({
					error: "Failed to unlock product",
					details: unlockErr.response?.data || unlockErr.message,
				});
			}

			console.log("Unlocked product successfully. Retrying update...");
			try {
				const secondRes = await doUpdate(finalPayload);
				return res.json({
					success: true,
					message: "Product was unlocked and updated successfully",
					data: secondRes.data,
				});
			} catch (secondErr) {
				console.error(
					"Error updating product (2nd attempt):",
					secondErr.response?.data || secondErr.message,
				);
				return res.status(500).json({
					error: "Failed to update Printify product after unlocking",
					details: secondErr.response?.data || secondErr.message,
				});
			}
		}
	} catch (outerErr) {
		console.error(
			"Error updating Printify product:",
			outerErr.response?.data || outerErr.message,
		);
		return res.status(500).json({
			error: "Failed to update Printify product (outer catch)",
			details: outerErr.response?.data || outerErr.message,
		});
	}
};

// A 1Ã—1 fully transparent PNG, Base64-encoded as a data URI
const TRANSPARENT_IMAGE_URL =
	"https://res.cloudinary.com/infiniteapps/image/upload/v1738428028/AdobeStock_679343692_Preview_onatmh.png";

/**
 * Reverts all Printify products in your shop to have "blank" designs
 * by replacing each placeholder's images with a single invisible
 * library image (referenced by an "id" from Printify).
 */
exports.revertPrintifyProductsToBePlainNoDesign = async (req, res) => {
	try {
		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;
		if (!DESIGN_PRINTIFY_TOKEN) {
			return res
				.status(500)
				.json({ error: "DESIGN_PRINTIFY_TOKEN not set in environment." });
		}

		// -------------------------------------
		// 1) UPLOAD TRANSPARENT IMAGE TO PRINTIFY -> GET `transparentId`
		// -------------------------------------
		let transparentId;
		try {
			const uploadResp = await axios.post(
				"https://api.printify.com/v1/uploads/images.json",
				{
					file_name: "transparent.png",
					url: TRANSPARENT_IMAGE_URL,
					// If you wanted to do base64 instead:
					// contents: "<base64_string>"
				},
				{
					headers: {
						Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
						"Content-Type": "application/json",
					},
				},
			);
			transparentId = uploadResp.data.id; // e.g. "5e16d66791287a0006e522b2"
			console.log("Uploaded transparent image => ID:", transparentId);
		} catch (uploadErr) {
			console.error(
				"Failed to upload transparent image:",
				uploadErr.response?.data || uploadErr.message,
			);
			return res.status(400).json({
				error: "Failed to upload transparent image to Printify",
				details: uploadErr.response?.data || uploadErr.message,
			});
		}

		// -------------------------------------
		// 2) FETCH SHOP ID
		// -------------------------------------
		let shopId;
		try {
			const shopRes = await axios.get(
				"https://api.printify.com/v1/shops.json",
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				},
			);
			if (!shopRes.data?.length) {
				return res.status(404).json({ error: "No Printify shops found." });
			}
			shopId = shopRes.data[0].id;
		} catch (shopErr) {
			console.error(
				"Error fetching shop ID:",
				shopErr.response?.data || shopErr.message,
			);
			return res.status(500).json({
				error: "Failed to fetch Printify shops",
				details: shopErr.response?.data || shopErr.message,
			});
		}

		// -------------------------------------
		// 3) FETCH ALL PRODUCTS
		// -------------------------------------
		let products;
		try {
			const productsRes = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products.json`,
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				},
			);
			products = productsRes.data?.data || [];
			if (!products.length) {
				return res.json({
					message: "No products in this Printify shop",
					updatedCount: 0,
				});
			}
		} catch (listErr) {
			console.error(
				"Error fetching products list:",
				listErr.response?.data || listErr.message,
			);
			return res.status(500).json({
				error: "Failed to fetch products from Printify",
				details: listErr.response?.data || listErr.message,
			});
		}

		const results = [];

		// -------------------------------------
		// 4) LOOP THROUGH EACH PRODUCT & UPDATE
		// -------------------------------------
		for (const product of products) {
			const productId = product.id;
			console.log(`Processing product: ${product.title} (${productId})`);

			// 4A) GET FULL PRODUCT DETAILS
			let fullProduct;
			try {
				const singleRes = await axios.get(
					`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
					{
						headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
					},
				);
				fullProduct = singleRes.data;
			} catch (getErr) {
				console.error(
					"Failed GET product details:",
					getErr.response?.data || getErr.message,
				);
				results.push({
					productId,
					status: "Failed_GetDetails",
					error: getErr.response?.data || getErr.message,
				});
				continue; // Move to next product
			}

			// 4B) BUILD NEW PRINT_AREAS => single transparent image referencing 'transparentId'
			const newPrintAreas = (fullProduct.print_areas || []).map((pa) => ({
				...pa,
				placeholders: (pa.placeholders || []).map((ph) => ({
					...ph,
					images: [
						{
							type: "image",
							id: transparentId, // Must use "id" from your library upload
							x: 0.5,
							y: 0.5,
							scale: 0.01,
							angle: 0,
						},
					],
				})),
			}));

			const updatePayload = {
				title: fullProduct.title,
				description: fullProduct.description || "",
				tags: fullProduct.tags || [],
				variants: fullProduct.variants || [],
				print_areas: newPrintAreas,
			};

			// 4C) PUT UPDATE
			try {
				await axios.put(
					`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
					updatePayload,
					{
						headers: {
							Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							"Content-Type": "application/json",
						},
					},
				);
				console.log(`âœ… Product ${productId}: replaced with blank design`);
				results.push({
					productId,
					status: "BlankDesignApplied",
					message:
						"Now has only a transparent library image for each placeholder",
				});
			} catch (putErr) {
				const errCode = putErr.response?.data?.code || null;
				// If locked => we do publishing_failed => re-try
				if (errCode === 8252) {
					console.log(
						`Product ${productId} is locked. Attempting to unlock...`,
					);
					try {
						// i) publishing_failed
						await axios.post(
							`https://api.printify.com/v1/shops/${shopId}/products/${productId}/publishing_failed.json`,
							{ reason: "Need to revert design." },
							{
								headers: {
									Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
									"Content-Type": "application/json",
								},
							},
						);
						// ii) Retry PUT
						await axios.put(
							`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
							updatePayload,
							{
								headers: {
									Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
									"Content-Type": "application/json",
								},
							},
						);
						console.log(`âœ… Product ${productId} unlocked and updated`);
						results.push({
							productId,
							status: "BlankDesignApplied_AfterUnlock",
							message: "Unlocked, replaced with blank design",
						});
					} catch (unlockErr) {
						console.error(
							"Failed unlocking or updating product:",
							unlockErr.response?.data || unlockErr.message,
						);
						results.push({
							productId,
							status: "Failed_AfterUnlock",
							error: unlockErr.response?.data || unlockErr.message,
						});
					}
				} else {
					console.error(
						`âŒ Validation/Other error for product ${productId}:`,
						putErr.response?.data || putErr.message,
					);
					results.push({
						productId,
						status: "Failed_Put",
						error: putErr.response?.data || putErr.message,
					});
				}
			}
		}

		// 5) SUMMARIZE RESULTS
		const successCount = results.filter((r) =>
			r.status.startsWith("BlankDesignApplied"),
		).length;
		const failCount = results.length - successCount;

		return res.json({
			success: true,
			totalProducts: products.length,
			totalSuccess: successCount,
			totalFailed: failCount,
			details: results,
		});
	} catch (error) {
		console.error(
			"Error removing designs:",
			error.response?.data || error.message,
		);
		return res.status(500).json({
			error: "Failed to revert designs on Printify products",
			details: error.response?.data || error.message,
		});
	}
};
