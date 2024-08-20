const express = require("express");
const router = express.Router();
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product model
const Product = require("../models/product");

router.get("/generate-merchant-feed", async (req, res) => {
	let items = [];

	// Fetch active products from MongoDB
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	// Generate product items for the feed
	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
			// Define attributes for product offer
			const hasVariables =
				product.productAttributes && product.productAttributes.length > 0;

			const price = hasVariables
				? product.productAttributes[0].priceAfterDiscount
				: product.priceAfterDiscount;

			const quantity = hasVariables
				? product.productAttributes.reduce(
						(acc, attr) => acc + attr.quantity,
						0
				  )
				: product.quantity;

			// Define product condition, availability, and shipping details
			const availability = quantity > 0 ? "in stock" : "out of stock";
			const condition = "new";
			const brand = "Serene Jannat"; // Replace with your brand or derive from product if available

			// Define product image link (fallback if image is not available)
			const imageLink = product.thumbnailImage[0]?.images[0]?.url || "";

			// Generate the <item> entry for the XML
			const item = `
                <item>
                    <g:id>${product._id}</g:id>
                    <g:title><![CDATA[${product.productName}]]></g:title>
                    <g:description><![CDATA[${product.description.replace(
											/<[^>]+>/g,
											""
										)}]]></g:description>
                    <g:link>https://serenejannat.com/single-product/${
											product.slug
										}/${product.category.categorySlug}/${product._id}</g:link>
                    <g:image_link>${imageLink}</g:image_link>
                    <g:availability>${availability}</g:availability>
                    <g:price>${price.toFixed(2)} USD</g:price>
                    <g:brand>${brand}</g:brand>
                    <g:condition>${condition}</g:condition>
                    <g:google_product_category><![CDATA[${
											product.googleProductCategory ||
											"Your Google Product Category"
										}]]></g:google_product_category>
                </item>
            `;
			items.push(item);
		}
	}

	// Wrap items in the RSS feed structure
	const feedContent = `
        <rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
            <channel>
                <title>Serene Jannat Products</title>
                <link>https://serenejannat.com</link>
                <description>Product feed for Serene Jannat Gift Store</description>
                ${items.join("\n")}
            </channel>
        </rss>
    `;

	// Write the XML content to a file in the public directory
	const writeStream = createWriteStream(
		resolve(__dirname, "../../serene_frontend/public/merchant-center-feed.xml"),
		{
			flags: "w",
		}
	);

	writeStream.write(feedContent, "utf-8");
	writeStream.end();

	writeStream.on("error", (err) => {
		console.error(err);
		res.status(500).end();
	});

	writeStream.on("finish", () => {
		console.log("Merchant Center feed has been generated");
		res.send("Merchant Center feed has been generated");
	});
});

module.exports = router;
