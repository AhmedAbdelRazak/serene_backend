const axios = require("axios");
const Category = require("../models/category");
const Product = require("../models/product");
const slugify = require("slugify");
const Subcategory = require("../models/subcategory");
const Colors = require("../models/colors");
const { Order } = require("../models/order");
const cloudinary = require("cloudinary").v2;

// Configure Cloudinary
cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

exports.publishPrintifyProducts = async (req, res) => {
	try {
		console.log("Fetching Shop ID from Printify...");

		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;

		// Fetch the Shop ID dynamically
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			}
		);

		if (!shopResponse.data || shopResponse.data.length === 0) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id; // Use the first shop ID
		console.log(`✅ Shop ID found: ${shopId}`);

		// Fetch all products from the shop
		const productsResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			}
		);

		if (!productsResponse.data || productsResponse.data.data.length === 0) {
			return res
				.status(404)
				.json({ error: "No products found in Printify shop" });
		}

		const printifyProducts = productsResponse.data.data;

		console.log(`✅ Total products retrieved: ${printifyProducts.length}`);

		// Log product visibility and lock status
		printifyProducts.forEach((product) => {
			console.log(
				`🔹 Product: ${product.title}, Visible: ${product.visible}, Locked: ${product.is_locked}, ID: ${product.id}`
			);
		});

		// Filter products that need publishing (if they failed publishing or are inactive)
		const productsToPublish = printifyProducts
			.filter((product) => !product.visible || product.is_locked) // Publish if not visible OR locked
			.map((product) => product.id);

		if (productsToPublish.length === 0) {
			console.log("🚀 No products need publishing.");
			return res.json({ message: "No products need publishing." });
		}

		console.log(`📌 Publishing ${productsToPublish.length} products...`);

		// Function to publish each product
		const publishResults = await Promise.all(
			productsToPublish.map(async (productId) => {
				try {
					await axios.post(
						`https://api.printify.com/v1/shops/${shopId}/products/${productId}/publish.json`,
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
								Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							},
						}
					);
					console.log(`✅ Successfully published product: ${productId}`);
					return { productId, status: "Published Successfully" };
				} catch (error) {
					console.error(
						`❌ Error publishing product ${productId}:`,
						error.response?.data || error.message
					);
					return {
						productId,
						status: "Failed to Publish",
						error: error.message,
					};
				}
			})
		);

		res.json({
			success: true,
			total_published: publishResults.filter(
				(p) => p.status === "Published Successfully"
			).length,
			total_failed: publishResults.filter(
				(p) => p.status === "Failed to Publish"
			).length,
			details: publishResults,
		});
	} catch (error) {
		console.error(
			"❌ Error publishing Printify products:",
			error.response?.data || error.message
		);
		res.status(500).json({ error: "Failed to publish Printify products" });
	}
};

exports.forceRepublishPrintifyProducts = async (req, res) => {
	try {
		console.log("Fetching Shop ID from Printify...");

		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;

		// Fetch the Shop ID dynamically
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			}
		);

		if (!shopResponse.data || shopResponse.data.length === 0) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id; // Use the first shop ID
		console.log(`✅ Shop ID found: ${shopId}`);

		// Fetch all products
		const productsResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			}
		);

		if (!productsResponse.data || productsResponse.data.data.length === 0) {
			return res
				.status(404)
				.json({ error: "No products found in Printify shop" });
		}

		const printifyProducts = productsResponse.data.data;

		console.log(`✅ Total products retrieved: ${printifyProducts.length}`);

		// Force republish all products by adding a random tag & republishing
		const republishResults = await Promise.all(
			printifyProducts.map(async (product) => {
				try {
					// First, update the product with a new tag
					await axios.put(
						`https://api.printify.com/v1/shops/${shopId}/products/${product.id}.json`,
						{
							tags: [...product.tags, "republish-attempt"], // Adding a new tag
						},
						{
							headers: {
								Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							},
						}
					);

					console.log(`🔄 Updated product ${product.id} with new tag`);

					// Now attempt to publish it
					await axios.post(
						`https://api.printify.com/v1/shops/${shopId}/products/${product.id}/publish.json`,
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
								Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							},
						}
					);

					console.log(`✅ Successfully republished product: ${product.id}`);
					return { productId: product.id, status: "Republished Successfully" };
				} catch (error) {
					console.error(
						`❌ Error republishing product ${product.id}:`,
						error.response?.data || error.message
					);
					return {
						productId: product.id,
						status: "Failed to Republish",
						error: error.message,
					};
				}
			})
		);

		res.json({
			success: true,
			total_republished: republishResults.filter(
				(p) => p.status === "Republished Successfully"
			).length,
			total_failed: republishResults.filter(
				(p) => p.status === "Failed to Republish"
			).length,
			details: republishResults,
		});
	} catch (error) {
		console.error(
			"❌ Error republishing Printify products:",
			error.response?.data || error.message
		);
		res.status(500).json({ error: "Failed to republish Printify products" });
	}
};

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

