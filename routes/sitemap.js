const express = require("express");
const router = express.Router();
const { SitemapStream, streamToPromise } = require("sitemap");
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

// Import the Product model
const Product = require("../models/product");

/**
 * Parse color/size from a typical Printify "variant.title" => "Light Blue / 2XL"
 */
function parseSizeColorFromVariantTitle(title) {
	if (!title || typeof title !== "string") {
		return { variantColor: "Unspecified", variantSize: "Unspecified" };
	}
	const parts = title.split(" / ");
	return {
		variantColor: parts[0] ? parts[0].trim() : "Unspecified",
		variantSize: parts[1] ? parts[1].trim() : "Unspecified",
	};
}

/**
 * Build a single link for a POD item with optional ?color= & ?size= in query
 */
function buildPODLink(productId, color, size) {
	let url = `/custom-gifts/${productId}`;
	const params = [];
	if (color && color !== "Unspecified")
		params.push(`color=${encodeURIComponent(color)}`);
	if (size && size !== "Unspecified")
		params.push(`size=${encodeURIComponent(size)}`);
	if (params.length) {
		url += `?${params.join("&")}`;
	}
	return url;
}

/**
 * For multi-variant POD items, gather each variant's images from productAttributes.
 * If none found, fallback to main product images.
 */
function gatherPODVariantImages(product, variantSKU) {
	// Attempt to match productAttributes => subSKU
	let matchedImages = [];

	if (Array.isArray(product.productAttributes)) {
		const foundAttr = product.productAttributes.find(
			(attr) => attr.SubSKU === variantSKU
		);
		if (foundAttr && Array.isArray(foundAttr.productImages)) {
			matchedImages = foundAttr.productImages.map((img) => img.url);
		}
	}

	// If no matchedImages, fallback to gatherProductImages
	if (!matchedImages.length) {
		matchedImages = gatherProductImages(product);
	}
	return matchedImages;
}

/**
 * Helper function: gather all relevant images for a non-variant or fallback scenario
 */
function gatherProductImages(product) {
	const imagesSet = new Set();

	// If productAttributes exist, gather all variant images
	if (product.productAttributes && product.productAttributes.length > 0) {
		for (const attr of product.productAttributes) {
			if (attr.productImages && attr.productImages.length > 0) {
				for (const imgObj of attr.productImages) {
					if (imgObj.url) {
						imagesSet.add(imgObj.url);
					}
				}
			}
		}
	}

	// Also gather main thumbnail
	if (
		product.thumbnailImage &&
		Array.isArray(product.thumbnailImage) &&
		product.thumbnailImage.length > 0 &&
		Array.isArray(product.thumbnailImage[0].images)
	) {
		for (const thumb of product.thumbnailImage[0].images) {
			if (thumb.url) {
				imagesSet.add(thumb.url);
			}
		}
	}

	const imagesArray = [];
	for (const imgUrl of imagesSet) {
		imagesArray.push(imgUrl);
	}
	return imagesArray;
}

/**
 * For a non-POD product => single link: /single-product/:slug/:categorySlug/:id
 */
function buildNonPODLink(product) {
	return `/single-product/${product.slug}/${product.category.categorySlug}/${product._id}`;
}

router.get("/generate-sitemap", async (req, res) => {
	let links = [];

	// Fetch data from MongoDB
	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);
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

	// -----------------------------------
	// Generate product URLs (with POD logic)
	// -----------------------------------
	for (let product of products) {
		if (!product.category || !product.category.categoryStatus) {
			continue; // skip inactive category
		}

		const lastModified = product.updatedAt
			? product.updatedAt.toISOString()
			: currentDate;

		const isPOD =
			product.printifyProductDetails?.POD === true &&
			product.printifyProductDetails?.id;

		if (isPOD) {
			// Check if multiple variants or single
			const variants = product.printifyProductDetails.variants || [];

			if (variants.length > 1) {
				// MULTI-VARIANT => Create multiple links
				variants.forEach((variant, index) => {
					const { variantColor, variantSize } = parseSizeColorFromVariantTitle(
						variant.title
					);

					// Build link => /custom-gifts/:id?color=xx&size=yy
					const productUrl = buildPODLink(
						product._id,
						variantColor,
						variantSize
					);

					// Gather images for this variant
					const imagesArr = gatherPODVariantImages(product, variant.sku);

					// Convert images to sitemap's "img" array
					const sitemapImages = imagesArr.map((u) => ({
						url: u,
						title: product.productName, // or variant.title
					}));

					links.push({
						url: productUrl,
						lastmod: lastModified,
						changefreq: "weekly",
						priority: 0.8,
						img: sitemapImages,
					});
				});
			} else if (variants.length === 1) {
				// SINGLE-VARIANT POD
				const productUrl = buildPODLink(product._id);

				// Gather images from that single variant or fallback
				const singleVarSKU = variants[0].sku;
				const imagesArr = gatherPODVariantImages(product, singleVarSKU);

				const sitemapImages = imagesArr.map((u) => ({
					url: u,
					title: product.productName,
				}));

				links.push({
					url: productUrl,
					lastmod: lastModified,
					changefreq: "weekly",
					priority: 0.8,
					img: sitemapImages,
				});
			} else {
				// POD but no variants array => fallback
				const productUrl = `/custom-gifts/${product._id}`;
				const imagesArr = gatherProductImages(product);
				const sitemapImages = imagesArr.map((u) => ({
					url: u,
					title: product.productName,
				}));

				links.push({
					url: productUrl,
					lastmod: lastModified,
					changefreq: "weekly",
					priority: 0.8,
					img: sitemapImages,
				});
			}
		} else {
			// Non-POD => single standard link
			const productUrl = buildNonPODLink(product);
			const imagesArr = gatherProductImages(product);
			const sitemapImages = imagesArr.map((u) => ({
				url: u,
				title: product.productName,
			}));

			links.push({
				url: productUrl,
				lastmod: lastModified,
				changefreq: "weekly",
				priority: 0.8,
				img: sitemapImages,
			});
		}
	}

	// -------------------------------------------------------
	// Add category filter URLs
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
		hostname: "https://serenejannat.com", // your domain
	});

	for (let link of links) {
		sitemapStream.write({
			url: link.url,
			lastmod: link.lastmod,
			changefreq: link.changefreq,
			priority: link.priority,
			img: link.img, // pass images for that URL
		});
	}

	sitemapStream.end();

	const sitemapPromise = streamToPromise(sitemapStream);

	sitemapPromise
		.then((sitemap) => {
			const xmlContent = sitemap.toString();
			const writeStream = createWriteStream(
				resolve(__dirname, "../../serene_frontend/public/sitemap.xml"),
				{ flags: "w" }
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
