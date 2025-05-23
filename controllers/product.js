/** @format */

const ActiveCategories = require("../models/activeCategories");
const Product = require("../models/product");
const User = require("../models/user");
const Category = require("../models/category"); // Adjust paths as necessary
const Subcategory = require("../models/subcategory"); // Adjust paths as necessary
const Gender = require("../models/gender"); // Adjust paths as necessary
const querystring = require("querystring");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const axios = require("axios");

exports.productById = async (req, res, next, id) => {
	try {
		const product = await Product.findById(id)
			.populate("ratings.ratedBy", "_id name email")
			.populate("comments.postedBy", "_id name email")
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
			return res.status(400).json({
				error: "Product not found",
			});
		}

		req.product = product;
		next();
	} catch (err) {
		res.status(400).json({ error: "Product not found" });
	}
};

exports.read = (req, res) => {
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
	let order = req.query.order ? req.query.order : "desc";
	let sortBy = req.query.sortBy ? req.query.sortBy : "viewsCount";
	let limit = req.query.limit ? parseInt(req.query.limit) : 200;

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
	let order = req.query.order ? req.query.order : "desc";
	let sortBy = req.query.sortBy ? req.query.sortBy : "viewsCount";
	let limit = req.query.limit ? parseInt(req.query.limit) : 200;

	try {
		const products = await Product.find({
			"printifyProductDetails.POD": true,
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
		.populate("comments.postedBy", "_id name email")
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
			.populate("comments.postedBy", "_id name email")
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
			.populate("comments.postedBy", "_id name email")
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

		// 1) Build baseMatch
		let baseMatch = { activeProduct: true };

		if (storeId) {
			baseMatch.store = new ObjectId(storeId);
		}
		if (customDesigns === "1") {
			baseMatch["printifyProductDetails.POD"] = true;
		}
		if (featured === "1") {
			baseMatch.featuredProduct = true;
			baseMatch["printifyProductDetails.POD"] = { $ne: true };
		}

		let pipeline = [];

		// (A) Match base
		pipeline.push({ $match: baseMatch });

		// (B) Lookup store + ensure store is active
		pipeline.push(
			{
				$lookup: {
					from: "storemanagements", // Adjust if your store collection is named differently
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

		// If newArrivals=1 => exclude POD
		if (newArrivals === "1") {
			pipeline.push({
				$match: {
					"printifyProductDetails.POD": { $ne: true },
				},
			});
		}

		// (C) Category / Subcategory / Gender lookups
		pipeline.push(
			{
				$lookup: {
					from: Category.collection.name,
					localField: "category",
					foreignField: "_id",
					as: "categoryDetails",
				},
			},
			{ $unwind: "$categoryDetails" },
			{
				$match: {
					"categoryDetails.categoryStatus": true,
					// Exclude category "6691981f25cf79d0a7dca70e"
					"categoryDetails._id": {
						$ne: new ObjectId("6691981f25cf79d0a7dca70e"),
					},
				},
			},
			{
				$lookup: {
					from: Subcategory.collection.name,
					localField: "subcategory",
					foreignField: "_id",
					as: "subcategoryDetails",
				},
			},
			{ $unwind: "$subcategoryDetails" },
			{
				$match: {
					"subcategoryDetails.subCategoryStatus": true,
				},
			},
			{
				$lookup: {
					from: Gender.collection.name,
					localField: "gender",
					foreignField: "_id",
					as: "genderDetails",
				},
			},
			{ $unwind: "$genderDetails" },
			{
				$match: {
					"genderDetails.genderNameStatus": true,
				},
			}
		);

		// (D) Exclude out-of-stock => totalQuantity > 0
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
				$match: { totalQuantity: { $gt: 0 } },
			}
		);

		// (E) Group
		pipeline.push({
			$group: {
				_id: null,
				categories: { $addToSet: "$categoryDetails" },
				subcategories: { $addToSet: "$subcategoryDetails" },
				genders: { $addToSet: "$genderDetails" },
				chosenSeasons: { $addToSet: "$chosenSeason" },
			},
		});

		const results = await Product.aggregate(pipeline);

		let categories = [];
		let subcategories = [];
		let genders = [];
		let chosenSeasons = [];

		if (results && results.length > 0) {
			const data = results[0];
			categories = data.categories;
			subcategories = data.subcategories;
			genders = data.genders;
			chosenSeasons = data.chosenSeasons.filter((season) => season); // filter out null/undefined
		}

		// 2) Delete any existing docs in ActiveCategories
		await ActiveCategories.deleteMany({});

		// 3) Create a new doc
		const doc = new ActiveCategories({
			categories,
			subcategories,
			genders,
			chosenSeasons,
		});

		await doc.save();

		// 4) Return newly created doc
		res.json({
			message: "ActiveCategories updated successfully",
			activeCategories: doc,
		});
	} catch (error) {
		console.error("Error in createDistinctCategoriesActiveProducts:", error);
		res.status(500).json({
			error: "There was an error creating/updating active categories.",
		});
	}
};

exports.getDistinctCategoriesActiveProducts = async (req, res) => {
	try {
		// If you only store one doc, you can do findOne() without sorting.
		// Or if you want the latest updated doc, we can sort descending by createdAt.
		const doc = await ActiveCategories.findOne().sort({ createdAt: -1 });

		if (!doc) {
			// No doc found, return empty arrays
			return res.json({
				categories: [],
				subcategories: [],
				genders: [],
				chosenSeasons: [],
			});
		}

		// Return the arrays from the stored doc
		return res.json({
			categories: doc.categories || [],
			subcategories: doc.subcategories || [],
			genders: doc.genders || [],
			chosenSeasons: doc.chosenSeasons || [],
		});
	} catch (error) {
		console.error("Error in getDistinctCategoriesActiveProducts:", error);
		return res
			.status(500)
			.json({ error: "There was an error retrieving active categories." });
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

		const { skip, storeId } = req.query; // from query

		// Convert them to numbers if needed
		const limitNumber = parseInt(records, 10) || 5;
		const skipNumber = parseInt(skip, 10) || 0;

		// 1) Base match
		let baseMatch = { activeProduct: true };

		// 2) If storeId is provided, match that store
		if (storeId) {
			baseMatch.store = new ObjectId(storeId);
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
				"category._id": { $ne: new ObjectId("6691981f25cf79d0a7dca70e") },
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

		return res.json(processedProducts);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: err.message });
	}
};

exports.readSingleProduct = async (req, res, next) => {
	const { slug, categorySlug, productId } = req.params;

	try {
		const product = await Product.findOne({ _id: productId, slug: slug })
			.populate({
				path: "category",
				match: { categorySlug: categorySlug },
				select: "categoryName categorySlug thumbnail categoryName_Arabic",
			})
			.populate(
				"subcategory",
				"SubcategoryName SubcategorySlug subCategoryStatus"
			)
			.populate("ratings.ratedBy", "_id name email")
			.populate("comments.postedBy", "_id name email")
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
			return res.status(400).json({
				error: "Product not found",
			});
		}

		res.json(product);
	} catch (err) {
		res.status(400).json({ error: "Product not found" });
	}
};

exports.getDistinctCategoriesActiveProducts = (req, res, next) => {
	Product.aggregate([
		{ $match: { activeProduct: true } }, // Match only active products

		// Join with the Category collection
		{
			$lookup: {
				from: Category.collection.name,
				localField: "category",
				foreignField: "_id",
				as: "categoryDetails",
			},
		},
		{ $unwind: "$categoryDetails" },
		{ $match: { "categoryDetails.categoryStatus": true } }, // Ensure the category is active

		// Join with the Subcategory collection
		{
			$lookup: {
				from: Subcategory.collection.name,
				localField: "subcategory",
				foreignField: "_id",
				as: "subcategoryDetails",
			},
		},
		{ $unwind: "$subcategoryDetails" },
		{ $match: { "subcategoryDetails.subCategoryStatus": true } }, // Ensure the subcategory is active

		// Join with the Gender collection
		{
			$lookup: {
				from: Gender.collection.name,
				localField: "gender",
				foreignField: "_id",
				as: "genderDetails",
			},
		},
		{ $unwind: "$genderDetails" },
		{ $match: { "genderDetails.genderNameStatus": true } }, // Ensure the gender is active

		// Grouping to get distinct values
		{
			$group: {
				_id: null,
				categories: { $addToSet: "$categoryDetails" },
				subcategories: { $addToSet: "$subcategoryDetails" },
				genders: { $addToSet: "$genderDetails" },
				chosenSeasons: { $addToSet: "$chosenSeason" },
			},
		},
	])
		.then((result) => {
			if (result && result.length > 0) {
				res.json({
					categories: result[0].categories,
					subcategories: result[0].subcategories,
					genders: result[0].genders,
					chosenSeasons: result[0].chosenSeasons.filter((season) => season), // Filter to remove any null or undefined seasons
				});
			} else {
				res.json({
					categories: [],
					subcategories: [],
					genders: [],
					chosenSeasons: [],
				});
			}
		})
		.catch((error) => {
			res
				.status(500)
				.json({ error: "There was an error processing your request." });
		});
};

exports.filteredProducts = async (req, res, next) => {
	const { page, records, filters } = req.params;
	let {
		color,
		priceMin,
		priceMax,
		category,
		size,
		gender,
		searchTerm,
		offers,
	} = querystring.parse(filters);

	console.log(offers, "offersoffersoffers");

	// Decode the color parameter
	color = querystring.unescape(color);

	let query = { activeProduct: true };

	if (offers === "jannatoffers") {
		console.log("Jannat Offers Was Triggered");
		query.$or = [
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
		];
	} else {
		// Filter by color
		if (color) {
			console.log(`Filtering by color: ${color}`);
			query.$or = [{ color: color }, { "productAttributes.color": color }];
		}

		// Filter by price range
		if (priceMin && priceMax) {
			console.log(`Filtering by price range: ${priceMin} - ${priceMax}`);
			query.priceAfterDiscount = {
				$gte: Number(priceMin),
				$lte: Number(priceMax),
			};
		} else if (priceMin) {
			console.log(`Filtering by minimum price: ${priceMin}`);
			query.priceAfterDiscount = { $gte: Number(priceMin) };
		} else if (priceMax) {
			console.log(`Filtering by maximum price: ${priceMax}`);
			query.priceAfterDiscount = { $lte: Number(priceMax) };
		}

		// Filter by category
		if (category) {
			console.log(`Filtering by category: ${category}`);
			query.category = new mongoose.Types.ObjectId(category);
		} else {
			console.log(`No category filter applied`);
		}

		// Filter by size
		if (size) {
			console.log(`Filtering by size: ${size}`);
			query.$or = [{ size: size }, { "productAttributes.size": size }];
		}

		// Filter by gender
		if (gender) {
			console.log(`Filtering by gender: ${gender}`);
			if (mongoose.Types.ObjectId.isValid(gender)) {
				query.gender = new mongoose.Types.ObjectId(gender);
			} else {
				return res.status(400).json({ error: "Invalid gender ID" });
			}
		}

		// Search term
		if (searchTerm) {
			console.log(`Filtering by search term: ${searchTerm}`);
			query.$text = { $search: searchTerm };
		}
	}

	// Pagination
	const pageNumber = parseInt(page, 10) || 1;
	const recordsPerPage = parseInt(records, 10) || 10;
	const skip = (pageNumber - 1) * recordsPerPage;

	// Build the initial aggregation pipeline
	const pipeline = [{ $match: query }];

	// Sort by createdAt descending initially
	pipeline.push({ $sort: { createdAt: -1 } });

	// Clone pipeline for counting
	const countPipeline = [...pipeline, { $count: "totalRecords" }];

	// Pagination
	pipeline.push({ $skip: skip });
	pipeline.push({ $limit: recordsPerPage });

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
		{ $unwind: "$category" },
		{ $unwind: "$subcategory" },
		{ $unwind: "$gender" }
	);

	try {
		// Parallel fetch
		const [totalResult, products] = await Promise.all([
			Product.aggregate(countPipeline),
			Product.aggregate(pipeline),
		]);

		const totalRecords = totalResult.length ? totalResult[0].totalRecords : 0;

		// Additional pipelines for color, size, category, gender
		const colorPipeline = [
			{ $match: { activeProduct: true } },
			{ $unwind: "$productAttributes" },
			{ $group: { _id: "$productAttributes.color" } },
			{ $project: { _id: 0, color: "$_id" } },
			{ $sort: { color: 1 } },
		];

		const sizePipeline = [
			{ $match: { activeProduct: true } },
			{ $unwind: "$productAttributes" },
			{ $group: { _id: "$productAttributes.size" } },
			{ $project: { _id: 0, size: "$_id" } },
			{ $sort: { size: 1 } },
		];

		const categoryPipeline = [
			{ $match: { activeProduct: true } },
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
			{ $match: { activeProduct: true } },
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

		const [colors, sizes, categories, genders] = await Promise.all([
			Product.aggregate(colorPipeline),
			Product.aggregate(sizePipeline),
			Product.aggregate(categoryPipeline),
			Product.aggregate(genderPipeline),
		]);

		// Price range
		const pricePipeline = [
			{ $match: { activeProduct: true } },
			{
				$project: {
					price: {
						$cond: {
							if: { $gt: [{ $size: "$productAttributes" }, 0] },
							then: { $min: "$productAttributes.priceAfterDiscount" },
							else: "$priceAfterDiscount",
						},
					},
				},
			},
			{
				$group: {
					_id: null,
					minPrice: { $min: "$price" },
					maxPrice: { $max: "$price" },
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

							if (color) {
								matchesColor = attr.color === color;
							}
							if (size) {
								matchesSize = attr.size === size;
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
			// 2. within same rank, sort by subRank ascending
			if (a.subRank !== b.subRank) {
				return a.subRank - b.subRank;
			}
			// 3. tie-break => updatedAt descending
			return new Date(b.updatedAt) - new Date(a.updatedAt);
		});

		console.log(
			finalProducts.length,
			"finalProducts.length after custom sorting"
		);

		// Return final response
		res.json({
			products: finalProducts,
			totalRecords,
			colors: colors.map((c) => c.color),
			sizes: sizes.map((s) => s.size),
			categories,
			genders,
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
