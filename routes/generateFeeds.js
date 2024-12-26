const express = require("express");
const router = express.Router();
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product model
const Product = require("../models/product");

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
	return unsafe.replace(/[<>&'"]/g, function (c) {
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

// Function to extract the first valid numeric value from strings
function extractFirstNumber(value) {
	if (!value) return "Not available";
	const match = value.match(/(\d+(\.\d+)?)/); // Extract the first number
	return match ? parseFloat(match[0]) : "Not available";
}

// Function to generate image links for products
function generateImageLinks(product) {
	let images = [];
	if (product.productAttributes && product.productAttributes.length > 0) {
		// Include all images from product attributes
		product.productAttributes.forEach((attr) => {
			if (attr.productImages && attr.productImages.length > 0) {
				images.push(...attr.productImages.map((img) => escapeXml(img.url)));
			}
		});
	} else if (product.thumbnailImage && product.thumbnailImage.length > 0) {
		// Include all images from thumbnailImage array
		images.push(
			...product.thumbnailImage[0].images.map((img) => escapeXml(img.url))
		);
	}
	// Filter for valid formats (JPEG, PNG, GIF, WebP, BMP, TIFF) and limit to max 5 images
	const validImages = images.filter((img) =>
		/\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(img)
	);

	// Add a fallback if no valid images are found
	if (validImages.length === 0) {
		validImages.push(
			"https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg"
		); // Replace with your default valid image URL
	}

	return validImages.slice(0, 5); // Limit to 5 images
}

// Conversion functions
function convertLbsToKg(lbs) {
	return lbs > 0 ? (lbs * 0.453592).toFixed(2) : "Not available"; // Convert lbs to kg or set as "Not available"
}

function convertInchesToCm(inches) {
	const numericValue = extractFirstNumber(inches);
	return numericValue !== "Not available"
		? (numericValue * 2.54).toFixed(2)
		: "Not available"; // Convert to cm or return "Not available"
}

router.get("/generate-feeds", async (req, res) => {
	let googleItems = [];
	let facebookItems = [];

	// Fetch active products from MongoDB
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	// Generate product items for feeds
	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
			const hasVariants =
				product.productAttributes && product.productAttributes.length > 0;

			// Price logic
			const originalPrice = hasVariants
				? product.productAttributes[0].price
				: product.price;
			const priceAfterDiscount = hasVariants
				? product.productAttributes[0].priceAfterDiscount
				: product.priceAfterDiscount;
			const finalPrice =
				priceAfterDiscount < originalPrice ? priceAfterDiscount : originalPrice;

			const quantity = hasVariants
				? product.productAttributes.reduce(
						(acc, attr) => acc + attr.quantity,
						0
				  )
				: product.quantity;
			const availability = quantity > 0 ? "in stock" : "out of stock";

			const condition = "new";
			const brand = "Serene Jannat";

			const images = generateImageLinks(product);
			const imageLink =
				images.length > 0
					? images[0]
					: "https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/default-image.jpg"; // Default valid image

			const googleProductCategory = escapeXml(
				categoryMapping[product.category.categoryName.toLowerCase()] ||
					"Home & Garden"
			);

			// Variant attributes
			let size = "";
			let color = "unspecified"; // Default if missing
			let ageGroup = "adult"; // Default if missing
			const gender = "both"; // Default to "both" for all products

			if (hasVariants) {
				// Generate feed items for each variant
				product.productAttributes.forEach((variant, index) => {
					const variantImage = variant.productImages?.[0]?.url || imageLink; // Use variant image or fallback
					const variantSize = variant.size || size;
					const variantColor = variant.color || color;
					const variantPrice =
						variant.priceAfterDiscount || variant.price || finalPrice;
					const variantAvailability =
						variant.quantity > 0 ? "in stock" : "out of stock";

					const variantWeight = convertLbsToKg(
						variant.weight || product.geodata?.weight
					);
					const variantLength = convertInchesToCm(
						variant.length || product.geodata?.length
					);
					const variantWidth = convertInchesToCm(
						variant.width || product.geodata?.width
					);
					const variantHeight = convertInchesToCm(
						variant.height || product.geodata?.height
					);

					const variantItem = `
                    <item>
                        <g:id>${escapeXml(
													product._id.toString()
												)}-${index}</g:id>
                        <g:title><![CDATA[${escapeXml(
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
                        <g:age_group>${escapeXml(ageGroup)}</g:age_group>
                        <g:gender>${escapeXml(gender)}</g:gender>
                        <g:identifier_exists>false</g:identifier_exists>
                        <g:shipping_weight>${variantWeight} kg</g:shipping_weight>
                        <g:shipping_length>${variantLength} cm</g:shipping_length>
                        <g:shipping_width>${variantWidth} cm</g:shipping_width>
                        <g:shipping_height>${variantHeight} cm</g:shipping_height>
                    </item>
                `;
					googleItems.push(variantItem);
				});
			} else {
				const weight = convertLbsToKg(product.geodata?.weight || 0);
				const length = convertInchesToCm(product.geodata?.length || 0);
				const width = convertInchesToCm(product.geodata?.width || 0);
				const height = convertInchesToCm(product.geodata?.height || 0);

				// Non-variant Google Item
				const googleItem = `
                <item>
                    <g:id>${escapeXml(product._id.toString())}</g:id>
                    <g:title><![CDATA[${escapeXml(
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
                    <g:availability>${availability}</g:availability>
                    <g:price>${finalPrice.toFixed(2)} USD</g:price>
                    <g:brand>${escapeXml(brand)}</g:brand>
                    <g:condition>${escapeXml(condition)}</g:condition>
                    <g:google_product_category>${googleProductCategory}</g:google_product_category>
                    <g:product_type><![CDATA[${escapeXml(
											product.category.categoryName
										)}]]></g:product_type>
                    <g:size>${escapeXml(size)}</g:size>
                    <g:color>${escapeXml(color)}</g:color>
                    <g:age_group>${escapeXml(ageGroup)}</g:age_group>
                    <g:gender>${escapeXml(gender)}</g:gender>
                    <g:identifier_exists>false</g:identifier_exists>
                    <g:shipping_weight>${weight} kg</g:shipping_weight>
                    <g:shipping_length>${length} cm</g:shipping_length>
                    <g:shipping_width>${width} cm</g:shipping_width>
                    <g:shipping_height>${height} cm</g:shipping_height>
                </item>
            `;
				googleItems.push(googleItem);
			}
		}
	}

	// Generate Google Feed
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
	const googleWriteStream = createWriteStream(
		resolve(__dirname, "../../serene_frontend/public/merchant-center-feed.xml"),
		{ flags: "w" }
	);
	googleWriteStream.write(googleFeedContent, "utf-8");
	googleWriteStream.end();

	// Generate Facebook Feed
	const facebookFeedContent = `
    <rss version="2.0">
      <channel>
        <title>Serene Jannat Products</title>
        <link>https://serenejannat.com</link>
        <description>Facebook Product Feed</description>
        ${googleItems.join("\n")} <!-- Reuse Google Items for Facebook -->
      </channel>
    </rss>
  `;
	const facebookWriteStream = createWriteStream(
		resolve(__dirname, "../../serene_frontend/public/facebook-feed.xml"),
		{ flags: "w" }
	);
	facebookWriteStream.write(facebookFeedContent, "utf-8");
	facebookWriteStream.end();

	// Logging and response
	googleWriteStream.on("finish", () => {
		console.log("Google Merchant Center feed generated successfully");
	});
	facebookWriteStream.on("finish", () => {
		console.log("Facebook feed generated successfully");
		res.send("Feeds for Google and Facebook generated successfully.");
	});
});

module.exports = router;
