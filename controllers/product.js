/** @format */

const ActiveCategories = require("../models/activeCategories");
const Product = require("../models/product");
const User = require("../models/user");
const Category = require("../models/category"); // Adjust paths as necessary
const Subcategory = require("../models/subcategory"); // Adjust paths as necessary
const Gender = require("../models/gender"); // Adjust paths as necessary
const Colors = require("../models/colors");
const StoreManagement = require("../models/storeManagement");
const querystring = require("querystring");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const axios = require("axios");

const EXCLUDED_CATEGORY_ID = "6691981f25cf79d0a7dca70e";
const POD_COLLECTION_CATEGORY_SLUG = "custom-design";
const DEFAULT_ACTIVE_CATEGORY_RESPONSE = {
	categories: [],
	subcategories: [],
	genders: [],
	chosenSeasons: [],
};
const ALLOWED_PRODUCT_SORT_FIELDS = new Set([
	"viewsCount",
	"createdAt",
	"updatedAt",
	"price",
	"priceAfterDiscount",
	"sold",
	"productName",
]);

function toTrimmedString(value = "") {
	return `${value || ""}`.trim();
}

function isValidObjectId(value = "") {
	return mongoose.Types.ObjectId.isValid(toTrimmedString(value));
}

function toObjectId(value = "") {
	return new mongoose.Types.ObjectId(toTrimmedString(value));
}

function clampPositiveInteger(value, fallback, { min = 1, max = 200 } = {}) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function sanitizeSortOrder(value = "", fallback = "desc") {
	const safeValue = toTrimmedString(value).toLowerCase();
	return safeValue === "asc" || safeValue === "desc" ? safeValue : fallback;
}

function sanitizeSortField(value = "", fallback = "viewsCount") {
	const safeValue = toTrimmedString(value);
	return ALLOWED_PRODUCT_SORT_FIELDS.has(safeValue) ? safeValue : fallback;
}

function uniqueValidObjectIds(values = []) {
	return Array.from(
		new Set(
			(Array.isArray(values) ? values : [values])
				.map((value) => toTrimmedString(value))
				.filter((value) => isValidObjectId(value))
		)
	).map((value) => toObjectId(value));
}

function normalizeActiveCategoriesSnapshot(snapshot = {}) {
	const safeCategories = Array.isArray(snapshot?.categories)
		? snapshot.categories.filter(
				(entry) =>
					toTrimmedString(entry?.categorySlug).toLowerCase() !==
					POD_COLLECTION_CATEGORY_SLUG
		  )
		: DEFAULT_ACTIVE_CATEGORY_RESPONSE.categories;
	const allowedCategoryIds = new Set(
		safeCategories.map((entry) => `${entry?._id || ""}`.trim()).filter(Boolean)
	);

	return {
		categories: safeCategories,
		subcategories: Array.isArray(snapshot?.subcategories)
			? snapshot.subcategories.filter((entry) => {
					const parentCategoryId = `${entry?.categoryId || ""}`.trim();
					return !parentCategoryId || allowedCategoryIds.has(parentCategoryId);
			  })
			: DEFAULT_ACTIVE_CATEGORY_RESPONSE.subcategories,
		genders: Array.isArray(snapshot?.genders)
			? snapshot.genders
			: DEFAULT_ACTIVE_CATEGORY_RESPONSE.genders,
		chosenSeasons: Array.isArray(snapshot?.chosenSeasons)
			? snapshot.chosenSeasons.filter(Boolean)
			: DEFAULT_ACTIVE_CATEGORY_RESPONSE.chosenSeasons,
	};
}

async function buildActiveCategoriesSnapshot({
	featured = "0",
	newArrivals = "0",
	customDesigns = "0",
	storeId = "",
} = {}) {
	const activeStoreDocs = await StoreManagement.find({
		activeStoreByAdmin: true,
		activeStoreBySeller: true,
	})
		.select("_id")
		.lean();
	const activeStoreIds = uniqueValidObjectIds(
		activeStoreDocs.map((entry) => `${entry?._id || ""}`)
	);

	const match = {
		activeProduct: true,
		activeProductBySeller: { $ne: false },
	};

	if (activeStoreIds.length > 0) {
		match.store = { $in: activeStoreIds };
	}

	if (storeId) {
		if (!isValidObjectId(storeId)) {
			const error = new Error("Invalid storeId param");
			error.statusCode = 400;
			throw error;
		}
		match.store = toObjectId(storeId);
	}

	if (customDesigns === "1") {
		match["printifyProductDetails.POD"] = true;
	}

	if (featured === "1") {
		match.featuredProduct = true;
		match["printifyProductDetails.POD"] = { $ne: true };
	}

	if (newArrivals === "1") {
		match["printifyProductDetails.POD"] = { $ne: true };
	}

	const [categoryIds, subcategoryIds, genderIds, chosenSeasons] = await Promise.all([
		Product.distinct("category", match),
		Product.distinct("subcategory", match),
		Product.distinct("gender", match),
		Product.distinct("chosenSeason", match),
	]);

	const [categories, subcategories, genders] = await Promise.all([
		Category.find({
			_id: {
				$in: uniqueValidObjectIds(categoryIds).filter(
					(value) => `${value}` !== EXCLUDED_CATEGORY_ID
				),
			},
			categoryStatus: true,
		})
			.select("_id categoryName categorySlug thumbnail categoryName_Arabic")
			.sort({ categoryName: 1 })
			.lean(),
		Subcategory.find({
			_id: { $in: uniqueValidObjectIds(subcategoryIds) },
			subCategoryStatus: true,
		})
			.select(
				"_id SubcategoryName SubcategorySlug thumbnail SubcategoryName_Arabic categoryId"
			)
			.sort({ SubcategoryName: 1 })
			.lean(),
		Gender.find({
			_id: { $in: uniqueValidObjectIds(genderIds) },
			genderNameStatus: true,
		})
			.select("_id genderName thumbnail genderName_Arabic")
			.sort({ genderName: 1 })
			.lean(),
	]);

	return normalizeActiveCategoriesSnapshot({
		categories,
		subcategories,
		genders,
		chosenSeasons,
	});
}

exports.productById = async (req, res, next, id) => {
	if (!isValidObjectId(id)) {
		return res.status(404).json({ error: "Product not found" });
	}

	try {
		const product = await Product.findById(id)
			.populate("ratings.ratedBy", "_id name")
			.populate("comments.postedBy", "_id name")
			.populate(
				"subcategory",
				"_id SubcategoryName SubcategorySlug subCategoryStatus"
			)
			.populate(
				"category",
				"_id categoryName categorySlug thumbnail categoryName_Arabic"
			)
			.populate("gender", "_id genderName thumbnail")
			.populate("addedByEmployee", "_id name role")
			.populate("updatedByEmployee", "_id name role")
			.populate({
				path: "relatedProducts",
				populate: {
					path: "category",
					select: "_id categoryName categorySlug thumbnail categoryName_Arabic",
				},
			});

		if (!product) {
			return res.status(404).json({
				error: "Product not found",
			});
		}

		req.product = product;
		next();
	} catch (err) {
		res.status(404).json({ error: "Product not found" });
	}
};

exports.read = (req, res) => {
	if (!req.product) {
		return res.status(404).json({ error: "Product not found" });
	}
	return res.json(req.product);
};

exports.create = async (req, res) => {
	try {
		const newProduct = await new Product(req.body).save();
		// console.log(req.body, "create a product");
		res.json(newProduct);
	} catch (err) {
		console.log(err, "Error while creating a Product");
		res.status(400).send("Product error during creation");
	}
};

