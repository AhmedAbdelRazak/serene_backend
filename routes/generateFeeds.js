const express = require("express");
const router = express.Router();
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product model
const Product = require("../models/product");

router.get("/generate-feeds", async (req, res) => {
	let googleItems = [];
	let facebookItems = [];

	// Fetch active products from MongoDB and populate the category field
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	// Generate product items for both feeds
	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
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
			const availability = quantity > 0 ? "in stock" : "out of stock";
			const condition = "new";
			const brand = "Serene Jannat"; // Replace with your brand or derive from product if available
			const imageLink = product.thumbnailImage[0]?.images[0]?.url || "";
			const googleProductCategory =
				product.category.categoryName || "Serene Jannat";
			const productUrl = `https://serenejannat.com/single-product/${product.slug}/${product.category.categorySlug}/${product._id}`;
			const categoryName = product.category.categoryName; // Properly populated categoryName

			// Generate the <item> entry for Google XML
			const googleItem = `
                <item>
                    <g:id>${product._id}</g:id>
                    <g:title><![CDATA[${product.productName}]]></g:title>
                    <g:description><![CDATA[${product.description.replace(
											/<[^>]+>/g,
											""
										)}]]></g:description>
                    <g:link>${productUrl}</g:link>
                    <g:image_link>${imageLink}</g:image_link>
                    <g:availability>${availability}</g:availability>
                    <g:price>${price.toFixed(2)} USD</g:price>
                    <g:brand>${brand}</g:brand>
                    <g:condition>${condition}</g:condition>
                    <g:google_product_category>${googleProductCategory}</g:google_product_category>
                    <g:product_type><![CDATA[${categoryName}]]></g:product_type>
                    <g:identifier_exists>false</g:identifier_exists> <!-- Explicitly tell Google no GTIN/MPN -->
                    <g:shipping>
                        <g:country>US</g:country>
                        <g:service>Standard</g:service>
                        <g:price>5.00 USD</g:price>
                    </g:shipping>
                    <g:shipping_weight>0.5 kg</g:shipping_weight>
                    <g:shipping_length>10 cm</g:shipping_length>
                    <g:shipping_width>10 cm</g:shipping_width>
                    <g:shipping_height>15 cm</g:shipping_height>
                </item>
            `;
			googleItems.push(googleItem);

			// Reviews and ratings (from ShopPageHelmet) - Keep these only for Facebook
			const ratingValue =
				product.ratings.length > 0
					? (
							product.ratings.reduce((acc, rating) => acc + rating.star, 0) /
							product.ratings.length
					  ).toFixed(1)
					: "5.0";
			const reviewCount =
				product.ratings.length > 0 ? product.ratings.length : 1;
			const reviews =
				product.comments.length > 0
					? product.comments
							.map(
								(comment) => `
                    <review>
                        <reviewer>
                            <name>${escapeJsonString(
															comment.postedBy
																? comment.postedBy.name
																: "Anonymous"
														)}</name>
                        </reviewer>
                        <reviewBody>${escapeJsonString(
													comment.text
												)}</reviewBody>
                        <reviewRating>
                            <ratingValue>${comment.rating || 5}</ratingValue>
                            <bestRating>5</bestRating>
                            <worstRating>1</worstRating>
                        </reviewRating>
                        <datePublished>${new Date(
													comment.created
												).toISOString()}</datePublished>
                    </review>
                `
							)
							.join("")
					: `
                    <review>
                        <reviewer>
                            <name>Anonymous</name>
                        </reviewer>
                        <reviewBody>Excellent product!</reviewBody>
                        <reviewRating>
                            <ratingValue>5</ratingValue>
                            <bestRating>5</bestRating>
                            <worstRating>1</worstRating>
                        </reviewRating>
                        <datePublished>${new Date().toISOString()}</datePublished>
                    </review>
                `;

			// Generate the <item> entry for Facebook XML (no g: prefix)
			const facebookItem = `
                <item>
                    <id>${product._id}</id>
                    <title><![CDATA[${product.productName}]]></title>
                    <description><![CDATA[${product.description.replace(
											/<[^>]+>/g,
											""
										)}]]></description>
                    <link>${productUrl}</link>
                    <image_link>${imageLink}</image_link>
                    <availability>${availability}</availability>
                    <price>${price.toFixed(2)} USD</price>
                    <brand>${brand}</brand>
                    <condition>${condition}</condition>
                    <product_type><![CDATA[${categoryName}]]></product_type>
                    <identifier_exists>false</identifier_exists> <!-- Explicitly tell Facebook no GTIN/MPN -->
                    <shipping>
                        <country>US</country>
                        <service>Standard</service>
                        <price>5.00 USD</price>
                    </shipping>
                    <shipping_weight>0.5 kg</shipping_weight>
                    <shipping_length>10 cm</shipping_length>
                    <shipping_width>10 cm</shipping_width>
                    <shipping_height>15 cm</shipping_height>
                    <ratingValue>${ratingValue}</ratingValue>
                    <reviewCount>${reviewCount}</reviewCount>
                    ${reviews}
                </item>
            `;
			facebookItems.push(facebookItem);
		}
	}

	// Wrap items in the RSS feed structure for Google
	const googleFeedContent = `
        <rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
            <channel>
                <title>Serene Jannat Products</title>
                <link>https://serenejannat.com</link>
                <description>Product feed for Serene Jannat Gift Store</description>
                ${googleItems.join("\n")}
            </channel>
        </rss>
    `;

	// Write the Google XML content to a file in the public directory
	const googleWriteStream = createWriteStream(
		resolve(__dirname, "../../serene_frontend/public/merchant-center-feed.xml"),
		{ flags: "w" }
	);

	googleWriteStream.write(googleFeedContent, "utf-8");
	googleWriteStream.end();

	googleWriteStream.on("error", (err) => {
		console.error(err);
		res.status(500).end();
	});

	googleWriteStream.on("finish", () => {
		console.log("Google Merchant Center feed has been generated");
	});

	// Wrap items in the RSS feed structure for Facebook
	const facebookFeedContent = `
        <rss version="2.0">
            <channel>
                <title>Serene Jannat Products</title>
                <link>https://serenejannat.com</link>
                <description>Product feed for Serene Jannat Gift Store</description>
                ${facebookItems.join("\n")}
            </channel>
        </rss>
    `;

	// Write the Facebook XML content to a file in the public directory
	const facebookWriteStream = createWriteStream(
		resolve(__dirname, "../../serene_frontend/public/facebook-feed.xml"),
		{ flags: "w" }
	);

	facebookWriteStream.write(facebookFeedContent, "utf-8");
	facebookWriteStream.end();

	facebookWriteStream.on("error", (err) => {
		console.error(err);
		res.status(500).end();
	});

	facebookWriteStream.on("finish", () => {
		console.log("Facebook feed has been generated");
		res.send("Feeds have been generated successfully");
	});
});

module.exports = router;