exports.printifyOrders = async (req, res) => {
	try {
		// 1. Grab orders, excluding any whose status matches
		//    "delivered", "cancelled", "shipped", or "ready to ship"
		//    in a case-insensitive manner.
		const ordersToCheck = await Order.find({
			status: {
				$nin: [
					/^delivered$/i,
					/^cancelled$/i,
					/^shipped$/i,
					/^ready to ship$/i,
					/^fulfilled$/i,
				],
			},
			"printifyOrderDetails.0.ephemeralOrder.id": { $exists: true },
		});

		// 2. Build a map of ephemeralOrder.id => local Order doc
		const orderMap = new Map();
		ordersToCheck.forEach((order) => {
			const printifyId = order.printifyOrderDetails?.[0]?.ephemeralOrder?.id;
			if (printifyId) {
				orderMap.set(printifyId, order);
			}
		});

		// 3. Fetch shops/orders using DESIGN_PRINTIFY_TOKEN only
		const token = process.env.DESIGN_PRINTIFY_TOKEN;
		if (!token) {
			return res.status(500).json({ error: "DESIGN_PRINTIFY_TOKEN missing." });
		}

		// Fetch shops
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: { Authorization: `Bearer ${token}` },
			}
		);
		const shops = shopResponse.data || [];
		let totalOrdersSynced = 0;

		// For each shop, get orders and update local DB
		for (const shop of shops) {
			const shopId = shop.id;
			const ordersResponse = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/orders.json`,
				{ headers: { Authorization: `Bearer ${token}` } }
			);
			const printifyOrders = ordersResponse.data?.data || [];

			for (const printifyOrder of printifyOrders) {
				// Attempt to find a matching local order
				const existingOrder = orderMap.get(printifyOrder.id);
				if (!existingOrder) continue;

				const updatedFields = {};

				// If local status differs from Printify, update it
				if (existingOrder.status !== printifyOrder.status) {
					updatedFields.status = printifyOrder.status;
				}

				// If tracking number differs, update it
				const printifyTracking = printifyOrder?.printify_connect?.url || null;
				if (existingOrder.trackingNumber !== printifyTracking) {
					updatedFields.trackingNumber = printifyTracking;
				}

				// If we have changes, update
				if (Object.keys(updatedFields).length > 0) {
					await Order.updateOne(
						{ _id: existingOrder._id },
						{ $set: updatedFields }
					);
					totalOrdersSynced++;
				}
			}
		}

		res.json({
			success: true,
			message: "Orders synced with Printify (DESIGN token only).",
			ordersSynced: totalOrdersSynced,
		});
	} catch (err) {
		console.error("Error syncing Printify orders:", err.message);
		if (err.response) {
			console.error("Printify API Response:", err.response.data);
		}
		res.status(500).json({ error: "Error syncing Printify orders" });
	}
};

exports.syncPrintifyProducts = async (req, res) => {
	try {
		//-------------------------------------------------------------------
		// 0. CONFIG CONSTANTS
		//-------------------------------------------------------------------
		const productIdsWithPOD = [
			"679ab3a63029882bb90b0159",
			"679ab2f94d8f4f8a1a088c32",
			"679ab284f6537a44d90232d6",
			"679ab1eed7eb5609e107e949",
			"679ab14d7fc1cdd41f08a20a",
			"679aafdff6537a44d9023235",
			"679aae24f6537a44d90231b7",
			"680a6dbc82aa6fcd4901beaa",
			"680a79254feb8fbd64074b22",
		];

		// Category & Subcategory IDs for POD
		const POD_CATEGORY_ID = "679bb2a7dba50a58933d01eb";
		const POD_SUBCATEGORY_ID = "679bb2bfdba50a58933d0233";

		// Token from environment (ONLY design token now)
		const DESIGN_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;
		if (!DESIGN_TOKEN) {
			return res
				.status(500)
				.json({ error: "DESIGN_PRINTIFY_TOKEN must be set." });
		}

		//-------------------------------------------------------------------
		// 1. FETCH CATEGORIES / SUBCATEGORIES
		//-------------------------------------------------------------------
		const categories = await Category.find().sort({ createdAt: -1 });
		const subcategories = await Subcategory.find();
		// If you need color sets from DB:
		// const colors = await Colors.find(); // Example (not strictly necessary)

		//-------------------------------------------------------------------
		// 2. HELPER: FETCH SHOP + PRODUCTS for the DESIGN token
		//-------------------------------------------------------------------
		const fetchDesignProducts = async (tokenName, token) => {
			const shopRes = await axios.get(
				"https://api.printify.com/v1/shops.json",
				{
					headers: { Authorization: `Bearer ${token}` },
				}
			);
			if (!shopRes.data?.length) {
				console.log(`⚠️ [${tokenName}] No shops found.`);
				return [];
			}
			const shopId = shopRes.data[0].id;
			console.log(`✅ [${tokenName}] Shop ID found: ${shopId}`);

			const productsRes = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products.json`,
				{ headers: { Authorization: `Bearer ${token}` } }
			);
			if (!productsRes.data?.data?.length) {
				console.log(`⚠️ [${tokenName}] No products found in shop ${shopId}`);
				return [];
			}
			console.log(
				`🔹 [${tokenName}] Fetched ${productsRes.data.data.length} products`
			);
			// Attach the shopId so we know which shop to update
			return productsRes.data.data.map((p) => ({ ...p, __shopId: shopId }));
		};

		//-------------------------------------------------------------------
		// 3. FETCH PRODUCTS ONLY FROM DESIGN TOKEN
		//-------------------------------------------------------------------
		console.log("🚀 Fetching products from Design token only...");
		const designProducts = await fetchDesignProducts("DESIGN", DESIGN_TOKEN);

		if (!designProducts.length) {
			return res
				.status(404)
				.json({ error: "No products found from the Printify design shop" });
		}

		// We’ll call these our “combinedProducts,” but in reality it’s just one list:
		const combinedProducts = designProducts;

		//-------------------------------------------------------------------
		// 4. IMAGE UPLOAD HELPER (LIMIT TO 5)
		//-------------------------------------------------------------------
		const uploadImageToCloudinaryLimited = async (
			imagesArray = [],
			limit = 5
		) => {
			const limitedImages = imagesArray.slice(0, limit);
			const uploadedImages = await Promise.all(
				limitedImages.map(async (img) => {
					try {
						const result = await cloudinary.uploader.upload(img.src, {
							folder: "serene_janat/products",
							resource_type: "image",
						});
						return { public_id: result.public_id, url: result.secure_url };
					} catch (err) {
						console.error("Cloudinary Upload Error:", err.message);
						return null;
					}
				})
			);
			return uploadedImages.filter(Boolean);
		};

		//-------------------------------------------------------------------
		// 5. MASTER SYNC HANDLER (CREATE/UPDATE in Mongo; then set “Draft”)
		//-------------------------------------------------------------------
		async function handleProductSync(productData, variantSKU, printifyProduct) {
			if (!variantSKU) {
				console.warn(
					`❌ Variant SKU is missing for product: ${printifyProduct.title}`
				);
				return;
			}

			//-------------------------------------------------------------------
			// A) CREATE or UPDATE in MONGODB
			//-------------------------------------------------------------------
			const existingProduct = await Product.findOne({ productSKU: variantSKU });
			if (existingProduct) {
				// Update existing
				existingProduct.productName = productData.productName;
				existingProduct.description = productData.description;
				existingProduct.price = productData.price;
				existingProduct.priceAfterDiscount = productData.priceAfterDiscount;
				existingProduct.MSRPPriceBasic = productData.MSRPPriceBasic;
				existingProduct.quantity = productData.quantity;

				existingProduct.slug = productData.slug;
				existingProduct.slug_Arabic = productData.slug_Arabic;

				existingProduct.category = productData.category;
				existingProduct.subcategory = productData.subcategory;
				existingProduct.gender = productData.gender;
				existingProduct.chosenSeason = productData.chosenSeason;
				existingProduct.isPrintifyProduct = productData.isPrintifyProduct;
				existingProduct.addVariables = productData.addVariables;

				existingProduct.printifyProductDetails =
					productData.printifyProductDetails;

				if (productData.scent) {
					existingProduct.scent = productData.scent;
				}
				if (productData.productAttributes?.length) {
					existingProduct.productAttributes = productData.productAttributes;
				}
				if (productData.thumbnailImage?.[0]?.images?.length) {
					existingProduct.thumbnailImage = productData.thumbnailImage;
				}

				await existingProduct.save();
				console.log(`↺ Updated product in Mongo: ${productData.productName}`);
			} else {
				// Create new
				const newProduct = new Product({
					productSKU: variantSKU,
					...productData,
				});
				await newProduct.save();
				console.log(`➕ Added product in Mongo: ${productData.productName}`);
			}

			//-------------------------------------------------------------------
			// B) Set product to “Draft” in Printify
			//-------------------------------------------------------------------
			// visible=false => product not published
			// is_enabled=true => variants are “enabled” so you can see them
			try {
				const variantSettings = (printifyProduct.variants || []).map((v) => ({
					...v,
					is_enabled: true,
				}));

				await axios.put(
					`https://api.printify.com/v1/shops/${printifyProduct.__shopId}/products/${printifyProduct.id}.json`,
					{
						title: printifyProduct.title,
						description: printifyProduct.description,
						visible: false, // draft/unpublished
						variants: variantSettings,
					},
					{
						headers: {
							Authorization: `Bearer ${DESIGN_TOKEN}`,
						},
					}
				);

				console.log(
					`✅ Set product ${printifyProduct.id} to draft (visible=false, variants enabled).`
				);
			} catch (draftError) {
				console.error(
					`Error setting product ${printifyProduct.id} to draft:`,
					draftError.response?.data || draftError.message
				);
			}
		}

		//-------------------------------------------------------------------
		// 6. LOOP + PROCESS EACH PRINTIFY PRODUCT (Design Only)
		//-------------------------------------------------------------------
		const failedProducts = [];
		const processedProducts = [];

		for (const printifyProduct of combinedProducts) {
			// Determine if product is in the POD list
			const isPOD = productIdsWithPOD.includes(printifyProduct.id);

			// If product is POD => fixed category, else auto-match
			let matchingCategory = null;
			let matchingSubcategories = [];

			if (isPOD) {
				matchingCategory = { _id: POD_CATEGORY_ID };
				matchingSubcategories = [{ _id: POD_SUBCATEGORY_ID }];
			} else {
				// Attempt to find a matching category by tags
				matchingCategory = categories.find((cat) =>
					printifyProduct.tags.some(
						(tag) =>
							tag.toLowerCase().includes(cat.categoryName.toLowerCase()) ||
							tag.toLowerCase().includes(cat.categorySlug.toLowerCase())
					)
				);
				if (matchingCategory) {
					matchingSubcategories = subcategories.filter(
						(sc) => sc.categoryId.toString() === matchingCategory._id.toString()
					);
				}
			}

			// If non-POD and no match => skip
			if (!matchingCategory && !isPOD) {
				failedProducts.push(printifyProduct.title);
				console.warn(`❌ Skipped non-POD product: ${printifyProduct.title}`);
				continue;
			}

			// Build product slug
			const productSlug = slugify(printifyProduct.title, {
				lower: true,
				strict: true,
			});
			const productSlugArabic = slugify(printifyProduct.title, {
				lower: true,
				strict: true,
			});

			// For toggling addVariables
			const addVariables =
				Array.isArray(printifyProduct.options) &&
				printifyProduct.options.length > 0;

			// Check for variants
			const enabledVariants = (printifyProduct.variants || []).filter(
				(v) => v.is_enabled
			);
			if (!enabledVariants.length) {
				failedProducts.push(printifyProduct.title);
				console.warn(`❌ No enabled variants for ${printifyProduct.title}`);
				continue;
			}

			// ---------------------------------------------------------
			// Build an option map => { [valueId]: { type, title, colors? } }
			// This ensures we can handle color/size/scent in ANY order
			// ---------------------------------------------------------
			const optionValueMap = {}; // key = value.id, val = { type, title, colors? }
			(printifyProduct.options || []).forEach((option) => {
				(option.values || []).forEach((val) => {
					// e.g. val = { id, title, colors }
					optionValueMap[val.id] = {
						type: option.type, // "color", "size", "scent", ...
						title: val.title,
						colors: val.colors || [],
					};
				});
			});

			// ---------------------------------------------------------
			// Sort by size if a size option is present
			// Example size ordering array. Adjust as needed.
			// ---------------------------------------------------------
			const sizeOrdering = [
				"XS",
				"S",
				"M",
				"L",
				"XL",
				"2XL",
				"XXL",
				"3XL",
				"4XL",
				"5XL",
			];
			enabledVariants.sort((a, b) => {
				// Attempt to find size strings from the variant options
				// Because variant.options is an array of value-IDs
				let sizeA = "";
				let sizeB = "";
				for (let valId of a.options || []) {
					if (optionValueMap[valId]?.type === "size") {
						sizeA = optionValueMap[valId].title;
						break;
					}
				}
				for (let valId of b.options || []) {
					if (optionValueMap[valId]?.type === "size") {
						sizeB = optionValueMap[valId].title;
						break;
					}
				}

				const idxA = sizeOrdering.indexOf(sizeA);
				const idxB = sizeOrdering.indexOf(sizeB);

				// If either size not found in list => sort them to the end
				if (idxA === -1 && idxB === -1) return 0;
				if (idxA === -1) return 1;
				if (idxB === -1) return -1;

				return idxA - idxB;
			});

			// We'll use the FIRST variant’s SKU for the top-level product (slug, etc.)
			const firstVariantSKU = enabledVariants[0].sku || "NOSKU";

			// Check if there's already a top-level product
			const existingTopLevel = await Product.findOne({
				productSKU: firstVariantSKU,
			});

			// -----------------------------------------
			// Upload a handful of images for top-level
			// -----------------------------------------
			let validUploadedImages = [];
			if (!existingTopLevel) {
				// If top-level doesn’t exist yet, we upload
				const relevantImagesForProduct = (printifyProduct.images || []).filter(
					(img) => {
						// Keep if any of its variant_ids matches an enabled variant
						return img.variant_ids.some((vId) =>
							enabledVariants.some((ev) => ev.id === vId)
						);
					}
				);
				validUploadedImages = await uploadImageToCloudinaryLimited(
					relevantImagesForProduct,
					5
				);
			} else {
				// If product already exists, just reuse its images
				validUploadedImages =
					existingTopLevel.thumbnailImage?.[0]?.images || [];
			}

			// -----------------------------------------
			// Build top-level product data (w/o attributes)
			// -----------------------------------------
			const baseVariantPrice = enabledVariants[0].price / 100;

			const productData = {
				productName: printifyProduct.title,
				description: printifyProduct.description || "",
				price: (baseVariantPrice * 1.2).toFixed(2),
				priceAfterDiscount: baseVariantPrice.toFixed(2),
				MSRPPriceBasic: (baseVariantPrice * 0.75).toFixed(2),
				quantity: 20,
				slug: `${productSlug}-${firstVariantSKU}`,
				slug_Arabic: `${productSlugArabic}-${firstVariantSKU}`,
				category: matchingCategory?._id,
				subcategory: matchingSubcategories.map((s) => s._id),
				gender: "6635ab22898104005c96250a", // Example
				chosenSeason: "all",
				thumbnailImage: [
					{
						images: validUploadedImages,
					},
				],
				isPrintifyProduct: true,
				addVariables: addVariables, // If there’s at least 1 “options” in Printify
				printifyProductDetails: {
					POD: isPOD,
					id: printifyProduct.id,
					title: printifyProduct.title,
					description: printifyProduct.description,
					tags: printifyProduct.tags,
					options: printifyProduct.options,
					variants: enabledVariants,
					images: printifyProduct.images,
					created_at: printifyProduct.created_at,
					updated_at: printifyProduct.updated_at,
					visible: printifyProduct.visible,
					is_locked: printifyProduct.is_locked,
					blueprint_id: printifyProduct.blueprint_id,
					user_id: printifyProduct.user_id,
					shop_id: printifyProduct.__shopId,
					print_provider_id: printifyProduct.print_provider_id,
					print_areas: printifyProduct.print_areas,
					print_details: printifyProduct.print_details,
					sales_channel_properties: printifyProduct.sales_channel_properties,
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

			// -----------------------------------------
			// Build productAttributes array
			// -----------------------------------------
			productData.productAttributes = await Promise.all(
				enabledVariants.map(async (variant) => {
					// For each variant, find color/size/scent (etc.)
					let colorVal = "";
					let sizeVal = "";
					let scentVal = "";

					// Each variant has an array of option IDs. We look them up in the map.
					for (let valId of variant.options || []) {
						const foundOption = optionValueMap[valId];
						if (!foundOption) continue;
						if (foundOption.type === "color") {
							// If "colors" array is present, usually the first color is the name
							// or it might just be foundOption.title if you prefer
							colorVal = foundOption.colors?.[0] || foundOption.title || "";
						} else if (foundOption.type === "size") {
							sizeVal = foundOption.title;
						} else if (foundOption.type === "scent") {
							scentVal = foundOption.title;
						}
						// If you have more option types, handle them here
					}

					// Build PK: e.g. "S#Black#Sea Salt + Orchid"
					const pkParts = [];
					if (sizeVal) pkParts.push(sizeVal);
					if (colorVal) pkParts.push(colorVal);
					if (scentVal) pkParts.push(scentVal);
					const PK = pkParts.length ? pkParts.join("#") : variant.sku;

					// Upload or reuse variant images
					let variantUploadedImages = [];
					if (existingTopLevel) {
						const existingAttr = existingTopLevel.productAttributes?.find(
							(a) => a.SubSKU === variant.sku
						);
						if (existingAttr) {
							variantUploadedImages = existingAttr.productImages || [];
						} else {
							// Otherwise, upload new for this variant
							const vImages = (printifyProduct.images || []).filter((img) =>
								img.variant_ids.includes(variant.id)
							);
							variantUploadedImages = await uploadImageToCloudinaryLimited(
								vImages,
								5
							);
						}
					} else {
						// top-level not exist => always upload
						const vImages = (printifyProduct.images || []).filter((img) =>
							img.variant_ids.includes(variant.id)
						);
						variantUploadedImages = await uploadImageToCloudinaryLimited(
							vImages,
							5
						);
					}

					const rawPrice = variant.price / 100;
					return {
						PK,
						color: colorVal,
						size: sizeVal,
						scent: scentVal,
						SubSKU: variant.sku,
						quantity: 20,
						price: (rawPrice * 1.2).toFixed(2),
						priceAfterDiscount: rawPrice.toFixed(2),
						MSRP: (rawPrice * 0.75).toFixed(2),
						WholeSalePrice: (rawPrice * 0.75).toFixed(2),
						DropShippingPrice: (rawPrice * 0.85).toFixed(2),
						productImages: variantUploadedImages,
					};
				})
			);

			// -----------------------------------------
			// Now create/update top-level product
			// (We pass the FIRST variant’s SKU so
			//  we can do a proper lookup in handleProductSync)
			// -----------------------------------------
			await handleProductSync(productData, firstVariantSKU, printifyProduct);
			processedProducts.push(printifyProduct.id);
		}

		//-------------------------------------------------------------------
		// 7. FINISH + REPORT
		//-------------------------------------------------------------------
		const recommendations = failedProducts.map((title) => ({
			productTitle: title,
			recommendation: "Check category matching or variant SKUs.",
		}));

		if (failedProducts.length > 0) {
			res.status(207).json({
				message: `Products synced with some failures. ${processedProducts.length} products processed, ${failedProducts.length} products failed.`,
				failedProducts,
				recommendations,
			});
		} else {
			res.json({
				message: `All Printify products synced successfully. ${processedProducts.length} products processed.`,
			});
		}
	} catch (error) {
		console.error("❌ Error syncing products:", error);
		res.status(500).json({ error: "Error syncing products" });
	}
};

