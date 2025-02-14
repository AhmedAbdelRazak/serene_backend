const express = require("express");
const router = express.Router();
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product and Colors models
const Product = require("../models/product");
const Colors = require("../models/colors");

// Mapping of your categories to Google Product Categories
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

// Default dimension/weight placeholders
const DEFAULT_WEIGHT = "1.00"; // in kg
const DEFAULT_LENGTH = "10.00"; // in cm
const DEFAULT_WIDTH = "10.00"; // in cm
const DEFAULT_HEIGHT = "10.00"; // in cm

// Extract first numeric value from a string
function extractFirstNumber(value) {
	if (!value) return "Not available";
	const match = value.match(/(\d+(\.\d+)?)/);
	return match ? parseFloat(match[0]) : "Not available";
}

// Generate fallback images
function generateImageLinks(product) {
	let images = [];

	// If the product has variant attributes with images
	if (product.productAttributes && product.productAttributes.length > 0) {
		product.productAttributes.forEach((attr) => {
			if (attr.productImages && attr.productImages.length > 0) {
				images.push(...attr.productImages.map((img) => escapeXml(img.url)));
			}
		});
	}
	// If no variant images, fallback to thumbnail
	else if (product.thumbnailImage && product.thumbnailImage.length > 0) {
		images.push(
			...product.thumbnailImage[0].images.map((img) => escapeXml(img.url))
		);
	}

	// Filter valid image formats
	const validImages = images.filter((img) =>
		/\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(img)
	);

	// Provide a default if no valid images
	if (validImages.length === 0) {
		validImages.push(
			"https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg"
		);
	}

	// Limit to max 5
	return validImages.slice(0, 5);
}

// Convert LBS to KG
function convertLbsToKg(lbs) {
	return lbs > 0 ? (lbs * 0.453592).toFixed(2) : "Not available";
}

// Convert inches to CM
function convertInchesToCm(inches) {
	const numericValue = extractFirstNumber(inches);
	return numericValue !== "Not available"
		? (numericValue * 2.54).toFixed(2)
		: "Not available";
}

// Resolve color name from DB
async function resolveColorName(hexCode) {
	if (!hexCode) return "Unspecified";
	const color = await Colors.findOne({ hexa: hexCode.toLowerCase() });
	return color ? color.color : "Unspecified";
}

// Generate product link
function getProductLink(product) {
	// If the product is POD (Printify)
	if (
		product.printifyProductDetails?.POD === true &&
		product.printifyProductDetails?.id
	) {
		return `https://serenejannat.com/custom-gifts/${product._id}`;
	}
	// Otherwise => normal link
	return `https://serenejannat.com/single-product/${escapeXml(
		product.slug
	)}/${escapeXml(product.category.categorySlug)}/${product._id}`;
}

// Safely parse the variant title to separate size and color
function parseSizeColorFromVariantTitle(title) {
	if (!title || typeof title !== "string") {
		return { variantSize: "Unspecified", variantColor: "Unspecified" };
	}
	// Usually looks like "M / White", "L / Black", etc.
	const parts = title.split(" / ");
	const size = parts[0] ? parts[0].trim() : "Unspecified";
	const color = parts[1] ? parts[1].trim() : "Unspecified";
	return { variantSize: size, variantColor: color };
}

// This is the core fix for your Printify prices:
//   - If the price is an integer >= 100, treat it like cents and divide by 100
//   - Otherwise leave it as-is
function getFinalVariantPrice(variant) {
	let rawPrice = variant.priceAfterDiscount ?? variant.price;
	if (!rawPrice) return "0.00";

	let floatVal = parseFloat(rawPrice);

	// If it's an integer >= 100, interpret it as cents (e.g. 805 => 8.05)
	if (Number.isInteger(floatVal) && floatVal >= 100) {
		floatVal /= 100;
	}

	return floatVal.toFixed(2);
}

// Validate gender
function validateGender(gender) {
	const validGenders = ["male", "female", "unisex"];
	if (!gender || typeof gender !== "string") return "unisex";
	const g = gender.toLowerCase();
	return validGenders.includes(g) ? g : "unisex";
}

