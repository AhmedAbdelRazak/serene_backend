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

async function resolveColorName(hexCode) {
	// If your color is stored as text or as a real hex, adapt as needed.
	if (!hexCode) return "";
	const color = await Colors.findOne({ hexa: hexCode.toLowerCase() });
	return color ? color.color : hexCode; // if your DB is storing "blue" or hex
}

function getProductLink(product, color, size) {
	// If product is POD => /custom-gifts/:id?color=xx&size=yy
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
		if (queryParams.length > 0) {
			url += `?${queryParams.join("&")}`;
		}
		return url;
	}
	// else normal link
	return `https://serenejannat.com/single-product/${escapeXml(
		product.slug
	)}/${escapeXml(product.category.categorySlug)}/${product._id}`;
}

function parseSizeColorFromVariantTitle(title) {
	if (!title || typeof title !== "string") {
		return { variantColor: "", variantSize: "" };
	}
	const parts = title.split(" / ");
	const variantColor = parts[0] ? parts[0].trim() : "";
	const variantSize = parts[1] ? parts[1].trim() : "";
	return { variantColor, variantSize };
}

// If price >= 100 and is integer => treat as cents
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

router.get("/generate-feeds", async (req, res) => {
	let googleItems = [];
	let facebookItems = [];

	// Fetch active products
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	for (let product of products) {
		// Only if product has an active category
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

			// Clean the description of HTML tags, then escape
			const cleanedDesc = escapeXml(
				product.description.replace(/<[^>]+>/g, "")
			);

			// Helper to build color/size tags (conditionally) for Google & FB
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
			// Check if product is Printify POD
			// -----------------------------------------
			if (product.printifyProductDetails?.POD) {
				const itemGroupId = escapeXml(product._id.toString());
				const variants = product.printifyProductDetails.variants || [];

				if (variants.length > 0) {
					// Multi-variant
					for (let [index, variant] of variants.entries()) {
						const { variantColor, variantSize } =
							parseSizeColorFromVariantTitle(variant.title);
						const variantPrice = getFinalVariantPrice(variant);

						// For Google: availability is "in stock" / "out of stock"
						const googleAvailability = "in stock"; // POD implies in stock?
						// For Facebook: also "in stock", plus numeric inventory
						const facebookAvailability = "in stock";
						const facebookInventory = variant.quantity || 9999;

						// Attempt to find images for that variant
						let variantImages = [];
						if (
							product.productAttributes &&
							product.productAttributes.length > 0
						) {
							const matchedAttr = product.productAttributes.find(
								(a) => a.SubSKU === variant.sku
							);
							if (matchedAttr && matchedAttr.productImages?.length) {
								variantImages = matchedAttr.productImages.map((x) => x.url);
							}
						}
						if (!variantImages.length) {
							variantImages = generateImageLinks(product);
						}

						// Build image tags
						const googleImageXML = buildGoogleImageTags(variantImages);
						const facebookImageXML = buildFacebookImageTags(variantImages);

						// Build final link with color/size
						const finalLink = getProductLink(
							product,
							variantColor,
							variantSize
						);
						const podTitle = `${capitalizeWords(
							product.productName
						)} (Custom Design, ${variantSize}, ${variantColor})`;

						// Conditionals for color/size tags
						const googleColorTag = buildGoogleColorTag(variantColor);
						const googleSizeTag = buildGoogleSizeTag(variantSize);
						const facebookColorTag = buildFacebookColorTag(variantColor);
						const facebookSizeTag = buildFacebookSizeTag(variantSize);

						// --------------------
						// 1) Google variant
						// --------------------
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
                ${googleSizeTag}
                ${googleColorTag}
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

						// --------------------
						// 2) Facebook variant
						// --------------------
						// NOTE: We add <quantity_to_sell_on_facebook> as well:
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
                ${facebookColorTag}
                ${facebookSizeTag}
                <google_product_category>${googleProductCategory}</google_product_category>
              </item>
            `;
						facebookItems.push(facebookVariantItem);
					}
				} else {
					// Single variant or no variants array
					let rawFallbackPrice = parseFloat(
						product.priceAfterDiscount || product.price || 0
					);
					if (Number.isInteger(rawFallbackPrice) && rawFallbackPrice >= 100) {
						rawFallbackPrice /= 100;
					}
					const fallbackPrice = rawFallbackPrice.toFixed(2);

					const fallbackImages = generateImageLinks(product);
					const googleImageXML = buildGoogleImageTags(fallbackImages);
					const facebookImageXML = buildFacebookImageTags(fallbackImages);

					const podFallbackTitle = `${capitalizeWords(
						product.productName
					)} (Custom Design)`;
					const finalLink = getProductLink(product);
					const googleAvailability =
						product.quantity > 0 ? "in stock" : "out of stock";
					const facebookAvailability = googleAvailability;
					const facebookInventory = product.quantity || 9999;

					const googleSizeTag = "";
					const googleColorTag = "";
					const facebookSizeTag = "";
					const facebookColorTag = "";

					// Google single POD
					const googleItem = `
            <item>
              <g:id>${escapeXml(product._id.toString())}</g:id>
              <g:title><![CDATA[${podFallbackTitle}]]></g:title>
              <g:description><![CDATA[${cleanedDesc}]]></g:description>
              <g:link>${escapeXml(finalLink)}</g:link>
              ${googleImageXML}
              <g:availability>${googleAvailability}</g:availability>
              <g:price>${fallbackPrice} USD</g:price>
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

              <!-- Custom labels -->
              <g:custom_label_0>${escapeXml(categoryLabel)}</g:custom_label_0>
              <g:custom_label_1>${escapeXml(generalLabel)}</g:custom_label_1>
              <g:custom_label_2>print_on_demand</g:custom_label_2>
              <g:additional_link>https://serenejannat.com/return-refund-policy</g:additional_link>
            </item>
          `;
					googleItems.push(googleItem);

					// Facebook single POD
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
              <price>${fallbackPrice} USD</price>
              <brand>${escapeXml(brand)}</brand>
              <condition>${escapeXml(condition)}</condition>
              ${facebookColorTag}
              ${facebookSizeTag}
              <google_product_category>${googleProductCategory}</google_product_category>
            </item>
          `;
					facebookItems.push(facebookItem);
				}
			}
			// -----------------------------------
			// Non-POD products
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

						const variantHexColor = variant.color || "";
						const resolvedVariantColor = await resolveColorName(
							variantHexColor
						);
						const variantSize = variant.size || "";

						const googleAvailability =
							variant.quantity > 0 ? "in stock" : "out of stock";
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

						// 1) Google variant
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

						// 2) Facebook variant
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

					const resolvedColor = await resolveColorName(product.color || "");
					const size = product.size || "";
					const finalLink = getProductLink(product);

					const fallbackImages = generateImageLinks(product);
					const googleImageXML = buildGoogleImageTags(fallbackImages);
					const facebookImageXML = buildFacebookImageTags(fallbackImages);

					const googleAvailability =
						product.quantity > 0 ? "in stock" : "out of stock";
					const facebookAvailability = googleAvailability;
					const facebookInventory = product.quantity || 9999;

					const priceVal = parseFloat(
						product.priceAfterDiscount || product.price || 0
					).toFixed(2);

					// Conditionals for color/size
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
	// Here we add <quantity_to_sell_on_facebook> for each item to avoid the "Missing quantity" error.
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
