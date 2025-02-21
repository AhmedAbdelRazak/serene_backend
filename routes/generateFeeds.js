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

	// If you have a category named "custom_design" in your DB,
	// map it to whichever Google category you prefer:
	custom_design: "Apparel & Accessories > Clothing > Customizable",
};

// Function to escape XML special characters
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

// ----------------------------
// 2) Generate *all* variant or fallback images (limit to 5 total in old code).
//    We'll keep it but we'll also handle "top 3" in the actual feed output.
// ----------------------------
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

	// Filter for valid formats
	const validImages = images.filter((img) =>
		/\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(img)
	);

	// Provide a default if none
	if (validImages.length === 0) {
		validImages.push(
			"https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg"
		);
	}

	// Limit to max of 5 in the old logic
	return validImages.slice(0, 5);
}

// Convert LBS → KG
function convertLbsToKg(lbs) {
	return lbs > 0 ? (lbs * 0.453592).toFixed(2) : "Not available";
}

// Convert inches → cm
function convertInchesToCm(inches) {
	const numericValue = extractFirstNumber(inches);
	return numericValue !== "Not available"
		? (numericValue * 2.54).toFixed(2)
		: "Not available";
}

// Attempt to get color name from DB
async function resolveColorName(hexCode) {
	if (!hexCode) return "Unspecified";
	const color = await Colors.findOne({ hexa: hexCode.toLowerCase() });
	return color ? color.color : "Unspecified";
}

// Build the product link
function getProductLink(product, color, size) {
	// If the product is POD => custom link
	if (
		product.printifyProductDetails?.POD === true &&
		product.printifyProductDetails?.id
	) {
		let url = `https://serenejannat.com/custom-gifts/${product._id}`;
		const queryParams = [];
		if (color && color !== "Unspecified") {
			queryParams.push(`color=${encodeURIComponent(color)}`);
		}
		if (size && size !== "Unspecified") {
			queryParams.push(`size=${encodeURIComponent(size)}`);
		}
		if (queryParams.length > 0) {
			url += `?${queryParams.join("&")}`;
		}
		return url;
	}

	// Otherwise => normal link
	return `https://serenejannat.com/single-product/${escapeXml(
		product.slug
	)}/${escapeXml(product.category.categorySlug)}/${product._id}`;
}

function parseSizeColorFromVariantTitle(title) {
	if (!title || typeof title !== "string") {
		return { variantColor: "Unspecified", variantSize: "Unspecified" };
	}
	const parts = title.split(" / ");
	const variantColor = parts[0] ? parts[0].trim() : "Unspecified";
	const variantSize = parts[1] ? parts[1].trim() : "Unspecified";
	return { variantColor, variantSize };
}

// If price is an int >=100 => treat as cents
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

