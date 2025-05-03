const express = require("express");
const router = express.Router();
const { SitemapStream, streamToPromise } = require("sitemap");
const { createWriteStream } = require("fs");
const { resolve } = require("path");
require("dotenv").config();

const Product = require("../models/product");

// ------------------------------
// 1) Existing parse fallback
// ------------------------------
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

// ------------------------------
// 2) Build “option -> value” map
// ------------------------------
function buildOptionValueMap(podDetails) {
	const map = {};
	(podDetails.options || []).forEach((option) => {
		(option.values || []).forEach((val) => {
			map[val.id] = {
				type: option.type, // e.g. "color", "size", "scent"
				title: val.title,
			};
		});
	});
	return map;
}

// ------------------------------
// 3) Lookup color/size from map
// ------------------------------
function getColorSizeFromPrintifyMap(variant, optionValueMap) {
	let colorVal = null;
	let sizeVal = null;

	for (const valId of variant.options || []) {
		const foundInfo = optionValueMap[valId];
		if (!foundInfo) continue;
		if (foundInfo.type === "color" && !colorVal) {
			colorVal = foundInfo.title;
		} else if (foundInfo.type === "size" && !sizeVal) {
			sizeVal = foundInfo.title;
		}
		// If you have "scent" or other types, add them as needed
	}

	return { colorVal, sizeVal };
}

// ------------------------------
// 4) Other existing helpers
// ------------------------------
function buildPODLink(productId, color, size) {
	let url = `/custom-gifts/${productId}`;
	const params = [];
	if (color && color !== "Unspecified") {
		params.push(`color=${encodeURIComponent(color)}`);
	}
	if (size && size !== "Unspecified") {
		params.push(`size=${encodeURIComponent(size)}`);
	}
	if (params.length) {
		url += `?${params.join("&")}`;
	}
	return url;
}

function gatherPODVariantImages(product, variantSKU) {
	let matchedImages = [];
	if (Array.isArray(product.productAttributes)) {
		const foundAttr = product.productAttributes.find(
			(attr) => attr.SubSKU === variantSKU
		);
		if (foundAttr && Array.isArray(foundAttr.productImages)) {
			matchedImages = foundAttr.productImages.map((img) => img.url);
		}
	}
	if (!matchedImages.length) {
		matchedImages = gatherProductImages(product);
	}
	return matchedImages;
}

function gatherProductImages(product) {
	const imagesSet = new Set();
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
	return Array.from(imagesSet);
}

function buildNonPODLink(product) {
	return `/single-product/${product.slug}/${product.category.categorySlug}/${product._id}`;
}

// ------------------------------
// 5) MAIN ROUTE
// ------------------------------
router.get("/generate-sitemap", async (req, res) => {
	let links = [];

	const products = await Product.find({ activeProduct: true }).populate(
		"category"
	);
	const currentDate = new Date().toISOString();

	// Add your static links
	const staticLinks = [
		{ url: "/", lastmod: currentDate, changefreq: "weekly", priority: 1.0 },
		{
			url: "/our-products",
			lastmod: currentDate,
			changefreq: "weekly",
			priority: 0.8,
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
			changefreq: "yearly",
			priority: 0.6,
		},
		{
			url: "/sellingagent/signup",
			lastmod: currentDate,
			changefreq: "yearly",
			priority: 0.5,
		},
	];
	links.push(...staticLinks);

	// ------------------------------
	// Generate product URLs
	// ------------------------------
	for (let product of products) {
		if (!product.category || !product.category.categoryStatus) {
			continue;
		}

		const lastModified = product.updatedAt
			? product.updatedAt.toISOString()
			: currentDate;

		const isPOD =
			product.printifyProductDetails?.POD === true &&
			product.printifyProductDetails?.id;

		if (isPOD) {
			const variants = product.printifyProductDetails.variants || [];
			// Build the Printify "option -> value" map
			const optionValueMap = buildOptionValueMap(
				product.printifyProductDetails
			);

			if (variants.length > 1) {
				// MULTI-VARIANT
				variants.forEach((variant, index) => {
					// 1) Try to get color/size from Printify map
					let { colorVal, sizeVal } = getColorSizeFromPrintifyMap(
						variant,
						optionValueMap
					);

					// 2) If nothing found in map, fallback to parse from variant.title
					if (!colorVal && !sizeVal) {
						const fallback = parseSizeColorFromVariantTitle(variant.title);
						colorVal = fallback.variantColor;
						sizeVal = fallback.variantSize;
					}

					// 3) Build link
					const productUrl = buildPODLink(product._id, colorVal, sizeVal);

					// 4) Gather images
					const imagesArr = gatherPODVariantImages(product, variant.sku);
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
				});
			} else if (variants.length === 1) {
				// SINGLE-VARIANT POD
				const singleVar = variants[0];

				// Attempt to get color/size
				let { colorVal, sizeVal } = getColorSizeFromPrintifyMap(
					singleVar,
					optionValueMap
				);
				if (!colorVal && !sizeVal) {
					const fallback = parseSizeColorFromVariantTitle(singleVar.title);
					colorVal = fallback.variantColor;
					sizeVal = fallback.variantSize;
				}

				const productUrl = buildPODLink(product._id, colorVal, sizeVal);
				const imagesArr = gatherPODVariantImages(product, singleVar.sku);
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
				// POD but no variants => fallback
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
			// NON-POD
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

	// ------------------------------
	// Category filter URLs
	// ------------------------------
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

	// ------------------------------
	// Build the actual sitemap
	// ------------------------------
	const sitemapStream = new SitemapStream({
		hostname: "https://serenejannat.com",
	});

	for (let link of links) {
		sitemapStream.write({
			url: link.url,
			lastmod: link.lastmod,
			changefreq: link.changefreq,
			priority: link.priority,
			img: link.img,
		});
	}

	sitemapStream.end();

	try {
		const sitemapBuffer = await streamToPromise(sitemapStream);
		const xmlContent = sitemapBuffer.toString();
		const writeStream = createWriteStream(
			resolve(__dirname, "../../serene_frontend/public/sitemap.xml"),
			{ flags: "w" }
		);
		writeStream.write(xmlContent, "utf-8");
		writeStream.end();

		writeStream.on("error", (err) => {
			console.error("Error writing sitemap:", err);
			return res.status(500).send("Error writing sitemap.");
		});
		writeStream.on("finish", () => {
			console.log("Sitemap has been generated successfully.");
			res.send("Sitemap has been generated successfully.");
		});
	} catch (err) {
		console.error("Error generating sitemap:", err);
		res.status(500).send("Error generating sitemap.");
	}
});

module.exports = router;
