const express = require("express");
const router = express.Router();
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product and Colors models
const Product = require("../models/product");
const Colors = require("../models/colors");

// --------------------------
// 1) Google Category Mapping
// --------------------------
const categoryMapping = {
	vases: "Home & Garden > Decor > Vases",
	planters: "Home & Garden > Lawn & Garden > Gardening > Pot & Planter Liners",
	candles: "Home & Garden > Decor > Candles",
	"home decor": "Home & Garden > Decor",
	outdoors: "Home & Garden > Lawn & Garden > Gardening > Gardening Accessories",
	"t shirts": "Apparel & Accessories > Clothing > Shirts & Tops",
	seasonal: "Home & Garden > Decor > Seasonal & Holiday Decorations",
	votives: "Home & Garden > Decor > Home Fragrances > Candles",
};

// --------------------------
// 2) Keyword-based fallback
// --------------------------
function computeGoogleCategory(product) {
	const catName = product.category?.categoryName?.toLowerCase() || "";
	if (categoryMapping[catName]) {
		return categoryMapping[catName];
	}
	const name = (product.productName || "").toLowerCase();

	if (name.includes("mug")) {
		return "Home & Garden > Kitchen & Dining > Tableware > Drinkware > Mugs";
	}
	if (
		name.includes("unisex") ||
		name.includes("t-shirt") ||
		name.includes("t shirt") ||
		name.includes("shirt") ||
		name.includes("short") ||
		name.includes("hoodie")
	) {
		return "Apparel & Accessories > Clothing";
	}
	if (name.includes("bag") || name.includes("tote")) {
		return "Apparel & Accessories > Handbags, Wallets & Cases";
	}
	if (name.includes("phone")) {
		return "Electronics > Communications > Telephony > Mobile Phones";
	}
	if (name.includes("pillow")) {
		return "Home & Garden > Linens & Bedding > Bedding > Pillows";
	}
	// 3) Otherwise, default:
	return "Apparel & Accessories";
}

// Escape XML
function escapeXml(unsafe) {
	return unsafe.replace(/[<>&'"]/g, (c) => {
		switch (c) {
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case "&":
				return "&amp;";
			case "'":
				return "&apos;";
			case '"':
				return "&quot;";
			default:
				return c;
		}
	});
}