exports.listProductsNoFilter = async (req, res) => {
	let order = sanitizeSortOrder(req.query.order, "desc");
	let sortBy = sanitizeSortField(req.query.sortBy, "viewsCount");
	let limit = clampPositiveInteger(req.query.limit, 200, { min: 1, max: 500 });

	try {
		const products = await Product.find({
			"printifyProductDetails.POD": { $ne: true },
		})
			.populate(
				"category",
				"_id categoryName categorySlug thumbnail categoryName_Arabic"
			)
			.populate(
				"subcategory",
				"_id SubcategoryName SubcategorySlug thumbnail SubcategoryName_Arabic"
			)
			.populate("gender", "_id genderName thumbnail")
			.populate("addedByEmployee", "_id name role")
			.populate("updatedByEmployee", "_id name role")
			.populate({
				path: "relatedProducts",
				populate: {
					path: "category",
					select: "_id categoryName categorySlug thumbnail categoryName_Arabic",
				},
			})
			.sort([[sortBy, order]])
			.limit(limit);

		res.json(products);
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.listProductsNoFilterForSeller = async (req, res) => {
	const storeId = req.params.storeId;
	if (!mongoose.Types.ObjectId.isValid(storeId)) {
		return res.status(400).json({ error: "Invalid storeId param" });
	}

	try {
		const products = await Product.find({
			"printifyProductDetails.POD": { $ne: true },
			store: storeId,
		})
			.populate(
				"category",
				"_id categoryName categorySlug thumbnail categoryName_Arabic"
			)
			.populate(
				"subcategory",
				"_id SubcategoryName SubcategorySlug thumbnail SubcategoryName_Arabic"
			)
			.populate("gender", "_id genderName thumbnail")
			.populate("addedByEmployee", "_id name role")
			.populate("updatedByEmployee", "_id name role")
			.populate({
				path: "relatedProducts",
				populate: {
					path: "category",
					select: "_id categoryName categorySlug thumbnail categoryName_Arabic",
				},
			});

		res.json(products);
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.listPODProducts = async (req, res) => {
	let order = sanitizeSortOrder(req.query.order, "desc");
	let sortBy = sanitizeSortField(req.query.sortBy, "viewsCount");
	let limit = clampPositiveInteger(req.query.limit, 200, { min: 1, max: 500 });
	const useLitePayload = `${req.query.lite || ""}` === "1";

	try {
		let query = Product.find({
			"printifyProductDetails.POD": true,
		})
			.sort([[sortBy, order]])
			.limit(limit);

		if (useLitePayload) {
			query = query
				.select(
					"_id productName slug price priceAfterDiscount quantity category thumbnailImage printifyProductDetails"
				)
				.populate(
					"category",
					"_id categoryName categorySlug thumbnail categoryName_Arabic"
				)
				.lean();
		} else {
			query = query
				.populate(
					"category",
					"_id categoryName categorySlug thumbnail categoryName_Arabic"
				)
				.populate(
					"subcategory",
					"_id SubcategoryName SubcategorySlug thumbnail SubcategoryName_Arabic"
				)
				.populate("gender", "_id genderName thumbnail")
				.populate("addedByEmployee", "_id name role")
				.populate("updatedByEmployee", "_id name role")
				.populate({
					path: "relatedProducts",
					populate: {
						path: "category",
						select: "_id categoryName categorySlug thumbnail categoryName_Arabic",
					},
				});
		}

		const products = await query;

		res.json(products);
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.update = async (req, res) => {
	try {
		// Extract the product ID from the request
		const productId = req.product._id;
		const updateFields = req.body.product;

		// Find the existing product
		const existingProduct = await Product.findById(productId);
		if (!existingProduct) {
			return res.status(404).json({ error: "Product not found" });
		}

		// Update the product document with the provided fields
		const updatedProduct = await Product.findByIdAndUpdate(
			productId,
			{ $set: updateFields }, // Only update the fields present in req.body.product
			{ new: true } // Return the updated document
		);

		if (!updatedProduct) {
			return res.status(404).json({ error: "Product not found" });
		}

		console.log("MongoDB update successful:", updatedProduct);

		// Check if the product is a Printify product
		if (existingProduct.isPrintifyProduct) {
			try {
				// Fetch the Shop ID from Printify API
				const shopResponse = await axios.get(
					"https://api.printify.com/v1/shops.json",
					{
						headers: {
							Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
						},
					}
				);

				if (shopResponse.data && shopResponse.data.length > 0) {
					const shopId = shopResponse.data[0].id; // Assuming you want the first shop ID

					// Construct the payload for Printify update
					const printifyUpdatePayload = {
						title: updatedProduct.productName,
						description: updatedProduct.description,
						tags: updatedProduct.printifyProductDetails.tags,
						options: updatedProduct.printifyProductDetails.options,
						variants: updatedProduct.printifyProductDetails.variants.map(
							(variant) => ({
								...variant,
								price: updatedProduct.priceAfterDiscount * 100, // Printify expects the price in cents
							})
						),
					};

					const printifyProductId = updatedProduct.printifyProductDetails.id;
					const printifyProductUrl = `https://api.printify.com/v1/shops/${shopId}/products/${printifyProductId}.json`;

					// Publish the product first
					try {
						await axios.post(
							`https://api.printify.com/v1/shops/${shopId}/products/${printifyProductId}/publish.json`,
							{
								title: true,
								description: true,
								images: true,
								variants: true,
								tags: true,
								keyFeatures: true,
								shipping_template: true,
							},
							{
								headers: {
									Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
								},
							}
						);
						console.log("Product published successfully on Printify");
					} catch (publishError) {
						console.error(
							"Error publishing Printify product:",
							publishError.response?.data || publishError.message
						);
						return res.status(200).json(updatedProduct); // Continue with MongoDB update success
					}

					// Attempt to unlock the product
					try {
						await axios.post(
							`https://api.printify.com/v1/shops/${shopId}/products/${printifyProductId}/publishing_succeeded.json`,
							{
								external: {
									id: updatedProduct._id.toString(),
									handle: `https://serenejannat.com/products/${updatedProduct.slug}`,
								},
							},
							{
								headers: {
									Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
								},
							}
						);
						console.log("Product unlocked successfully on Printify");
					} catch (unlockError) {
						console.error(
							"Error unlocking Printify product:",
							unlockError.response?.data || unlockError.message
						);
						// Continue even if unlocking fails
					}

					// Update the Printify product via their API
					try {
						await axios.put(printifyProductUrl, printifyUpdatePayload, {
							headers: {
								Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
							},
						});
						console.log("Product updated successfully on Printify");
					} catch (updateError) {
						console.error(
							"Error updating Printify product:",
							updateError.response?.data || updateError.message
						);
						return res.status(200).json(updatedProduct); // Continue with MongoDB update success
					}

					// Ensure the product is published again
					try {
						await axios.post(
							`https://api.printify.com/v1/shops/${shopId}/products/${printifyProductId}/publish.json`,
							{
								title: true,
								description: true,
								images: true,
								variants: true,
								tags: true,
								keyFeatures: true,
								shipping_template: true,
							},
							{
								headers: {
									Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
								},
							}
						);
						console.log("Product re-published successfully on Printify");
					} catch (republishError) {
						console.error(
							"Error re-publishing Printify product:",
							republishError.response?.data || republishError.message
						);
						return res.status(200).json(updatedProduct); // Continue with MongoDB update success
					}

					// Set product publish status to succeeded
					try {
						await axios.post(
							`https://api.printify.com/v1/shops/${shopId}/products/${printifyProductId}/publishing_succeeded.json`,
							{
								external: {
									id: updatedProduct._id.toString(),
									handle: `https://serenejannat.com/products/${updatedProduct.slug}`,
								},
							},
							{
								headers: {
									Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
								},
							}
						);
						console.log("Product publish status set to succeeded on Printify");
					} catch (succeededError) {
						console.error(
							"Error setting publish status to succeeded:",
							succeededError.response?.data || succeededError.message
						);
						return res.status(200).json(updatedProduct); // Continue with MongoDB update success
					}
				}
			} catch (printifyError) {
				console.error(
					"Error handling Printify product:",
					printifyError.response?.data || printifyError.message
				);
				return res.status(200).json(updatedProduct); // Continue with MongoDB update success
			}
		}

		res.json(updatedProduct);
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: "Product update failed" });
	}
};

exports.listRelated = async (req, res) => {
	let limit = req.query.limit ? parseInt(req.query.limit) : 6;

	try {
		const products = await Product.find({
			_id: { $ne: req.product },
			category: req.product.category,
		})
			.select("-photo -photo2 -photo3 -photo4 -photo5")
			.limit(limit)
			.populate("category", "_id name")
			.populate(
				"subcategory",
				"_id SubcategoryName SubcategorySlug subCategoryStatus"
			)
			.exec();

		res.json(products);
	} catch (err) {
		res.status(400).json({ error: "Products not found" });
	}
};

exports.listCategories = async (req, res) => {
	try {
		const categories = await Product.distinct("category").exec();
		res.json(categories);
	} catch (err) {
		res.status(400).json({ error: "Categories not found" });
	}
};

exports.list = (req, res) => {
	let order = req.query.order ? req.query.order : "desc";
	let sortBy = req.query.sortBy ? req.query.sortBy : "viewsCount";
	let limit = req.query.limit ? parseInt(req.query.limit) : 200;

	Product.find()
		.populate(
			"category",
			"_id categoryName categorySlug thumbnail categoryName_Arabic"
		)
		.populate("comments", "text created")
		.populate("comments.postedBy", "_id name")
		.populate(
			"subcategory",
			"_id SubcategoryName SubcategorySlug subCategoryStatus"
		)
		.populate("addedByEmployee", "_id name role")
		.populate("updatedByEmployee", "_id name role")
		.populate({
			path: "relatedProducts",
			populate: {
				path: "category",
				select: "_id categoryName categorySlug thumbnail categoryName_Arabic",
			},
		})
		.sort([[sortBy, order]])
		.limit(limit)
		.exec((err, products) => {
			if (err) {
				return res.status(400).json({
					err: "products not found",
				});
			}
			res.json(products);
		});
};

exports.like = async (req, res) => {
	try {
		const result = await Product.findByIdAndUpdate(
			req.body.productId,
			{ $push: { likes: req.body.userId } },
			{ new: true }
		).exec();

		res.json(result);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.unlike = async (req, res) => {
	try {
		const result = await Product.findByIdAndUpdate(
			req.body.productId,
			{ $pull: { likes: req.body.userId } },
			{ new: true }
		).exec();

		res.json(result);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.comment = async (req, res) => {
	let comment = req.body.comment;
	comment.postedBy = req.body.userId;
	// console.log(req.body, "comments");

	try {
		const result = await Product.findByIdAndUpdate(
			req.body.productId,
			{ $push: { comments: comment } },
			{ new: true }
		)
			.populate("comments.postedBy", "_id name")
			// .populate("postedBy", "_id name email")
			.exec();

		res.json(result);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.uncomment = async (req, res) => {
	let comment = req.body.comment;

	try {
		const result = await Product.findByIdAndUpdate(
			req.body.productId,
			{ $pull: { comments: { _id: comment._id } } },
			{ new: true }
		)
			.populate("comments.postedBy", "_id name")
			// .populate("postedBy", "_id name email")
			.exec();

		res.json(result);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.productStar = async (req, res) => {
	try {
		const product = await Product.findById(req.params.productId).exec();
		const user = await User.findById(req.body.userId).exec();
		const { star } = req.body;

		// Check if currently logged in user has already added a rating to this product
		let existingRatingObject = product.ratings.find(
			(ele) => ele.ratedBy.toString() === user._id.toString()
		);

		// If user hasn't left a rating yet, push it
		if (existingRatingObject === undefined) {
			let ratingAdded = await Product.findByIdAndUpdate(
				product._id,
				{
					$push: { ratings: { star, ratedBy: user._id } },
				},
				{ new: true }
			).exec();

			res.json(ratingAdded);
		} else {
			// If user has already left a rating, update it
			const ratingUpdated = await Product.updateOne(
				{
					_id: product._id,
					"ratings._id": existingRatingObject._id,
				},
				{
					$set: { "ratings.$.star": star },
				},
				{ new: true }
			).exec();

			res.json(ratingUpdated);
		}
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.remove = (req, res) => {
	const product = req.product;

	product.remove((err, data) => {
		if (err) {
			console.log(err, "err");
			return res.status(400).json({
				err: "error while removing product",
			});
		}
		res.json({ message: "product deleted" });
	});
};

exports.createDistinctCategoriesActiveProducts = async (req, res) => {
	try {
		const { featured, newArrivals, customDesigns, storeId } = req.query;
		const snapshot = await buildActiveCategoriesSnapshot({
			featured,
			newArrivals,
			customDesigns,
			storeId,
		});

		// 2) Delete any existing docs in ActiveCategories
		await ActiveCategories.deleteMany({});

		// 3) Create a new doc
		const doc = new ActiveCategories({
			categories: snapshot.categories,
			subcategories: snapshot.subcategories,
			genders: snapshot.genders,
			chosenSeasons: snapshot.chosenSeasons,
		});

		await doc.save();

		// 4) Return newly created doc
		res.json({
			message: "ActiveCategories updated successfully",
			activeCategories: doc,
		});
	} catch (error) {
		console.error("Error in createDistinctCategoriesActiveProducts:", error);
		const statusCode = Number(error?.statusCode || 0) || 500;
		res.status(statusCode).json({
			error:
				statusCode === 400
					? error.message || "Invalid request"
					: "There was an error creating/updating active categories.",
		});
	}
};

exports.getDistinctCategoriesActiveProducts = async (req, res) => {
	try {
		const doc = await ActiveCategories.findOne()
			.sort({ createdAt: -1 })
			.lean();

		const cachedSnapshot = normalizeActiveCategoriesSnapshot(doc);
		if (
			cachedSnapshot.categories.length > 0 ||
			cachedSnapshot.subcategories.length > 0 ||
			cachedSnapshot.genders.length > 0 ||
			cachedSnapshot.chosenSeasons.length > 0
		) {
			return res.json(cachedSnapshot);
		}

		const freshSnapshot = await buildActiveCategoriesSnapshot(req.query || {});
		return res.json(freshSnapshot);
	} catch (error) {
		console.error("Error in getDistinctCategoriesActiveProducts:", error);
		const statusCode = Number(error?.statusCode || 0) || 500;
		return res
			.status(statusCode)
			.json({
				error:
					statusCode === 400
						? error.message || "Invalid request"
						: "There was an error retrieving active categories.",
			});
	}
};

exports.gettingSpecificSetOfProducts = async (req, res) => {
	try {
		const {
			featured,
			newArrivals,
			customDesigns,
			sortByRate,
			offers,
			records,
		} = req.params; // from path

		const { skip, storeId, lite } = req.query; // from query
		const useLitePayload = String(lite || "").trim() === "1";

		// Convert them to numbers if needed
		const limitNumber = clampPositiveInteger(records, 5, { min: 1, max: 60 });
		const skipNumber = Math.max(0, Number.parseInt(skip, 10) || 0);

		// 1) Base match
		let baseMatch = { activeProduct: true };

		// 2) If storeId is provided, match that store
		if (storeId) {
			if (!isValidObjectId(storeId)) {
				return res.status(400).json({ error: "Invalid storeId query value" });
			}
			baseMatch.store = toObjectId(storeId);
		}

		// 3) customDesigns => only POD
		if (customDesigns === "1") {
			baseMatch["printifyProductDetails.POD"] = true;
		}

		// 4) featured => also exclude POD
		if (featured === "1") {
			baseMatch.featuredProduct = true;
			baseMatch["printifyProductDetails.POD"] = { $ne: true };
		}

		// Build the pipeline
		let pipeline = [];

		// First stage match
		pipeline.push({ $match: baseMatch });

		// (A) Lookup store
		pipeline.push(
			{
				$lookup: {
					from: "storemanagements", // <-- Adjust if your store collection is named differently
					localField: "store",
					foreignField: "_id",
					as: "storeDetails",
				},
			},
			{ $unwind: "$storeDetails" },
			{
				$match: {
					"storeDetails.activeStoreByAdmin": true,
					"storeDetails.activeStoreBySeller": true,
				},
			}
		);

		// (B) If newArrivals=1 => sort by createdAt desc and exclude POD
		if (newArrivals === "1") {
			pipeline.push({ $sort: { createdAt: -1 } });
			pipeline.push({
				$match: {
					"printifyProductDetails.POD": { $ne: true },
				},
			});
		}

		// (C) If offers=1 => items that have a discounted price
		if (offers === "1") {
			pipeline.push({
				$match: {
					$or: [
						{ $expr: { $gt: ["$MSRPPriceBasic", "$priceAfterDiscount"] } },
						{ $expr: { $gt: ["$price", "$priceAfterDiscount"] } },
					],
				},
			});
		}

		// (D) Category lookup
		pipeline.push(
			{
				$lookup: {
					from: "categories",
					localField: "category",
					foreignField: "_id",
					as: "category",
				},
			},
			{ $unwind: "$category" }
		);

		// Exclude category= "6691981f25cf79d0a7dca70e"
		pipeline.push({
			$match: {
				"category._id": { $ne: new ObjectId(EXCLUDED_CATEGORY_ID) },
			},
		});

		// (E) Sort by rating if needed
		if (sortByRate === "1") {
			pipeline.push({
				$match: {
					ratings: { $exists: true, $not: { $size: 0 } },
				},
			});
			pipeline.push(
				{ $addFields: { ratingsCount: { $size: "$ratings" } } },
				{ $sort: { ratingsCount: -1 } }
			);
		}

		// (F) If featured=1 or newArrivals=1 => remove "printifyProductDetails"
		if (featured === "1" || newArrivals === "1") {
			pipeline.push({ $unset: "printifyProductDetails" });
		}

		// (G) Exclude out-of-stock by computing totalQuantity
		pipeline.push(
			{
				$addFields: {
					totalQuantity: {
						$cond: {
							if: { $gt: [{ $size: "$productAttributes" }, 0] },
							then: { $sum: "$productAttributes.quantity" },
							else: "$quantity",
						},
					},
				},
			},
			{
				$match: {
					totalQuantity: { $gt: 0 },
				},
			}
		);

		// (H) Pagination
		pipeline.push({ $skip: skipNumber }, { $limit: limitNumber });

		// Execute the pipeline
		let products = await Product.aggregate(pipeline);

		// (I) Fallback if sortByRate=1 yields no products but featured!=1
		if (sortByRate === "1" && products.length === 0 && featured !== "1") {
			// We'll do a .find on featured products, filter out-of-stock manually
			let fallback = await Product.find({
				activeProduct: true,
				featuredProduct: true,
			})
				.populate("category")
				.lean();

			// Filter out-of-stock
			fallback = fallback.filter((prod) => {
				if (prod.productAttributes && prod.productAttributes.length > 0) {
					const sumQty = prod.productAttributes.reduce(
						(acc, a) => acc + a.quantity,
						0
					);
					return sumQty > 0;
				} else {
					return prod.quantity > 0;
				}
			});

			// Then limit the result
			fallback = fallback.slice(0, limitNumber);

			products = fallback;
		}

		const slimImageObject = (image) => {
			if (!image) return image;
			if (typeof image === "string") return image;
			if (typeof image !== "object") return image;
			const slim = {};
			if (image.url) slim.url = image.url;
			if (image.src) slim.src = image.src;
			if (image.public_id) slim.public_id = image.public_id;
			if (image.cloudinary_url) slim.cloudinary_url = image.cloudinary_url;
			if (image.cloudinary_public_id) {
				slim.cloudinary_public_id = image.cloudinary_public_id;
			}
			return Object.keys(slim).length ? slim : image;
		};

		const slimPrintifyImage = (image) => {
			if (!image || typeof image !== "object") return null;
			return {
				src: image.src || image.url || "",
				position: image.position || image.placeholder || "",
				is_default: Boolean(image.is_default),
			};
		};

		const slimProductAttribute = (attribute, index) => {
			if (!attribute || typeof attribute !== "object") return null;
			const slimAttribute = {
				PK: attribute.PK || "",
				size: attribute.size || "",
				color: attribute.color || "",
				scent: attribute.scent || "",
				quantity: Number(attribute.quantity || 0),
			};

			if (index === 0) {
				slimAttribute.price = Number(attribute.price || 0);
				slimAttribute.priceAfterDiscount = Number(
					attribute.priceAfterDiscount || 0
				);
				slimAttribute.productImages = Array.isArray(attribute.productImages)
					? attribute.productImages.slice(0, 1).map(slimImageObject)
					: [];
			}

			if (attribute.exampleDesignImage) {
				slimAttribute.exampleDesignImage = slimImageObject(
					attribute.exampleDesignImage
				);
			}

			return slimAttribute;
		};

		const slimProductForHome = (product) => {
			const rawAttributes = Array.isArray(product?.productAttributes)
				? product.productAttributes
				: [];
			const productAttributes = Array.isArray(product?.productAttributes)
				? rawAttributes
						.map((attr, index) => slimProductAttribute(attr, index))
						.filter(Boolean)
				: [];
			const printifyImages = Array.isArray(product?.printifyProductDetails?.images)
				? product.printifyProductDetails.images
						.slice(0, 1)
						.map(slimPrintifyImage)
						.filter(Boolean)
				: [];
			const thumbnailImage = Array.isArray(product?.thumbnailImage)
				? product.thumbnailImage.slice(0, 1).map((thumb) => ({
						images: Array.isArray(thumb?.images)
							? thumb.images.slice(0, 1).map(slimImageObject)
							: [],
					}))
				: [];
			return {
				_id: product?._id,
				productName: product?.productName || "",
				slug: product?.slug || "",
				description: `${product?.description || ""}`.slice(0, 400),
				price: Number(product?.price || 0),
				priceAfterDiscount: Number(product?.priceAfterDiscount || 0),
				quantity: Number(product?.quantity || 0),
				isPrintifyProduct: Boolean(product?.isPrintifyProduct),
				createdAt: product?.createdAt || null,
				updatedAt: product?.updatedAt || null,
				category: product?.category
					? {
							_id: product.category._id,
							categoryName: product.category.categoryName || "",
							categorySlug: product.category.categorySlug || "",
						}
					: null,
				thumbnailImage,
				productAttributes,
				printifyProductDetails: product?.printifyProductDetails
					? {
							POD: Boolean(product.printifyProductDetails.POD),
							id: product.printifyProductDetails.id || "",
							title: product.printifyProductDetails.title || "",
							images: printifyImages,
						}
					: null,
			};
		};

		// (J) Group each product by color
		const processedProducts = products
			.map((product) => {
				if (product.productAttributes && product.productAttributes.length > 0) {
					const byColor = product.productAttributes.reduce((acc, attr) => {
						const colorKey = attr.color || "unknown";
						if (!acc[colorKey]) {
							acc[colorKey] = {
								...product,
								productAttributes: [],
								thumbnailImage: product.thumbnailImage,
							};
						}
						acc[colorKey].productAttributes.push(attr);
						return acc;
					}, {});
					return Object.values(byColor);
				}
				// otherwise it's a simple product
				return [product];
			})
			.flat();

		if (useLitePayload) {
			res.set(
				"Cache-Control",
				"public, max-age=120, s-maxage=300, stale-while-revalidate=600"
			);
			return res.json(processedProducts.map(slimProductForHome));
		}

		return res.json(processedProducts);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: err.message });
	}
};

exports.readSingleProduct = async (req, res, next) => {
	const { slug, categorySlug, productId } = req.params;
	const safeProductId = toTrimmedString(productId);

	if (!isValidObjectId(safeProductId)) {
		return res.status(404).json({ error: "Product not found" });
	}

	try {
		const product = await Product.findById(safeProductId)
			.populate(
				"category",
				"categoryName categorySlug thumbnail categoryName_Arabic"
			)
			.populate(
				"subcategory",
				"SubcategoryName SubcategorySlug subCategoryStatus"
			)
			.populate("ratings.ratedBy", "_id name")
			.populate("comments.postedBy", "_id name")
			.populate("gender", "_id genderName thumbnail")
			.populate("addedByEmployee", "_id name role")
			.populate("updatedByEmployee", "_id name role")
			.populate({
				path: "relatedProducts",
				populate: {
					path: "category",
					select: "_id categoryName categorySlug thumbnail categoryName_Arabic",
				},
			});

		if (!product) {
			return res.status(404).json({
				error: "Product not found",
			});
		}

		res.json(product);
	} catch (err) {
		console.error(
			"Error in readSingleProduct:",
			err?.message || err,
			{ slug, categorySlug, productId: safeProductId }
		);
		res.status(404).json({ error: "Product not found" });
	}
};

exports.filteredProducts = async (req, res, next) => {
	const { page, records, filters } = req.params;
	const shouldDebugFilteredProducts = process.env.DEBUG_PRODUCTS_FILTER === "true";
	const debugFilteredProducts = (...args) => {
		if (shouldDebugFilteredProducts) {
			console.log(...args);
		}
	};
	let {
		color,
		priceMin,
		priceMax,
		category,
		size,
		gender,
		searchTerm,
		offers,
		store,
	} = querystring.parse(filters);
	debugFilteredProducts(offers, "offersoffersoffers");

	const decodeFilterValue = (value) => querystring.unescape(`${value || ""}`).trim();
	const escapeRegex = (value = "") =>
		`${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const normalizeToArray = (value) => {
		if (Array.isArray(value)) {
			return value.flatMap((entry) => `${entry || ""}`.split(","));
		}
		if (value === undefined || value === null) return [];
		return `${value}`.split(",");
	};
	const normalizeFilterArray = (value) =>
		normalizeToArray(value)
			.map((entry) => decodeFilterValue(entry))
			.filter(Boolean);

	const selectedColors = normalizeFilterArray(color).filter(
		(value) => value.toLowerCase() !== "unknown"
	);
	const selectedSizes = normalizeFilterArray(size);
	const selectedCategoryValues = normalizeFilterArray(category);
	const directCategoryIds = selectedCategoryValues
		.filter((value) => mongoose.Types.ObjectId.isValid(value))
		.map((value) => new mongoose.Types.ObjectId(value));
	const nonObjectIdCategoryValues = selectedCategoryValues.filter(
		(value) => !mongoose.Types.ObjectId.isValid(value)
	);
	let selectedCategories = [...directCategoryIds];

	// Resolve category filters passed as slug/name (legacy URLs and external links).
	if (nonObjectIdCategoryValues.length > 0) {
		try {
			const slugCandidates = nonObjectIdCategoryValues
				.map((value) => value.toLowerCase())
				.filter(Boolean);
			const nameCandidates = nonObjectIdCategoryValues
				.map((value) => value.replace(/[-_]+/g, " ").trim())
				.filter(Boolean);
			const regexCandidates = Array.from(
				new Set([...slugCandidates, ...nameCandidates])
			).map((value) => new RegExp(`^${escapeRegex(value)}$`, "i"));

			const categoryMatch = [];
			if (slugCandidates.length > 0) {
				categoryMatch.push({ categorySlug: { $in: slugCandidates } });
			}
			if (nameCandidates.length > 0) {
				categoryMatch.push({ categoryName: { $in: nameCandidates } });
			}
			if (regexCandidates.length > 0) {
				regexCandidates.forEach((regex) => {
					categoryMatch.push({ categorySlug: regex });
					categoryMatch.push({ categoryName: regex });
				});
			}

			if (categoryMatch.length > 0) {
				const matchedCategories = await Category.find({ $or: categoryMatch })
					.select("_id")
					.lean();
				const resolvedCategoryIds = matchedCategories
					.map((entry) => `${entry?._id || ""}`)
					.filter((id) => mongoose.Types.ObjectId.isValid(id));
				if (resolvedCategoryIds.length > 0) {
					selectedCategories = [
						...selectedCategories,
						...resolvedCategoryIds.map(
							(id) => new mongoose.Types.ObjectId(id)
						),
					];
				}
			}
		} catch (categoryLookupError) {
			console.error(
				"Category lookup failed:",
				categoryLookupError.message || categoryLookupError
			);
		}
	}

	// Keep category IDs unique before building Mongo match conditions.
	selectedCategories = Array.from(
		new Set(selectedCategories.map((value) => `${value}`))
	).map((value) => new mongoose.Types.ObjectId(value));
	const normalizedStoreInput = decodeFilterValue(store);
	const normalizedGenderInput = decodeFilterValue(gender);
	const validGenderId = mongoose.Types.ObjectId.isValid(normalizedGenderInput)
		? new mongoose.Types.ObjectId(normalizedGenderInput)
		: null;
	searchTerm = decodeFilterValue(searchTerm).slice(0, 120);
	const parsedMinPrice = Number(priceMin);
	const parsedMaxPrice = Number(priceMax);
	const hasMinPriceFilter = Number.isFinite(parsedMinPrice) && parsedMinPrice > 0;
	const hasMaxPriceFilter = Number.isFinite(parsedMaxPrice) && parsedMaxPrice > 0;
	const safeMinPrice = hasMinPriceFilter ? parsedMinPrice : null;
	const safeMaxPrice = hasMaxPriceFilter ? parsedMaxPrice : null;

	const colorCandidatesSet = new Set();
	selectedColors.forEach((value) => {
		colorCandidatesSet.add(value);
		colorCandidatesSet.add(value.toLowerCase());
		colorCandidatesSet.add(value.toUpperCase());
	});
	if (selectedColors.length > 0) {
		try {
			const normalizedColorLowers = selectedColors.map((value) =>
				value.toLowerCase()
			);
			const mappedColors = await Colors.find({
				$or: [
					{ color: { $in: normalizedColorLowers } },
					{ hexa: { $in: normalizedColorLowers } },
				],
			})
				.select("color hexa")
				.lean();
			mappedColors.forEach((entry) => {
				if (entry?.color) colorCandidatesSet.add(entry.color);
				if (entry?.hexa) colorCandidatesSet.add(entry.hexa);
			});
		} catch (colorMappingError) {
			console.error(
				"Color mapping lookup failed:",
				colorMappingError.message || colorMappingError
			);
		}
	}
	const colorCandidates = Array.from(colorCandidatesSet).filter(Boolean);

	let storeIdCandidates = [];
	if (normalizedStoreInput) {
		if (mongoose.Types.ObjectId.isValid(normalizedStoreInput)) {
			storeIdCandidates = [new mongoose.Types.ObjectId(normalizedStoreInput)];
		} else {
			const normalizedStoreName = normalizedStoreInput
				.replace(/[-_]+/g, " ")
				.trim();
			try {
				const matchedStores = await StoreManagement.find({
					addStoreName: {
						$regex: `^${escapeRegex(normalizedStoreName)}$`,
						$options: "i",
					},
				})
					.select("_id")
					.lean();
				storeIdCandidates = matchedStores.map((entry) => entry._id);
			} catch (storeLookupError) {
				console.error(
					"Store lookup failed:",
					storeLookupError.message || storeLookupError
				);
			}
		}
	}

		const conditionByKey = {};

		if (toTrimmedString(offers).toLowerCase() === "jannatoffers") {
			console.log("Jannat Offers Was Triggered");
			conditionByKey.offers = {
				$or: [
					{
						$expr: { $lt: ["$priceAfterDiscount", "$price"] },
					},
					{
						$expr: {
							$lt: [
								"$productAttributes.priceAfterDiscount",
								"$productAttributes.price",
							],
						},
					},
				],
			};
		}

		if (colorCandidates.length > 0) {
			debugFilteredProducts(
				`Filtering by color candidates: ${colorCandidates.join(", ")}`
			);
			conditionByKey.color = {
				$or: [
					{ color: { $in: colorCandidates } },
					{ "productAttributes.color": { $in: colorCandidates } },
				],
			};
		}

		if (selectedSizes.length > 0) {
			debugFilteredProducts(
				`Filtering by size candidates: ${selectedSizes.join(", ")}`
			);
			conditionByKey.size = {
				$or: [
					{ size: { $in: selectedSizes } },
					{ "productAttributes.size": { $in: selectedSizes } },
				],
			};
		}

		if (hasMinPriceFilter || hasMaxPriceFilter) {
			const priceCondition = {};
			if (hasMinPriceFilter) priceCondition.$gte = safeMinPrice;
			if (hasMaxPriceFilter) priceCondition.$lte = safeMaxPrice;
			debugFilteredProducts(
				`Filtering by price condition: ${JSON.stringify(priceCondition)}`
			);
			conditionByKey.price = {
				$or: [
					{ priceAfterDiscount: priceCondition },
					{ price: priceCondition },
					{ "productAttributes.priceAfterDiscount": priceCondition },
					{ "productAttributes.price": priceCondition },
				],
			};
		} else if (Number.isFinite(parsedMinPrice) || Number.isFinite(parsedMaxPrice)) {
			debugFilteredProducts(
				`Skipping invalid price filter values: min=${priceMin}, max=${priceMax}`
			);
		}

		if (selectedCategories.length > 0) {
			debugFilteredProducts(
				`Filtering by category IDs: ${selectedCategories
					.map((value) => value.toString())
					.join(", ")}`
			);
			conditionByKey.category = { category: { $in: selectedCategories } };
		} else if (selectedCategoryValues.length > 0) {
			debugFilteredProducts(
				`Skipping invalid category filter values: ${selectedCategoryValues.join(", ")}`
			);
		} else {
			debugFilteredProducts(`No category filter applied`);
		}

		if (normalizedGenderInput && validGenderId) {
			debugFilteredProducts(`Filtering by gender: ${normalizedGenderInput}`);
			conditionByKey.gender = { gender: validGenderId };
		} else if (normalizedGenderInput && !validGenderId) {
			debugFilteredProducts(
				`Skipping invalid gender filter value: ${normalizedGenderInput}`
			);
		}

		if (normalizedStoreInput) {
			if (storeIdCandidates.length > 0) {
				debugFilteredProducts(`Filtering by store: ${normalizedStoreInput}`);
				conditionByKey.store = { store: { $in: storeIdCandidates } };
			} else {
				debugFilteredProducts(
					`No matching store found for: ${normalizedStoreInput}`
				);
				conditionByKey.store = { _id: { $in: [] } };
			}
		}

		if (searchTerm) {
			debugFilteredProducts(`Filtering by search term: ${searchTerm}`);
			conditionByKey.search = { $text: { $search: searchTerm } };
		}

		const buildMatchQuery = (excludedKeys = []) => {
			const andFilters = Object.entries(conditionByKey)
				.filter(([key]) => !excludedKeys.includes(key))
				.map(([, condition]) => condition);
			if (!andFilters.length) {
				return { activeProduct: true };
			}
			return { activeProduct: true, $and: andFilters };
		};

		const mainQuery = buildMatchQuery();

	// Pagination
	const pageNumber = clampPositiveInteger(page, 1, { min: 1, max: 10000 });
	const recordsPerPage = clampPositiveInteger(records, 10, { min: 1, max: 60 });
	const skip = (pageNumber - 1) * recordsPerPage;

	// Build the initial aggregation pipeline
		const pipeline = [{ $match: mainQuery }];

	// Sort by createdAt descending initially
	pipeline.push({ $sort: { createdAt: -1 } });

	// Lookups
	pipeline.push(
		{
			$lookup: {
				from: "categories",
				localField: "category",
				foreignField: "_id",
				as: "category",
			},
		},
		{
			$lookup: {
				from: "subcategories",
				localField: "subcategory",
				foreignField: "_id",
				as: "subcategory",
			},
		},
		{
			$lookup: {
				from: "genders",
				localField: "gender",
				foreignField: "_id",
				as: "gender",
			},
		}
	);

	// Unwind
	pipeline.push(
		{
			$unwind: {
				path: "$category",
				preserveNullAndEmptyArrays: false,
			},
		},
		{
			$unwind: {
				path: "$subcategory",
				preserveNullAndEmptyArrays: true,
			},
		},
		{
			$unwind: {
				path: "$gender",
				preserveNullAndEmptyArrays: true,
			},
		}
	);

	try {
		// Fetch the full matched dataset, then paginate after final card shaping.
		const products = await Product.aggregate(pipeline);

			// Additional pipelines for color, size, category, gender, store
			const colorPipeline = [
				{ $match: buildMatchQuery(["color"]) },
				{
					$project: {
						colors: {
							$concatArrays: [
								[{ $ifNull: ["$color", ""] }],
								{
									$map: {
										input: { $ifNull: ["$productAttributes", []] },
										as: "attr",
										in: { $ifNull: ["$$attr.color", ""] },
									},
								},
							],
						},
					},
				},
				{ $unwind: "$colors" },
				{
					$project: {
						color: {
							$cond: [
								{ $eq: [{ $type: "$colors" }, "string"] },
								{ $trim: { input: "$colors" } },
								"",
							],
						},
					},
				},
				{
					$project: {
						color: 1,
						colorLower: { $toLower: "$color" },
					},
				},
				{
					$match: {
						colorLower: { $nin: ["", "unknown"] },
					},
				},
				{
					$group: {
						_id: "$colorLower",
						color: { $first: "$color" },
					},
				},
				{ $project: { _id: 0, color: "$color" } },
				{ $sort: { color: 1 } },
			];

			const sizePipeline = [
				{ $match: buildMatchQuery(["size"]) },
				{
					$project: {
						sizes: {
							$concatArrays: [
								[{ $ifNull: ["$size", ""] }],
								{
									$map: {
										input: { $ifNull: ["$productAttributes", []] },
										as: "attr",
										in: { $ifNull: ["$$attr.size", ""] },
									},
								},
							],
						},
					},
				},
				{ $unwind: "$sizes" },
				{
					$project: {
						size: {
							$cond: [
								{ $eq: [{ $type: "$sizes" }, "string"] },
								{ $trim: { input: "$sizes" } },
								"",
							],
						},
					},
				},
				{
					$project: {
						size: 1,
						sizeLower: { $toLower: "$size" },
					},
				},
				{
					$match: {
						sizeLower: { $nin: [""] },
					},
				},
				{
					$group: {
						_id: "$sizeLower",
						size: { $first: "$size" },
					},
				},
				{ $project: { _id: 0, size: "$size" } },
				{ $sort: { size: 1 } },
			];

			const categoryPipeline = [
				{ $match: buildMatchQuery(["category"]) },
				{
					$lookup: {
						from: "categories",
						localField: "category",
						foreignField: "_id",
						as: "category",
					},
				},
				{ $unwind: "$category" },
				{
					$group: {
						_id: "$category._id",
						name: { $first: "$category.categoryName" },
					},
				},
				{ $project: { _id: 0, id: "$_id", name: 1 } },
				{ $sort: { name: 1 } },
			];

			const genderPipeline = [
				{ $match: buildMatchQuery(["gender"]) },
				{
					$lookup: {
						from: "genders",
						localField: "gender",
						foreignField: "_id",
						as: "gender",
					},
				},
				{ $unwind: "$gender" },
				{
					$group: {
						_id: "$gender._id",
						name: { $first: "$gender.genderName" },
					},
				},
				{ $project: { _id: 0, id: "$_id", name: 1 } },
				{ $sort: { name: 1 } },
			];

			const storePipeline = [
				{ $match: buildMatchQuery(["store"]) },
				{
					$lookup: {
						from: "storemanagements",
						localField: "store",
						foreignField: "_id",
						as: "storeDetails",
					},
				},
				{
					$unwind: {
						path: "$storeDetails",
						preserveNullAndEmptyArrays: false,
					},
				},
				{
					$project: {
						id: "$storeDetails._id",
						name: {
							$trim: {
								input: { $ifNull: ["$storeDetails.addStoreName", ""] },
							},
						},
					},
				},
				{ $match: { name: { $ne: "" } } },
				{
					$group: {
						_id: "$id",
						name: { $first: "$name" },
					},
				},
				{ $project: { _id: 0, id: "$_id", name: 1 } },
				{ $sort: { name: 1 } },
			];

			const [colors, sizes, categories, genders, stores] = await Promise.all([
				Product.aggregate(colorPipeline),
				Product.aggregate(sizePipeline),
				Product.aggregate(categoryPipeline),
				Product.aggregate(genderPipeline),
				Product.aggregate(storePipeline),
			]);

			// Price range: use effective price (discount when present, otherwise base price)
			const pricePipeline = [
				{ $match: buildMatchQuery(["price"]) },
				{
					$project: {
						priceCandidates: {
							$concatArrays: [
								[
									{
										$cond: [
											{ $gt: ["$priceAfterDiscount", 0] },
											"$priceAfterDiscount",
											{
												$cond: [{ $gt: ["$price", 0] }, "$price", null],
											},
										],
									},
								],
								{
									$map: {
										input: { $ifNull: ["$productAttributes", []] },
										as: "attr",
										in: {
											$cond: [
												{ $gt: ["$$attr.priceAfterDiscount", 0] },
												"$$attr.priceAfterDiscount",
												{
													$cond: [
														{ $gt: ["$$attr.price", 0] },
														"$$attr.price",
														null,
													],
												},
											],
										},
									},
								},
							],
						},
					},
				},
				{ $unwind: "$priceCandidates" },
				{ $match: { priceCandidates: { $ne: null } } },
				{
					$group: {
						_id: null,
						minPrice: { $min: "$priceCandidates" },
						maxPrice: { $max: "$priceCandidates" },
					},
				},
			];

		const [priceRange] = await Product.aggregate(pricePipeline);

		// ======================
		// Process final results
		// ======================
		let uniqueProductsMap = {};
		let finalProducts = [];

		// (1) Filter attributes by color/size if provided.
		//     Instead of pushing into finalProducts here,
		//     we build an intermediate array: processedProducts.
		const processedProducts = products
			.map((product) => {
				if (
					product &&
					product.productAttributes &&
					product.productAttributes.length > 0
				) {
					// Store all attributes to keep track
					const overallProductAttributes = [...product.productAttributes];

					// Filter by color & size
					const filteredAttributes = product.productAttributes.filter(
						(attr) => {
							let matchesColor = true;
							let matchesSize = true;

							if (colorCandidates.length > 0) {
								const attrColor = `${attr.color || ""}`.toLowerCase();
								matchesColor = colorCandidates.some(
									(candidate) => `${candidate}`.toLowerCase() === attrColor
								);
							}
							if (selectedSizes.length > 0) {
								matchesSize = selectedSizes.includes(`${attr.size || ""}`);
							}
							return matchesColor && matchesSize;
						}
					);

					if (filteredAttributes.length > 0) {
						return {
							...product,
							productAttributes: filteredAttributes,
							overallProductAttributes,
						};
					} else {
						// If no attributes match, skip
						return null;
					}
				} else {
					// Product has no attributes or is null
					return product; // if product is valid, just return
				}
			})
			.filter(Boolean); // remove null entries

		// (2) Deduplicate logic + build finalProducts
		processedProducts.forEach((product) => {
			if (product) {
				if (product.addVariables) {
					const overallProductAttributes = [...product.productAttributes];
					product.productAttributes.forEach((attr) => {
						const key = `${product._id}-${attr.color}-${attr.size}`;
						if (!uniqueProductsMap[key]) {
							uniqueProductsMap[key] = {
								...product,
								productAttributes: [attr],
								overallProductAttributes,
							};
							finalProducts.push(uniqueProductsMap[key]);
						}
					});
				} else {
					if (!uniqueProductsMap[product._id]) {
						uniqueProductsMap[product._id] = product;
						finalProducts.push(product);
					}
				}
			}
		});

			// ===============================
			// Custom Sorting w/ In-Stock First
			// ===============================
			const pinnedIds = []; // e.g. ["someObjectId1","someObjectId2"]
			const sereneStoreIds = new Set(
				(stores || [])
					.filter(
						(storeEntry) =>
							`${storeEntry?.name || ""}`.trim().toLowerCase() === "serene jannat"
					)
					.map((storeEntry) => `${storeEntry.id}`)
			);

		function getTotalQuantity(prod) {
			let attrSum = 0;
			if (prod.productAttributes && Array.isArray(prod.productAttributes)) {
				attrSum = prod.productAttributes.reduce((acc, a) => {
					return acc + (Number(a.quantity) || 0);
				}, 0);
			}
			const topLevelQty = Number(prod.quantity) || 0;
			return topLevelQty + attrSum;
		}

			finalProducts.forEach((prod) => {
				const strId = String(prod._id);
				const totalQty = getTotalQuantity(prod);
				const productStoreId = `${prod?.store || ""}`;
				const isSereneStoreProduct = sereneStoreIds.has(productStoreId);
				prod.storePriority = isSereneStoreProduct ? 0 : 1;

				if (pinnedIds.includes(strId)) {
					// pinned => top
					prod.sortRank = pinnedIds.indexOf(strId); // 0 or 1...
					prod.sortMark = "pinnedProduct";
				prod.subRank = 0; // pinned gets subRank=0
			} else if (prod.printifyProductDetails) {
				// bottom
				prod.sortRank = 3;
				prod.sortMark = "otherPrintify";
				prod.subRank = 0; // doesn't matter for rank=3
			} else {
				// normal => rank=2
				prod.sortRank = 2;
				prod.sortMark = "normalProduct";

				// subRank=0 if in-stock, else=1
				prod.subRank = totalQty > 0 ? 0 : 1;
			}
		});

		// Final sort
			finalProducts.sort((a, b) => {
				// 1. sort by rank ascending
				if (a.sortRank !== b.sortRank) {
					return a.sortRank - b.sortRank;
				}
				// 2. within same rank, prioritize Serene Jannat store
				if (a.storePriority !== b.storePriority) {
					return a.storePriority - b.storePriority;
				}
				// 3. within same rank, sort by subRank ascending
				if (a.subRank !== b.subRank) {
					return a.subRank - b.subRank;
				}
				// 4. tie-break => updatedAt descending
				return new Date(b.updatedAt) - new Date(a.updatedAt);
			});

			const totalRecords = finalProducts.length;
			const paginatedProducts = finalProducts.slice(skip, skip + recordsPerPage);

			debugFilteredProducts(
				paginatedProducts.length,
				"finalProducts.length after custom sorting"
			);

			// Return final response
			res.json({
				products: paginatedProducts,
				totalRecords,
				colors: colors.map((c) => c.color).filter(Boolean),
					sizes: sizes.map((s) => s.size).filter(Boolean),
				categories,
				genders,
				stores,
				priceRange: priceRange || { minPrice: 0, maxPrice: 0 },
			});
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: err.message });
	}
};

exports.likedProducts = async (req, res) => {
	const userId = req.params.userId;

	try {
		const products = await Product.find({
			$or: [
				{ likes: userId },
				{ "ratings.ratedBy": userId },
				{ "comments.postedBy": userId },
			],
		}).populate("category", "_id name");

		if (!products || products.length === 0) {
			return res.status(404).json({
				error: "No products found in the wishlist",
			});
		}

		res.json(products);
	} catch (err) {
		return res.status(400).json({
			error: "Error fetching wishlist products",
		});
	}
};

exports.autoCompleteProducts = async (req, res) => {
	try {
		const { query } = req.query;
		console.log(req.query, "req.query");

		// Enforce a minimum length (e.g., 4 chars)
		if (!query || query.trim().length < 4) {
			return res.json([]); // Returns a 200 status with an empty array
		}

		// Escape special regex chars in query. For example: "Glass (Test)" -> "Glass \(Test\)"
		const escapedQuery = query
			.trim()
			.replace(/[-[\]{}()*+?.,\\/^$|#\s]/g, "\\$&");

		// Wrap in .* to allow matching anywhere in the string
		const regex = new RegExp(`.*${escapedQuery}.*`, "i");

		// Adjust your search fields as desired
		const products = await Product.find({
			$or: [
				{ productName: { $regex: regex } },
				{ productSKU: { $regex: regex } },
				// Add other fields if you want them included (e.g. slug, etc.)
			],
		})
			.select("_id productName productSKU store slug thumbnailImage")
			.limit(10);

		return res.json(products); // 200 OK
	} catch (error) {
		console.error("Error in autoCompleteProducts:", error);
		return res.status(500).json({
			error: "Server error occurred while fetching product suggestions.",
		});
	}
};

exports.listProductsForSeo = async (req, res) => {
	try {
		const page = Math.max(1, Number.parseInt(req.params.page || "1", 10) || 1);
		const records = Math.min(
			500,
			Math.max(1, Number.parseInt(req.params.records || "100", 10) || 100)
		);
		const skip = (page - 1) * records;
		const match = {
			activeProduct: true,
			activeProductBySeller: { $ne: false },
		};

		const [products, totalRecords] = await Promise.all([
			Product.find(match)
				.select(
					"_id productName slug description price priceAfterDiscount price_unit quantity updatedAt createdAt brandName isPrintifyProduct category thumbnailImage printifyProductDetails productAttributes"
				)
				.populate(
					"category",
					"_id categoryName categorySlug categoryName_Arabic categoryStatus"
				)
				.sort({ updatedAt: -1 })
				.skip(skip)
				.limit(records)
				.lean(),
			Product.countDocuments(match),
		]);

		const MAX_SEO_THUMBNAIL_IMAGES = 4;
		const MAX_SEO_ATTRIBUTE_IMAGES = 10;

		const slimProducts = (products || []).map((product) => {
			const safeThumbnailImage = Array.isArray(product?.thumbnailImage)
				? product.thumbnailImage.slice(0, 2).map((thumb) => ({
						...thumb,
						images: Array.isArray(thumb?.images)
							? thumb.images.slice(0, MAX_SEO_THUMBNAIL_IMAGES)
							: [],
					}))
				: [];

			const safePrintify = product?.printifyProductDetails
				? {
						POD: product.printifyProductDetails.POD,
						id: product.printifyProductDetails.id,
						title: product.printifyProductDetails.title,
						description: product.printifyProductDetails.description,
						options: Array.isArray(product.printifyProductDetails.options)
							? product.printifyProductDetails.options.map((opt) => ({
									name: opt?.name,
									type: opt?.type,
									values: Array.isArray(opt?.values)
										? opt.values.map((value) => ({
												id: value?.id,
												title: value?.title,
												colors: Array.isArray(value?.colors)
													? value.colors
													: [],
										  }))
										: [],
								}))
							: [],
						variants: Array.isArray(product.printifyProductDetails.variants)
							? product.printifyProductDetails.variants.map((variant) => ({
									id: variant?.id,
									sku: variant?.sku,
									price: variant?.price,
									is_default: Boolean(variant?.is_default),
									is_enabled: variant?.is_enabled !== false,
									options: Array.isArray(variant?.options)
										? variant.options
										: [],
							  }))
							: [],
						images: Array.isArray(product.printifyProductDetails.images)
							? product.printifyProductDetails.images
									.slice(0, 24)
									.map((image) => ({
										src: image?.src || image?.url || "",
										variant_ids: Array.isArray(image?.variant_ids)
											? image.variant_ids
											: [],
										is_default: Boolean(image?.is_default),
										position: image?.position || image?.placeholder || "",
										camera_label:
											image?.camera_label || image?.cameraLabel || "",
									}))
							: [],
					}
				: {};

			const safeProductAttributes = Array.isArray(product?.productAttributes)
				? product.productAttributes.map((attr) => ({
						PK: attr?.PK,
						SubSKU: attr?.SubSKU,
						size: attr?.size,
						color: attr?.color,
						scent: attr?.scent,
						price: attr?.price,
						priceAfterDiscount: attr?.priceAfterDiscount,
						quantity: attr?.quantity,
						exampleDesignImage: attr?.exampleDesignImage || null,
						productImages: Array.isArray(attr?.productImages)
							? attr.productImages.slice(0, MAX_SEO_ATTRIBUTE_IMAGES)
							: [],
						defaultDesigns: Array.isArray(attr?.defaultDesigns)
							? attr.defaultDesigns.map((designSet) => ({
									occassion: designSet?.occassion || designSet?.occasion || "",
									defaultDesignImages: Array.isArray(
										designSet?.defaultDesignImages
									)
										? designSet.defaultDesignImages
										: [],
								}))
							: [],
					}))
				: [];

			return {
				_id: product?._id,
				productName: product?.productName,
				slug: product?.slug,
				description: product?.description,
				price: product?.price,
				priceAfterDiscount: product?.priceAfterDiscount,
				price_unit: product?.price_unit,
				quantity: product?.quantity,
				updatedAt: product?.updatedAt,
				createdAt: product?.createdAt,
				brandName: product?.brandName,
				isPrintifyProduct: product?.isPrintifyProduct,
				category: product?.category || null,
				thumbnailImage: safeThumbnailImage,
				printifyProductDetails: safePrintify,
				productAttributes: safeProductAttributes,
			};
		});

		return res.json({
			page,
			records,
			totalRecords,
			hasMore: skip + slimProducts.length < totalRecords,
			products: slimProducts,
		});
	} catch (error) {
		console.error("Error in listProductsForSeo:", error);
		return res.status(500).json({
			error: "Server error while preparing SEO products.",
			details: error?.message || "unknown_error",
		});
	}
};
