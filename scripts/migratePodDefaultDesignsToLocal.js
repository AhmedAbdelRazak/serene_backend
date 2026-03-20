#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const axios = require("axios");
const mongoose = require("mongoose");

const Product = require("../models/product");

const IMAGE_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".webp",
	".gif",
	".bmp",
	".tif",
	".tiff",
]);

const CONTENT_TYPE_TO_EXT = {
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/bmp": ".bmp",
	"image/tiff": ".tiff",
	"image/svg+xml": ".svg",
};

function parseArgs(argv = []) {
	const args = {
		dryRun: false,
		overwrite: false,
		assetSubdir: "serene_janat/pod_default_designs",
		filterMode: "pod-with-default-designs",
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			args.dryRun = true;
			continue;
		}
		if (arg === "--overwrite") {
			args.overwrite = true;
			continue;
		}
		if (!arg.startsWith("--")) continue;

		const key = arg.slice(2);
		const value = argv[i + 1];
		if (value == null || value.startsWith("--")) {
			throw new Error(`Missing value for argument: ${arg}`);
		}
		args[key] = value;
		i += 1;
	}

	return args;
}

function usage() {
	return [
		"Usage:",
		"  node scripts/migratePodDefaultDesignsToLocal.js \\",
		"    --assetRoot /var/www/serenejannat/assets \\",
		"    --publicBaseUrl https://serenejannat.com/assets \\",
		"    [--assetSubdir serene_janat/pod_default_designs] \\",
		"    [--productId 67b7fb903d0cd90c4fc410d6] \\",
		"    [--storeId 67ef147140130b857c44ba75] \\",
		"    [--limit 10] [--dry-run] [--overwrite]",
		"",
		"Notes:",
		"  - This script only migrates productAttributes[].defaultDesigns[].defaultDesignImages[].",
		"  - For local delivery to work in the storefront, migrated images are saved with:",
		"      url       = local /assets URL",
		'      public_id = ""',
	].join("\n");
}

function ensureTrailingSlashRemoved(value = "") {
	return `${value || ""}`.trim().replace(/[\\/]+$/, "");
}

function normalizePublicBaseUrl(value = "") {
	return ensureTrailingSlashRemoved(value).replace(/\/assets$/i, "/assets");
}