// Capitalize product titles
function capitalizeWords(string) {
	return string
		.toLowerCase()
		.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// Ensure valid numeric dimension
function validateDimension(value, defaultValue) {
	const numericValue = parseFloat(value);
	return !isNaN(numericValue) && numericValue > 0
		? numericValue.toFixed(2)
		: defaultValue;
}

const DEFAULT_WEIGHT = "1.00"; // kg
const DEFAULT_LENGTH = "10.00"; // cm
const DEFAULT_WIDTH = "10.00"; // cm
const DEFAULT_HEIGHT = "10.00"; // cm

function extractFirstNumber(value) {
	if (!value) return "Not available";
	const match = value.match(/(\d+(\.\d+)?)/);
	return match ? parseFloat(match[0]) : "Not available";
}

function generateImageLinks(product) {
	let images = [];
	// If product has variant attributes w/images
	if (product.productAttributes && product.productAttributes.length > 0) {
		product.productAttributes.forEach((attr) => {
			if (attr.productImages && attr.productImages.length > 0) {
				images.push(...attr.productImages.map((img) => escapeXml(img.url)));
			}
		});
	}
	// Otherwise fallback to thumbnail images
	else if (product.thumbnailImage && product.thumbnailImage.length > 0) {
		images.push(
			...product.thumbnailImage[0].images.map((img) => escapeXml(img.url))
		);
	}
	const validImages = images.filter((img) =>
		/\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(img)
	);
	if (validImages.length === 0) {
		validImages.push(
			"https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg"
		);
	}
	return validImages.slice(0, 5);
}

function convertLbsToKg(lbs) {
	return lbs > 0 ? (lbs * 0.453592).toFixed(2) : "Not available";
}

function convertInchesToCm(inches) {
	const numericValue = extractFirstNumber(inches);
	return numericValue !== "Not available"
		? (numericValue * 2.54).toFixed(2)
		: "Not available";
}

// For non-POD products, we sometimes store color as a hex
async function resolveColorName(hexCode) {
	if (!hexCode) return "";
	const color = await Colors.findOne({ hexa: hexCode.toLowerCase() });
	return color ? color.color : hexCode;
}

/**
 * If product is POD, build a URL like:
 *   https://serenejannat.com/custom-gifts/PRODUCT_ID?color=xxx&size=yyy&scent=zzz
 * Otherwise:
 *   https://serenejannat.com/single-product/<slug>/<categorySlug>/<product_id>
 */
function getProductLink(product, color, size, scent) {
	if (
		product.printifyProductDetails?.POD === true &&
		product.printifyProductDetails?.id
	) {
		let url = `https://serenejannat.com/custom-gifts/${product._id}`;
		const queryParams = [];
		if (color && color.toLowerCase() !== "unspecified") {
			queryParams.push(`color=${encodeURIComponent(color)}`);
		}
		if (size && size.toLowerCase() !== "unspecified") {
			queryParams.push(`size=${encodeURIComponent(size)}`);
		}
		if (scent && scent.toLowerCase() !== "unspecified") {
			queryParams.push(`scent=${encodeURIComponent(scent)}`);
		}

		if (queryParams.length > 0) {
			url += `?${queryParams.join("&")}`;
		}
		return url;
	}
	// Normal link for non-POD
	return `https://serenejannat.com/single-product/${escapeXml(
		product.slug
	)}/${escapeXml(product.category.categorySlug)}/${product._id}`;
}

// If price >= 100 and integer => treat as cents
function getFinalVariantPrice(variant) {
	let rawPrice = variant.priceAfterDiscount ?? variant.price;
	if (!rawPrice) return "0.00";
	let floatVal = parseFloat(rawPrice);
	if (Number.isInteger(floatVal) && floatVal >= 100) {
		floatVal /= 100;
	}
	return floatVal.toFixed(2);
}

function validateGender(gender) {
	const validGenders = ["male", "female", "unisex"];
	if (!gender || typeof gender !== "string") return "unisex";
	const g = gender.toLowerCase();
	return validGenders.includes(g) ? g : "unisex";
}

// Build Google image tags (with g:)
function buildGoogleImageTags(imageArray) {
	const upTo3 = imageArray.slice(0, 3);
	if (!upTo3.length) {
		upTo3.push(
			"https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg"
		);
	}
	const main = upTo3[0];
	const additionals = upTo3.slice(1);

	let xml = `<g:image_link>${escapeXml(main)}</g:image_link>`;
	if (additionals.length > 0) {
		additionals.forEach((img) => {
			xml += `\n<g:additional_image_link>${escapeXml(
				img
			)}</g:additional_image_link>`;
		});
	}
	return xml;
}

// Build Facebook image tags (no g:)
function buildFacebookImageTags(imageArray) {
	const upTo3 = imageArray.slice(0, 3);
	if (!upTo3.length) {
		upTo3.push(
			"https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg"
		);
	}
	const main = upTo3[0];
	const additionals = upTo3.slice(1);

	let xml = `<image_link>${escapeXml(main)}</image_link>`;
	if (additionals.length > 0) {
		additionals.forEach((img) => {
			xml += `\n<additional_image_link>${escapeXml(
				img
			)}</additional_image_link>`;
		});
	}
	return xml;
}

/**
 * For Printify POD: build an option-value map so we can retrieve actual English
 * color/size/scent from "printifyProductDetails.options" using the variant's "options" array.
 *
 * e.g. if variant.options = [14, 511], we look up 14 => { type: "size", title: "S" }
 * and 511 => { type: "color", title: "Navy" }
 */
function buildOptionValueMap(podDetails) {
	const map = {};
	// e.g. podDetails.options = [ {name: "Colors", type: "color", values: [...]}, {...} ]
	(podDetails.options || []).forEach((option) => {
		(option.values || []).forEach((val) => {
			map[val.id] = {
				type: option.type, // e.g. "color", "size", "scent"
				title: val.title,
			};
		});
	});
	return map;
}

/**
 * Get color/size/scent from the Printify "optionValueMap" if possible.
 * If you want to do a fallback to productAttributes, you can—but in this
 * version we rely purely on the Printify data for the naming.
 */
function getVariantNamesFromPrintifyMap(variant, optionValueMap) {
	let colorVal = "";
	let sizeVal = "";
	let scentVal = "";

	// variant.options => e.g. [14, 511]
	for (const valId of variant.options || []) {
		const info = optionValueMap[valId];
		if (!info) continue; // skip unknown IDs
		if (info.type === "color") {
			colorVal = info.title;
		} else if (info.type === "size") {
			sizeVal = info.title;
		} else if (info.type === "scent") {
			scentVal = info.title;
		}
		// If you have other possible "type" values, handle them here
	}
	return { colorVal, sizeVal, scentVal };
}

// ----------------------
//   MAIN FEED ROUTE
// ----------------------
router.get("/generate-feeds", async (req, res) => {
	let googleItems = [];
	let facebookItems = [];

	// Fetch products that are active or allowed for backorder or activated by the seller
	const products = await Product.find({
		$or: [
			{ activeProduct: true },
			// { activeProductBySeller: true },
			// { activeBackorder: true },
		],
	}).populate("category");

	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
			const condition = "new";
			const brand = "Serene Jannat";
			const defaultGender = validateGender(product.gender || "unisex");

			// Google product category
			const googleProductCategory = escapeXml(computeGoogleCategory(product));

			// Custom labels (for Google)
			const categoryLabel = product.category.categoryName
				? product.category.categoryName.toLowerCase().replace(/\s+/g, "_")
				: "general";
			const generalLabel = "general_campaign";

			// Clean out HTML in description, then escape
			const cleanedDesc = escapeXml(
				product.description.replace(/<[^>]+>/g, "")
			);

			// For building color/size tags
			function buildGoogleColorTag(colorValue) {
				if (!colorValue || colorValue.toLowerCase() === "unspecified")
					return "";
				return `<g:color><![CDATA[${colorValue}]]></g:color>`;
			}
			function buildGoogleSizeTag(sizeValue) {
				if (!sizeValue || sizeValue.toLowerCase() === "unspecified") return "";
				return `<g:size><![CDATA[${sizeValue}]]></g:size>`;
			}
			function buildFacebookColorTag(colorValue) {
				if (!colorValue || colorValue.toLowerCase() === "unspecified")
					return "";
				return `<color><![CDATA[${colorValue}]]></color>`;
			}
			function buildFacebookSizeTag(sizeValue) {
				if (!sizeValue || sizeValue.toLowerCase() === "unspecified") return "";
				return `<size><![CDATA[${sizeValue}]]></size>`;
			}

			// -----------------------------------------
			// If product is Printify POD
			// -----------------------------------------
			if (product.printifyProductDetails?.POD) {
				const itemGroupId = escapeXml(product._id.toString());
				const podDetails = product.printifyProductDetails;
				const variants = podDetails.variants || [];

				// Build a map of valueId => { type, title }
				const optionValueMap = buildOptionValueMap(podDetails);

				if (variants.length > 1) {
					// Multi-variant POD
					for (let [index, variant] of variants.entries()) {
						// 1) Get color/size/scent from the Printify map
						const { colorVal, sizeVal, scentVal } =
							getVariantNamesFromPrintifyMap(variant, optionValueMap);

						const variantPrice = getFinalVariantPrice(variant);

						// 2) Quantity check -> from productAttributes if available
						let matchedAttr = null;
						if (
							product.productAttributes &&
							product.productAttributes.length > 0
						) {
							matchedAttr = product.productAttributes.find(
								(a) => a.SubSKU === variant.sku
							);
						}
						let facebookInventory = 9999;
						let googleAvailability = "in stock";
						if (matchedAttr && matchedAttr.quantity != null) {
							facebookInventory = matchedAttr.quantity;
							googleAvailability =
								matchedAttr.quantity > 0 ? "in stock" : "out_of_stock";
						} else {
							// fallback to variant.quantity or default
							facebookInventory = variant.quantity || 9999;
						}
						const facebookAvailability = googleAvailability;

						// 3) Build variant images
						let variantImages = [];
						if (matchedAttr && matchedAttr.productImages?.length) {
							variantImages = matchedAttr.productImages.map((x) => x.url);
						}
						if (!variantImages.length) {
							variantImages = generateImageLinks(product);
						}

						// >>>> NEW: If the attribute has an exampleDesignImage, put it first
						if (
							matchedAttr &&
							matchedAttr.exampleDesignImage &&
							matchedAttr.exampleDesignImage.url
						) {
							variantImages.unshift(matchedAttr.exampleDesignImage.url);
						}
						// <<<< END NEW

						const googleImageXML = buildGoogleImageTags(variantImages);
						const facebookImageXML = buildFacebookImageTags(variantImages);

						// 4) Build final link with color, size, scent
						const finalLink = getProductLink(
							product,
							colorVal,
							sizeVal,
							scentVal
						);

						// 5) Build feed item title
						let attributeParts = ["Custom Design"];
						if (colorVal) attributeParts.push(colorVal);
						if (sizeVal) attributeParts.push(sizeVal);
						if (scentVal) attributeParts.push(scentVal);

						const attributeStr = attributeParts.join(", ");
						const podTitle = `${capitalizeWords(
							product.productName
						)} (${attributeStr})`;

						// 6) Output for Google
						const googleVariantItem = `
              <item>
                <g:id>${escapeXml(product._id.toString())}-${index}</g:id>
                <g:title><![CDATA[${podTitle}]]></g:title>
                <g:description><![CDATA[${cleanedDesc}]]></g:description>
                <g:link>${escapeXml(finalLink)}</g:link>
                ${googleImageXML}
                <g:availability>${googleAvailability}</g:availability>
                <g:price>${variantPrice} USD</g:price>
                <g:brand>${escapeXml(brand)}</g:brand>
                <g:condition>${escapeXml(condition)}</g:condition>
                <g:google_product_category>${googleProductCategory}</g:google_product_category>
                <g:product_type><![CDATA[${escapeXml(
									product.category.categoryName
								)}]]></g:product_type>
                <g:item_group_id>${itemGroupId}</g:item_group_id>
                ${buildGoogleSizeTag(sizeVal)}
                ${buildGoogleColorTag(colorVal)}
                <g:age_group>adult</g:age_group>
                <g:gender>${defaultGender}</g:gender>
                <g:identifier_exists>false</g:identifier_exists>

                <!-- Custom labels -->
                <g:custom_label_0>${escapeXml(categoryLabel)}</g:custom_label_0>
                <g:custom_label_1>${escapeXml(generalLabel)}</g:custom_label_1>
                <g:custom_label_2>print_on_demand</g:custom_label_2>
                <g:additional_link>https://serenejannat.com/return-refund-policy</g:additional_link>
              </item>
            `;
						googleItems.push(googleVariantItem);

						// 7) Output for Facebook
						const facebookVariantItem = `
              <item>
                <id>${escapeXml(product._id.toString())}-${index}</id>
                <title><![CDATA[${podTitle}]]></title>
                <description><![CDATA[${cleanedDesc}]]></description>
                <link>${escapeXml(finalLink)}</link>
                ${facebookImageXML}
                <availability>${facebookAvailability}</availability>
                <inventory>${facebookInventory}</inventory>
                <quantity_to_sell_on_facebook>${facebookInventory}</quantity_to_sell_on_facebook>
                <price>${variantPrice} USD</price>
                <brand>${escapeXml(brand)}</brand>
                <condition>${escapeXml(condition)}</condition>
                <item_group_id>${itemGroupId}</item_group_id>
                ${buildFacebookColorTag(colorVal)}
                ${buildFacebookSizeTag(sizeVal)}
                <google_product_category>${googleProductCategory}</google_product_category>
              </item>
            `;
						facebookItems.push(facebookVariantItem);
					}
				} else if (variants.length === 1) {
					// Single POD variant fallback
					const singleVar = variants[0];
					const variantPrice = getFinalVariantPrice(singleVar);

					// parse color/size/scent from Printify
					const { colorVal, sizeVal, scentVal } =
						getVariantNamesFromPrintifyMap(singleVar, optionValueMap);

					// check quantity from productAttributes
					let matchedAttr = null;
					if (
						product.productAttributes &&
						product.productAttributes.length > 0
					) {
						matchedAttr = product.productAttributes.find(
							(a) => a.SubSKU === singleVar.sku
						);
					}
					let facebookInventory = 9999;
					let googleAvailability = "in stock";
					if (matchedAttr && matchedAttr.quantity != null) {
						facebookInventory = matchedAttr.quantity;
						googleAvailability =
							matchedAttr.quantity > 0 ? "in stock" : "out_of_stock";
					} else {
						facebookInventory = singleVar.quantity || 9999;
					}
					const facebookAvailability = googleAvailability;

					// images
					let variantImages = [];
					if (matchedAttr && matchedAttr.productImages?.length) {
						variantImages = matchedAttr.productImages.map((x) => x.url);
					}
					if (!variantImages.length) {
						variantImages = generateImageLinks(product);
					}

					// >>>> NEW: If the attribute has an exampleDesignImage, put it first
					if (
						matchedAttr &&
						matchedAttr.exampleDesignImage &&
						matchedAttr.exampleDesignImage.url
					) {
						variantImages.unshift(matchedAttr.exampleDesignImage.url);
					}
					// <<<< END NEW

					const googleImageXML = buildGoogleImageTags(variantImages);
					const facebookImageXML = buildFacebookImageTags(variantImages);

					// final link
					const finalLink = getProductLink(
						product,
						colorVal,
						sizeVal,
						scentVal
					);

					let attributeParts = ["Custom Design"];
					if (colorVal) attributeParts.push(colorVal);
					if (sizeVal) attributeParts.push(sizeVal);
					if (scentVal) attributeParts.push(scentVal);

					const attributeStr = attributeParts.join(", ");
					const podFallbackTitle = `${capitalizeWords(
						product.productName
					)} (${attributeStr})`;

					// Google single
					const googleItem = `
            <item>
              <g:id>${escapeXml(product._id.toString())}</g:id>
              <g:title><![CDATA[${podFallbackTitle}]]></g:title>
              <g:description><![CDATA[${cleanedDesc}]]></g:description>
              <g:link>${escapeXml(finalLink)}</g:link>
              ${googleImageXML}
              <g:availability>${googleAvailability}</g:availability>
              <g:price>${variantPrice} USD</g:price>
              <g:brand>${escapeXml(brand)}</g:brand>
              <g:condition>${escapeXml(condition)}</g:condition>
              <g:google_product_category>${googleProductCategory}</g:google_product_category>
              <g:product_type><![CDATA[${escapeXml(
								product.category.categoryName
							)}]]></g:product_type>
              <g:age_group>adult</g:age_group>
              <g:gender>${defaultGender}</g:gender>
              <g:identifier_exists>false</g:identifier_exists>

              <!-- Custom labels -->
              <g:custom_label_0>${escapeXml(categoryLabel)}</g:custom_label_0>
              <g:custom_label_1>${escapeXml(generalLabel)}</g:custom_label_1>
              <g:custom_label_2>print_on_demand</g:custom_label_2>
              <g:additional_link>https://serenejannat.com/return-refund-policy</g:additional_link>
            </item>
          `;
					googleItems.push(googleItem);

					// Facebook single
					const facebookItem = `
            <item>
              <id>${escapeXml(product._id.toString())}</id>
              <title><![CDATA[${podFallbackTitle}]]></title>
              <description><![CDATA[${cleanedDesc}]]></description>
              <link>${escapeXml(finalLink)}</link>
              ${facebookImageXML}
              <availability>${facebookAvailability}</availability>
              <inventory>${facebookInventory}</inventory>
              <quantity_to_sell_on_facebook>${facebookInventory}</quantity_to_sell_on_facebook>
              <price>${variantPrice} USD</price>
              <brand>${escapeXml(brand)}</brand>
              <condition>${escapeXml(condition)}</condition>
              <google_product_category>${googleProductCategory}</google_product_category>
            </item>
          `;
					facebookItems.push(facebookItem);
				} else {
					// No variants => just skip or treat as a single item
					// (Keep your original fallback logic if needed)
				}
			}

			// -----------------------------------
			// Non-POD products (unchanged logic)
			// -----------------------------------
			else {
				const hasVariants =
					product.productAttributes && product.productAttributes.length > 0;

				if (hasVariants) {
					const itemGroupId = escapeXml(product._id.toString());

					for (let [index, variant] of product.productAttributes.entries()) {
						const variantPrice = parseFloat(
							variant.priceAfterDiscount || variant.price || product.price
						).toFixed(2);

						let variantImages = variant.productImages?.map((x) => x.url) || [];
						if (!variantImages.length) {
							variantImages = generateImageLinks(product);
						}
						const googleImageXML = buildGoogleImageTags(variantImages);
						const facebookImageXML = buildFacebookImageTags(variantImages);

						// For non-POD, color might be hex => try to resolve
						const resolvedVariantColor = await resolveColorName(
							variant.color || ""
						);
						const variantSize = variant.size || "";

						const googleAvailability =
							variant.quantity > 0 ? "in stock" : "out_of_stock";
						const facebookAvailability = googleAvailability;
						const facebookInventory = variant.quantity || 9999;

						const variantWeight = validateDimension(
							variant.weight || product.geodata?.weight,
							DEFAULT_WEIGHT
						);
						const variantLength = validateDimension(
							variant.length || product.geodata?.length,
							DEFAULT_LENGTH
						);
						const variantWidth = validateDimension(
							variant.width || product.geodata?.width,
							DEFAULT_WIDTH
						);
						const variantHeight = validateDimension(
							variant.height || product.geodata?.height,
							DEFAULT_HEIGHT
						);

						// Normal link for non-POD
						const finalLink = getProductLink(product);

						const variantTitle = `${capitalizeWords(
							product.productName
						)} (${variantSize}, ${resolvedVariantColor})`;

						// Conditionals for color/size tags
						const googleColorTag = buildGoogleColorTag(resolvedVariantColor);
						const googleSizeTag = buildGoogleSizeTag(variantSize);
						const facebookColorTag =
							buildFacebookColorTag(resolvedVariantColor);
						const facebookSizeTag = buildFacebookSizeTag(variantSize);

						// Google variant
						const googleVariantItem = `
              <item>
                <g:id>${escapeXml(product._id.toString())}-${index}</g:id>
                <g:title><![CDATA[${variantTitle}]]></g:title>
                <g:description><![CDATA[${cleanedDesc}]]></g:description>
                <g:link>${escapeXml(finalLink)}</g:link>
                ${googleImageXML}
                <g:availability>${googleAvailability}</g:availability>
                <g:price>${variantPrice} USD</g:price>
                <g:brand>${escapeXml(brand)}</g:brand>
                <g:condition>${escapeXml(condition)}</g:condition>
                <g:google_product_category>${googleProductCategory}</g:google_product_category>
                <g:product_type><![CDATA[${escapeXml(
									product.category.categoryName
								)}]]></g:product_type>
                <g:item_group_id>${itemGroupId}</g:item_group_id>
                ${googleSizeTag}
                ${googleColorTag}
                <g:age_group>adult</g:age_group>
                <g:gender>${defaultGender}</g:gender>
                <g:identifier_exists>false</g:identifier_exists>
                <g:shipping_weight>${variantWeight} kg</g:shipping_weight>
                <g:shipping_length>${variantLength} cm</g:shipping_length>
                <g:shipping_width>${variantWidth} cm</g:shipping_width>
                <g:shipping_height>${variantHeight} cm</g:shipping_height>

                <!-- Custom labels -->
                <g:custom_label_0>${escapeXml(categoryLabel)}</g:custom_label_0>
                <g:custom_label_1>${escapeXml(generalLabel)}</g:custom_label_1>
                <g:additional_link>https://serenejannat.com/return-refund-policy</g:additional_link>
              </item>
            `;
						googleItems.push(googleVariantItem);

						// Facebook variant
						const facebookVariantItem = `
              <item>
                <id>${escapeXml(product._id.toString())}-${index}</id>
                <title><![CDATA[${variantTitle}]]></title>
                <description><![CDATA[${cleanedDesc}]]></description>
                <link>${escapeXml(finalLink)}</link>
                ${facebookImageXML}
                <availability>${facebookAvailability}</availability>
                <inventory>${facebookInventory}</inventory>
                <quantity_to_sell_on_facebook>${facebookInventory}</quantity_to_sell_on_facebook>
                <price>${variantPrice} USD</price>
                <brand>${escapeXml(brand)}</brand>
                <condition>${escapeXml(condition)}</condition>
                <item_group_id>${itemGroupId}</item_group_id>
                ${facebookColorTag}
                ${facebookSizeTag}
                <google_product_category>${googleProductCategory}</google_product_category>
              </item>
            `;
						facebookItems.push(facebookVariantItem);
					}
				} else {
					// Single product (no variants)
					const weight = convertLbsToKg(product.geodata?.weight || 0);
					const length = convertInchesToCm(product.geodata?.length || 0);
					const width = convertInchesToCm(product.geodata?.width || 0);
					const height = convertInchesToCm(product.geodata?.height || 0);

					// Possibly resolve color if it’s a hex
					const resolvedColor = await resolveColorName(product.color || "");
					const size = product.size || "";
					const finalLink = getProductLink(product);

					const fallbackImages = generateImageLinks(product);
					const googleImageXML = buildGoogleImageTags(fallbackImages);
					const facebookImageXML = buildFacebookImageTags(fallbackImages);

					const googleAvailability =
						product.quantity > 0 ? "in stock" : "out_of_stock";
					const facebookAvailability = googleAvailability;
					const facebookInventory = product.quantity || 9999;

					const priceVal = parseFloat(
						product.priceAfterDiscount || product.price || 0
					).toFixed(2);

					const googleColorTag = buildGoogleColorTag(resolvedColor);
					const googleSizeTag = buildGoogleSizeTag(size);
					const facebookColorTag = buildFacebookColorTag(resolvedColor);
					const facebookSizeTag = buildFacebookSizeTag(size);

					// Google single
					const googleItemXML = `
            <item>
              <g:id>${escapeXml(product._id.toString())}</g:id>
              <g:title><![CDATA[${capitalizeWords(
								product.productName
							)}]]></g:title>
              <g:description><![CDATA[${cleanedDesc}]]></g:description>
              <g:link>${escapeXml(finalLink)}</g:link>
              ${googleImageXML}
              <g:availability>${googleAvailability}</g:availability>
              <g:price>${priceVal} USD</g:price>
              <g:brand>${escapeXml(brand)}</g:brand>
              <g:condition>${escapeXml(condition)}</g:condition>
              <g:google_product_category>${googleProductCategory}</g:google_product_category>
              <g:product_type><![CDATA[${escapeXml(
								product.category.categoryName
							)}]]></g:product_type>
              ${googleSizeTag}
              ${googleColorTag}
              <g:age_group>adult</g:age_group>
              <g:gender>${defaultGender}</g:gender>
              <g:identifier_exists>false</g:identifier_exists>
              <g:shipping_weight>${weight} kg</g:shipping_weight>
              <g:shipping_length>${length} cm</g:shipping_length>
              <g:shipping_width>${width} cm</g:shipping_width>
              <g:shipping_height>${height} cm</g:shipping_height>

              <!-- Custom labels -->
              <g:custom_label_0>${escapeXml(categoryLabel)}</g:custom_label_0>
              <g:custom_label_1>${escapeXml(generalLabel)}</g:custom_label_1>
              <g:additional_link>https://serenejannat.com/return-refund-policy</g:additional_link>
            </item>
          `;
					googleItems.push(googleItemXML);

					// Facebook single
					const facebookItemXML = `
            <item>
              <id>${escapeXml(product._id.toString())}</id>
              <title><![CDATA[${capitalizeWords(product.productName)}]]></title>
              <description><![CDATA[${cleanedDesc}]]></description>
              <link>${escapeXml(finalLink)}</link>
              ${facebookImageXML}
              <availability>${facebookAvailability}</availability>
              <inventory>${facebookInventory}</inventory>
              <quantity_to_sell_on_facebook>${facebookInventory}</quantity_to_sell_on_facebook>
              <price>${priceVal} USD</price>
              <brand>${escapeXml(brand)}</brand>
              <condition>${escapeXml(condition)}</condition>
              ${facebookColorTag}
              ${facebookSizeTag}
              <google_product_category>${googleProductCategory}</google_product_category>
            </item>
          `;
					facebookItems.push(facebookItemXML);
				}
			}
		}
	}

	// ----------------------------
	// Build Google Feed
	// ----------------------------
	const googleFeedContent = `
    <rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
      <channel>
        <title>Serene Jannat Products</title>
        <link>https://serenejannat.com</link>
        <description>Google Merchant Center Feed</description>
        ${googleItems.join("\n")}
      </channel>
    </rss>
  `;

	// ----------------------------
	// Build Facebook Feed
	// ----------------------------
	const facebookFeedContent = `
    <rss version="2.0">
      <channel>
        <title>Serene Jannat Products</title>
        <link>https://serenejannat.com</link>
        <description>Facebook Product Feed</description>
        ${facebookItems.join("\n")}
      </channel>
    </rss>
  `;

	// Write the files
	const googleWriteStream = createWriteStream(
		resolve(__dirname, "../../serene_frontend/public/merchant-center-feed.xml"),
		{ flags: "w" }
	);
	googleWriteStream.write(googleFeedContent, "utf-8");
	googleWriteStream.end();

	const facebookWriteStream = createWriteStream(
		resolve(__dirname, "../../serene_frontend/public/facebook-feed.xml"),
		{ flags: "w" }
	);
	facebookWriteStream.write(facebookFeedContent, "utf-8");
	facebookWriteStream.end();

	googleWriteStream.on("finish", () => {
		console.log("Google Merchant Center feed generated successfully");
	});
	facebookWriteStream.on("finish", () => {
		console.log("Facebook feed generated successfully");
		res.send("Feeds for Google and Facebook generated successfully.");
	});
});

module.exports = router;