exports.getSpecificPrintifyProducts = async (req, res) => {
	try {
		console.log("Fetching all products from Printify...");

		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;
		if (!DESIGN_PRINTIFY_TOKEN) {
			return res.status(500).json({
				error: "DESIGN_PRINTIFY_TOKEN not set in environment variables.",
			});
		}

		// 1. Fetch Shop ID
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			}
		);

		if (!shopResponse.data || shopResponse.data.length === 0) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id;
		console.log(`✅ Shop ID found: ${shopId}`);

		// 2. Fetch ALL products from the shop
		const productsResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			{
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
				},
			}
		);

		if (!productsResponse.data || productsResponse.data.data.length === 0) {
			return res
				.status(404)
				.json({ error: "No products found in Printify shop" });
		}

		let allProducts = productsResponse.data.data;
		console.log(`✅ Total products retrieved: ${allProducts.length}`);

		// 3. Optional: If ?productIds=xyz,abc is provided, filter
		const republishedProductIds = req.query.productIds
			? req.query.productIds.split(",")
			: null;

		if (republishedProductIds && republishedProductIds.length > 0) {
			console.log(
				`Filtering only products with IDs: ${republishedProductIds.join(", ")}`
			);

			allProducts = allProducts.filter((product) =>
				republishedProductIds.includes(product.id)
			);
			console.log(`✅ Filtered products count: ${allProducts.length}`);
		}

		// 4. Map them to a simplified structure (optional)
		// If you want to return the entire raw product object, skip this `.map(...)`
		// and return `allProducts` directly.
		const mappedProducts = allProducts.map((product) => ({
			id: product.id,
			title: product.title,
			description: product.description || "No description available",
			visible: product.visible,
			is_locked: product.is_locked,
			images: product.images?.map((img) => img.src) || [],
			variants: product.variants?.map((variant) => ({
				id: variant.id,
				title: variant.title,
				price: variant.price / 100, // Convert cents to dollars
				available: variant.is_available,
				is_enabled: variant.is_enabled,
				sku: variant.sku,
			})),
		}));

		// 5. Return all or mapped products
		res.json({
			success: true,
			total_products_returned: mappedProducts.length,
			products: mappedProducts,
		});
	} catch (error) {
		console.error(
			"❌ Error fetching Printify products:",
			error.response?.data || error.message
		);
		res.status(500).json({ error: "Failed to fetch Printify products" });
	}
};

