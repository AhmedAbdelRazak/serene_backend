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
	outdoors: "Home & Garden > Lawn & Garden",
	"t shirts": "Apparel & Accessories > Clothing > Shirts & Tops > T-Shirts",
	seasonal: "Home & Garden > Holiday & Seasonal Decor",
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
	// Filter for valid formats (JPEG, PNG, GIF)
	return images.filter((img) => /\.(jpg|jpeg|png|gif)$/i.test(img));
}

// Conversion functions
function convertLbsToKg(lbs) {
	return (lbs * 0.453592).toFixed(2); // Convert lbs to kg
}

function convertInchesToCm(inches) {
	return (inches * 2.54).toFixed(2); // Convert inches to cm
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
			const hasVariables =
				product.productAttributes && product.productAttributes.length > 0;

			// Price and availability logic
			const originalPrice = hasVariables
				? product.productAttributes[0].price
				: product.price;
			const priceAfterDiscount = hasVariables
				? product.productAttributes[0].priceAfterDiscount
				: product.priceAfterDiscount;
			const finalPrice =
				priceAfterDiscount < originalPrice ? priceAfterDiscount : originalPrice;

			const quantity = hasVariables
				? product.productAttributes.reduce(
						(acc, attr) => acc + attr.quantity,
						0
				  )
				: product.quantity;

			const availability = quantity > 0 ? "in stock" : "out of stock";
			const condition = "new";
			const brand = "Serene Jannat";
			const images = generateImageLinks(product);
			const imageLink = images.length > 0 ? images[0] : "";

			// Google Product Category
			const googleProductCategory = escapeXml(
				categoryMapping[product.category.categoryName.toLowerCase()] ||
					"Home & Garden"
			);

			// Additional Attributes for Variants
			let size = "";
			let color = "unspecified"; // Default to unspecified if missing
			let ageGroup = "adult"; // Default to adult
			if (hasVariables) {
				const attribute = product.productAttributes[0];
				size = attribute.size || "";
				color =
					attribute.color && attribute.color.startsWith("#")
						? "unspecified"
						: attribute.color || "unspecified";
				ageGroup = attribute.ageGroup || "adult";
			}

			// Shipping Dimensions
			const weight = convertLbsToKg(product.geodata.weight || 0);
			const length = convertInchesToCm(product.geodata.length || 0);
			const width = convertInchesToCm(product.geodata.width || 0);
			const height = convertInchesToCm(product.geodata.height || 0);

			// Ensure valid shipping dimensions
			const validHeight = isNaN(height) ? "0.00" : height;
			const validLength = isNaN(length) ? "0.00" : length;
			const validWidth = isNaN(width) ? "0.00" : width;

			// Generate Google Item XML
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
                    <g:identifier_exists>false</g:identifier_exists>
                    <g:shipping_weight>${weight} kg</g:shipping_weight>
                    <g:shipping_length>${validLength} cm</g:shipping_length>
                    <g:shipping_width>${validWidth} cm</g:shipping_width>
                    <g:shipping_height>${validHeight} cm</g:shipping_height>
                    <g:tax>
                        <g:country>US</g:country>
                        <g:rate>0.00</g:rate>
                        <g:tax_ship>true</g:tax_ship>
                    </g:tax>
                </item>
            `;
			googleItems.push(googleItem);

			// Generate Facebook Item XML
			const facebookItem = `
                <item>
                    <id>${escapeXml(product._id.toString())}</id>
                    <title><![CDATA[${escapeXml(product.productName)}]]></title>
                    <description><![CDATA[${escapeXml(
											product.description.replace(/<[^>]+>/g, "")
										)}]]></description>
                    <link>https://serenejannat.com/single-product/${escapeXml(
											product.slug
										)}/${escapeXml(product.category.categorySlug)}/${
				product._id
			}</link>
                    <image_link>${imageLink}</image_link>
                    <availability>${availability}</availability>
                    <price>${finalPrice.toFixed(2)} USD</price>
                    <brand>${escapeXml(brand)}</brand>
                    <condition>${escapeXml(condition)}</condition>
                    <product_type><![CDATA[${escapeXml(
											product.category.categoryName
										)}]]></product_type>
                    <shipping_weight>${weight} kg</shipping_weight>
                    <shipping_length>${validLength} cm</shipping_length>
                    <shipping_width>${validWidth} cm</shipping_width>
                    <shipping_height>${validHeight} cm</shipping_height>
                </item>
            `;
			facebookItems.push(facebookItem);
		}
	}

	// Generate Google Feed XML
	const googleFeedContent = `
        <rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
            <channel>
                <title>Serene Jannat Products</title>
                <link>https://serenejannat.com</link>
                <description>High-quality product feed for Google Merchant Center</description>
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

	// Generate Facebook Feed XML
	const facebookFeedContent = `
        <rss version="2.0">
            <channel>
                <title>Serene Jannat Products</title>
                <link>https://serenejannat.com</link>
                <description>High-quality product feed for Facebook</description>
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

	googleWriteStream.on("finish", () => {
		console.log("Google Merchant Center feed generated successfully");
	});
	facebookWriteStream.on("finish", () => {
		console.log("Facebook feed generated successfully");
		res.send("Feeds for Google and Facebook generated successfully.");
	});
});

module.exports = router;
