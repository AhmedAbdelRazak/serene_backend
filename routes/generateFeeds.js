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
	planters: "Home & Garden > Lawn & Garden > Planters",
	candles: "Home & Garden > Decor > Candles",
	"home decor": "Home & Garden > Decor",
	outdoors: "Home & Garden > Lawn & Garden > Gardening > Gardening Accessories",
	"t shirts": "Apparel & Accessories > Clothing > Shirts & Tops",
	seasonal: "Home & Garden > Decor > Seasonal & Holiday Decorations",
	votives: "Home & Garden > Decor > Candles > Votive Candles",
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
	// Filter for valid formats (JPEG, PNG, GIF) and limit to max 5 images
	return images.filter((img) => /\.(jpg|jpeg|png|gif)$/i.test(img)).slice(0, 5);
}

// Conversion functions
function convertLbsToKg(lbs) {
	return lbs > 0 ? (lbs * 0.453592).toFixed(2) : "Not available"; // Convert lbs to kg or set as "Not available"
}

function convertInchesToCm(inches) {
	return inches > 0 ? (inches * 2.54).toFixed(2) : "Not available"; // Convert inches to cm or set as "Not available"
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
					: "https://res.cloudinary.com/infiniteapps/image/upload/v1723694291/janat/1723694290986.png";

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
				const attribute = product.productAttributes[0];
				size = attribute.size || "";
				color = attribute.color || "unspecified";
			}

			const weight = convertLbsToKg(product.geodata?.weight || 0);
			const length = convertInchesToCm(product.geodata?.length || 0);
			const width = convertInchesToCm(product.geodata?.width || 0);
			const height = convertInchesToCm(product.geodata?.height || 0);

			// Google Item
			const googleItem = `
        <item>
          <g:id>${escapeXml(product._id.toString())}</g:id>
          <g:title><![CDATA[${escapeXml(product.productName)}]]></g:title>
          <g:description><![CDATA[${escapeXml(
						product.description.replace(/<[^>]+>/g, "")
					)}]]></g:description>
          <g:link>https://serenejannat.com/single-product/${escapeXml(
						product.slug
					)}/${escapeXml(product.category.categorySlug)}/${product._id}</g:link>
          <g:image_link>${imageLink}</g:image_link>
          ${images
						.slice(1)
						.map(
							(img) =>
								`<g:additional_image_link>${img}</g:additional_image_link>`
						)
						.join("\n")}
          <g:availability>${availability}</g:availability>
          <g:price>${finalPrice.toFixed(2)} USD</g:price>
          ${
						priceAfterDiscount < originalPrice
							? `<g:sale_price>${priceAfterDiscount.toFixed(
									2
							  )} USD</g:sale_price>`
							: ""
					}
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
          <g:shipping_weight>${weight}</g:shipping_weight>
          <g:shipping_length>${length} cm</g:shipping_length>
          <g:shipping_width>${width} cm</g:shipping_width>
          <g:shipping_height>${height} cm</g:shipping_height>
        </item>
      `;
			googleItems.push(googleItem);

			// Facebook Item
			const facebookItem = `
        <item>
          <id>${escapeXml(product._id.toString())}</id>
          <title><![CDATA[${escapeXml(product.productName)}]]></title>
          <description><![CDATA[${escapeXml(
						product.description.replace(/<[^>]+>/g, "")
					)}]]></description>
          <link>https://serenejannat.com/single-product/${escapeXml(
						product.slug
					)}/${escapeXml(product.category.categorySlug)}/${product._id}</link>
          <image_link>${imageLink}</image_link>
          <availability>${availability}</availability>
          <price>${finalPrice.toFixed(2)} USD</price>
          <brand>${escapeXml(brand)}</brand>
          <condition>${escapeXml(condition)}</condition>
          <product_type><![CDATA[${escapeXml(
						product.category.categoryName
					)}]]></product_type>
          <shipping_weight>${weight} kg</shipping_weight>
          <shipping_length>${length} cm</shipping_length>
          <shipping_width>${width} cm</shipping_width>
          <shipping_height>${height} cm</shipping_height>
        </item>
      `;
			facebookItems.push(facebookItem);
		}
	}

	// Google Feed
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

	// Facebook Feed
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