exports.getSinglePrintifyProductById = async (req, res) => {
	try {
		const { product_id } = req.params;

		// 1. **Validate Product ID**
		if (!product_id) {
			return res.status(400).json({ error: "Product ID is required" });
		}

		// 2. **Retrieve Printify API Token**
		const token = process.env.DESIGN_PRINTIFY_TOKEN;

		if (!token) {
			return res
				.status(500)
				.json({ error: "Printify API Token is not configured" });
		}

		// 3. **Fetch Shop ID Dynamically**
		const shopResponse = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: { Authorization: `Bearer ${token}` },
			}
		);

		// 4. **Validate Shop Response**
		if (
			!shopResponse.data ||
			!Array.isArray(shopResponse.data) ||
			shopResponse.data.length === 0
		) {
			return res.status(404).json({ error: "No shops found in Printify" });
		}

		const shopId = shopResponse.data[0].id; // Use the first shop ID
		console.log(`✅ Shop ID found: ${shopId}`);

		// 5. **Fetch the Single Product from Printify**
		const productResponse = await axios.get(
			`https://api.printify.com/v1/shops/${shopId}/products/${product_id}.json`,
			{
				headers: { Authorization: `Bearer ${token}` },
			}
		);

		const fetchedProduct = productResponse.data;

		// 6. **Validate Product Data**
		if (!fetchedProduct) {
			console.error("❌ 'fetchedProduct' is undefined");
			return res.status(404).json({ error: "Product not found in Printify" });
		}

		// 7. **Ensure 'variants' is an array**
		if (!Array.isArray(fetchedProduct.variants)) {
			console.error("❌ 'variants' is not an array", fetchedProduct.variants);
			return res
				.status(500)
				.json({ error: "'variants' data structure is invalid" });
		}

		// 8. **Filter Variants: Only include available and enabled variants**
		const filteredVariants = fetchedProduct.variants.filter(
			(variant) => variant.is_available && variant.is_enabled
		);
		console.log(
			`🔍 Found ${filteredVariants.length} available and enabled variants`
		);

		// 9. **Check if Any Variants Remain After Filtering**
		if (filteredVariants.length === 0) {
			console.error(
				"❌ No available and enabled variants found for this product."
			);
			return res.status(404).json({
				error: "No available and enabled variants found for this product.",
			});
		}

		// 10. **Ensure 'options' is an array**
		if (!Array.isArray(fetchedProduct.options)) {
			console.error("❌ 'options' is not an array", fetchedProduct.options);
			return res
				.status(500)
				.json({ error: "'options' data structure is invalid" });
		}

		// 11. **Map Option Names to Indices in Variants**
		const optionNameToIndexMap = {};
		fetchedProduct.options.forEach((opt, idx) => {
			if (opt && opt.name) {
				optionNameToIndexMap[opt.name.toLowerCase()] = idx;
			}
		});

		// 12. **Identify the "Colors" Option Index (Optional)**
		const colorOptionIndex = optionNameToIndexMap["colors"];
		const hasColorOption = colorOptionIndex !== undefined;

		if (hasColorOption) {
			console.log("🎨 'Colors' option found in product options");

			// 13. **Ensure 'variants.options' arrays are valid**
			const availableColorIds = new Set(
				filteredVariants
					.map((variant) => {
						if (!Array.isArray(variant.options)) {
							console.error(
								`❌ 'options' array missing in variant ID: ${variant.id}`
							);
							return undefined;
						}
						const colorId = variant.options[colorOptionIndex];
						if (colorId === undefined) {
							console.error(`❌ Color ID missing in variant ID: ${variant.id}`);
						}
						return colorId;
					})
					.filter((optId) => optId !== undefined)
			);

			console.log(
				`🎨 Available Color IDs: ${[...availableColorIds].join(", ")}`
			);

			if (availableColorIds.size === 0) {
				console.error(
					"❌ No available color IDs found after filtering variants"
				);
				return res.status(500).json({
					error: "No available color IDs found after filtering variants",
				});
			}

			// 14. **Filter Colors in Options Based on Available Variants**
			const colorOption = fetchedProduct.options.find(
				(opt) => opt.name.toLowerCase() === "colors"
			);
			if (!colorOption) {
				console.error("❌ 'Colors' option not found", fetchedProduct.options);
				return res
					.status(500)
					.json({ error: "Colors option not found in product options" });
			}

			if (!Array.isArray(colorOption.values)) {
				console.error(
					"❌ 'values' is not an array in 'Colors' option",
					colorOption
				);
				return res
					.status(500)
					.json({ error: "'values' is not an array in 'Colors' option" });
			}

			const filteredColorValues = colorOption.values.filter((color) =>
				availableColorIds.has(color.id)
			);

			if (filteredColorValues.length === 0) {
				console.warn("⚠️ No colors available after filtering");
			}

			var filteredOptions = fetchedProduct.options
				.map((opt) => {
					if (opt.name.toLowerCase() === "colors") {
						return {
							...opt,
							values: filteredColorValues,
						};
					}
					return opt; // Keep other options unchanged
				})
				.filter(
					(opt) => opt && Array.isArray(opt.values) && opt.values.length > 0
				); // Remove nulls and options with no values
		} else {
			console.warn(
				"⚠️ 'Colors' option not found. Proceeding without color filtering."
			);
			// If there is no 'Colors' option, keep all existing options
			var filteredOptions = fetchedProduct.options.filter(
				(opt) => opt && Array.isArray(opt.values) && opt.values.length > 0
			);
		}

		// 15. **Ensure 'images' is an array**
		if (!Array.isArray(fetchedProduct.images)) {
			console.error("❌ 'images' is not an array", fetchedProduct.images);
			return res
				.status(500)
				.json({ error: "'images' data structure is invalid" });
		}

		// 16. **Filter Images: Only include images associated with filtered variants**
		const filteredVariantIds = filteredVariants.map((variant) => variant.id);
		const filteredImages = fetchedProduct.images.filter(
			(image) =>
				Array.isArray(image.variant_ids) &&
				image.variant_ids.some((id) => filteredVariantIds.includes(id))
		);
		console.log(`🖼️ Found ${filteredImages.length} associated images`);

		// 17. **Remove Image Limitation**
		const finalImages = filteredImages; // No limit on images

		// 18. **Ensure 'print_areas' is an array**
		if (!Array.isArray(fetchedProduct.print_areas)) {
			console.error(
				"❌ 'print_areas' is not an array",
				fetchedProduct.print_areas
			);
			return res
				.status(500)
				.json({ error: "'print_areas' data structure is invalid" });
		}

		// 19. **Filter Print Areas: Only include variant_ids present in filtered variants**
		const filteredPrintAreas = fetchedProduct.print_areas
			.map((printArea) => {
				if (!printArea || !Array.isArray(printArea.variant_ids)) {
					console.error(
						`❌ Invalid 'printArea' structure: ${JSON.stringify(printArea)}`
					);
					return null; // Exclude invalid print areas
				}

				const filteredVariantIdsInPrintArea = printArea.variant_ids.filter(
					(id) => filteredVariantIds.includes(id)
				);

				// Ensure 'placeholders' is an array
				let filteredPlaceholders = [];
				if (Array.isArray(printArea.placeholders)) {
					filteredPlaceholders = printArea.placeholders
						.map((placeholder) => {
							if (!placeholder || !Array.isArray(placeholder.images)) {
								console.warn(
									`⚠️ Invalid 'placeholder' structure: ${JSON.stringify(
										placeholder
									)}`
								);
								return null; // Exclude invalid placeholders
							}

							// You can add more filtering logic here if necessary
							return {
								...placeholder,
								images: placeholder.images.filter(
									(img) => img !== undefined && img !== null
								),
							};
						})
						.filter(
							(placeholder) => placeholder && placeholder.images.length > 0
						);
				} else {
					console.warn(
						`⚠️ 'placeholders' is not an array in printArea ID: ${printArea.id}`
					);
				}

				return {
					...printArea,
					variant_ids: filteredVariantIdsInPrintArea,
					placeholders: filteredPlaceholders,
				};
			})
			.filter(
				(printArea) =>
					printArea &&
					printArea.variant_ids.length > 0 &&
					printArea.placeholders.length > 0
			); // Remove invalid or empty print areas
		console.log(`🖨️ Found ${filteredPrintAreas.length} valid print areas`);

		// 20. **Do Not Filter Views Based on Variant IDs**
		const filteredViews = fetchedProduct.views; // Retain all views
		console.log(`👁️ Found ${filteredViews.length} views`);

		// 21. **Construct the Modified Product Object**
		const modifiedProduct = {
			...fetchedProduct,
			variants: filteredVariants,
			options: filteredOptions,
			images: finalImages,
			print_areas: filteredPrintAreas,
			views: filteredViews, // Retained all views
		};

		// 22. **Respond to the Frontend**
		return res.json({ success: true, product: modifiedProduct });
	} catch (error) {
		console.error(
			"❌ Error fetching single Printify product:",
			error.response?.data || error.message,
			error.stack
		);

		// Determine appropriate status code
		const statusCode = error.response?.status || 500;
		const errorMessage =
			error.response?.data?.message || "Internal server error";

		return res.status(statusCode).json({ error: errorMessage });
	}
};

