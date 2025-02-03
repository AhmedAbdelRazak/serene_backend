const express = require("express");
const router = express.Router();
const { SitemapStream, streamToPromise } = require("sitemap");
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product model
const Product = require("../models/product");

/**
 * Helper function: determines the sitemap URL for a product.
 * If it's a POD item, use /custom-gifts/:id
 * Otherwise, use /single-product/:slug/:categorySlug/:id
 */
function getProductLink(product) {
	// If the product is POD (Printify) => link to /custom-gifts/<_id>
	if (
		product.printifyProductDetails?.POD === true &&
		product.printifyProductDetails?.id
	) {
		return `/custom-gifts/${product._id}`;
	}
	// Otherwise => normal single product route
	return `/single-product/${product.slug}/${product.category.categorySlug}/${product._id}`;
}

/**
 * Helper function: gather all relevant images for a product.
 * - If product has variant images, collect them.
 * - Else fallback to thumbnail images.
 * - Return an array of objects { url, title } for the sitemap.
 */
function gatherProductImages(product) {
	const imagesSet = new Set();
	const imagesArray = [];

	// 1) If productAttributes exist, gather variant images:
	if (product.productAttributes && product.productAttributes.length > 0) {
		for (const attribute of product.productAttributes) {
			if (attribute.productImages && attribute.productImages.length > 0) {
				for (const imgObj of attribute.productImages) {
					if (imgObj.url) {
						imagesSet.add(imgObj.url);
					}
				}
			}
		}
	}

	// 2) If no variant images (or we still want to include main thumbnail), fallback:
	if (product.thumbnailImage && product.thumbnailImage.length > 0) {
		for (const thumb of product.thumbnailImage[0].images) {
			if (thumb.url) {
				imagesSet.add(thumb.url);
			}
		}
	}

	// 3) Convert set to array of { url, title }
	for (const imgUrl of imagesSet) {
		imagesArray.push({
			url: imgUrl,
			title: product.productName, // You could also add description, or alt text if available
		});
	}

	return imagesArray;
}

router.get("/generate-sitemap", async (req, res) => {
	let links = [];

	// Fetch data from MongoDB
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	// Get current date as fallback
	const currentDate = new Date().toISOString();

	// ----------------
	// Add static links
	// ----------------
	const staticLinks = [
		{ url: "/", lastmod: currentDate, changefreq: "weekly", priority: 1.0 },
		{
			url: "/our-products",
			lastmod: currentDate,
			changefreq: "weekly",
			priority: 0.9,
		},
		{
			url: "/custom-gifts",
			lastmod: currentDate,
			changefreq: "weekly",
			priority: 0.9,
		},
		{
			url: "/about",
			lastmod: currentDate,
			changefreq: "yearly",
			priority: 0.5,
		},
		{
			url: "/contact",
			lastmod: currentDate,
			changefreq: "yearly",
			priority: 0.5,
		},
		{
			url: "/signup",
			lastmod: currentDate,
			changefreq: "monthly",
			priority: 1.0,
		},
	];

	links.push(...staticLinks);

	// -------------------------------------------------------
	// Generate product URLs (with POD logic and images)
	// -------------------------------------------------------
	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
			const productUrl = getProductLink(product);

			// If product.updatedAt is not set, we fallback to current date
			const lastModified = product.updatedAt
				? product.updatedAt.toISOString()
				: currentDate;

			// Gather images
			const productImages = gatherProductImages(product);

			const productLink = {
				url: productUrl,
				lastmod: lastModified,
				changefreq: "weekly",
				priority: 0.8,
				img: productImages, // Include images in the sitemap
			};

			links.push(productLink);
		}
	}

	// -------------------------------------------------------
	// Generate category filter URLs based on product categories
	// -------------------------------------------------------
	const categoryUrls = new Set();
	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
			categoryUrls.add(
				`/our-products?category=${product.category.categorySlug}`
			);
		}
	}

	for (let url of categoryUrls) {
		links.push({
			url,
			lastmod: currentDate,
			changefreq: "weekly",
			priority: 0.9,
		});
	}

	// -----------------------------
	// Build the sitemap XML
	// -----------------------------
	const sitemapStream = new SitemapStream({
		hostname: "https://serenejannat.com", // Replace with your actual hostname
	});

	// Push each link
	for (let link of links) {
		sitemapStream.write({
			url: link.url,
			lastmod: link.lastmod,
			changefreq: link.changefreq,
			priority: link.priority,
			img: link.img, // include image data if available
		});
	}

	sitemapStream.end();

	// Convert the stream to a promise
	const sitemapPromise = streamToPromise(sitemapStream);

	// Wait for the stream to finish and write to file
	sitemapPromise
		.then((sitemap) => {
			const xmlContent = sitemap.toString();
			const writeStream = createWriteStream(
				resolve(__dirname, "../../serene_frontend/public/sitemap.xml"),
				{ flags: "w" } // Overwrite the existing file
			);
			writeStream.write(xmlContent, "utf-8");
			writeStream.end();
			writeStream.on("error", (err) => {
				console.error("Error writing sitemap:", err);
				res.status(500).send("Error writing sitemap.");
			});
			writeStream.on("finish", () => {
				console.log("Sitemap has been generated successfully.");
				res.send("Sitemap has been generated successfully.");
			});
		})
		.catch((err) => {
			console.error("Error generating sitemap:", err);
			res.status(500).send("Error generating sitemap.");
		});
});

module.exports = router;
