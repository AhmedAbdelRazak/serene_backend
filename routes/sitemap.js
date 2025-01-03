const express = require("express");
const router = express.Router();
const { SitemapStream, streamToPromise } = require("sitemap");
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product model
const Product = require("../models/product");

router.get("/generate-sitemap", async (req, res) => {
	let links = [];

	// Fetch data from MongoDB
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);

	// Get current date
	const currentDate = new Date().toISOString();

	// Add static links
	const staticLinks = [
		{ url: "/", lastmod: currentDate, changefreq: "weekly", priority: 1.0 },
		{
			url: "/our-products",
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

	// Generate product URLs with images
	for (let product of products) {
		if (product.category && product.category.categoryStatus) {
			const productLink = {
				url: `/single-product/${product.slug}/${product.category.categorySlug}/${product._id}`,
				lastmod: product.updatedAt.toISOString(),
				changefreq: "weekly",
				priority: 0.8,
			};

			// Include images in sitemap
			if (product.thumbnailImage && product.thumbnailImage.length > 0) {
				productLink.img = product.thumbnailImage[0].images.map((img) => ({
					url: img.url,
					title: product.productName,
				}));
			}

			links.push(productLink);
		}
	}

	// Generate category filter URLs based on product categories
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

	// Create a stream to pass to SitemapStream
	const sitemapStream = new SitemapStream({
		hostname: "https://serenejannat.com", // Replace with your actual hostname
	});

	// Add URLs and images to the sitemap
	for (let link of links) {
		sitemapStream.write({
			url: link.url,
			lastmod: link.lastmod,
			changefreq: link.changefreq,
			priority: link.priority,
			img: link.img, // Add image data (if available)
		});
	}

	sitemapStream.end();

	// Convert the stream to a promise
	const sitemapPromise = streamToPromise(sitemapStream);

	// Wait for the stream to be flushed and collect the XML content
	sitemapPromise
		.then((sitemap) => {
			const xmlContent = sitemap.toString();
			const writeStream = createWriteStream(
				resolve(__dirname, "../../serene_frontend/public/sitemap.xml"),
				{ flags: "w" } // Set the 'w' flag to overwrite the existing file
			);
			writeStream.write(xmlContent, "utf-8");
			writeStream.end();
			writeStream.on("error", (err) => {
				console.error(err);
				res.status(500).end();
			});
			writeStream.on("finish", () => {
				console.log("Sitemap has been generated");
				res.send("Sitemap has been generated");
			});
		})
		.catch((err) => {
			console.error(err);
			res.status(500).end();
		});
});

module.exports = router;