/**
 * POST /api/printify/create-custom-order
 *
 * 1) Create a new "on-the-fly" product
 * 2) Order that product
 * 3) Delete or disable the product
 */
exports.createCustomPrintifyOrder = async (req, res) => {
	try {
		// 0) Extract your custom design data + shipping info from the request body
		const {
			// Product creation data:
			blueprint_id,
			print_provider_id,
			variant_id, // e.g. "Light Blue / 3XL" or some variant integer ID
			quantity,
			print_areas, // e.g. { front: [ { type: "text/plain", x:0.5, y:0.5, input_text:"Hello!" } ] }
			// Order shipping data:
			shipping_method, // 1=standard,2=priority,3=express,4=economy
			address_to,
			// Optional external_id for your order
			external_id,
		} = req.body;

		// 1) Basic validation checks
		if (!blueprint_id || !print_provider_id || !variant_id || !quantity) {
			return res
				.status(400)
				.json({ error: "Missing required fields for product creation." });
		}
		if (
			!address_to ||
			!address_to.first_name ||
			!address_to.last_name ||
			!address_to.country ||
			!address_to.address1 ||
			!address_to.city ||
			!address_to.zip
		) {
			return res
				.status(400)
				.json({ error: "Missing required shipping address fields." });
		}

		// 2) Get your Shop ID from Printify
		//    (If you only have one shop, you can skip this step and store shopId in .env)
		const shopsResp = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: {
					Authorization: `Bearer ${process.env.PRINTIFY_API_TOKEN}`,
					"User-Agent": "NodeJS-App",
				},
			}
		);
		if (!shopsResp.data?.length) {
			return res.status(404).json({ error: "No Printify shop found." });
		}
		const shopId = shopsResp.data[0].id;

		// 3) CREATE THE PRODUCT
		//    We only enable the single variant we want.
		//    Also note that "blueprint_id" & "print_provider_id" are required for creation.
		//    "print_areas" must follow Printify's structure to place text/images on front/back etc.
		//
		//    Example of "images" array in placeholders:
		//      {
		//        "id": "some-upload-id",
		//        "type": "image/png",
		//        "x": 0.5,
		//        "y": 0.5,
		//        "scale": 1,
		//        "angle": 0
		//      }
		//    Example of "text layer":
		//      {
		//        "id": "text-layer-123",
		//        "type": "text/plain",
		//        "font_family": "Arial",
		//        "font_size": 24,
		//        "font_color": "#000000",
		//        "x": 0.5,
		//        "y": 0.5,
		//        "scale": 1,
		//        "angle": 0,
		//        "input_text": "Hello World"
		//      }
		//
		//    Each placeholder can hold an array of images (layers).
		//    For example: front: [ { ... } ], back: [ { ... } ], etc.

		const createProductPayload = {
			title: "Custom One-Time Product", // set as you like
			description: "User-personalized product",
			blueprint_id,
			print_provider_id,
			// variants: only 1 variant is enabled; others are disabled
			variants: [
				{
					id: variant_id, // the integer ID from the Printify blueprint
					price: 4900, // in cents, e.g. $49.00
					is_enabled: true, // we want to enable only this variant
					is_default: true, // the "main" variant
				},
			],
			print_areas: [
				{
					variant_ids: [variant_id],
					placeholders: Object.entries(print_areas).map(
						([position, layers]) => ({
							position, // e.g. "front"
							images: layers, // an array of images or text layers
						})
					),
				},
			],
			// optionally set "tags": ["custom", "one-time"]
		};

		const createProductResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			createProductPayload,
			{
				headers: {
					Authorization: `Bearer ${process.env.PRINTIFY_API_TOKEN}`,
					"Content-Type": "application/json",
					"User-Agent": "NodeJS-App",
				},
			}
		);

		if (!createProductResp.data?.id) {
			return res
				.status(500)
				.json({ error: "Failed to create product on Printify." });
		}
		const newProductId = createProductResp.data.id;

		// 4) CREATE THE ORDER referencing the newly created product
		//    We'll order the single variant the user configured.
		const orderPayload = {
			external_id: external_id || `custom-order-${Date.now()}`,
			line_items: [
				{
					product_id: newProductId, // the product we just created
					variant_id,
					quantity,
				},
			],
			shipping_method: shipping_method || 1, // default to standard
			send_shipping_notification: false,
			address_to,
		};

		const orderResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/orders.json`,
			orderPayload,
			{
				headers: {
					Authorization: `Bearer ${process.env.PRINTIFY_API_TOKEN}`,
					"Content-Type": "application/json",
					"User-Agent": "NodeJS-App",
				},
			}
		);

		if (!orderResp.data) {
			return res
				.status(500)
				.json({ error: "Failed to create order for the new product." });
		}

		// 5) CLEAN UP: Remove or disable the product so it doesn’t show in your store.
		//    Option A: Delete the product entirely
		try {
			await axios.delete(
				`https://api.printify.com/v1/shops/${shopId}/products/${newProductId}.json`,
				{
					headers: {
						Authorization: `Bearer ${process.env.PRINTIFY_API_TOKEN}`,
						"User-Agent": "NodeJS-App",
					},
				}
			);
		} catch (err) {
			console.warn(
				"Warning: The order was created, but deleting the product failed:",
				err.response?.data || err.message
			);
			// not a show-stopper — the order is still placed
		}

		// Option B (instead of deleting): Update the product to disable variants
		//    e.g. using PUT /v1/shops/{shop_id}/products/{product_id}.json
		//    to set "is_enabled" = false for all variants. Then it won't appear.
		//    (But it's simpler to just DELETE if truly ephemeral.)

		// 6) Return success (include the order info in response)
		return res.status(201).json({
			message: "Custom product created and order placed successfully.",
			product_id: newProductId,
			order: orderResp.data,
		});
	} catch (error) {
		console.error(
			"Error creating on-the-fly Printify product & order:",
			error?.response?.data || error.message
		);
		return res.status(500).json({
			error: "Error creating on-the-fly Printify product & order",
		});
	}
};

