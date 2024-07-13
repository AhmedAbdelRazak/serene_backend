const axios = require("axios");
const Category = require("../models/category");
const Product = require("../models/product");
const slugify = require("slugify");
const Subcategory = require("../models/subcategory");
const Colors = require("../models/colors");

exports.printifyProducts = async (req, res) => {
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

		// Check if there are shops in the response
		if (shopResponse.data && shopResponse.data.length > 0) {
			const shopId = shopResponse.data[0].id; // Assuming you want the first shop ID

			// Fetch the products for the Shop ID
			const productsResponse = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products.json`,
				{
					headers: {
						Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
					},
				}
			);

			// Check if there are products in the response
			if (productsResponse.data && productsResponse.data.data.length > 0) {
				// Filter products to only include those with is_enabled: true
				const enabledProducts = productsResponse.data.data
					.filter((product) =>
						product.variants.some((variant) => variant.is_enabled)
					)
					.map((product) => ({
						...product,
						variants: product.variants.filter((variant) => variant.is_enabled),
					}));

				return res.json({
					shopId,
					products: enabledProducts,
				});
			} else {
				return res
					.status(404)
					.json({ error: "No products found for the shop" });
			}
		} else {
			return res.status(404).json({ error: "No shops found" });
		}
	} catch (error) {
		console.error("Error fetching products:", error);
		return res.status(500).json({ error: "Error fetching products" });
	}
};

exports.removeAllPrintifyProducts = async (req, res) => {
	try {
		// Remove all products where isPrintifyProduct is true
		const result = await Product.deleteMany({ isPrintifyProduct: true });

		// Respond with the result of the deletion
		return res.json({
			message: "All Printify products have been removed",
			deletedCount: result.deletedCount,
		});
	} catch (error) {
		console.error("Error removing Printify products:", error);
		return res.status(500).json({ error: "Error removing Printify products" });
	}
};

const sizeOrder = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

exports.syncPrintifyProducts = async (req, res) => {
	try {
		// Fetch all categories and subcategories sorted by createdAt in descending order
		const categories = await Category.find().sort({ createdAt: -1 });
		const subcategories = await Subcategory.find();
		const colors = await Colors.find();

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

			// Fetch the products for the Shop ID
			const productsResponse = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products.json`,
				{
					headers: {
						Authorization: `Bearer ${process.env.PRINTIFY_TOKEN}`,
					},
				}
			);

			if (productsResponse.data && productsResponse.data.data.length > 0) {
				const printifyProducts = productsResponse.data.data;
				const failedProducts = [];
				const addedProducts = [];

				// Loop through each product and either update or create in the database
				for (const printifyProduct of printifyProducts) {
					// Find matching category
					const matchingCategory = categories.find((category) =>
						printifyProduct.tags.some(
							(tag) =>
								tag
									.toLowerCase()
									.includes(category.categoryName.toLowerCase()) ||
								tag.toLowerCase().includes(category.categorySlug.toLowerCase())
						)
					);

					if (!matchingCategory) {
						failedProducts.push(printifyProduct.title);
						continue; // Skip this product if no matching category is found
					}

					// Find subcategories based on the matching category
					const matchingSubcategories = subcategories.filter(
						(subcategory) =>
							subcategory.categoryId.toString() ===
							matchingCategory._id.toString()
					);

					// Generate slug from product title
					const productSlug = slugify(printifyProduct.title, {
						lower: true,
						strict: true,
					});

					// Generate slug_Arabic from product title (assuming Arabic translation is not provided)
					const productSlugArabic = slugify(printifyProduct.title, {
						lower: true,
						strict: true,
					});

					// Determine if the product has variables
					const addVariables =
						printifyProduct.options && printifyProduct.options.length > 0;

					// Handle candles with variables as separate products
					if (
						printifyProduct.title.toLowerCase().includes("candle") ||
						printifyProduct.tags.some((tag) =>
							tag.toLowerCase().includes("candles")
						)
					) {
						if (addVariables) {
							for (const variant of printifyProduct.variants) {
								if (!variant.is_enabled) continue;

								// Extract scent if available
								const scentOption = printifyProduct.options.find(
									(option) => option.type === "scent"
								);
								const scent = scentOption
									? scentOption.values.find(
											(value) => value.id === variant.options[0]
									  )
										? scentOption.values.find(
												(value) => value.id === variant.options[0]
										  ).title
										: null
									: null;

								const variantImages = printifyProduct.images.filter((image) =>
									image.variant_ids.includes(variant.id)
								);

								const productData = {
									productName: `${printifyProduct.title} - ${variant.title}`,
									description: printifyProduct.description,
									price: (variant.price / 100) * 1.75,
									priceAfterDiscount: variant.price / 100,
									MSRPPriceBasic: Number((variant.price / 100) * 0.75).toFixed(
										2
									),
									quantity: 10,
									slug: `${productSlug}-${variant.options.join("-")}`,
									slug_Arabic: `${productSlugArabic}-${variant.options.join(
										"-"
									)}`,
									category: matchingCategory._id,
									subcategory: matchingSubcategories.map(
										(subcategory) => subcategory._id
									),
									gender: "6635ab22898104005c96250a",
									chosenSeason: "all",
									thumbnailImage: [
										{
											images: variantImages.map((image) => ({
												public_id: image.variant_ids.join("_"),
												url: image.src,
											})),
										},
									],
									isPrintifyProduct: true,
									addVariables: false,
									printifyProductDetails: {
										id: printifyProduct.id,
										title: printifyProduct.title,
										description: printifyProduct.description,
										tags: printifyProduct.tags,
										options: printifyProduct.options,
										variants: [variant],
										images: printifyProduct.images,
										created_at: printifyProduct.created_at,
										updated_at: printifyProduct.updated_at,
										visible: printifyProduct.visible,
										is_locked: printifyProduct.is_locked,
										blueprint_id: printifyProduct.blueprint_id,
										user_id: printifyProduct.user_id,
										shop_id: printifyProduct.shop_id,
										print_provider_id: printifyProduct.print_provider_id,
										print_areas: printifyProduct.print_areas,
										print_details: printifyProduct.print_details,
										sales_channel_properties:
											printifyProduct.sales_channel_properties,
										is_printify_express_eligible:
											printifyProduct.is_printify_express_eligible,
										is_printify_express_enabled:
											printifyProduct.is_printify_express_enabled,
										is_economy_shipping_eligible:
											printifyProduct.is_economy_shipping_eligible,
										is_economy_shipping_enabled:
											printifyProduct.is_economy_shipping_enabled,
									},
									scent: scent,
									productAttributes: [],
								};

								// Find product by SKU
								let product = await Product.findOne({
									productSKU: variant.sku,
								});

								if (product) {
									// Update existing product
									await Product.updateOne({ _id: product._id }, productData);
									addedProducts.push(
										`Updated product: ${productData.productName}`
									);
								} else {
									// Create new product
									const newProduct = new Product({
										productSKU: variant.sku,
										...productData,
										// Add other necessary fields with default or empty values
									});

									await newProduct.save();
									addedProducts.push(
										`Added product: ${newProduct.productName}`
									);
								}
							}
						} else {
							// Handle candles without variables normally
							const productData = {
								productName: printifyProduct.title,
								description: printifyProduct.description,
								price: (printifyProduct.variants[0].price / 100) * 1.75,
								priceAfterDiscount: printifyProduct.variants[0].price / 100,
								MSRPPriceBasic: Number(
									(printifyProduct.variants[0].price / 100) * 0.75
								).toFixed(2),
								quantity: 10,
								slug: productSlug,
								slug_Arabic: productSlugArabic,
								category: matchingCategory._id, // Assign the matching category ID
								subcategory: matchingSubcategories.map(
									(subcategory) => subcategory._id
								), // Assign matching subcategory IDs
								gender: "6635ab22898104005c96250a",
								chosenSeason: "all",
								thumbnailImage: [
									{
										images: printifyProduct.images
											.slice(0, 5)
											.sort(() => 0.5 - Math.random()) // Shuffle images
											.map((image) => ({
												public_id: image.variant_ids.join("_"),
												url: image.src,
											})),
									},
								],
								isPrintifyProduct: true,
								addVariables: false,
								printifyProductDetails: {
									id: printifyProduct.id,
									title: printifyProduct.title,
									description: printifyProduct.description,
									tags: printifyProduct.tags,
									options: printifyProduct.options,
									variants: printifyProduct.variants,
									images: printifyProduct.images,
									created_at: printifyProduct.created_at,
									updated_at: printifyProduct.updated_at,
									visible: printifyProduct.visible,
									is_locked: printifyProduct.is_locked,
									blueprint_id: printifyProduct.blueprint_id,
									user_id: printifyProduct.user_id,
									shop_id: printifyProduct.shop_id,
									print_provider_id: printifyProduct.print_provider_id,
									print_areas: printifyProduct.print_areas,
									print_details: printifyProduct.print_details,
									sales_channel_properties:
										printifyProduct.sales_channel_properties,
									is_printify_express_eligible:
										printifyProduct.is_printify_express_eligible,
									is_printify_express_enabled:
										printifyProduct.is_printify_express_enabled,
									is_economy_shipping_eligible:
										printifyProduct.is_economy_shipping_eligible,
									is_economy_shipping_enabled:
										printifyProduct.is_economy_shipping_enabled,
								},
								productAttributes: [],
							};

							// Find product by SKU
							let product = await Product.findOne({
								productSKU: printifyProduct.variants[0].sku,
							});

							if (product) {
								// Update existing product
								await Product.updateOne({ _id: product._id }, productData);
								addedProducts.push(
									`Updated product: ${productData.productName}`
								);
							} else {
								// Create new product
								const newProduct = new Product({
									productSKU: printifyProduct.variants[0].sku,
									...productData,
									// Add other necessary fields with default or empty values
								});

								await newProduct.save();
								addedProducts.push(`Added product: ${newProduct.productName}`);
							}
						}
					} else {
						// Handle other products normally
						const colorOption = printifyProduct.options.find(
							(option) => option.type === "color"
						);

						let colorValue = null;
						if (colorOption) {
							const variantOption = printifyProduct.variants[0].options[0];
							const colorMatch = colorOption.values.find(
								(value) => value.id === variantOption
							);
							colorValue = colorMatch ? colorMatch.colors[0] : null;
						}

						const closestColor = colorValue ? colorValue : null;

						if (!closestColor) {
							failedProducts.push(printifyProduct.title);
							continue; // Skip this product if no matching color is found
						}

						// Sorting sizes based on the defined order
						const sortedVariants = printifyProduct.variants
							.filter((variant) => variant.is_enabled)
							.sort((a, b) => {
								const sizeA = sizeOrder.indexOf(
									printifyProduct.options
										.find((option) => option.type === "size")
										.values.find((value) => value.id === a.options[1]).title
								);
								const sizeB = sizeOrder.indexOf(
									printifyProduct.options
										.find((option) => option.type === "size")
										.values.find((value) => value.id === b.options[1]).title
								);
								return sizeA - sizeB;
							});

						const productData = {
							productName: printifyProduct.title,
							description: printifyProduct.description,
							price: (sortedVariants[0].price / 100) * 1.75,
							priceAfterDiscount: sortedVariants[0].price / 100,
							MSRPPriceBasic: Number(
								(sortedVariants[0].price / 100) * 0.75
							).toFixed(2),
							quantity: 10,
							slug: productSlug,
							slug_Arabic: productSlugArabic,
							category: matchingCategory._id, // Assign the matching category ID
							subcategory: matchingSubcategories.map(
								(subcategory) => subcategory._id
							), // Assign matching subcategory IDs
							gender: "6635ab22898104005c96250a",
							chosenSeason: "all",
							thumbnailImage: [
								{
									images: printifyProduct.images
										.filter((image) =>
											image.variant_ids.some((id) =>
												printifyProduct.variants
													.filter((variant) => variant.is_enabled)
													.map((v) => v.id)
													.includes(id)
											)
										)
										.slice(0, 5)
										.map((image) => ({
											public_id: image.variant_ids.join("_"),
											url: image.src,
										})),
								},
							],
							isPrintifyProduct: true,
							addVariables: addVariables,
							printifyProductDetails: {
								id: printifyProduct.id,
								title: printifyProduct.title,
								description: printifyProduct.description,
								tags: printifyProduct.tags,
								options: printifyProduct.options,
								variants: sortedVariants,
								images: printifyProduct.images,
								created_at: printifyProduct.created_at,
								updated_at: printifyProduct.updated_at,
								visible: printifyProduct.visible,
								is_locked: printifyProduct.is_locked,
								blueprint_id: printifyProduct.blueprint_id,
								user_id: printifyProduct.user_id,
								shop_id: printifyProduct.shop_id,
								print_provider_id: printifyProduct.print_provider_id,
								print_areas: printifyProduct.print_areas,
								print_details: printifyProduct.print_details,
								sales_channel_properties:
									printifyProduct.sales_channel_properties,
								is_printify_express_eligible:
									printifyProduct.is_printify_express_eligible,
								is_printify_express_enabled:
									printifyProduct.is_printify_express_enabled,
								is_economy_shipping_eligible:
									printifyProduct.is_economy_shipping_eligible,
								is_economy_shipping_enabled:
									printifyProduct.is_economy_shipping_enabled,
							},
							productAttributes: addVariables
								? sortedVariants.map((variant) => {
										const sizeOption = printifyProduct.options.find(
											(option) => option.type === "size"
										);
										const scentOption = printifyProduct.options.find(
											(option) => option.type === "scent"
										);

										const variantImages = printifyProduct.images
											.filter((image) => image.variant_ids.includes(variant.id))
											.slice(0, 8); // Limit to 8 images

										const color = printifyProduct.options.find(
											(option) => option.type === "color"
										);

										const colorValue = color
											? color.values.find(
													(value) => value.id === variant.options[0]
											  )
												? color.values.find(
														(value) => value.id === variant.options[0]
												  ).colors[0]
												: null
											: null;

										return {
											PK: `${variant.options.join("#")}`,
											color: colorValue,
											size: sizeOption
												? sizeOption.values.find(
														(value) => value.id === variant.options[1]
												  )
													? sizeOption.values.find(
															(value) => value.id === variant.options[1]
													  ).title
													: null
												: null,
											scent: scentOption
												? scentOption.values.find(
														(value) => value.id === variant.options[0]
												  )
													? scentOption.values.find(
															(value) => value.id === variant.options[0]
													  ).title
													: null
												: null,
											SubSKU: variant.sku,
											quantity: 10,
											price: (variant.price / 100) * 1.75,
											priceAfterDiscount: variant.price / 100,
											MSRP: Number((variant.price / 100) * 0.75).toFixed(2),
											WholeSalePrice: Number(
												(variant.price / 100) * 0.75
											).toFixed(2), // Assuming a wholesale price calculation
											DropShippingPrice: Number(
												(variant.price / 100) * 0.85
											).toFixed(2), // Assuming a dropshipping price calculation
											productImages: variantImages.map((image) => ({
												public_id: image.variant_ids.join("_"),
												url: image.src,
											})),
										};
								  })
								: [],
						};

						// Find product by SKU
						let product = await Product.findOne({
							productSKU: printifyProduct.variants[0].sku,
						});

						if (product) {
							// Update existing product
							await Product.updateOne({ _id: product._id }, productData);
							addedProducts.push(`Updated product: ${productData.productName}`);
						} else {
							// Create new product
							const newProduct = new Product({
								productSKU: printifyProduct.variants[0].sku,
								...productData,
								// Add other necessary fields with default or empty values
							});

							await newProduct.save();
							addedProducts.push(`Added product: ${newProduct.productName}`);
						}
					}
				}

				const recommendations = failedProducts.map((productTitle) => {
					return {
						productTitle,
						recommendation: "Add a category that matches this product",
					};
				});

				if (failedProducts.length > 0) {
					res.status(207).json({
						message: `Products synced with some failures. ${addedProducts.length} products added, ${failedProducts.length} products failed.`,
						failedProducts,
						recommendations,
					});
				} else {
					res.json({
						message: `Products synced successfully. ${addedProducts.length} products added.`,
						addedProducts,
					});
				}
			} else {
				res.status(404).json({ error: "No products found for the shop" });
			}
		} else {
			res.status(404).json({ error: "No shops found" });
		}
	} catch (error) {
		console.error("Error syncing products:", error);
		res.status(500).json({ error: "Error syncing products" });
	}
};
