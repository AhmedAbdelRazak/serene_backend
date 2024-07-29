/** @format */

const Product = require("../models/product");
const User = require("../models/user");
const Category = require("../models/category"); // Adjust paths as necessary
const Subcategory = require("../models/subcategory"); // Adjust paths as necessary
const Gender = require("../models/gender"); // Adjust paths as necessary
const querystring = require("querystring");
const mongoose = require("mongoose");
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
		const products = await Product.find()
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

exports.gettingSpecificSetOfProducts = (req, res, next) => {
	const { featured, newArrivals, sortByRate, offers, records } = req.params;

	let query = { activeProduct: true };
	let pipeline = [];

	// For featured products
	if (featured === "1") {
		query.featuredProduct = true;
	}

	// For new arrivals, no need to modify the query, we'll handle sorting later
	if (newArrivals === "1") {
		// If newArrivals is requested, it will be handled in the sorting stage
		pipeline.push({ $sort: { createdAt: -1 } });
	}

	// Handle sorting by rating
	if (sortByRate === "1") {
		pipeline.push(
			{ $match: { ...query, ratings: { $exists: true, $not: { $size: 0 } } } },
			{ $addFields: { ratingsCount: { $size: "$ratings" } } },
			{ $sort: { ratingsCount: -1 } }
		);
	}

	// For offers
	if (offers === "1") {
		query.$or = [
			{ $expr: { $gt: ["$MSRPPriceBasic", "$priceAfterDiscount"] } },
			{ $expr: { $gt: ["$price", "$priceAfterDiscount"] } },
		];
	}

	// Add the match stage
	pipeline.push({ $match: query });

	// Add the lookup stage to populate the category
	pipeline.push({
		$lookup: {
			from: "categories",
			localField: "category",
			foreignField: "_id",
			as: "category",
		},
	});

	// Unwind the category array
	pipeline.push({ $unwind: "$category" });

	// Limit the number of records if specified
	if (records) {
		pipeline.push({ $limit: parseInt(records) });
	}

	// Execute the aggregation pipeline
	Product.aggregate(pipeline)
		.then((products) => {
			// Check if any product was returned when sorting by rate; if none, fallback to featured
			if (sortByRate === "1" && products.length === 0 && featured !== "1") {
				return Product.find({ activeProduct: true, featuredProduct: true })
					.limit(parseInt(records))
					.populate("category") // Populate category here as well
					.lean();
			}
			return products;
		})
		.then((products) => {
			const processedProducts = products
				.map((product) => {
					if (
						product.productAttributes &&
						product.productAttributes.length > 0
					) {
						// Group by color
						const byColor = product.productAttributes.reduce((acc, attr) => {
							acc[attr.color] = acc[attr.color] || {
								...product,
								productAttributes: [],
								thumbnailImage: product.thumbnailImage,
							};
							acc[attr.color].productAttributes.push(attr);
							return acc;
						}, {});

						// Return an array of products split by color
						return Object.values(byColor);
					}
					// Return simple products as is
					return [product];
				})
				.flat();
			res.json(processedProducts);
		})
		.catch((err) => {
			res.status(500).json({ error: err.message });
		});
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
		// query.category.categoryStatus = true;
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

		// Search term filter
		if (searchTerm) {
			console.log(`Filtering by search term: ${searchTerm}`);
			query.$text = { $search: searchTerm };
		}
	}

	// Pagination
	const pageNumber = parseInt(page, 10) || 1;
	const recordsPerPage = parseInt(records, 10) || 10;
	const skip = (pageNumber - 1) * recordsPerPage;

	// Add match stage to pipeline
	const pipeline = [{ $match: query }];

	pipeline.push({ $sort: { createdAt: -1 } });

	// Clone the pipeline to count the total number of records
	const countPipeline = [...pipeline, { $count: "totalRecords" }];

	// Add skip and limit for pagination
	pipeline.push({ $skip: skip });
	pipeline.push({ $limit: recordsPerPage });

	// Add the lookup stages to populate the references
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

	// Unwind the arrays
	pipeline.push(
		{ $unwind: "$category" },
		{ $unwind: "$subcategory" },
		{ $unwind: "$gender" }
	);

	try {
		const [totalResult, products] = await Promise.all([
			Product.aggregate(countPipeline),
			Product.aggregate(pipeline),
		]);

		const totalRecords = totalResult.length ? totalResult[0].totalRecords : 0;

		// Extract unique colors, sizes, and categories
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

		// Calculate the min and max prices
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

		// Ensure to clear the uniqueProductsMap for every new request
		let uniqueProductsMap = {};
		let finalProducts = [];

		const processedProducts = products
			.map((product) => {
				if (
					product &&
					product.productAttributes &&
					product.productAttributes.length > 0
				) {
					// Store all attributes
					const overallProductAttributes = [...product.productAttributes];

					// Filter product attributes by color and size if provided
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
						// Only add product with matching attributes
						const newProduct = {
							...product,
							productAttributes: filteredAttributes,
							overallProductAttributes, // Add overall attributes to the product object
						};
						finalProducts.push(newProduct);
					}
				} else if (product) {
					// Return simple products as is
					finalProducts.push(product);
				}
			})
			.flat();

		processedProducts.forEach((product) => {
			if (product) {
				if (product.addVariables) {
					// For products with variables, consider the attribute logic
					const overallProductAttributes = [...product.productAttributes]; // Store all attributes
					product.productAttributes.forEach((attr) => {
						const key = `${product._id}-${attr.color}-${attr.size}`;
						if (!uniqueProductsMap[key]) {
							uniqueProductsMap[key] = {
								...product,
								productAttributes: [attr],
								overallProductAttributes, // Add overall attributes to the product object
							};
							finalProducts.push(uniqueProductsMap[key]);
						}
					});
				} else {
					// For products without variables, ensure unique IDs
					if (!uniqueProductsMap[product._id]) {
						uniqueProductsMap[product._id] = product;
						finalProducts.push(product);
					}
				}
			}
		});

		console.log(finalProducts.length, "finalProducts.length");

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
		console.error(err); // Log the error to see what it is
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