// Existing helper functions...

// New Function: Webhook Handler (Optional)
exports.printifyWebhook = async (req, res) => {
	try {
		const event = req.body;

		// Verify webhook signature if Printify provides one

		switch (event.event) {
			case "order_status_changed":
				const orderId = event.data.id;
				const newStatus = event.data.status;

				// Update the local order status
				await Order.findOneAndUpdate(
					{ "printifyOrderDetails.id": orderId },
					{ "printifyOrderDetails.status": newStatus }
				);
				break;
			// Handle other events as needed
			default:
				console.log(`Unhandled event type: ${event.event}`);
		}

		res.status(200).send("Webhook received");
	} catch (error) {
		console.error("Error handling Printify webhook:", error);
		res.status(500).send("Webhook error");
	}
};

exports.updatePrintifyProduct = async (req, res) => {
	try {
		const { product_id } = req.params;
		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;

		if (!product_id) {
			return res.status(400).json({ error: "Missing product_id" });
		}
		if (!DESIGN_PRINTIFY_TOKEN) {
			return res.status(500).json({
				error: "DESIGN_PRINTIFY_TOKEN not set in environment variables",
			});
		}

		// 1) Fetch Shop ID
		const shopRes = await axios.get("https://api.printify.com/v1/shops.json", {
			headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
		});
		if (!shopRes.data?.length) {
			return res.status(404).json({ error: "No Printify shops found" });
		}
		const shopId = shopRes.data[0].id;

		// 2) Optionally fetch all library images if you want to filter out invalid 'id' references:
		let validImageIds = new Set();
		try {
			const uploadsRes = await axios.get(
				"https://api.printify.com/v1/uploads.json",
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				}
			);
			for (const libImg of uploadsRes.data?.data || []) {
				validImageIds.add(libImg.id);
			}
		} catch (libErr) {
			// not fatal if we can't fetch library, but we won't remove unknown images
			console.error(
				"Could not fetch library uploads:",
				libErr.response?.data || libErr.message
			);
		}

		// 3) Grab fields from req.body
		const {
			title,
			description,
			tags,
			options,
			variants,
			images,
			print_areas,
			visible,
			// is_locked is read-only
		} = req.body;

		// 4) Fetch the existing product (to merge with your changes)
		let existingProduct;
		try {
			const existingResp = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products/${product_id}.json`,
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				}
			);
			existingProduct = existingResp.data;
		} catch (errGet) {
			console.error(
				"Failed to fetch existing product:",
				errGet.response?.data || errGet.message
			);
			return res.status(500).json({
				error: "Failed to fetch existing product before update",
				details: errGet.response?.data || errGet.message,
			});
		}

		// 5) Build finalPayload by merging existing data with new changes
		const finalPayload = {
			title: existingProduct.title,
			description: existingProduct.description,
			tags: existingProduct.tags,
			options: existingProduct.options,
			variants: existingProduct.variants,
			images: existingProduct.images,
			print_areas: existingProduct.print_areas,
			visible: existingProduct.visible,
		};

		if (title !== undefined) finalPayload.title = title;
		if (description !== undefined) finalPayload.description = description;
		if (tags !== undefined) finalPayload.tags = tags;
		if (options !== undefined) finalPayload.options = options;
		if (variants !== undefined) finalPayload.variants = variants;
		if (images !== undefined) finalPayload.images = images;
		if (print_areas !== undefined) finalPayload.print_areas = print_areas;
		if (visible !== undefined) finalPayload.visible = visible;

		// 6) Filter invalid images if needed (avoid code 8253)
		if (Array.isArray(finalPayload.print_areas)) {
			finalPayload.print_areas = finalPayload.print_areas.map((pa) => {
				const placeholders = (pa.placeholders || []).map((ph) => {
					const safeImages = (ph.images || []).filter((img) => {
						// text => keep
						if (img.type === "text") return true;
						// has 'id' => must be in library
						if (typeof img.id === "string" && img.id.trim() !== "") {
							return validImageIds.size > 0 ? validImageIds.has(img.id) : true;
						}
						// else drop
						return false;
					});
					return { ...ph, images: safeImages };
				});
				return { ...pa, placeholders };
			});
		}

		// 7) Ensure all variants appear in at least one print_area's variant_ids (avoid code 8251)
		//    We'll gather the final variant IDs, then check if each is found in any print_area.
		//    If not found, we insert it into the first print_area's variant_ids for safety.
		const finalVariants = finalPayload.variants || [];
		const finalVariantIds = finalVariants.map((v) => v.id);

		if (
			Array.isArray(finalPayload.print_areas) &&
			finalPayload.print_areas.length > 0
		) {
			// let the first print_area handle any missing variant IDs
			const firstPA = finalPayload.print_areas[0];

			finalPayload.print_areas = finalPayload.print_areas.map((pa) => {
				// filter out any variant_ids that are not in finalVariantIds
				// or keep them if your blueprint demands
				const validPAIds = (pa.variant_ids || []).filter((vid) =>
					finalVariantIds.includes(vid)
				);

				return { ...pa, variant_ids: validPAIds };
			});

			// Now we ensure each variant appears in at least one print_area
			for (const vId of finalVariantIds) {
				let foundIt = false;
				for (const pa of finalPayload.print_areas) {
					if (pa.variant_ids.includes(vId)) {
						foundIt = true;
						break;
					}
				}
				// If not found in any print_area => put it in the first one
				if (!foundIt) {
					if (!firstPA.variant_ids.includes(vId)) {
						firstPA.variant_ids.push(vId);
					}
				}
			}
		}

		// 8) Prepare to PUT
		const putUrl = `https://api.printify.com/v1/shops/${shopId}/products/${product_id}.json`;

		async function doUpdate(payload) {
			return axios.put(putUrl, payload, {
				headers: {
					Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
					"Content-Type": "application/json",
				},
			});
		}

		// 9) Attempt first update
		try {
			const printifyRes = await doUpdate(finalPayload);
			return res.json({
				success: true,
				message: "Printify product updated successfully",
				data: printifyRes.data,
			});
		} catch (firstErr) {
			const errData = firstErr.response?.data;
			const errCode = errData?.code;
			if (errCode !== 8252) {
				// Not locked => fail
				console.error(
					"Error updating product (1st attempt):",
					errData || firstErr.message
				);
				return res.status(500).json({
					error: "Failed to update Printify product",
					details: errData || firstErr.message,
				});
			}

			// If locked => unlock => retry
			console.log(
				"Product locked. Attempting to unlock via publishing_failed..."
			);
			try {
				await axios.post(
					`https://api.printify.com/v1/shops/${shopId}/products/${product_id}/publishing_failed.json`,
					{ reason: "Manual unlock for editing." },
					{
						headers: {
							Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							"Content-Type": "application/json",
						},
					}
				);
			} catch (unlockErr) {
				console.error(
					"Failed to unlock product:",
					unlockErr.response?.data || unlockErr.message
				);
				return res.status(500).json({
					error: "Failed to unlock product",
					details: unlockErr.response?.data || unlockErr.message,
				});
			}

			console.log("Unlocked product successfully. Retrying update...");
			try {
				const secondRes = await doUpdate(finalPayload);
				return res.json({
					success: true,
					message: "Product was unlocked and updated successfully",
					data: secondRes.data,
				});
			} catch (secondErr) {
				console.error(
					"Error updating product (2nd attempt):",
					secondErr.response?.data || secondErr.message
				);
				return res.status(500).json({
					error: "Failed to update Printify product after unlocking",
					details: secondErr.response?.data || secondErr.message,
				});
			}
		}
	} catch (outerErr) {
		console.error(
			"Error updating Printify product:",
			outerErr.response?.data || outerErr.message
		);
		return res.status(500).json({
			error: "Failed to update Printify product (outer catch)",
			details: outerErr.response?.data || outerErr.message,
		});
	}
};

