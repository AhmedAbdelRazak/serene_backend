/* ---------------------------------------------------------------------------
   HelperFunctions.js
   Centralised helpers for Order / Payment flow   (Stripe edition)
   --------------------------------------------------------------------------- */
"use strict";

/* ─────────────────────────────────  External libs  ───────────────────────── */
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const PDFDocument = require("pdfkit");
const sgMail = require("@sendgrid/mail");
const twilio = require("twilio");

/* ───────────────────────────────────  Models  ────────────────────────────── */
const { Order } = require("../models/order");
const Product = require("../models/product");
const StoreManagement = require("../models/storeManagement");
const Colors = require("../models/colors");

/* ─────────────────────────────  E‑mail templates  ────────────────────────── */
const {
	formatOrderEmail,
	formatOrderEmailPOS,
	formatPaymentLinkEmail,
	formatSellerEmail,
} = require("./Helper"); //  ← your existing HTML helpers

/* ────────────────────────────  SendGrid / Twilio  ────────────────────────── */
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const orderStatusSMS = twilio(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

/* ────────────────────────────────  Constants  ────────────────────────────── */
const BusinessName = "Serene Jannat";
const fromEmail = "noreply@serenejannat.com";
const defaultEmail = "ahmed.abdelrazak@jannatbooking.com";
const owners = [
	"ahmedandsally14@gmail.com",
	"ahmed.abdelrazak20@gmail.com",
	"sally.abdelrazak@serenejannat.com",
];
const shopLogo = path.join(__dirname, "../shopLogo/logo.png");

function normalizePrintifyToken(value = "") {
	return `${value || ""}`.trim().toLowerCase();
}

function normalizePrintifyColor(value = "") {
	const raw = normalizePrintifyToken(value);
	if (!raw) return "";
	if (raw.startsWith("#")) return raw;
	if (/^[0-9a-f]{3,8}$/i.test(raw)) return `#${raw}`;
	return raw;
}

function coercePrintifyId(value) {
	return typeof value === "number" ? value : parseInt(value, 10);
}

function findPrintifyOption(details = {}, target = "") {
	const targetToken = normalizePrintifyToken(target);
	const options = Array.isArray(details?.options) ? details.options : [];
	return (
		options.find((option) => {
			const optionType = normalizePrintifyToken(option?.type);
			const optionName = normalizePrintifyToken(option?.name);
			return (
				optionType.includes(targetToken) || optionName.includes(targetToken)
			);
		}) || null
	);
}

function findPrintifyOptionValue(details = {}, target = "", requested = "", explicitId = null) {
	const option = findPrintifyOption(details, target);
	const values = Array.isArray(option?.values) ? option.values : [];
	if (!values.length) return null;

	if (explicitId !== undefined && explicitId !== null && `${explicitId}`.trim()) {
		const byId =
			values.find((value) => `${value?.id ?? ""}`.trim() === `${explicitId}`.trim()) ||
			null;
		if (byId) return byId;
	}

	const requestedToken = normalizePrintifyToken(requested);
	const requestedColor = normalizePrintifyColor(requested);
	if (!requestedToken && !requestedColor) return null;

	return (
		values.find((value) => {
			const titleToken = normalizePrintifyToken(value?.title);
			if (requestedToken && titleToken === requestedToken) {
				return true;
			}
			if (!target.includes("color") || !requestedColor) {
				return false;
			}
			const swatches = Array.isArray(value?.colors)
				? value.colors.map((entry) => normalizePrintifyColor(entry)).filter(Boolean)
				: [];
			return swatches.includes(requestedColor);
		}) || null
	);
}

function collectPodVariantOptionIds(item = {}) {
	const details = item?.printifyProductDetails || {};
	const chosenAttributes = item?.chosenAttributes || {};
	const customDesign = item?.customDesign || {};
	const ids = [];

	const colorValue = findPrintifyOptionValue(
		details,
		"color",
		customDesign.color || chosenAttributes.color || "",
		customDesign?.variants?.color?.id
	);
	const sizeValue = findPrintifyOptionValue(
		details,
		"size",
		customDesign.size || chosenAttributes.size || "",
		customDesign?.variants?.size?.id
	);
	const scentValue = findPrintifyOptionValue(
		details,
		"scent",
		customDesign.scent || chosenAttributes.scent || "",
		customDesign?.variants?.scent?.id
	);

	for (const value of [colorValue, sizeValue, scentValue]) {
		if (value?.id !== undefined && value?.id !== null) {
			const parsedId = coercePrintifyId(value.id);
			if (!Number.isNaN(parsedId)) {
				ids.push(parsedId);
			}
		}
	}

	return ids;
}

function findMatchingPodVariantForItem(item = {}) {
	const details = item?.printifyProductDetails || {};
	const variants = Array.isArray(details?.variants) ? details.variants : [];
	if (!variants.length) return null;

	const directVariantId =
		item?.customDesign?.variantId || item?.chosenAttributes?.variantId || null;
	if (directVariantId !== null && `${directVariantId}`.trim()) {
		const directMatch =
			variants.find(
				(variant) => `${variant?.id ?? ""}`.trim() === `${directVariantId}`.trim()
			) || null;
		if (directMatch) return directMatch;
	}

	const explicitSku =
		item?.customDesign?.variantSku || item?.chosenAttributes?.variantSku || "";
	if (`${explicitSku}`.trim()) {
		const skuMatch =
			variants.find(
				(variant) => `${variant?.sku ?? ""}`.trim() === `${explicitSku}`.trim()
			) || null;
		if (skuMatch) return skuMatch;
	}

	const optionIds = collectPodVariantOptionIds(item);
	if (optionIds.length) {
		const optionMatch =
			variants.find((variant) => {
				const variantIds = Array.isArray(variant?.options)
					? variant.options.map(coercePrintifyId)
					: [];
				return optionIds.every((id) => variantIds.includes(id));
			}) || null;
		if (optionMatch) return optionMatch;
	}

	const colorToken = normalizePrintifyToken(
		item?.customDesign?.color || item?.chosenAttributes?.color || ""
	).replace(/["']/g, "");
	const sizeToken = normalizePrintifyToken(
		item?.customDesign?.size || item?.chosenAttributes?.size || ""
	).replace(/["']/g, "");
	return (
		variants.find((variant) => {
			const title = normalizePrintifyToken(variant?.title).replace(/["']/g, "");
			return (
				(!colorToken || title.includes(colorToken)) &&
				(!sizeToken || title.includes(sizeToken))
			);
		}) ||
		variants.find((variant) => variant?.is_default) ||
		variants[0] ||
		null
	);
}

function isLikelyMongoId(value = "") {
	return /^[a-f0-9]{24}$/i.test(`${value || ""}`.trim());
}

function normalizePodPrintAreaPosition(value = "") {
	return `${value || ""}`
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_");
}

function getPodProductKindForPlacement(item = {}) {
	const normalizedName = `${item?.name || item?.productName || item?.printifyProductDetails?.title || ""}`
		.toLowerCase();
	if (
		normalizedName.includes("t-shirt") ||
		normalizedName.includes("tee") ||
		(normalizedName.includes("shirt") &&
			!normalizedName.includes("sweatshirt"))
	) {
		return "apparel";
	}
	if (
		normalizedName.includes("hoodie") ||
		normalizedName.includes("sweatshirt") ||
		normalizedName.includes("pullover")
	) {
		return "hoodie";
	}
	if (normalizedName.includes("tote")) return "tote";
	if (normalizedName.includes("weekender") || normalizedName.includes("bag")) {
		return "bag";
	}
	if (normalizedName.includes("mug")) return "mug";
	if (normalizedName.includes("pillow")) return "pillow";
	if (normalizedName.includes("magnet")) return "magnet";
	if (normalizedName.includes("candle")) return "candle";
	return "default";
}

function getFullPrintAreaScaleForOrder(item = {}, positionInput = "") {
	return 1;
}

function getCartProductId(item = {}) {
	const raw = item?.productId || item?._id || item?.id || "";
	const normalized = `${raw || ""}`.trim();
	return normalized || null;
}

function isPodCartItem(item = {}) {
	return Boolean(
		item?.isPrintifyProduct &&
			(item?.printifyProductDetails?.POD === true || item?.customDesign)
	);
}

function isAvailablePrintifyVariant(variant = null) {
	return Boolean(variant) && variant?.is_enabled !== false && variant?.is_available !== false;
}

async function hydratePrintifyItemFromCatalog(item = {}) {
	if (!item?.isPrintifyProduct) return item;

	const currentDetails = item?.printifyProductDetails || {};
	const hasVariants =
		Array.isArray(currentDetails?.variants) && currentDetails.variants.length > 0;
	const hasOptions =
		Array.isArray(currentDetails?.options) && currentDetails.options.length > 0;

	if (hasVariants && hasOptions && (currentDetails?.POD === true || !item?.customDesign)) {
		return item;
	}

	const productId = getCartProductId(item);
	if (!isLikelyMongoId(productId)) {
		return item;
	}

	try {
		const productDoc = await Product.findById(productId)
			.select("productName isPrintifyProduct printifyProductDetails")
			.lean();
		if (!productDoc?.printifyProductDetails) {
			return item;
		}

		const catalogDetails = productDoc.printifyProductDetails || {};
		return {
			...item,
			name: item?.name || productDoc.productName || "",
			isPrintifyProduct:
				item?.isPrintifyProduct ?? productDoc.isPrintifyProduct ?? false,
			printifyProductDetails: {
				...catalogDetails,
				...currentDetails,
				POD: currentDetails?.POD === true || catalogDetails?.POD === true,
				variants: hasVariants
					? currentDetails.variants
					: Array.isArray(catalogDetails?.variants)
						? catalogDetails.variants
						: [],
				options: hasOptions
					? currentDetails.options
					: Array.isArray(catalogDetails?.options)
						? catalogDetails.options
						: [],
				images:
					Array.isArray(currentDetails?.images) && currentDetails.images.length > 0
						? currentDetails.images
						: Array.isArray(catalogDetails?.images)
							? catalogDetails.images
							: [],
			},
		};
	} catch (error) {
		console.warn(
			`Failed to hydrate Printify product details for ${productId}:`,
			error?.message || error
		);
		return item;
	}
}

function getPodVariantTitleParts(item = {}) {
	return `${item?.customDesign?.variantTitle || ""}`
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean);
}

function getPodAttributeDisplayLabel(item = {}, key = "") {
	const rawValue =
		item?.customDesign?.variants?.[key]?.label ||
		item?.customDesign?.variants?.[key]?.title ||
		item?.customDesign?.[key] ||
		item?.chosenAttributes?.[key] ||
		item?.[key] ||
		"";
	const rawText = `${rawValue || ""}`.trim();
	if (rawText && (key !== "color" || !rawText.startsWith("#"))) {
		return rawText;
	}

	const variantParts = getPodVariantTitleParts(item);
	if (!variantParts.length) return rawText;

	if (key === "size") {
		return (
			variantParts.find(
				(part) =>
					normalizePrintifyToken(part).replace(/["']/g, "") ===
					normalizePrintifyToken(
						item?.customDesign?.size || item?.chosenAttributes?.size || item?.size || ""
					).replace(/["']/g, "")
			) || rawText
		);
	}

	if (key === "scent") {
		return (
			variantParts.find(
				(part) =>
					normalizePrintifyToken(part).replace(/["']/g, "") ===
					normalizePrintifyToken(
						item?.customDesign?.scent || item?.chosenAttributes?.scent || item?.scent || ""
					).replace(/["']/g, "")
			) || rawText
		);
	}

	const blocked = new Set(
		[
			item?.customDesign?.size,
			item?.chosenAttributes?.size,
			item?.customDesign?.scent,
			item?.chosenAttributes?.scent,
		]
			.map((entry) => normalizePrintifyToken(entry).replace(/["']/g, ""))
			.filter(Boolean)
	);
	return (
		variantParts.find(
			(part) => !blocked.has(normalizePrintifyToken(part).replace(/["']/g, ""))
		) ||
		variantParts[0] ||
		rawText
	);
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  1. STOCK & INVENTORY – EXACT COPY of your previous logic               ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

const checkStockAvailability = async (order) => {
	// ─────────────  A) Simple (no‑variable) products  ─────────────
	for (const item of order.productsNoVariable) {
		console.log("      checking simple item ->", item.name);
		if (isPodCartItem(item)) {
			/* POD – check variant availability inside printifyProductDetails */
			const hydratedItem = await hydratePrintifyItemFromCatalog(item);
			const matchedVariant = findMatchingPodVariantForItem(hydratedItem);

			if (!matchedVariant)
				return `No matching POD variant found for product ${item.name}.`;
			if (!isAvailablePrintifyVariant(matchedVariant))
				return `Variant is not available for product ${item.name}.`;
		} else {
			/* Local stock */
			const product = await Product.findById(item.productId);
			if (!product) return `Product not found for ID ${item.productId}.`;
			if (product.quantity < item.ordered_quantity)
				return `Insufficient stock for product ${product.productName}.`;
		}
	}

	// ─────────────  B) Variable products  ─────────────
	for (const item of order.chosenProductQtyWithVariables) {
		console.log("      checking variant item ->", item.name);
		if (isPodCartItem(item)) {
			const hydratedItem = await hydratePrintifyItemFromCatalog(item);
			const matchedVariant = findMatchingPodVariantForItem(hydratedItem);

			if (!matchedVariant)
				return `No matching POD variant found for product ${item.name}.`;
			if (!isAvailablePrintifyVariant(matchedVariant))
				return `Variant is not available for product ${item.name}.`;
		} else {
			const product = await Product.findById(item.productId);
			if (!product) return `Product not found for ID ${item.productId}.`;

			const attribute = product.productAttributes.find(
				(a) =>
					(a.color || "").toLowerCase() ===
						(item.chosenAttributes.color || "").toLowerCase() &&
					(a.size || "").toLowerCase() ===
						(item.chosenAttributes.size || "").toLowerCase()
			);

			if (!attribute)
				return `Attribute not found for product ${product.productName}.`;
			if (attribute.quantity < item.ordered_quantity)
				return `Insufficient stock for product ${product.productName} with color ${attribute.color} and size ${attribute.size}.`;
		}
	}
	return null; // all good
};

/* --------  updateStock   (original bulk‑write logic – unchanged)  -------- */
const updateStock = async (order) => {
	try {
		const bulkOps = [];

		// ───────── simple items
		for (const item of order.productsNoVariable) {
			if (isPodCartItem(item))
				continue; // POD handled by Printify
			bulkOps.push({
				updateOne: {
					filter: { _id: item.productId },
					update: { $inc: { quantity: -item.ordered_quantity } },
					upsert: false,
				},
			});
		}

		// ───────── variable items
		for (const item of order.chosenProductQtyWithVariables) {
			if (isPodCartItem(item))
				continue;
			const product = await Product.findById(item.productId);
			if (!product)
				throw new Error(`Product not found for ID ${item.productId}`);

			const attr = product.productAttributes.find(
				(a) =>
					(a.color || "").toLowerCase() ===
						(item.chosenAttributes.color || "").toLowerCase() &&
					(a.size || "").toLowerCase() ===
						(item.chosenAttributes.size || "").toLowerCase()
			);
			if (!attr)
				throw new Error(
					`Attribute not found for product ${product.productName}`
				);

			attr.quantity -= item.ordered_quantity;
			if (attr.quantity < 0)
				throw new Error(
					`Insufficient stock for ${product.productName} color ${attr.color} size ${attr.size}`
				);

			bulkOps.push({
				updateOne: {
					filter: { _id: product._id, "productAttributes._id": attr._id },
					update: { $set: { "productAttributes.$.quantity": attr.quantity } },
					upsert: false,
				},
			});
		}

		if (bulkOps.length > 0) await Product.bulkWrite(bulkOps);
	} catch (err) {
		console.error("Error updating stock:", err);
		throw err;
	}
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  2. INVOICE NUMBERS                                                     ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

const generateRandomInvoiceNumber = () =>
	Math.floor(1000000000 + Math.random() * 9000000000).toString();

const isInvoiceNumberUnique = async (invoiceNumber) => {
	const order = await Order.findOne({ invoiceNumber });
	return !order;
};

const generateUniqueInvoiceNumber = async () => {
	let invoiceNumber,
		isUnique = false;
	while (!isUnique) {
		invoiceNumber = generateRandomInvoiceNumber();
		isUnique = await isInvoiceNumberUnique(invoiceNumber);
	}
	return invoiceNumber;
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  3. PRINTIFY  (identical logic – copied verbatim)                       ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

/* ---------- helper to upload design screenshot ---------- */
async function uploadIfNeeded(imageUrl, token) {
	try {
		const payload = { file_name: "custom-design.png", url: imageUrl };
		const resp = await axios.post(
			"https://api.printify.com/v1/uploads/images.json",
			payload,
			{ headers: { Authorization: `Bearer ${token}` } }
		);
		console.log(`✓ Design uploaded to Printify – ID: ${resp.data.id}`);
		return resp.data.id; // e.g. "623e0f87f•••"
	} catch (error) {
		console.error("Printify upload error:", error?.response?.data || error);
		return null;
	}
}

function splitRecipientName(order = {}) {
	const fullName =
		order?.customerDetails?.shipToName || order?.customerDetails?.name || "Customer";
	const tokens = `${fullName}`.trim().split(/\s+/).filter(Boolean);
	return {
		fullName,
		firstName: tokens[0] || "Customer",
		lastName: tokens.slice(1).join(" ") || "Customer",
	};
}

function buildPodFulfillmentRecord({
	item,
	order,
	shopId,
	matchedVariant,
	realVariantId,
	uploadedId,
	newProductId,
	orderResponse,
}) {
	return {
		type: "ephemeral_pod",
		productId: item.productId || item._id || null,
		productName: item.name || "",
		invoiceNumber: order.invoiceNumber || "",
		shopId,
		originalPrintifyProductId: item.printifyProductDetails?.id || null,
		previewProductId: item.customDesign?.previewProductId || null,
		previewShopId: item.customDesign?.previewShopId || null,
		uploadedArtworkId: uploadedId,
		ephemeralProductId: newProductId,
		matchedVariantId: realVariantId,
		matchedVariantTitle: matchedVariant?.title || "",
		quantity: item.ordered_quantity || 1,
		placementParams: item.customDesign?.placementParams || {
			x: 0.5,
			y: 0.5,
			scale: 1,
			angle: 0,
		},
		customDesign: {
			occasion: item.customDesign?.occasion || "",
			giftName: item.customDesign?.giftName || "",
			giftMessage: item.customDesign?.giftMessage || "",
			printArea: item.customDesign?.printArea || "front",
			screenshots: {
				bare: item.customDesign?.bareScreenshotUrl || "",
				final: item.customDesign?.finalScreenshotUrl || "",
				mockup: item.customDesign?.mockupPreviewUrl || "",
				original: item.customDesign?.originalPrintifyImageURL || "",
			},
			mockupPreviewImages: Array.isArray(item.customDesign?.mockupPreviewImages)
				? item.customDesign.mockupPreviewImages
				: [],
			variantId: item.customDesign?.variantId || realVariantId || null,
			variantSku: item.customDesign?.variantSku || matchedVariant?.sku || "",
			variantTitle: item.customDesign?.variantTitle || matchedVariant?.title || "",
			variants: item.customDesign?.variants || {},
			customizations: item.customDesign?.customizations || {
				texts: [],
				images: [],
			},
			elements: item.customDesign?.elements || [],
		},
		ephemeralOrder: orderResponse,
		createdAt: new Date(),
	};
}

/* ----------  for POD items with custom design (ephemeral product) ---------- */
async function createOnTheFlyPOD(item, order, token) {
	try {
		const hydratedItem = await hydratePrintifyItemFromCatalog(item);
		const shopId = hydratedItem.printifyProductDetails?.shop_id;
		if (!shopId) {
			throw new Error("No Printify shop_id found for POD item");
		}
		const recipient = splitRecipientName(order);

		const matchedVariant = findMatchingPodVariantForItem(hydratedItem);
		if (!matchedVariant) {
			throw new Error("No real variant found for chosen color/size");
		}

		const realVariantId = matchedVariant.id;

		let uploadedId = null;
		if (hydratedItem?.customDesign?.bareScreenshotUrl) {
			uploadedId = await uploadIfNeeded(
				hydratedItem.customDesign.bareScreenshotUrl,
				token
			);
			if (!uploadedId) {
				throw new Error("Cannot proceed ephemeral. uploadIfNeeded is null");
			}
		} else {
			throw new Error("No bareScreenshotUrl found. Skipping ephemeral creation.");
		}

		const requestedPrintArea = normalizePodPrintAreaPosition(
			hydratedItem.customDesign?.printArea || "front"
		);
		const availablePlaceholders = Array.isArray(
			hydratedItem?.printifyProductDetails?.print_areas?.[0]?.placeholders
		)
			? hydratedItem.printifyProductDetails.print_areas[0].placeholders
			: [];
		const supportedPositions = new Set(
			availablePlaceholders
				.map((placeholder) =>
					normalizePodPrintAreaPosition(placeholder?.position || "")
				)
				.filter(Boolean)
		);
		const finalPrintArea = supportedPositions.has(requestedPrintArea)
			? requestedPrintArea
			: supportedPositions.has("front")
				? "front"
				: requestedPrintArea || "front";
		const fullPrintAreaScale = getFullPrintAreaScaleForOrder(
			hydratedItem,
			finalPrintArea
		);
		const shouldUseFullPrintAreaScale =
			hydratedItem?.customDesign?.isFullPrintAreaCapture !== false;
		const {
			x = 0.5,
			y = 0.5,
			scale = fullPrintAreaScale,
			angle = 0,
		} = hydratedItem.customDesign?.placementParams || {};
		const resolvedScale = shouldUseFullPrintAreaScale
			? fullPrintAreaScale
			: Number.isFinite(Number(scale))
				? Number(scale)
				: fullPrintAreaScale;

		/* 4) create temporary product */
		const placeholders = [
			{
				position: finalPrintArea || "front",
				images: [
					{
						id: uploadedId,
						type: "image/png",
						x,
						y,
						scale: resolvedScale,
						angle,
					},
				],
			},
		];

		const productPayload = {
			title: "Custom One‐Time Product",
			description: "User‐personalised product",
			blueprint_id: hydratedItem.printifyProductDetails.blueprint_id,
			print_provider_id: hydratedItem.printifyProductDetails.print_provider_id,
			variants: [
				{
					id: realVariantId,
					price: Math.round(hydratedItem.price * 100),
					is_enabled: true,
					is_default: true,
				},
			],
			print_areas: [
				{
					variant_ids: [realVariantId],
					placeholders,
				},
			],
		};

		const createR = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			productPayload,
			{ headers: { Authorization: `Bearer ${token}` } }
		);
		if (!createR.data?.id)
			throw new Error("Failed to create POD product on Printify");

		const newProductId = createR.data.id;

		/* 5) place order */
		const orderPayload = {
			external_id: `custom-order-${Date.now()}`,
			line_items: [
				{
					product_id: newProductId,
					variant_id: realVariantId,
					quantity: hydratedItem.ordered_quantity,
				},
			],
			shipping_method: 1,
			send_shipping_notification: false,
			address_to: {
				first_name: recipient.firstName,
				last_name: recipient.lastName,
				email: order.customerDetails.email,
				phone: order.customerDetails.phone,
				country: "US",
				region: order.customerDetails.state,
				city: order.customerDetails.city,
				address1: order.customerDetails.address,
				zip: order.customerDetails.zipcode,
			},
		};

		const orderR = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/orders.json`,
			orderPayload,
			{ headers: { Authorization: `Bearer ${token}` } }
		);

		/* 6) disable the temporary product */
		await axios.put(
			`https://api.printify.com/v1/shops/${shopId}/products/${newProductId}.json`,
			{ visible: false },
			{ headers: { Authorization: `Bearer ${token}` } }
		);

		console.log(
			`✓ POD product created on Printify – ID: ${newProductId}, Order ID: ${orderR.data.id}`
		);

		/* 7) persist POD info */
		const podFulfillmentRecord = buildPodFulfillmentRecord({
			item: hydratedItem,
			order,
			shopId,
			matchedVariant,
			realVariantId,
			uploadedId,
			newProductId,
			orderResponse: orderR.data,
		});
		await Order.findByIdAndUpdate(order._id, {
			$push: {
				printifyOrderDetails: podFulfillmentRecord,
				podFulfillment: podFulfillmentRecord,
			},
		});
	} catch (err) {
		console.error("createOnTheFlyPOD error:", err?.response?.data || err);
		throw err; // bubble up so the whole order can be flagged / refunded
	}
}

/* ----------  Post order to Printify (normal + POD)  ---------- */
const postOrderToPrintify = async (order) => {
	const normalToken = process.env.PRINTIFY_TOKEN;
	const designToken = process.env.DESIGN_PRINTIFY_TOKEN || normalToken;

	const allItems = [
		...order.productsNoVariable,
		...order.chosenProductQtyWithVariables,
	];

	for (const item of allItems) {
		if (!item.isPrintifyProduct) continue;
		const recipient = splitRecipientName(order);

		/* POD with user design → create temporary product */
		if (isPodCartItem(item) && item.customDesign) {
			await createOnTheFlyPOD(item, order, designToken);
			continue;
		}

		/* existing Printify catalogue item */
		const headers = {
			Authorization: `Bearer ${normalToken}`,
			"Content-Type": "application/json",
		};

		let variantId;
		if (item.chosenAttributes && item.chosenAttributes.SubSKU) {
			const matched = item.printifyProductDetails.variants.find(
				(v) => v.sku === item.chosenAttributes.SubSKU
			);
			if (!matched)
				throw new Error(
					`No matching variant for SKU ${item.chosenAttributes.SubSKU}`
				);
			variantId = matched.id;
		} else {
			variantId = item.printifyProductDetails.variants[0].id;
		}

		const printifyOrder = {
			line_items: [
				{
					product_id: item.printifyProductDetails.id,
					variant_id: variantId,
					quantity: item.ordered_quantity,
					print_provider_id: item.printifyProductDetails.print_provider_id,
					blueprint_id: item.printifyProductDetails.blueprint_id,
				},
			],
			address_to: {
				first_name: recipient.firstName,
				last_name: recipient.lastName,
				email: order.customerDetails.email,
				phone: order.customerDetails.phone,
				country: "US",
				region: order.customerDetails.state,
				city: order.customerDetails.city,
				address1: order.customerDetails.address,
				postal_code:
					Number(order.customerDetails.zipcode) ||
					order.customerDetails.zipcode,
			},
		};

		const response = await axios.post(
			`https://api.printify.com/v1/shops/${item.printifyProductDetails.shop_id}/orders.json`,
			printifyOrder,
			{ headers }
		);

		console.log(
			`Printify order created for item ${item.name} – ID: ${response.data.id}`
		);

		/* save to DB */
		await Order.findByIdAndUpdate(order._id, {
			$push: {
				printifyOrderDetails: {
					type: "catalog_item",
					productId: item.productId || item._id || null,
					productName: item.name || "",
					shopId: item.printifyProductDetails?.shop_id || null,
					printifyProductId: item.printifyProductDetails?.id || null,
					variantId,
					order: response.data,
					createdAt: new Date(),
				},
			},
		});
	}
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  4.  PDF + EMAIL + SMS                                                  ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

/* ----------  PDF invoice generator  ---------- */
const createPdfBuffer = (order) =>
	new Promise(async (resolve, reject) => {
		const doc = new PDFDocument({ margin: 50 });
		const buffers = [];

		doc.on("data", (b) => buffers.push(b));
		doc.on("end", () => resolve(Buffer.concat(buffers)));
		doc.on("error", reject);

		if (fs.existsSync(shopLogo))
			doc.image(shopLogo, 50, 45, { width: 120 }).moveDown();
		else doc.text("Serene Jannat", 50, 45).moveDown();

		doc.fontSize(25).text("Order Invoice", { align: "center" }).moveDown();
		doc
			.fontSize(16)
			.text(`Invoice Number: ${order.invoiceNumber}`)
			.text(`Customer Name: ${order.customerDetails.name}`)
			.text(
				`Order Date: ${moment(order.createdAt).format(
					"MMMM Do YYYY, h:mm:ss a"
				)}`
			)
			.text(`Phone: ${order.customerDetails.phone}`)
			.text(`Ship to State: ${order.customerDetails.state}`)
			.text(`Shipping Address: ${order.customerDetails.address}`)
			.text(`Ship to Zipcode: ${order.customerDetails.zipcode}`)
			.text(`Status: ${order.status}`)
			.text(`Carrier: ${order.chosenShippingOption.carrierName}`)
			.text(`Shipping Price: $${order.chosenShippingOption.shippingPrice}`)
			.moveDown()
			.fontSize(20)
			.text("Product Details:", { underline: true });

		/* no‑variable */
		order.productsNoVariable.forEach((p, i) => {
			doc
				.moveDown()
				.fontSize(16)
				.text(`Product ${i + 1}`);
			doc
				.fontSize(14)
				.text(`Name: ${p.name}`)
				.text(`Quantity: ${p.ordered_quantity}`)
				.text(`Price: ${p.price}`);
		});

		/* variable */
		for (const item of order.chosenProductQtyWithVariables) {
			const product = await Product.findById(item.productId);
			if (product) {
				const resolvedColor =
					getPodAttributeDisplayLabel(item, "color") ||
					item.chosenAttributes.color;
				const color = await Colors.findOne({
					hexa: resolvedColor,
				});
				doc.moveDown().fontSize(16).text(`Product: ${product.productName}`);
				doc.text(`Color: ${color ? color.color : resolvedColor}`);
				doc.text(
					`Size: ${getPodAttributeDisplayLabel(item, "size") || item.chosenAttributes.size}`
				);
				doc.text(`Quantity: ${item.ordered_quantity}`);
				doc.text(`Price: ${item.price}`);
			}
		}

		doc
			.moveDown()
			.fontSize(16)
			.text(
				`Total Amount: $${Number(order.totalAmountAfterDiscount).toFixed(2)}`
			);

		doc.end();
	});

/* ----------  Email notifications  ---------- */
const sendOrderConfirmationEmail = async (order) => {
	try {
		const pdfBuffer = await createPdfBuffer(order);
		const htmlContent = await formatOrderEmail(order);
		const recipient = order.customerDetails.email || defaultEmail;

		const msgBase = {
			from: fromEmail,
			subject: `${BusinessName} - Order Confirmation`,
			html: htmlContent,
			attachments: [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Order_Confirmation.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		};

		/* A) Customer */
		await sgMail.send({ ...msgBase, to: recipient });
		console.log(`✓ Order confirmation sent to ${recipient}`);

		/* B) Internal team (bcc) */
		const bccEmails = owners.filter((e) => e !== recipient);
		if (bccEmails.length) await sgMail.send({ ...msgBase, to: bccEmails });

		/* C) Seller e‑mails */
		const storeIds = [
			...order.productsNoVariable.map((p) => p.storeId),
			...order.chosenProductQtyWithVariables.map((p) => p.storeId),
		].filter(Boolean);

		const distinctStoreIds = [...new Set(storeIds)];
		if (!distinctStoreIds.length) return;

		const storeDocs = await StoreManagement.find({
			_id: { $in: distinctStoreIds },
		})
			.populate("belongsTo", "name email")
			.exec();

		for (const storeDoc of storeDocs) {
			if (!storeDoc?.belongsTo?.email) continue;

			const sellerEmail = storeDoc.belongsTo.email.trim().toLowerCase();
			const firstName = (storeDoc.belongsTo.name || "Seller").split(" ")[0];
			const storeName = storeDoc.addStoreName || "Your Store";
			const htmlSeller = await formatSellerEmail(firstName, storeName);

			await sgMail.send({
				...msgBase,
				to: sellerEmail,
				html: htmlSeller,
				attachments: [], // sellers do not need the PDF
			});
		}
	} catch (error) {
		console.error(
			"Error sending order e‑mail:",
			error?.response?.body || error
		);
	}
};

/* ----------  SMS notification  ---------- */
const sendOrderConfirmationSMS = async (order) => {
	const smsData = {
		phone: order.customerDetails.phone,
		text: `Hi ${order.customerDetails.name} - Your order was successfully placed. Thank you for choosing Serene Jannat Gifts.`,
	};

	let formattedPhone = smsData.phone;
	if (!formattedPhone.startsWith("+1")) formattedPhone = `+1${formattedPhone}`;

	try {
		await orderStatusSMS.messages.create({
			body: smsData.text,
			from: "+19094884148",
			to: formattedPhone,
		});
	} catch (err) {
		console.error("Error sending SMS:", err);
	}
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  5. UTILS                                                               ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

function convertBigIntToString(value, seen = new WeakMap()) {
	/* primitives ---------------------------------------------------------- */
	if (value === null || typeof value !== "object") {
		return typeof value === "bigint" ? value.toString() : value;
	}

	/* circular refs ------------------------------------------------------- */
	if (seen.has(value)) return seen.get(value);
	/* arrays -------------------------------------------------------------- */
	if (Array.isArray(value)) {
		const out = [];
		seen.set(value, out);
		for (const item of value) out.push(convertBigIntToString(item, seen));
		return out;
	}
	/* plain objects & docs ------------------------------------------------ */
	const out = {};
	seen.set(value, out);
	for (const [k, v] of Object.entries(value)) {
		out[k] = convertBigIntToString(v, seen);
	}
	return out;
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  6. EXPORTS                                                             ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
module.exports = {
	/* inventory */
	checkStockAvailability,
	updateStock,

	/* invoice numbers */
	generateUniqueInvoiceNumber,

	/* Printify & fulfilment */
	postOrderToPrintify,

	/* notifications */
	sendOrderConfirmationEmail,
	sendOrderConfirmationSMS,

	/* utils */
	convertBigIntToString,
};