// ------------------------------
// HELPER to transform an array of up to 3 images into
// <g:image_link> (first) + <g:additional_image_link> (the rest).
// ------------------------------
function buildImageTags(imageArray) {
	// limit to 3 total
	const upTo3 = imageArray.slice(0, 3);
	if (!upTo3.length) {
		// fallback if empty
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

router.get("/generate-feeds", async (req, res) => {
	let googleItems = [];
	let facebookItems = [];

	// Fetch active products
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	for (let product of products) {
		// Ensure product's category is active
		if (product.category && product.category.categoryStatus) {
			const condition = "new";
			const brand = "Serene Jannat";
			const defaultGender = validateGender(product.gender || "unisex");

			// Google Category
			const googleProductCategory = escapeXml(
				categoryMapping[product.category.categoryName?.toLowerCase()] ||
					"Home & Garden"
			);

			// Some custom labels
			const categoryLabel = product.category.categoryName
				? product.category.categoryName.toLowerCase().replace(/\s+/g, "_")
				: "general";
			const generalLabel = "general_campaign";

			// Because it's repeated, let's store a shorted description
			const cleanedDesc = escapeXml(
				product.description.replace(/<[^>]+>/g, "")
			);

			// -----------------------------
			// POD PRINTIFY Products (POD= true)
			// -----------------------------
			if (product.printifyProductDetails?.POD) {
				const itemGroupId = escapeXml(product._id.toString());
				const variants = product.printifyProductDetails.variants || [];

				if (Array.isArray(variants) && variants.length > 0) {
					// multi-variant
					for (let [index, variant] of variants.entries()) {
						const { variantColor, variantSize } =
							parseSizeColorFromVariantTitle(variant.title);
						const variantPrice = getFinalVariantPrice(variant);
						const variantAvailability = "in stock";

						// Gather up to 3 images for THIS variant, fallback to the product-level ones if none
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
						// fallback if variantImages empty => fallback product-level
						if (!variantImages.length) {
							variantImages = generateImageLinks(product);
						}

						// Build the <g:image_link> + <g:additional_image_link> lines
						const imageLinksXML = buildImageTags(variantImages);

						// Build link with color/size in the query
						const finalLink = getProductLink(
							product,
							variantColor,
							variantSize
						);
						const podTitle = `${capitalizeWords(
							product.productName
						)} (Custom Design, ${variantSize}, ${variantColor})`;

						const variantItem = `
              <item>
                <g:id>${escapeXml(product._id.toString())}-${index}</g:id>
                <g:title><![CDATA[${podTitle}]]></g:title>
                <g:description><![CDATA[${cleanedDesc}]]></g:description>
                <g:link>${escapeXml(finalLink)}</g:link>
                ${imageLinksXML}
                <g:availability>${variantAvailability}</g:availability>
                <g:price>${variantPrice} USD</g:price>
                <g:brand>${escapeXml(brand)}</g:brand>
                <g:condition>${escapeXml(condition)}</g:condition>
                <g:google_product_category>${googleProductCategory}</g:google_product_category>
                <g:product_type><![CDATA[${escapeXml(
									product.category.categoryName
								)}]]></g:product_type>
                <g:item_group_id>${itemGroupId}</g:item_group_id>
                <g:size><![CDATA[${variantSize}]]></g:size>
                <g:color><![CDATA[${variantColor}]]></g:color>
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
						googleItems.push(variantItem);
						facebookItems.push(variantItem);
					}
				} else {
					// Single-variant POD
					const finalLink = getProductLink(product);
					let rawFallbackPrice = parseFloat(
						product.priceAfterDiscount || product.price || 0
					);
					if (Number.isInteger(rawFallbackPrice) && rawFallbackPrice >= 100) {
						rawFallbackPrice /= 100;
					}
					const fallbackImages = generateImageLinks(product);
					const imageLinksXML = buildImageTags(fallbackImages);

					const podFallbackTitle = `${capitalizeWords(
						product.productName
					)} (Custom Design)`;

					const podItem = `
            <item>
              <g:id>${escapeXml(product._id.toString())}</g:id>
              <g:title><![CDATA[${podFallbackTitle}]]></g:title>
              <g:description><![CDATA[${cleanedDesc}]]></g:description>
              <g:link>${escapeXml(finalLink)}</g:link>
              ${imageLinksXML}
              <g:availability>${
								product.quantity > 0 ? "in stock" : "out of stock"
							}</g:availability>
              <g:price>${rawFallbackPrice.toFixed(2)} USD</g:price>
              <g:brand>${escapeXml(brand)}</g:brand>
              <g:condition>${escapeXml(condition)}</g:condition>
              <g:google_product_category>${googleProductCategory}</g:google_product_category>
              <g:product_type><![CDATA[${escapeXml(
								product.category.categoryName
							)}]]></g:product_type>
              <g:size>Unspecified</g:size>
              <g:color>Unspecified</g:color>
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
					googleItems.push(podItem);
					facebookItems.push(podItem);
				}
			}
			// ------------------------------------
			// NON-POD / Regular products
			// ------------------------------------
			else {
				const hasVariants =
					product.productAttributes && product.productAttributes.length > 0;

				if (hasVariants) {
					const itemGroupId = escapeXml(product._id.toString());

					for (let [index, variant] of product.productAttributes.entries()) {
						const variantPrice = parseFloat(
							variant.priceAfterDiscount || variant.price || product.price
						).toFixed(2);

						// Up to 3 images for this variant
						let variantImages = variant.productImages?.map((x) => x.url) || [];
						if (!variantImages.length) {
							variantImages = generateImageLinks(product);
						}
						const imageLinksXML = buildImageTags(variantImages);

						const variantSize = variant.size || "Unspecified";
						const variantHexColor = variant.color || "";
						const variantColor = await resolveColorName(variantHexColor);
						const variantAvailability =
							variant.quantity > 0 ? "in stock" : "out of stock";

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
						)} (${variantSize}, ${variantColor})`;

						const variantItem = `
              <item>
                <g:id>${escapeXml(product._id.toString())}-${index}</g:id>
                <g:title><![CDATA[${variantTitle}]]></g:title>
                <g:description><![CDATA[${cleanedDesc}]]></g:description>
                <g:link>${escapeXml(finalLink)}</g:link>
                ${imageLinksXML}
                <g:availability>${variantAvailability}</g:availability>
                <g:price>${variantPrice} USD</g:price>
                <g:brand>${escapeXml(brand)}</g:brand>
                <g:condition>${escapeXml(condition)}</g:condition>
                <g:google_product_category>${googleProductCategory}</g:google_product_category>
                <g:product_type><![CDATA[${escapeXml(
									product.category.categoryName
								)}]]></g:product_type>
                <g:item_group_id>${itemGroupId}</g:item_group_id>
                <g:size>${escapeXml(variantSize)}</g:size>
                <g:color>${escapeXml(variantColor)}</g:color>
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
						googleItems.push(variantItem);
						facebookItems.push(variantItem);
					}
				} else {
					// single product
					const weight = convertLbsToKg(product.geodata?.weight || 0);
					const length = convertInchesToCm(product.geodata?.length || 0);
					const width = convertInchesToCm(product.geodata?.width || 0);
					const height = convertInchesToCm(product.geodata?.height || 0);
					const size = product.size || "Unspecified";
					const variantHexColor = product.color || "";
					const resolvedColor = await resolveColorName(variantHexColor);
					const finalLink = getProductLink(product);

					const fallbackImages = generateImageLinks(product);
					const imageLinksXML = buildImageTags(fallbackImages);

					const itemXML = `
            <item>
              <g:id>${escapeXml(product._id.toString())}</g:id>
              <g:title><![CDATA[${capitalizeWords(
								product.productName
							)}]]></g:title>
              <g:description><![CDATA[${cleanedDesc}]]></g:description>
              <g:link>${escapeXml(finalLink)}</g:link>
              ${imageLinksXML}
              <g:availability>${
								product.quantity > 0 ? "in stock" : "out of stock"
							}</g:availability>
              <g:price>${parseFloat(
								product.priceAfterDiscount || product.price || 0
							).toFixed(2)} USD</g:price>
              <g:brand>${escapeXml(brand)}</g:brand>
              <g:condition>${escapeXml(condition)}</g:condition>
              <g:google_product_category>${googleProductCategory}</g:google_product_category>
              <g:product_type><![CDATA[${escapeXml(
								product.category.categoryName
							)}]]></g:product_type>
              <g:size>${escapeXml(size)}</g:size>
              <g:color>${escapeXml(resolvedColor)}</g:color>
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
					googleItems.push(itemXML);
					facebookItems.push(itemXML);
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