// A 1×1 fully transparent PNG, Base64-encoded as a data URI
const TRANSPARENT_IMAGE_URL =
	"https://res.cloudinary.com/infiniteapps/image/upload/v1738428028/AdobeStock_679343692_Preview_onatmh.png";

/**
 * Reverts all Printify products in your shop to have "blank" designs
 * by replacing each placeholder's images with a single invisible
 * library image (referenced by an "id" from Printify).
 */
exports.revertPrintifyProductsToBePlainNoDesign = async (req, res) => {
	try {
		const DESIGN_PRINTIFY_TOKEN = process.env.DESIGN_PRINTIFY_TOKEN;
		if (!DESIGN_PRINTIFY_TOKEN) {
			return res
				.status(500)
				.json({ error: "DESIGN_PRINTIFY_TOKEN not set in environment." });
		}

		// -------------------------------------
		// 1) UPLOAD TRANSPARENT IMAGE TO PRINTIFY -> GET `transparentId`
		// -------------------------------------
		let transparentId;
		try {
			const uploadResp = await axios.post(
				"https://api.printify.com/v1/uploads/images.json",
				{
					file_name: "transparent.png",
					url: TRANSPARENT_IMAGE_URL,
					// If you wanted to do base64 instead:
					// contents: "<base64_string>"
				},
				{
					headers: {
						Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);
			transparentId = uploadResp.data.id; // e.g. "5e16d66791287a0006e522b2"
			console.log("Uploaded transparent image => ID:", transparentId);
		} catch (uploadErr) {
			console.error(
				"Failed to upload transparent image:",
				uploadErr.response?.data || uploadErr.message
			);
			return res.status(400).json({
				error: "Failed to upload transparent image to Printify",
				details: uploadErr.response?.data || uploadErr.message,
			});
		}

		// -------------------------------------
		// 2) FETCH SHOP ID
		// -------------------------------------
		let shopId;
		try {
			const shopRes = await axios.get(
				"https://api.printify.com/v1/shops.json",
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				}
			);
			if (!shopRes.data?.length) {
				return res.status(404).json({ error: "No Printify shops found." });
			}
			shopId = shopRes.data[0].id;
		} catch (shopErr) {
			console.error(
				"Error fetching shop ID:",
				shopErr.response?.data || shopErr.message
			);
			return res.status(500).json({
				error: "Failed to fetch Printify shops",
				details: shopErr.response?.data || shopErr.message,
			});
		}

		// -------------------------------------
		// 3) FETCH ALL PRODUCTS
		// -------------------------------------
		let products;
		try {
			const productsRes = await axios.get(
				`https://api.printify.com/v1/shops/${shopId}/products.json`,
				{
					headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
				}
			);
			products = productsRes.data?.data || [];
			if (!products.length) {
				return res.json({
					message: "No products in this Printify shop",
					updatedCount: 0,
				});
			}
		} catch (listErr) {
			console.error(
				"Error fetching products list:",
				listErr.response?.data || listErr.message
			);
			return res.status(500).json({
				error: "Failed to fetch products from Printify",
				details: listErr.response?.data || listErr.message,
			});
		}

		const results = [];

		// -------------------------------------
		// 4) LOOP THROUGH EACH PRODUCT & UPDATE
		// -------------------------------------
		for (const product of products) {
			const productId = product.id;
			console.log(`Processing product: ${product.title} (${productId})`);

			// 4A) GET FULL PRODUCT DETAILS
			let fullProduct;
			try {
				const singleRes = await axios.get(
					`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
					{
						headers: { Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}` },
					}
				);
				fullProduct = singleRes.data;
			} catch (getErr) {
				console.error(
					"Failed GET product details:",
					getErr.response?.data || getErr.message
				);
				results.push({
					productId,
					status: "Failed_GetDetails",
					error: getErr.response?.data || getErr.message,
				});
				continue; // Move to next product
			}

			// 4B) BUILD NEW PRINT_AREAS => single transparent image referencing 'transparentId'
			const newPrintAreas = (fullProduct.print_areas || []).map((pa) => ({
				...pa,
				placeholders: (pa.placeholders || []).map((ph) => ({
					...ph,
					images: [
						{
							type: "image",
							id: transparentId, // Must use "id" from your library upload
							x: 0.5,
							y: 0.5,
							scale: 0.01,
							angle: 0,
						},
					],
				})),
			}));

			const updatePayload = {
				title: fullProduct.title,
				description: fullProduct.description || "",
				tags: fullProduct.tags || [],
				variants: fullProduct.variants || [],
				print_areas: newPrintAreas,
			};

			// 4C) PUT UPDATE
			try {
				await axios.put(
					`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
					updatePayload,
					{
						headers: {
							Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
							"Content-Type": "application/json",
						},
					}
				);
				console.log(`✅ Product ${productId}: replaced with blank design`);
				results.push({
					productId,
					status: "BlankDesignApplied",
					message:
						"Now has only a transparent library image for each placeholder",
				});
			} catch (putErr) {
				const errCode = putErr.response?.data?.code || null;
				// If locked => we do publishing_failed => re-try
				if (errCode === 8252) {
					console.log(
						`Product ${productId} is locked. Attempting to unlock...`
					);
					try {
						// i) publishing_failed
						await axios.post(
							`https://api.printify.com/v1/shops/${shopId}/products/${productId}/publishing_failed.json`,
							{ reason: "Need to revert design." },
							{
								headers: {
									Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
									"Content-Type": "application/json",
								},
							}
						);
						// ii) Retry PUT
						await axios.put(
							`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
							updatePayload,
							{
								headers: {
									Authorization: `Bearer ${DESIGN_PRINTIFY_TOKEN}`,
									"Content-Type": "application/json",
								},
							}
						);
						console.log(`✅ Product ${productId} unlocked and updated`);
						results.push({
							productId,
							status: "BlankDesignApplied_AfterUnlock",
							message: "Unlocked, replaced with blank design",
						});
					} catch (unlockErr) {
						console.error(
							"Failed unlocking or updating product:",
							unlockErr.response?.data || unlockErr.message
						);
						results.push({
							productId,
							status: "Failed_AfterUnlock",
							error: unlockErr.response?.data || unlockErr.message,
						});
					}
				} else {
					console.error(
						`❌ Validation/Other error for product ${productId}:`,
						putErr.response?.data || putErr.message
					);
					results.push({
						productId,
						status: "Failed_Put",
						error: putErr.response?.data || putErr.message,
					});
				}
			}
		}

		// 5) SUMMARIZE RESULTS
		const successCount = results.filter((r) =>
			r.status.startsWith("BlankDesignApplied")
		).length;
		const failCount = results.length - successCount;

		return res.json({
			success: true,
			totalProducts: products.length,
			totalSuccess: successCount,
			totalFailed: failCount,
			details: results,
		});
	} catch (error) {
		console.error(
			"Error removing designs:",
			error.response?.data || error.message
		);
		return res.status(500).json({
			error: "Failed to revert designs on Printify products",
			details: error.response?.data || error.message,
		});
	}
};