router.get("/generate-feeds", async (req, res) => {
	let googleItems = [];
	let facebookItems = [];

	// Fetch active products
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	for (let product of products) {
		// Make sure product category is active
		if (product.category && product.category.categoryStatus) {
			const condition = "new";
			const brand = "Serene Jannat";
			const defaultGender = validateGender(product.gender || "unisex");

			// Fallback images if no matched variant images
			const fallbackImages = generateImageLinks(product);
			const fallbackImageLink =
				fallbackImages.length > 0
					? fallbackImages[0]
					: "https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg";

			// Map to google product category if possible
			const googleProductCategory = escapeXml(
				categoryMapping[product.category.categoryName.toLowerCase()] ||
					"Home & Garden"
			);

			// Some custom labels
			const categoryLabel = product.category.categoryName
				? product.category.categoryName.toLowerCase().replace(/\s+/g, "_")
				: "general";
			const generalLabel = "general_campaign";

			// ===========================
			// CASE 1: POD PRINTIFY LOGIC
			// ===========================
			if (product.printifyProductDetails?.POD) {
				const itemGroupId = escapeXml(product._id.toString());
				const variants = product.printifyProductDetails.variants || [];

				if (Array.isArray(variants) && variants.length > 0) {
					// Build an <item> per variant
					for (let [index, variant] of variants.entries()) {
						const { variantSize, variantColor } =
							parseSizeColorFromVariantTitle(variant.title);
						const variantPrice = getFinalVariantPrice(variant);
						const variantAvailability = "in stock"; // or real stock if you have it

						// Attempt to match a Cloudinary image by variant.sku
						let variantImage = fallbackImageLink;
						if (
							product.productAttributes &&
							product.productAttributes.length > 0
						) {
							const matchedAttr = product.productAttributes.find(
								(attr) => attr.SubSKU === variant.sku
							);
							if (
								matchedAttr &&
								matchedAttr.productImages &&
								matchedAttr.productImages.length > 0
							) {
								variantImage = matchedAttr.productImages[0].url;
							}
						}

						const finalLink = getProductLink(product);
						const podTitle = `${capitalizeWords(
							product.productName
						)} (Custom Design, ${variantSize}, ${variantColor})`;

						const variantItem = `
              <item>
                <g:id>${escapeXml(product._id.toString())}-${index}</g:id>
                <g:title><![CDATA[${podTitle}]]></g:title>
                <g:description><![CDATA[${escapeXml(
									product.description.replace(/<[^>]+>/g, "")
								)}]]></g:description>
                <g:link>${finalLink}</g:link>
                <g:image_link>${escapeXml(variantImage)}</g:image_link>
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
					// POD but no variants => fallback to single item
					const finalLink = getProductLink(product);

					// Same "cents" fix for single/parent price
					const rawFallbackPrice = parseFloat(
						product.priceAfterDiscount || product.price || 0
					);
					let fallbackPrice = rawFallbackPrice;

					// If it's an integer >= 100, treat as cents
					if (Number.isInteger(fallbackPrice) && fallbackPrice >= 100) {
						fallbackPrice = fallbackPrice / 100;
					}

					const podFallbackTitle = `${capitalizeWords(
						product.productName
					)} (Custom Design)`;

					const podItem = `
            <item>
              <g:id>${escapeXml(product._id.toString())}</g:id>
              <g:title><![CDATA[${podFallbackTitle}]]></g:title>
              <g:description><![CDATA[${escapeXml(
								product.description.replace(/<[^>]+>/g, "")
							)}]]></g:description>
              <g:link>${finalLink}</g:link>
              <g:image_link>${fallbackImageLink}</g:image_link>
              <g:availability>${
								product.quantity > 0 ? "in stock" : "out of stock"
							}</g:availability>
              <g:price>${fallbackPrice.toFixed(2)} USD</g:price>
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

				// ============================
				// CASE 2: NON-POD PRODUCT
				// ============================
			} else {
				const hasVariants =
					product.productAttributes && product.productAttributes.length > 0;

				if (hasVariants) {
					const itemGroupId = escapeXml(product._id.toString());

					for (let [index, variant] of product.productAttributes.entries()) {
						const variantImage =
							variant.productImages?.[0]?.url || fallbackImageLink;
						const variantSize = variant.size || "Unspecified";
						const variantHexColor = variant.color || "";
						const variantColor = await resolveColorName(variantHexColor);

						// If you have discount, use it, else normal price
						const variantPrice =
							variant.priceAfterDiscount || variant.price || product.price;
						const variantAvailability =
							variant.quantity > 0 ? "in stock" : "out of stock";

						// Dimensions
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
                <g:description><![CDATA[${escapeXml(
									product.description.replace(/<[^>]+>/g, "")
								)}]]></g:description>
                <g:link>${finalLink}</g:link>
                <g:image_link>${escapeXml(variantImage)}</g:image_link>
                <g:availability>${variantAvailability}</g:availability>
                <g:price>${parseFloat(variantPrice).toFixed(2)} USD</g:price>
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
					// Single product
					const weight = convertLbsToKg(product.geodata?.weight || 0);
					const length = convertInchesToCm(product.geodata?.length || 0);
					const width = convertInchesToCm(product.geodata?.width || 0);
					const height = convertInchesToCm(product.geodata?.height || 0);
					const size = product.size || "Unspecified";
					const variantHexColor = product.color || "";
					const resolvedColor = await resolveColorName(variantHexColor);
					const finalLink = getProductLink(product);

					const googleItem = `
            <item>
              <g:id>${escapeXml(product._id.toString())}</g:id>
              <g:title><![CDATA[${capitalizeWords(
								product.productName
							)}]]></g:title>
              <g:description><![CDATA[${escapeXml(
								product.description.replace(/<[^>]+>/g, "")
							)}]]></g:description>
              <g:link>${finalLink}</g:link>
              <g:image_link>${fallbackImageLink}</g:image_link>
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
					googleItems.push(googleItem);
					facebookItems.push(googleItem);
				}
			}
		}
	}

	// Build Google Feed
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

	// Build Facebook Feed
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

	// Write the files to your public folder
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

	// On finish, respond to client
	googleWriteStream.on("finish", () => {
		console.log("Google Merchant Center feed generated successfully");
	});
	facebookWriteStream.on("finish", () => {
		console.log("Facebook feed generated successfully");
		res.send("Feeds for Google and Facebook generated successfully.");
	});
});

module.exports = router;