function sanitizeSegment(value = "") {
	return `${value || ""}`
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function toPosixPath(value = "") {
	return `${value || ""}`.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function normalizeOccasion(value = "") {
	return sanitizeSegment(`${value || ""}`.toLowerCase()) || "occasion";
}

function isLocalUrl(url = "", publicBaseUrl = "") {
	const safeUrl = `${url || ""}`.trim();
	const safeBase = ensureTrailingSlashRemoved(publicBaseUrl);
	return Boolean(safeUrl && safeBase && safeUrl.startsWith(`${safeBase}/`));
}

function stripQueryAndHash(url = "") {
	return `${url || ""}`.split("#")[0].split("?")[0];
}

function getExtensionFromUrl(url = "") {
	try {
		const pathname = new URL(url).pathname;
		const ext = path.posix.extname(pathname).toLowerCase();
		return IMAGE_EXTENSIONS.has(ext) ? ext : "";
	} catch {
		return "";
	}
}

function getExtensionFromContentType(contentType = "") {
	const normalized = `${contentType || ""}`.split(";")[0].trim().toLowerCase();
	return CONTENT_TYPE_TO_EXT[normalized] || "";
}

function getBasenameWithoutExtension(value = "") {
	const normalized = `${value || ""}`.trim().replace(/^\/+|\/+$/g, "");
	if (!normalized) return "";
	const base = normalized.split("/").pop() || "";
	return base.replace(/\.[a-z0-9]+$/i, "");
}

function buildCloudinaryUrlFromPublicId(publicId = "") {
	const normalized = `${publicId || ""}`.trim().replace(/^\/+/, "");
	return normalized
		? `https://res.cloudinary.com/infiniteapps/image/upload/${normalized}`
		: "";
}

function resolveSourceUrl(image = {}) {
	if (!image || typeof image !== "object") return "";
	return (
		`${image.cloudinary_url || image.cloudinaryUrl || image.url || image.src || ""}`.trim() ||
		buildCloudinaryUrlFromPublicId(
			image.cloudinary_public_id ||
				image.cloudinaryPublicId ||
				image.public_id ||
				image.publicId ||
				"",
		)
	);
}

function buildTargetFileName({
	image = {},
	sourceUrl = "",
	productId = "",
	attrIndex = 0,
	designIndex = 0,
	imageIndex = 0,
	occasion = "",
	contentType = "",
}) {
	const candidates = [
		getBasenameWithoutExtension(
			image.public_id ||
				image.publicId ||
				image.cloudinary_public_id ||
				image.cloudinaryPublicId ||
				"",
		),
		getBasenameWithoutExtension(stripQueryAndHash(sourceUrl)),
		`${productId || "product"}-attr${attrIndex + 1}-${normalizeOccasion(
			occasion,
		)}-${designIndex + 1}-${imageIndex + 1}`,
	]
		.map(sanitizeSegment)
		.filter(Boolean);

	const baseName = candidates[0];
	const ext =
		getExtensionFromUrl(sourceUrl) ||
		getExtensionFromContentType(contentType) ||
		".jpg";
	return `${baseName}${ext}`;
}

async function ensureDir(dirPath) {
	await fs.promises.mkdir(dirPath, { recursive: true });
}

async function downloadFile(url, destinationPath, overwrite = false) {
	if (!overwrite && fs.existsSync(destinationPath)) {
		return {
			skippedDownload: true,
			contentType: "",
			bytesWritten: fs.statSync(destinationPath).size,
		};
	}

	const response = await axios.get(url, {
		responseType: "stream",
		timeout: 60000,
		maxRedirects: 5,
	});

	await ensureDir(path.dirname(destinationPath));

	await new Promise((resolve, reject) => {
		const writer = fs.createWriteStream(destinationPath);
		response.data.pipe(writer);
		writer.on("finish", resolve);
		writer.on("error", reject);
	});

	const stats = await fs.promises.stat(destinationPath);
	return {
		skippedDownload: false,
		contentType: response.headers["content-type"] || "",
		bytesWritten: stats.size,
	};
}

function buildMongoFilter(args) {
	const filter = {
		isPrintifyProduct: true,
		"productAttributes.defaultDesigns.0": { $exists: true },
	};

	if (args.productId) {
		const ids = `${args.productId}`
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean)
			.map((id) => new mongoose.Types.ObjectId(id));
		filter._id = ids.length === 1 ? ids[0] : { $in: ids };
	}

	if (args.storeId) {
		filter.store = new mongoose.Types.ObjectId(`${args.storeId}`.trim());
	}

	return filter;
}

function cloneDefaultDesignsForBackup(product = {}) {
	return (
		Array.isArray(product.productAttributes) ? product.productAttributes : []
	).map((attribute) => ({
		PK: attribute?.PK || "",
		size: attribute?.size || "",
		color: attribute?.color || "",
		defaultDesigns: Array.isArray(attribute?.defaultDesigns)
			? attribute.defaultDesigns.map((entry) => ({
					occassion: entry?.occassion || entry?.occasion || "",
					defaultDesignImages: Array.isArray(entry?.defaultDesignImages)
						? entry.defaultDesignImages.map((image) => ({
								url: image?.url || "",
								public_id: image?.public_id || "",
								cloudinary_url: image?.cloudinary_url || "",
								cloudinary_public_id: image?.cloudinary_public_id || "",
							}))
						: [],
				}))
			: [],
	}));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const assetRoot = ensureTrailingSlashRemoved(args.assetRoot || "");
	const publicBaseUrl = normalizePublicBaseUrl(args.publicBaseUrl || "");
	const assetSubdir = toPosixPath(
		args.assetSubdir || "serene_janat/pod_default_designs",
	);
	const limit = Number(args.limit || 0);

	if (!process.env.DATABASE) {
		throw new Error("DATABASE is not set in the environment.");
	}
	if (!assetRoot) {
		throw new Error("Missing required argument: --assetRoot");
	}
	if (!publicBaseUrl) {
		throw new Error("Missing required argument: --publicBaseUrl");
	}

	const backupFile =
		args.backupFile ||
		path.resolve(
			process.cwd(),
			`pod-default-designs-backup-${new Date()
				.toISOString()
				.replace(/[:.]/g, "-")}.json`,
		);

	console.log("Configuration:", {
		dryRun: args.dryRun,
		overwrite: args.overwrite,
		assetRoot,
		assetSubdir,
		publicBaseUrl,
		backupFile,
		productId: args.productId || null,
		storeId: args.storeId || null,
		limit: limit || null,
	});

	await mongoose.connect(process.env.DATABASE);

	const filter = buildMongoFilter(args);
	let query = Product.find(filter).sort({ updatedAt: -1 });
	if (limit > 0) {
		query = query.limit(limit);
	}
	const products = await query.exec();

	console.log(`Found ${products.length} product(s) to inspect.`);

	const backup = [];
	const summary = {
		productsScanned: products.length,
		productsChanged: 0,
		productsSkipped: 0,
		imagesUpdated: 0,
		imagesAlreadyLocal: 0,
		downloadsCompleted: 0,
		downloadsSkipped: 0,
		failures: 0,
	};

	for (const product of products) {
		let changed = false;
		let productFailed = false;
		let productImagesUpdated = 0;
		let productImagesAlreadyLocal = 0;
		let productDownloadsCompleted = 0;
		let productDownloadsSkipped = 0;

		const originalDefaultDesigns = cloneDefaultDesignsForBackup(product);

		const attributes = Array.isArray(product.productAttributes)
			? product.productAttributes
			: [];

		for (let attrIndex = 0; attrIndex < attributes.length; attrIndex += 1) {
			const attribute = attributes[attrIndex];
			const defaultDesigns = Array.isArray(attribute?.defaultDesigns)
				? attribute.defaultDesigns
				: [];

			for (
				let designIndex = 0;
				designIndex < defaultDesigns.length;
				designIndex += 1
			) {
				const design = defaultDesigns[designIndex];
				const occasion = design?.occassion || design?.occasion || "occasion";
				const images = Array.isArray(design?.defaultDesignImages)
					? design.defaultDesignImages
					: [];

				for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
					const image = images[imageIndex];
					const sourceUrl = resolveSourceUrl(image);
					if (!sourceUrl) {
						console.warn(
							`[WARN] Missing source URL for product=${product._id} attr=${attrIndex} occasion=${occasion} image=${imageIndex}`,
						);
						productFailed = true;
						summary.failures += 1;
						continue;
					}

					const alreadyLocal = isLocalUrl(image?.url || "", publicBaseUrl);
					let contentType = "";
					let fileName = buildTargetFileName({
						image,
						sourceUrl,
						productId: String(product._id),
						attrIndex,
						designIndex,
						imageIndex,
						occasion,
					});

					let targetRelativePath = toPosixPath(`${assetSubdir}/${fileName}`);
					let targetAbsolutePath = path.join(
						assetRoot,
						...targetRelativePath.split("/"),
					);

					if (!alreadyLocal) {
						try {
							const result = await downloadFile(
								sourceUrl,
								targetAbsolutePath,
								Boolean(args.overwrite),
							);
							contentType = result.contentType;
							if (!getExtensionFromUrl(sourceUrl) && contentType) {
								fileName = buildTargetFileName({
									image,
									sourceUrl,
									productId: String(product._id),
									attrIndex,
									designIndex,
									imageIndex,
									occasion,
									contentType,
								});
								targetRelativePath = toPosixPath(`${assetSubdir}/${fileName}`);
								targetAbsolutePath = path.join(
									assetRoot,
									...targetRelativePath.split("/"),
								);
								if (
									!result.skippedDownload &&
									!fs.existsSync(targetAbsolutePath)
								) {
									await fs.promises.rename(
										path.join(
											assetRoot,
											...toPosixPath(
												`${assetSubdir}/${buildTargetFileName({
													image,
													sourceUrl,
													productId: String(product._id),
													attrIndex,
													designIndex,
													imageIndex,
													occasion,
												})}`,
											).split("/"),
										),
										targetAbsolutePath,
									);
								}
							}

							if (result.skippedDownload) {
								productDownloadsSkipped += 1;
							} else {
								productDownloadsCompleted += 1;
							}
						} catch (error) {
							console.error(
								`[ERROR] Download failed for product=${product._id} occasion=${occasion} image=${imageIndex}: ${error.message}`,
							);
							productFailed = true;
							summary.failures += 1;
							continue;
						}
					}

					const localUrl = `${publicBaseUrl}/${targetRelativePath}`;
					const needsUpdate =
						`${image?.url || ""}`.trim() !== localUrl ||
						`${image?.public_id || ""}`.trim() !== "" ||
						`${image?.cloudinary_url || ""}`.trim() !== "" ||
						`${image?.cloudinary_public_id || ""}`.trim() !== "";

					if (!needsUpdate) {
						productImagesAlreadyLocal += 1;
						continue;
					}

					image.url = localUrl;
					image.public_id = "";
					delete image.cloudinary_url;
					delete image.cloudinary_public_id;
					delete image.cloudinaryUrl;
					delete image.cloudinaryPublicId;

					changed = true;
					productImagesUpdated += 1;
					if (alreadyLocal) {
						productImagesAlreadyLocal += 1;
					}
				}
			}
		}

		if (productFailed) {
			console.warn(
				`[SKIP] Product ${product._id} had one or more failures. No DB changes will be saved for this product.`,
			);
			summary.productsSkipped += 1;
			continue;
		}

		if (!changed) {
			summary.productsSkipped += 1;
			summary.imagesAlreadyLocal += productImagesAlreadyLocal;
			summary.downloadsCompleted += productDownloadsCompleted;
			summary.downloadsSkipped += productDownloadsSkipped;
			console.log(`[OK] Product ${product._id} already aligned.`);
			continue;
		}

		backup.push({
			productId: String(product._id),
			productName: product.productName || "",
			slug: product.slug || "",
			productAttributes: originalDefaultDesigns,
		});

		summary.productsChanged += 1;
		summary.imagesUpdated += productImagesUpdated;
		summary.imagesAlreadyLocal += productImagesAlreadyLocal;
		summary.downloadsCompleted += productDownloadsCompleted;
		summary.downloadsSkipped += productDownloadsSkipped;

		if (args.dryRun) {
			console.log(
				`[DRY RUN] Product ${product._id}: would update ${productImagesUpdated} image(s).`,
			);
			continue;
		}

		product.markModified("productAttributes");
		await product.save();
		console.log(
			`[UPDATED] Product ${product._id}: updated ${productImagesUpdated} image(s).`,
		);
	}

	if (backup.length > 0) {
		await fs.promises.writeFile(
			backupFile,
			JSON.stringify(backup, null, 2),
			"utf8",
		);
		console.log(`Backup written to ${backupFile}`);
	}

	console.log("Summary:", summary);
	await mongoose.disconnect();
}

main().catch(async (error) => {
	console.error(error.message || error);
	console.error("");
	console.error(usage());
	try {
		await mongoose.disconnect();
	} catch {}
	process.exit(1);
});
