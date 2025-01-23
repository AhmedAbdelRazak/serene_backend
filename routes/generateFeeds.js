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

// Function to capitalize product titles
function capitalizeWords(string) {
	return string
		.toLowerCase()
		.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// Function to ensure valid dimensions and weight
function validateDimension(value, defaultValue) {
	const numericValue = parseFloat(value);
	return !isNaN(numericValue) && numericValue > 0
		? numericValue.toFixed(2)
		: defaultValue;
}

// Default values for dimensions and weight
const DEFAULT_WEIGHT = "1.00"; // Default to 1 kg if not provided
const DEFAULT_LENGTH = "10.00"; // Default to 10 cm if not provided
const DEFAULT_WIDTH = "10.00"; // Default to 10 cm if not provided
const DEFAULT_HEIGHT = "10.00"; // Default to 10 cm if not provided

// Function to extract the first valid numeric value from strings
function extractFirstNumber(value) {
	if (!value) return "Not available";
	const match = value.match(/(\d+(\.\d+)?)/);
	return match ? parseFloat(match[0]) : "Not available";
}

// Function to generate image links for products
function generateImageLinks(product) {
	let images = [];
	if (product.productAttributes && product.productAttributes.length > 0) {
		product.productAttributes.forEach((attr) => {
			if (attr.productImages && attr.productImages.length > 0) {
				images.push(...attr.productImages.map((img) => escapeXml(img.url)));
			}
		});
	} else if (product.thumbnailImage && product.thumbnailImage.length > 0) {
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

// Conversion functions
function convertLbsToKg(lbs) {
	return lbs > 0 ? (lbs * 0.453592).toFixed(2) : "Not available";
}

function convertInchesToCm(inches) {
	const numericValue = extractFirstNumber(inches);
	return numericValue !== "Not available"
		? (numericValue * 2.54).toFixed(2)
		: "Not available";
}

// Function to resolve color name from hex code
async function resolveColorName(hexCode) {
	if (!hexCode) return "Unspecified";
	const color = await Colors.findOne({ hexa: hexCode.toLowerCase() });
	return color ? color.color : "Unspecified";
}

// Generate Feeds Route
router.get("/generate-feeds", async (req, res) => {
	let googleItems = [];
	let facebookItems = [];

	// Fetch active products from MongoDB
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
			const hasVariants =
				product.productAttributes && product.productAttributes.length > 0;

			const condition = "new";
			const brand = "Serene Jannat";

			function validateGender(gender) {
				const validGenders = ["male", "female", "unisex"];
				return typeof gender === "string" &&
					validGenders.includes(gender.toLowerCase())
					? gender.toLowerCase()
					: "unisex";
			}

			const defaultGender = validateGender(product.gender || "unisex");

			const images = generateImageLinks(product);
			const imageLink =
				images.length > 0
					? images[0]
					: "https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg";

			const googleProductCategory = escapeXml(
				categoryMapping[product.category.categoryName.toLowerCase()] ||
					"Home & Garden"
			);

			if (hasVariants) {
				for (let [index, variant] of product.productAttributes.entries()) {
					const variantImage = variant.productImages?.[0]?.url || imageLink;
					const variantSize = variant.size || "Unspecified";
					const variantHexColor = variant.color || "Unspecified";
					const variantColor = await resolveColorName(variantHexColor);
					const variantPrice =
						variant.priceAfterDiscount || variant.price || product.price;
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

					const variantItem = `
            <item>
              <g:id>${escapeXml(product._id.toString())}-${index}</g:id>
              <g:title><![CDATA[${capitalizeWords(
								product.productName
							)} (${variantSize}, ${variantColor})]]></g:title>
              <g:description><![CDATA[${escapeXml(
								product.description.replace(/<[^>]+>/g, "")
							)}]]></g:description>
              <g:link>https://serenejannat.com/single-product/${escapeXml(
								product.slug
							)}/${escapeXml(product.category.categorySlug)}/${
						product._id
					}</g:link>
              <g:image_link>${escapeXml(variantImage)}</g:image_link>
              <g:availability>${variantAvailability}</g:availability>
              <g:price>${variantPrice.toFixed(2)} USD</g:price>
              <g:brand>${escapeXml(brand)}</g:brand>
              <g:condition>${escapeXml(condition)}</g:condition>
              <g:google_product_category>${googleProductCategory}</g:google_product_category>
              <g:product_type><![CDATA[${escapeXml(
								product.category.categoryName
							)}]]></g:product_type>
              <g:size>${escapeXml(variantSize)}</g:size>
              <g:color>${escapeXml(variantColor)}</g:color>
              <g:age_group>adult</g:age_group>
              <g:gender>${defaultGender}</g:gender>
              <g:identifier_exists>false</g:identifier_exists>
              <g:shipping_weight>${variantWeight} kg</g:shipping_weight>
              <g:shipping_length>${variantLength} cm</g:shipping_length>
              <g:shipping_width>${variantWidth} cm</g:shipping_width>
              <g:shipping_height>${variantHeight} cm</g:shipping_height>
              <g:additional_link>https://serenejannat.com/return-refund-policy</g:additional_link>
            </item>
          `;
					googleItems.push(variantItem);
					facebookItems.push(variantItem);
				}
			} else {
				const weight = convertLbsToKg(product.geodata?.weight || 0);
				const length = convertInchesToCm(product.geodata?.length || 0);
				const width = convertInchesToCm(product.geodata?.width || 0);
				const height = convertInchesToCm(product.geodata?.height || 0);
				const size = product.size || "Unspecified";
				const variantHexColor = product.color || "Unspecified";
				const resolvedColor = variantHexColor;

				const googleItem = `
          <item>
            <g:id>${escapeXml(product._id.toString())}</g:id>
            <g:title><![CDATA[${capitalizeWords(
							product.productName
						)}]]></g:title>
            <g:description><![CDATA[${escapeXml(
							product.description.replace(/<[^>]+>/g, "")
						)}]]></g:description>
            <g:link>https://serenejannat.com/single-product/${escapeXml(
							product.slug
						)}/${escapeXml(product.category.categorySlug)}/${
					product._id
				}</g:link>
            <g:image_link>${imageLink}</g:image_link>
            <g:availability>${
							product.quantity > 0 ? "in stock" : "out of stock"
						}</g:availability>
            <g:price>${product.priceAfterDiscount.toFixed(2)} USD</g:price>
            <g:brand>${escapeXml(brand)}</g:brand>
            <g:condition>${escapeXml(condition)}</g:condition>
            <g:google_product_category>${googleProductCategory}</g:google_product_category>
            <g:product_type><![CDATA[${escapeXml(
							product.category.categoryName
						)}]]></g:product_type>
            <g:size>${size}</g:size>
            <g:color>${resolvedColor}</g:color>
            <g:age_group>adult</g:age_group>
            <g:gender>${defaultGender}</g:gender>
            <g:identifier_exists>false</g:identifier_exists>
            <g:shipping_weight>${weight} kg</g:shipping_weight>
            <g:shipping_length>${length} cm</g:shipping_length>
            <g:shipping_width>${width} cm</g:shipping_width>
            <g:shipping_height>${height} cm</g:shipping_height>
            <g:additional_link>https://serenejannat.com/return-refund-policy</g:additional_link>
          </item>
        `;
				googleItems.push(googleItem);
				facebookItems.push(googleItem);
			}
		}
	}

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
