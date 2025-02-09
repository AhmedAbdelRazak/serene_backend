/** @format */

const { Order } = require("../models/order");
const Product = require("../models/product");
const Colors = require("../models/colors");
const sgMail = require("@sendgrid/mail");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const { Client, Environment } = require("square");
const crypto = require("crypto");

const {
	formatOrderEmail,
	formatOrderEmailPOS,
	formatPaymentLinkEmail,
} = require("./Helper");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const orderStatusSMS = require("twilio")(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

// ==================== SQUARE SETUP ======================
const squareClient = new Client({
	environment: Environment.Production, // for sandbox 'cnon:...' token
	accessToken: process.env.SQUARE_ACCESS_TOKEN_TEST,
});

const BusinessName = "Serene Jannat";
const fromEmail = "noreply@serenejannat.com";
const defaultEmail = "ahmed.abdelrazak@jannatbooking.com";
const shopLogo = path.join(__dirname, "../shopLogo/logo.png");

// ========================================================
// =============== ORDER MIDDLEWARE =======================
exports.orderById = async (req, res, next, id) => {
	try {
		const order = await Order.findById(id).exec();
		if (!order) {
			return res.status(404).json({ error: "Order not found" });
		}
		req.order = order;
		next();
	} catch (err) {
		return res.status(400).json({
			error: "Error Getting Order by Id",
		});
	}
};

// ========================================================
// =============== PDF INVOICE CREATION ===================
const createPdfBuffer = (order) => {
	return new Promise(async (resolve, reject) => {
		const doc = new PDFDocument({ margin: 50 });
		let buffers = [];

		doc.on("data", buffers.push.bind(buffers));
		doc.on("end", () => {
			const pdfBuffer = Buffer.concat(buffers);
			resolve(pdfBuffer);
		});
		doc.on("error", (err) => {
			reject(err);
		});

		// If you have a logo file:
		if (fs.existsSync(shopLogo)) {
			doc.image(shopLogo, 50, 45, { width: 120 }).moveDown();
		} else {
			console.error("Error: Shop logo not found.");
			doc.text("Shop Logo Here", 50, 45).moveDown();
		}

		doc.fontSize(25).text("Order Invoice", { align: "center" });
		doc.moveDown();
		doc.fontSize(16).text(`Invoice Number: ${order.invoiceNumber}`);
		doc.text(`Customer Name: ${order.customerDetails.name}`);
		doc.text(
			`Order Date: ${moment(order.createdAt).format("MMMM Do YYYY, h:mm:ss a")}`
		);
		doc.text(`Phone: ${order.customerDetails.phone}`);
		doc.text(`Ship to State: ${order.customerDetails.state}`);
		doc.text(`Shipping Address: ${order.customerDetails.address}`);
		doc.text(`Ship to Zipcode: ${order.customerDetails.zipcode}`);
		doc.text(`Status: ${order.status}`);
		doc.text(`Carrier: ${order.chosenShippingOption.carrierName}`);
		doc.text(`Shipping Price: $${order.chosenShippingOption.shippingPrice}`);
		doc.moveDown();

		doc.fontSize(20).text("Product Details:", { underline: true });

		// No-variable
		order.productsNoVariable.forEach((p, i) => {
			doc.moveDown();
			doc.fontSize(16).text(`Product ${i + 1}`);
			doc.fontSize(14).text(`Name: ${p.name}`);
			doc.text(`Quantity: ${p.ordered_quantity}`);
			doc.text(`Price: ${p.price}`);
		});

		// Variable
		for (const item of order.chosenProductQtyWithVariables) {
			const product = await Product.findById(item.productId);
			if (product) {
				const color = await Colors.findOne({
					hexa: item.chosenAttributes.color,
				});
				doc.moveDown();
				doc.fontSize(16).text(`Product: ${product.productName}`);
				doc.text(`Color: ${color ? color.color : item.chosenAttributes.color}`);
				doc.text(`Size: ${item.chosenAttributes.size}`);
				doc.text(`Quantity: ${item.ordered_quantity}`);
				doc.text(`Price: ${item.price}`);
			}
		}

		doc.moveDown();
		doc
			.fontSize(16)
			.text(
				`Total Amount: $${Number(order.totalAmountAfterDiscount).toFixed(2)}`
			);

		doc.end();
	});
};

// ========================================================
// ============= EMAIL & SMS NOTIFICATIONS ===============
const sendOrderConfirmationEmail = async (order) => {
	try {
		const pdfBuffer = await createPdfBuffer(order);
		const htmlContent = await formatOrderEmail(order);

		const recipientEmail = order.customerDetails.email || defaultEmail;

		// These might originally be objects like { email: "..."}
		// Convert them to an array of email strings:
		const bccEmails = [
			{ email: "sally.abdelrazak@serenejannat.com" },
			{ email: "ahmed.abdelrazak20@gmail.com" },
			{ email: "ahmedandsally14@gmail.com" },
		];
		const uniqueBccEmails = bccEmails
			.filter((bcc) => bcc.email !== recipientEmail)
			.map((item) => item.email);

		const FormSubmittionEmail = {
			to: recipientEmail,
			from: fromEmail,
			subject: `${BusinessName} - Order Confirmation`,
			html: htmlContent,
			attachments: [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Order_Confirmation.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		};

		// separate email for the internal team
		const FormSubmittionEmail2 = {
			to: uniqueBccEmails, // array of strings
			from: fromEmail,
			subject: `${BusinessName} - Order Confirmation`,
			html: htmlContent,
			attachments: [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Order_Confirmation.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		};

		// Send first to customer
		await sgMail.send(FormSubmittionEmail);

		// Send second to internal staff
		await sgMail.send(FormSubmittionEmail2);

		console.log("Order confirmation emails sent successfully.");
	} catch (error) {
		console.error("Error sending order confirmation email:", error);
		if (error.response) {
			console.error("SendGrid response body:", error.response.body);
		}
	}
};

const sendOrderConfirmationSMS = async (order) => {
	const smsData = {
		phone: order.customerDetails.phone,
		text: `Hi ${order.customerDetails.name} - Your order was successfully placed. Thank you for choosing Serene Jannat Gifts.`,
	};

	let formattedPhone = smsData.phone;
	if (!formattedPhone.startsWith("+1")) {
		formattedPhone = `+1${formattedPhone}`;
	}

	console.log(`Sending SMS to: ${formattedPhone}`);

	try {
		await orderStatusSMS.messages.create({
			body: smsData.text,
			from: "+19094884148",
			to: formattedPhone,
		});
		console.log(`SMS sent to ${formattedPhone}`);
	} catch (err) {
		console.error(`Error sending SMS to ${formattedPhone}:`, err);
	}
};

// ========================================================
// =============== STOCK CHECK & UPDATE ===================
const checkStockAvailability = async (order) => {
	// productsNoVariable
	for (const item of order.productsNoVariable) {
		if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true) {
			// POD logic => ensure variant is "available" in printifyProductDetails
			const cartColor = (item.chosenAttributes?.color || "").toLowerCase();
			const cartSize = (item.chosenAttributes?.size || "").toLowerCase();

			const matchedVariant = item.printifyProductDetails.variants.find((v) => {
				const titleLC = v.title.toLowerCase().replace(/["']/g, "");
				const colorLC = cartColor.replace(/["']/g, "");
				const sizeLC = cartSize.replace(/["']/g, "");
				return titleLC.includes(colorLC) && titleLC.includes(sizeLC);
			});

			if (!matchedVariant) {
				return `No matching POD variant found for product ${item.name}.`;
			}
			if (!matchedVariant.is_available) {
				return `Variant is not available for product ${item.name}.`;
			}
		} else {
			// normal local logic
			const product = await Product.findById(item.productId);
			if (!product) {
				return `Product not found for ID ${item.productId}`;
			}
			if (product.quantity < item.ordered_quantity) {
				return `Insufficient stock for product ${product.productName}.`;
			}
		}
	}

	// chosenProductQtyWithVariables
	for (const item of order.chosenProductQtyWithVariables) {
		if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true) {
			// POD logic => ensure variant is "available"
			const cartColor = (item.chosenAttributes?.color || "").toLowerCase();
			const cartSize = (item.chosenAttributes?.size || "").toLowerCase();

			const matchedVariant = item.printifyProductDetails.variants.find((v) => {
				const titleLC = v.title.toLowerCase().replace(/["']/g, "");
				const colorLC = cartColor.replace(/["']/g, "");
				const sizeLC = cartSize.replace(/["']/g, "");
				return titleLC.includes(colorLC) && titleLC.includes(sizeLC);
			});

			if (!matchedVariant) {
				return `No matching POD variant found for product ${item.name}.`;
			}
			if (!matchedVariant.is_available) {
				return `Variant is not available for product ${item.name}.`;
			}
		} else {
			// normal local logic
			const product = await Product.findById(item.productId);
			if (!product) {
				return `Product not found for ID ${item.productId}`;
			}

			const attribute = product.productAttributes.find(
				(a) =>
					(a.color || "").toLowerCase() ===
						(item.chosenAttributes.color || "").toLowerCase() &&
					(a.size || "").toLowerCase() ===
						(item.chosenAttributes.size || "").toLowerCase()
			);
			if (!attribute) {
				return `Attribute not found for product ${product.productName}`;
			}
			if (attribute.quantity < item.ordered_quantity) {
				return `Insufficient stock for product ${product.productName} with color ${attribute.color} and size ${attribute.size}.`;
			}
		}
	}

	return null;
};

const updateStock = async (order) => {
	try {
		const bulkOps = [];

		// no-variable
		for (const item of order.productsNoVariable) {
			if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true) {
				// skip local stock
				continue;
			}
			bulkOps.push({
				updateOne: {
					filter: { _id: item.productId },
					update: { $inc: { quantity: -item.ordered_quantity } },
					upsert: false,
				},
			});
		}

		// variable
		for (const item of order.chosenProductQtyWithVariables) {
			if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true) {
				// skip local attribute logic
				continue;
			}

			const product = await Product.findById(item.productId);
			if (!product) {
				throw new Error(`Product not found for ID ${item.productId}`);
			}

			const attr = product.productAttributes.find((a) => {
				return (
					(a.color || "").toLowerCase() ===
						(item.chosenAttributes.color || "").toLowerCase() &&
					(a.size || "").toLowerCase() ===
						(item.chosenAttributes.size || "").toLowerCase()
				);
			});

			if (!attr) {
				throw new Error(
					`Attribute not found for product ${product.productName}`
				);
			}

			attr.quantity -= item.ordered_quantity;
			if (attr.quantity < 0) {
				throw new Error(
					`Insufficient stock for ${product.productName} color ${attr.color} size ${attr.size}`
				);
			}

			bulkOps.push({
				updateOne: {
					filter: {
						_id: product._id,
						"productAttributes._id": attr._id,
					},
					update: {
						$set: { "productAttributes.$.quantity": attr.quantity },
					},
					upsert: false,
				},
			});
		}

		if (bulkOps.length > 0) {
			await Product.bulkWrite(bulkOps);
		}
	} catch (err) {
		console.error("Error updating stock:", err);
		throw err;
	}
};

// ========================================================
// =============== HELPER: INVOICE NUMBERS ================
const generateRandomInvoiceNumber = () => {
	return Math.floor(1000000000 + Math.random() * 9000000000).toString();
};

const isInvoiceNumberUnique = async (invoiceNumber) => {
	const order = await Order.findOne({ invoiceNumber });
	return !order;
};

const generateUniqueInvoiceNumber = async () => {
	let invoiceNumber;
	let isUnique = false;

	while (!isUnique) {
		invoiceNumber = generateRandomInvoiceNumber();
		isUnique = await isInvoiceNumberUnique(invoiceNumber);
	}
	return invoiceNumber;
};

// ========================================================
// =============== SQUARE PAYMENT LOGIC ===================
const processSquarePayment = async (
	amount,
	nonce,
	zipCode,
	customerDetails
) => {
	const idempotencyKey = crypto.randomBytes(12).toString("hex");

	console.log("FINAL ZIP CODE:", zipCode);

	const requestBody = {
		sourceId: nonce,
		idempotencyKey,
		amountMoney: {
			amount: Math.round(amount * 100),
			currency: "USD",
		},
		autocomplete: true,
		billingAddress: {
			postal_code: zipCode || "",
		},
		customerDetails: {
			givenName: customerDetails.name.split(" ")[0],
			familyName: customerDetails.name.split(" ").slice(1).join(" "),
			emailAddress: customerDetails.email,
			phoneNumber: customerDetails.phone,
			address: {
				addressLine1: customerDetails.address,
				locality: customerDetails.state,
				postal_code: zipCode || "",
			},
		},
	};

	console.log("Square Request Body:", requestBody);

	try {
		const response = await squareClient.paymentsApi.createPayment(requestBody);
		return response.result;
	} catch (err) {
		console.log(err.message, "Square error.message");
		throw new Error(err.message);
	}
};

// ========================================================
// =============== MISC HELPER ============================
const convertBigIntToString = (obj) => {
	if (typeof obj !== "object" || obj === null) return obj;
	for (const key in obj) {
		if (typeof obj[key] === "bigint") {
			obj[key] = obj[key].toString();
		} else if (typeof obj[key] === "object") {
			obj[key] = convertBigIntToString(obj[key]);
		}
	}
	return obj;
};

/**
 * Upload an image file to Printify if needed.
 *
 * @param {String} imageUrl  - The publicly accessible URL (e.g., from Cloudinary).
 * @param {String} token     - The Printify personal access token to use.
 * @returns {String|null}    - The uploaded image's "id" from Printify, or null on failure.
 */
async function uploadIfNeeded(imageUrl, token) {
	try {
		// 1) Attempt to upload by "url"
		const payload = {
			file_name: "custom-design.png",
			url: imageUrl, // direct link to your final screenshot
		};
		const resp = await axios.post(
			"https://api.printify.com/v1/uploads/images.json",
			payload,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			}
		);
		// If successful, we get e.g. { id, file_name, ... }
		return resp.data.id;
	} catch (error) {
		console.error(
			"Error uploading final screenshot to Printify:",
			error?.response?.data || error
		);
		return null;
	}
}

// ========================================================
// === For ephemeral POD item => create custom product, order, then DISABLE
async function createOnTheFlyPOD(item, order, token) {
	try {
		const shopId = item.printifyProductDetails?.shop_id;
		if (!shopId) {
			throw new Error("No Printify shop_id found for POD item");
		}

		// 1) Normalize chosen color & size
		const cartColor = (item.chosenAttributes.color || "").toLowerCase();
		const cartSize = (item.chosenAttributes.size || "").toLowerCase();

		// Remove quotes and trim so "15\" x 16\"" => "15 x 16"
		const cartColorNormalized = cartColor.replace(/["']/g, "").trim();
		const cartSizeNormalized = cartSize.replace(/["']/g, "").trim();

		console.log(
			"DEBUG: Matching variant =>",
			"cartColorNormalized:",
			cartColorNormalized,
			"cartSizeNormalized:",
			cartSizeNormalized
		);

		// 2) Find the real variant ID from item.printifyProductDetails.variants
		const matchedVariantObj = item.printifyProductDetails.variants.find((v) => {
			// Lowercase & remove quotes in the variant title
			const titleNormalized = v.title.toLowerCase().replace(/["']/g, "").trim();
			console.log("Variant title (normalized):", titleNormalized);

			// We consider a match if the variant title includes both color & size
			return (
				titleNormalized.includes(cartColorNormalized) &&
				titleNormalized.includes(cartSizeNormalized)
			);
		});

		if (!matchedVariantObj) {
			// THROW so the entire order is aborted
			throw new Error("No real variant found for chosen color/size");
		}

		const realVariantId = matchedVariantObj.id;

		// 3) Upload the BARE screenshot URL
		let uploadedId = null;
		if (item?.customDesign?.bareScreenshotUrl) {
			uploadedId = await uploadIfNeeded(
				item.customDesign.bareScreenshotUrl,
				token
			);
			if (!uploadedId) {
				throw new Error("Cannot proceed ephemeral. uploadIfNeeded is null");
			}
		} else {
			throw new Error(
				"No bareScreenshotUrl found. Skipping ephemeral creation."
			);
		}

		// 4) Build placeholders
		const placeholders = [
			{
				position: "front",
				images: [
					{
						id: uploadedId,
						type: "image/png", // or image/jpeg if needed
						x: 0.5,
						y: 0.5,
						scale: 1,
						angle: 0,
					},
				],
			},
		];

		// 5) Create ephemeral product
		const createProductPayload = {
			title: "Custom One-Time Product",
			description: "User-personalized product",
			blueprint_id: item.printifyProductDetails.blueprint_id,
			print_provider_id: item.printifyProductDetails.print_provider_id,
			variants: [
				{
					id: realVariantId,
					price: Math.round(item.price * 100),
					is_enabled: true,
					is_default: true,
				},
			],
			print_areas: [
				{
					variant_ids: [realVariantId],
					placeholders,
				},
			],
		};

		const createResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			createProductPayload,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			}
		);

		if (!createResp.data?.id) {
			throw new Error("Failed to create ephemeral POD product on Printify.");
		}
		const newProductId = createResp.data.id;
		console.log("Ephemeral POD product created:", newProductId);

		// 6) Place ephemeral order
		const orderPayload = {
			external_id: `custom-order-${Date.now()}`,
			line_items: [
				{
					product_id: newProductId,
					variant_id: realVariantId,
					quantity: item.ordered_quantity,
				},
			],
			shipping_method: 1, // standard shipping
			send_shipping_notification: false,
			address_to: {
				first_name: order.customerDetails.name.split(" ")[0],
				last_name: order.customerDetails.name.split(" ").slice(1).join(" "),
				email: order.customerDetails.email,
				phone: order.customerDetails.phone,
				country: "US",
				region: order.customerDetails.state,
				address1: order.customerDetails.address,
				city: order.customerDetails.city,
				zip: order.customerDetails.zipcode,
			},
		};

		const orderResp = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/orders.json`,
			orderPayload,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			}
		);
		console.log("Ephemeral POD order created:", orderResp.data);

		// 7) DISABLE ephemeral product instead of deleting
		try {
			const disablePayload = { visible: false };
			await axios.put(
				`https://api.printify.com/v1/shops/${shopId}/products/${newProductId}.json`,
				disablePayload,
				{
					headers: {
						Authorization: `Bearer ${token}`,
					},
				}
			);
			console.log("Ephemeral POD product disabled:", newProductId);
		} catch (disableErr) {
			console.warn(
				"Warning: ephemeral product was ordered but not disabled:",
				disableErr
			);
		}

		// 8) Save ephemeral order details in DB
		await Order.findByIdAndUpdate(order._id, {
			$push: {
				printifyOrderDetails: {
					ephemeralProductId: newProductId,
					ephemeralOrder: orderResp.data,
				},
			},
		});
	} catch (err) {
		console.error("Error in createOnTheFlyPOD:", err?.response?.data || err);
		// rethrow to abort entire order
		throw err;
	}
}

// ========================================================
// =============== POST ORDER TO PRINTIFY =================
const postOrderToPrintify = async (order) => {
	const normalToken = process.env.PRINTIFY_TOKEN; // normal Printify token
	const designToken = process.env.DESIGN_PRINTIFY_TOKEN || normalToken; // for ephemeral POD

	const products = [
		...order.productsNoVariable,
		...order.chosenProductQtyWithVariables,
	];

	for (const item of products) {
		// If not a Printify item, skip
		if (!item.isPrintifyProduct) {
			continue;
		}

		// If it's a "pure POD" with custom design => ephemeral approach
		if (item.printifyProductDetails?.POD === true && item.customDesign) {
			// If createOnTheFlyPOD fails, we throw => entire order is aborted
			await createOnTheFlyPOD(item, order, designToken);
		} else {
			// normal approach => existing product
			const headers = {
				Authorization: `Bearer ${normalToken}`,
				"Content-Type": "application/json",
			};

			let variantId;
			if (item.chosenAttributes && item.chosenAttributes.SubSKU) {
				const matchedVariant = item.printifyProductDetails.variants.find(
					(v) => v.sku === item.chosenAttributes.SubSKU
				);
				if (!matchedVariant) {
					// Throw if we can't find the specified SKU
					throw new Error(
						`No matching variant in printifyProductDetails for SKU: ${item.chosenAttributes.SubSKU}`
					);
				}
				variantId = matchedVariant.id;
			} else {
				// fallback to the 1st variant
				variantId = item.printifyProductDetails.variants[0].id;
			}

			const printifyOrder = {
				line_items: [
					{
						product_id: item.printifyProductDetails.id,
						variant_id: variantId,
						quantity: item.ordered_quantity,
						print_provider_id: item.printifyProductDetails.print_provider_id,
						blueprint_id: item.printifyProductDetails.blueprint_id,
					},
				],
				address_to: {
					first_name: order.customerDetails.name.split(" ")[0],
					last_name: order.customerDetails.name.split(" ").slice(1).join(" "),
					email: order.customerDetails.email,
					phone: order.customerDetails.phone,
					country: "US",
					region: order.customerDetails.state,
					city: order.customerDetails.city,
					address1: order.customerDetails.address,
					postal_code:
						Number(order.customerDetails.zipcode) ||
						order.customerDetails.zipcode,
				},
			};

			console.log(
				"Sending the following order to Printify (non-POD):",
				JSON.stringify(printifyOrder, null, 2)
			);

			try {
				const response = await axios.post(
					`https://api.printify.com/v1/shops/${item.printifyProductDetails.shop_id}/orders.json`,
					printifyOrder,
					{ headers }
				);
				console.log(`Order posted to Printify: ${response.data.id}`);

				// Save normal printify order details
				await Order.findByIdAndUpdate(order._id, {
					$set: {
						printifyOrderDetails: response.data,
					},
				});
				console.log(`Printify order details saved for order: ${order._id}`);
			} catch (error) {
				console.error(`Error posting order to Printify: ${error.message}`);
				if (error.response) {
					console.error("Printify API response:", error.response.data);
				}
				// Rethrow => so we can abort the entire order
				throw error;
			}
		}
	}
};

// ========================================================
// =============== CREATE ORDER CONTROLLER ================
// Flow:
//  1) Check stock
//  2) Generate invoice number
//  3) Create local order doc (without payment details yet)
//  4) postOrderToPrintify => if fails => remove local order => throw error
//  5) If printify success => processSquarePayment => if that fails => same approach
//  6) Add paymentDetails => update stock => send notifications => respond
exports.create = async (req, res) => {
	try {
		const { paymentToken, orderData } = req.body;
		const zipCode = orderData?.customerDetails?.zipcode;

		if (!orderData || !orderData.totalAmount) {
			throw new Error("Order data or totalAmount is missing");
		}

		// 1) Check stock
		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) {
			return res.status(400).json({ error: stockIssue });
		}

		// 2) Generate Invoice Number
		const invoiceNumber = await generateUniqueInvoiceNumber();

		// 3) Create local order in DB (without payment details yet)
		const order = new Order({
			...orderData,
			invoiceNumber,
		});
		await order.save();

		// 4) Attempt to create the order on Printify BEFORE charging
		try {
			await postOrderToPrintify(order);
		} catch (err) {
			// If Printify fails (including "No real variant found"), remove the local doc
			await Order.findByIdAndDelete(order._id);
			throw new Error(
				`Failed to create POD order. Card not charged. Please try again later`
			);
		}

		// 5) Process Square Payment
		let paymentResult;
		try {
			paymentResult = await processSquarePayment(
				orderData.totalAmountAfterDiscount,
				paymentToken,
				zipCode,
				orderData.customerDetails
			);
		} catch (err) {
			// If Square fails, also remove the local order
			await Order.findByIdAndDelete(order._id);
			throw new Error(
				`Card payment failed. Order aborted. Details: ${err.message}`
			);
		}

		// 6) Save payment details in local order
		order.paymentDetails = paymentResult;
		await order.save();

		// 7) Update local stock
		await updateStock(order);

		// 8) Send Email & SMS
		sendOrderConfirmationEmail(order).catch((err) =>
			console.error("Error sending confirmation email:", err)
		);
		sendOrderConfirmationSMS(order).catch((err) =>
			console.error("Error sending confirmation SMS:", err)
		);

		// 9) Convert BigInt => string & respond
		const responseOrder = convertBigIntToString(order.toObject());
		res.json(responseOrder);
	} catch (error) {
		console.error("Error creating order:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.readSingleOrder = async (req, res) => {
	try {
		const order = await Order.findById(req.params.singleOrderId).exec();
		if (!order) {
			return res.status(404).json({ error: "Order not found" });
		}
		res.json(order);
	} catch (err) {
		console.error("Error fetching order:", err);
		res.status(400).json({ error: "Error fetching order" });
	}
};

const createPdfBufferPOS = (order) => {
	return new Promise(async (resolve, reject) => {
		const doc = new PDFDocument({ margin: 50 });
		let buffers = [];

		doc.on("data", buffers.push.bind(buffers));
		doc.on("end", () => {
			const pdfBuffer = Buffer.concat(buffers);
			resolve(pdfBuffer);
		});
		doc.on("error", (err) => {
			reject(err);
		});

		// Ensure the image path is correct and add the shop logo
		if (fs.existsSync(shopLogo)) {
			doc.image(shopLogo, 50, 45, { width: 120 }).moveDown();
		} else {
			console.error("Error: Shop logo not found.");
			doc.text("Shop Logo Here", 50, 45).moveDown();
		}

		// Add content to the PDF
		doc.fontSize(25).text("Order Invoice", { align: "center" });
		doc.moveDown();
		doc.fontSize(16).text(`Invoice Number: ${order.invoiceNumber}`);
		doc.text(`Customer Name: ${order.customerDetails.name}`);
		doc.text(
			`Order Date: ${moment(order.createdAt).format("MMMM Do YYYY, h:mm:ss a")}`
		);
		doc.text(`Status: ${order.status}`);
		doc.moveDown();

		doc.fontSize(20).text("Product Details:", { underline: true });

		// Handle products without variables
		order.productsNoVariable.forEach((product, index) => {
			doc.moveDown();
			doc.fontSize(16).text(`Product ${index + 1}`);
			doc.fontSize(14).text(`Name: ${product.name}`);
			doc.text(`Quantity: ${product.ordered_quantity}`);
			doc.text(`Price: ${product.price}`);
		});

		// Handle products with variables
		for (const item of order.chosenProductQtyWithVariables) {
			const product = await Product.findById(item.productId);
			if (product) {
				const color = await Colors.findOne({
					hexa: item.chosenAttributes.color,
				});
				doc.moveDown();
				doc.fontSize(16).text(`Product: ${product.productName}`);
				doc.text(`Color: ${color ? color.color : item.chosenAttributes.color}`);
				doc.text(`Size: ${item.chosenAttributes.size}`);
				doc.text(`Quantity: ${item.ordered_quantity}`);
				doc.text(`Price: ${item.price}`);
			}
		}

		doc.moveDown();
		doc
			.fontSize(16)
			.text(
				`Total Amount: $${Number(order.totalAmountAfterDiscount).toFixed(2)}`
			);

		doc.end();
	});
};

const sendOrderConfirmationEmailPOS = async (order) => {
	try {
		const pdfBuffer = await createPdfBufferPOS(order);
		const htmlContent = await formatOrderEmailPOS(order);

		const recipientEmail = order.customerDetails.email || defaultEmail;
		const bccEmails = [
			{ email: "sally.abdelrazak@serenejannat.com" },
			{ email: "ahmed.abdelrazak20@gmail.com" },
			{ email: "ahmedandsally14@gmail.com" },
		];

		// Remove duplicates
		const uniqueBccEmails = bccEmails.filter(
			(bcc) => bcc.email !== recipientEmail
		);

		const FormSubmittionEmail = {
			to: recipientEmail,
			from: fromEmail,
			bcc: uniqueBccEmails,
			subject: `${BusinessName} - Order Confirmation`,
			html: htmlContent,
			attachments: [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Order_Confirmation.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		};

		await sgMail.send(FormSubmittionEmail);
		console.log("Order confirmation email sent successfully.");
	} catch (error) {
		console.error("Error sending order confirmation email:", error);
		if (error.response) {
			console.error("SendGrid response body:", error.response.body);
		}
	}
};

exports.createPOS = async (req, res) => {
	try {
		const { orderData } = req.body;

		if (!orderData || !orderData.totalAmount) {
			throw new Error("Order data or totalAmount is missing");
		}

		console.log("Order data received: ", orderData);

		// Check stock availability before proceeding
		const stockIssue = await checkStockAvailability(orderData);
		if (stockIssue) {
			return res.status(400).json({ error: stockIssue });
		}

		// Generate a unique invoice number
		const invoiceNumber = await generateUniqueInvoiceNumber();

		// Create the order object with the unique invoice number
		const order = new Order({
			...orderData,
			invoiceNumber,
			orderSource: "POS",
		});

		console.log("Order object before saving: ", order);

		// Save the order
		const data = await order.save();
		console.log("Order saved successfully: ", data);

		// Update stock
		await updateStock(order);

		// Check if sendReceipt is true, then send confirmation email with PDF attached
		if (orderData.sendReceipt) {
			sendOrderConfirmationEmailPOS(order).catch((error) => {
				console.error("Error sending confirmation email:", error);
			});
		}

		// Check if sendPaymentLink is true, then send payment link
		if (orderData.sendPaymentLink) {
			const paymentLink = `${process.env.CLIENT_URL}/payment-link/${order._id}`;
			const { email, phone, name } = order.customerDetails;

			if (phone) {
				const formattedPhone = phone.startsWith("+1") ? phone : `+1${phone}`;
				const smsData = {
					body: `Dear ${name}, please use the following link to complete your payment: ${paymentLink}`,
					from: "+19094884148",
					to: formattedPhone,
				};

				orderStatusSMS.messages
					.create(smsData)
					.then(() => {
						console.log(`Payment link SMS sent to ${formattedPhone}`);
					})
					.catch((err) => {
						console.error(
							`Error sending payment link SMS to ${formattedPhone}:`,
							err
						);
					});
			} else if (email) {
				const htmlContent = formatPaymentLinkEmail(order, paymentLink);
				const FormSubmittionEmail = {
					to: email,
					from: fromEmail,
					subject: `${BusinessName} - Payment Link`,
					html: htmlContent,
				};

				sgMail
					.send(FormSubmittionEmail)
					.then(() => {
						console.log("Payment link email sent successfully.");
					})
					.catch((error) => {
						console.error("Error sending payment link email:", error);
						if (error.response) {
							console.error("SendGrid response body:", error.response.body);
						}
					});
			} else {
				console.log("No phone or email provided for sending payment link.");
			}
		}

		// Convert BigInt values to strings before sending the response
		const responseOrder = convertBigIntToString(data.toObject());

		res.json(responseOrder);
	} catch (error) {
		console.error("Error creating POS order:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.processOrderPayment = async (req, res) => {
	const { orderId, token, zipCode } = req.body;

	try {
		const order = await Order.findById(orderId).exec();
		if (!order) {
			return res.status(404).json({ error: "Order not found" });
		}

		// Process payment
		const paymentResult = await processSquarePayment(
			order.totalAmountAfterDiscount,
			token,
			zipCode,
			order.customerDetails
		);

		// Update order status
		order.paymentStatus = "Paid Via Link";
		order.paymentDetails = paymentResult;
		await order.save();

		// Convert BigInt values to strings before emitting the event
		const sanitizedOrder = convertBigIntToString(order.toObject());

		// Emit WebSocket event for order update
		const io = req.app.get("io");
		io.emit("orderUpdated", sanitizedOrder);

		res.json(sanitizedOrder);
	} catch (error) {
		console.error("Error processing order payment:", error);
		res.status(400).json({ error: "Payment processing failed" });
	}
};

exports.usersHistoryOrders = async (req, res) => {
	try {
		const { userId } = req.params;
		const orders = await Order.find({ "customerDetails.userId": userId }).sort({
			createdAt: -1,
		});

		if (!orders.length) {
			return res
				.status(404)
				.json({ message: "No orders found for this user." });
		}

		res.status(200).json(orders);
	} catch (error) {
		console.error("Error fetching user orders:", error);
		res.status(500).json({ message: "Server error. Please try again later." });
	}
};

exports.listOfAggregatedForPagination = async (req, res) => {
	const {
		page = 1,
		records = 50,
		startDate,
		endDate,
		status = "all",
	} = req.params;

	const pageNum = parseInt(page, 10) || 1;
	const recordsNum = parseInt(records, 10) || 50;
	const filters = {};

	// Validate and add date filters
	const isValidDate = (date) => /\d{4}-\d{2}-\d{2}/.test(date);

	if (startDate && endDate && isValidDate(startDate) && isValidDate(endDate)) {
		filters.createdAt = {
			$gte: new Date(`${startDate}T00:00:00+00:00`),
			$lte: new Date(`${endDate}T23:59:59+00:00`),
		};
	}

	// Add status filter
	if (status === "open") {
		filters.status = {
			$nin: ["Shipped", "Delivered", "Cancelled", "fulfilled"],
		};
	} else if (status === "closed") {
		filters.status = {
			$in: ["Shipped", "Delivered", "Cancelled", "fulfilled"],
		};
	}

	try {
		// 1) Match stage
		const matchStage = { $match: filters };

		// 2) Count total records
		const countStage = { $count: "count" };

		// 3) Build the "ordersStage"
		const ordersStage = [
			{ $sort: { createdAt: -1 } },
			{ $skip: (pageNum - 1) * recordsNum },
			{ $limit: recordsNum },

			// --- STEP A: Convert productId (string) => ObjectId for each item in productsNoVariable ---
			{
				$addFields: {
					productsNoVariable: {
						$map: {
							input: "$productsNoVariable",
							as: "item",
							in: {
								$mergeObjects: [
									// Original fields from each item
									"$$item",
									// Add a new field "productIdObj" by converting the string to ObjectId
									{
										productIdObj: { $toObjectId: "$$item.productId" },
									},
								],
							},
						},
					},
				},
			},

			// --- STEP B: Lookup the actual Product docs using productIdObj ---
			{
				$lookup: {
					from: "products", // collection name
					localField: "productsNoVariable.productIdObj",
					foreignField: "_id",
					as: "noVarProducts",
				},
			},

			// --- STEP C: Merge the found productSKU into productsNoVariable ---
			{
				$addFields: {
					productsNoVariable: {
						$map: {
							input: "$productsNoVariable",
							as: "item",
							in: {
								$mergeObjects: [
									"$$item", // original item fields
									{
										productSKU: {
											$let: {
												vars: {
													matchedProduct: {
														$first: {
															$filter: {
																input: "$noVarProducts",
																as: "p",
																cond: {
																	$eq: ["$$item.productIdObj", "$$p._id"],
																},
															},
														},
													},
												},
												in: "$$matchedProduct.productSKU",
											},
										},

										color: {
											$let: {
												vars: {
													matchedProduct: {
														$first: {
															$filter: {
																input: "$noVarProducts",
																as: "p",
																cond: {
																	$eq: ["$$item.productIdObj", "$$p._id"],
																},
															},
														},
													},
												},
												in: "$$matchedProduct.color",
											},
										},
									},
								],
							},
						},
					},
				},
			},

			// --- STEP D: Remove temp array so it doesn’t clutter final output ---
			{ $unset: "noVarProducts" },
		];

		// 4) Combine into a facet so we get totalRecords & orders together
		const aggregateQuery = [
			matchStage,
			{
				$facet: {
					totalRecords: [countStage],
					orders: ordersStage,
				},
			},
			{
				$project: {
					totalRecords: { $arrayElemAt: ["$totalRecords.count", 0] },
					orders: 1,
				},
			},
		];

		// 5) Execute the pipeline
		const result = await Order.aggregate(aggregateQuery);

		const totalRecords = result[0]?.totalRecords || 0;
		const orders = result[0]?.orders || [];

		// 6) Return the final response
		res.json({
			page: pageNum,
			records: recordsNum,
			totalRecords,
			totalPages: Math.ceil(totalRecords / recordsNum),
			orders,
		});
	} catch (error) {
		console.error("Error fetching user orders:", error);
		res.status(500).json({ message: "Server error. Please try again later." });
	}
};

const updateStockCancelled = async (order) => {
	try {
		const bulkOps = [];

		// Update stock for products without variables
		for (const item of order.productsNoVariable) {
			bulkOps.push({
				updateOne: {
					filter: { _id: item.productId },
					update: { $inc: { quantity: item.ordered_quantity } },
					upsert: false,
				},
			});
		}

		// Update stock for products with variables
		for (const item of order.chosenProductQtyWithVariables) {
			const product = await Product.findById(item.productId);
			if (product) {
				const attribute = product.productAttributes.find(
					(attr) =>
						attr.color === item.chosenAttributes.color &&
						attr.size === item.chosenAttributes.size
				);

				if (attribute) {
					attribute.quantity += item.ordered_quantity;

					bulkOps.push({
						updateOne: {
							filter: {
								_id: product._id,
								"productAttributes._id": attribute._id,
							},
							update: {
								$set: { "productAttributes.$.quantity": attribute.quantity },
							},
							upsert: false,
						},
					});
				} else {
					throw new Error(
						`Attribute not found for product ${product.productName}`
					);
				}
			} else {
				throw new Error(`Product not found for ID ${item.productId}`);
			}
		}

		if (bulkOps.length > 0) {
			await Product.bulkWrite(bulkOps);
		}
	} catch (error) {
		console.error("Error updating stock:", error);
		throw error; // Rethrow the error to handle it in the order update flow
	}
};

const updateStockForOrder = async (order, type, product) => {
	const bulkOps = [];

	console.log(`Updating stock for type: ${type}`);
	console.log("Product:", product);

	if (type === "remove" || type === "exchange") {
		console.log("Updating stock for removing/exchanging product");
		const incrementQuantity = product.ordered_quantity || 1; // Ensure that we have a valid ordered quantity

		if (
			order.productsNoVariable.some((p) => p.productId === product.productId)
		) {
			bulkOps.push({
				updateOne: {
					filter: { _id: product.productId },
					update: { $inc: { quantity: incrementQuantity } },
					upsert: false,
				},
			});
		} else if (
			order.chosenProductQtyWithVariables.some(
				(p) => p.productId === product.productId
			)
		) {
			const productDoc = await Product.findById(product.productId);
			const attribute = productDoc.productAttributes.find(
				(attr) =>
					attr.color === product.chosenAttributes.color &&
					attr.size === product.chosenAttributes.size
			);
			if (attribute) {
				attribute.quantity += incrementQuantity;
				bulkOps.push({
					updateOne: {
						filter: {
							_id: product.productId,
							"productAttributes._id": attribute._id,
						},
						update: {
							$set: { "productAttributes.$.quantity": attribute.quantity },
						},
						upsert: false,
					},
				});
			}
		}
	} else if (type === "addUnits" || type === "addProduct") {
		console.log("Updating stock for adding product/units");
		const changeQuantity = -product.added_quantity || -product.ordered_quantity; // Adjust the stock decrement correctly

		// Add product without variables
		if (
			order.productsNoVariable.some((p) => p.productId === product.productId)
		) {
			bulkOps.push({
				updateOne: {
					filter: { _id: product.productId },
					update: { $inc: { quantity: changeQuantity } },
					upsert: false,
				},
			});
		} else if (product.chosenAttributes) {
			const productDoc = await Product.findById(product.productId);
			const attribute = productDoc.productAttributes.find(
				(attr) =>
					attr.color === product.chosenAttributes.color &&
					attr.size === product.chosenAttributes.size
			);
			if (attribute) {
				attribute.quantity += changeQuantity;
				bulkOps.push({
					updateOne: {
						filter: {
							_id: product.productId,
							"productAttributes._id": attribute._id,
						},
						update: {
							$set: { "productAttributes.$.quantity": attribute.quantity },
						},
						upsert: false,
					},
				});
			} else {
				console.log("Attribute not found:", product.chosenAttributes);
			}
		} else {
			console.log("Product not found in order:", product.productId);

			// New product case
			bulkOps.push({
				updateOne: {
					filter: { _id: product.productId },
					update: { $inc: { quantity: changeQuantity } },
					upsert: false,
				},
			});
		}
	}

	console.log("Bulk operations:", bulkOps);

	if (bulkOps.length > 0) {
		const bulkWriteResult = await Product.bulkWrite(bulkOps);
		console.log("Bulk write result:", bulkWriteResult);
	} else {
		console.log("No bulk operations to execute");
	}
};

const calculateOrderTotals = (order) => {
	const totalOrderQty =
		order.productsNoVariable.reduce(
			(total, item) => total + item.ordered_quantity,
			0
		) +
		order.chosenProductQtyWithVariables.reduce(
			(total, item) => total + item.ordered_quantity,
			0
		);

	const totalAmount =
		order.productsNoVariable.reduce(
			(total, item) => total + item.ordered_quantity * item.price,
			0
		) +
		order.chosenProductQtyWithVariables.reduce(
			(total, item) => total + item.ordered_quantity * item.price,
			0
		) +
		order.chosenShippingOption.shippingPrice;

	return { totalOrderQty, totalAmount, totalAmountAfterDiscount: totalAmount };
};

exports.updateSingleOrder = async (req, res) => {
	try {
		const { orderId } = req.params;
		const {
			order,
			updateType,
			product,
			trackingNumber,
			status,
			customerDetails,
		} = req.body;

		console.log(req.body, "req.body");
		console.log(updateType, "updateType");

		const currentOrder = await Order.findById(orderId);
		if (!currentOrder) {
			return res.status(404).json({ message: "Order not found." });
		}

		let updatedOrder;
		let updateStatusMessage = "";

		switch (updateType) {
			case "remove":
				await updateStockForOrder(currentOrder, "remove", product);
				updatedOrder = await Order.findByIdAndUpdate(
					orderId,
					{
						$pull: {
							productsNoVariable: { productId: product.productId },
							chosenProductQtyWithVariables: { productId: product.productId },
						},
						$set: { updateStatus: "Removed product" },
					},
					{ new: true }
				);
				updateStatusMessage = "Removed product";
				break;

			case "addUnits":
				const currentProduct =
					currentOrder.productsNoVariable.find(
						(p) => p.productId === product.productId
					) ||
					currentOrder.chosenProductQtyWithVariables.find(
						(p) => p.productId === product.productId
					);

				if (currentProduct) {
					product.ordered_quantity =
						currentProduct.ordered_quantity + product.added_quantity;
				}
				await updateStockForOrder(currentOrder, "addUnits", product);
				updatedOrder = await Order.findByIdAndUpdate(
					orderId,
					{
						$set: {
							"productsNoVariable.$[elem].ordered_quantity":
								product.ordered_quantity,
							"chosenProductQtyWithVariables.$[elem].ordered_quantity":
								product.ordered_quantity,
							updateStatus: "Added units to product",
						},
					},
					{
						new: true,
						arrayFilters: [{ "elem.productId": product.productId }],
					}
				);
				updateStatusMessage = "Added units to product";
				break;

			case "addProduct":
				await updateStockForOrder(currentOrder, "addProduct", product);
				if (product.chosenAttributes) {
					updatedOrder = await Order.findByIdAndUpdate(
						orderId,
						{
							$push: { chosenProductQtyWithVariables: product },
							$set: { updateStatus: "Added new product" },
						},
						{ new: true }
					);
				} else {
					updatedOrder = await Order.findByIdAndUpdate(
						orderId,
						{
							$push: { productsNoVariable: product },
							$set: { updateStatus: "Added new product" },
						},
						{ new: true }
					);
				}
				updateStatusMessage = "Added new product";
				break;

			case "exchange":
				// Remove old product first
				if (product.oldProduct.chosenAttributes) {
					updatedOrder = await Order.findByIdAndUpdate(
						orderId,
						{
							$pull: {
								chosenProductQtyWithVariables: {
									productId: product.oldProduct.productId,
								},
							},
							$push: {
								exchangedProductQtyWithVariables: {
									...product.oldProduct,
									name: product.oldProduct.name,
									newProduct: {
										productId: product.newProduct.productId,
										ordered_quantity: product.newProduct.ordered_quantity,
										name: product.newProduct.name,
										price: product.newProduct.price,
										image: product.newProduct.image,
										receivedQuantity: product.newProduct.receivedQuantity || 0,
									},
								},
							},
							$set: { updateStatus: "Exchanged product" },
						},
						{
							new: true,
						}
					);
				} else {
					updatedOrder = await Order.findByIdAndUpdate(
						orderId,
						{
							$pull: {
								productsNoVariable: { productId: product.oldProduct.productId },
							},
							$push: {
								exhchangedProductsNoVariable: {
									...product.oldProduct,
									name: product.oldProduct.name,
									newProduct: {
										productId: product.newProduct.productId,
										ordered_quantity: product.newProduct.ordered_quantity,
										name: product.newProduct.name,
										price: product.newProduct.price,
										image: product.newProduct.image,
										receivedQuantity: product.newProduct.receivedQuantity || 0,
									},
								},
							},
							$set: { updateStatus: "Exchanged product" },
						},
						{
							new: true,
						}
					);
				}

				// Add new product
				await updateStockForOrder(currentOrder, "exchange", product.oldProduct);
				await updateStockForOrder(
					currentOrder,
					"addProduct",
					product.newProduct
				);

				if (product.newProduct.chosenAttributes) {
					updatedOrder = await Order.findByIdAndUpdate(
						orderId,
						{
							$push: { chosenProductQtyWithVariables: product.newProduct },
							$set: { updateStatus: "Exchanged product" },
						},
						{ new: true }
					);
				} else {
					updatedOrder = await Order.findByIdAndUpdate(
						orderId,
						{
							$push: { productsNoVariable: product.newProduct },
							$set: { updateStatus: "Exchanged product" },
						},
						{ new: true }
					);
				}

				updateStatusMessage = "Exchanged product";
				break;

			case "cancel":
				await updateStockCancelled(currentOrder);
				updatedOrder = await Order.findByIdAndUpdate(orderId, order, {
					new: true,
					runValidators: true,
					$set: { updateStatus: "Cancelled order" },
				});
				updateStatusMessage = "Cancelled order";
				break;

			case "trackingNumber":
				console.log("Updating tracking number:", trackingNumber);
				updatedOrder = await Order.findByIdAndUpdate(
					orderId,
					{ $set: { trackingNumber, updateStatus: "Updated tracking number" } },
					{ new: true }
				);
				if (!updatedOrder) {
					return res
						.status(500)
						.json({ message: "Failed to update tracking number" });
				}
				console.log("Updated Order:", updatedOrder);
				updateStatusMessage = "Updated tracking number";
				break;

			case "status":
				if (status.toLowerCase() === "cancelled") {
					await updateStockCancelled(currentOrder);
				}
				updatedOrder = await Order.findByIdAndUpdate(
					orderId,
					{ $set: { status, updateStatus: "Updated status" } },
					{ new: true }
				);
				updateStatusMessage = "Updated status";
				break;

			case "customerDetails":
				updatedOrder = await Order.findByIdAndUpdate(
					orderId,
					{
						$set: { customerDetails, updateStatus: "Updated customer details" },
					},
					{ new: true }
				);
				updateStatusMessage = "Updated customer details";
				break;

			default:
				updatedOrder = await Order.findByIdAndUpdate(orderId, order, {
					new: true,
					runValidators: true,
					$set: { updateStatus: "Updated order" },
				});
				updateStatusMessage = "Updated order";
				break;
		}

		if (!updatedOrder) {
			return res.status(500).json({ message: "Failed to update order" });
		}

		// Recalculate order totals
		const { totalOrderQty, totalAmount, totalAmountAfterDiscount } =
			calculateOrderTotals(updatedOrder);
		updatedOrder.totalOrderQty = totalOrderQty;
		updatedOrder.totalAmount = totalAmount;
		updatedOrder.totalAmountAfterDiscount = totalAmountAfterDiscount;
		updatedOrder.updateStatus = updateStatusMessage;

		await updatedOrder.save();

		// === Email Notification Logic ===
		try {
			const fromEmail = "noreply@serenejannat.com";
			const adminEmails = [
				"sally.abdelrazak@serenejannat.com",
				"ahmed.abdelrazak20@gmail.com",
				"ahmedandsally14@gmail.com",
			];
			const customerEmail = updatedOrder?.customerDetails?.email || "";

			// Subject line still includes the general update message:
			const subjectLine = `Order #${updatedOrder.invoiceNumber} - ${updateStatusMessage}`;

			// Build a small helper string describing what's changed:
			let detailLine = "";
			switch (updateType) {
				case "trackingNumber":
					detailLine = `Your order tracking number is now <strong>${updatedOrder.trackingNumber}</strong>.`;
					break;
				case "status":
					detailLine = `Your order status is now <strong>${updatedOrder.status}</strong>.`;
					break;
				case "cancel":
					detailLine = `Your order has been <strong>cancelled</strong>.`;
					break;
				case "remove":
					detailLine = `One or more items have been <strong>removed</strong> from your order.`;
					break;
				case "addUnits":
				case "addProduct":
					detailLine = `New item(s) have been <strong>added</strong> or quantity has changed.`;
					break;
				case "exchange":
					detailLine = `An item in your order was <strong>exchanged</strong>.`;
					break;
				case "customerDetails":
					detailLine = `Your shipping/contact information has been <strong>updated</strong>.`;
					break;
				default:
					detailLine = `Your order information has been <strong>updated</strong>.`;
					break;
			}

			// You can replace this URL with your own publicly hosted logo if desired:
			const logoUrl =
				"https://res.cloudinary.com/infiniteapps/image/upload/v1719198504/serene_janat/1719198503886.png";

			// HTML layout similar to "create new order" but simpler
			const htmlContent = `
				<html>
					<head>
						<meta charset="UTF-8" />
						<title>Serene Jannat - Order Update</title>
					</head>
					<body style="margin:0; padding:0; font-family: Arial, sans-serif; background-color: #f6f6f6; color: #333;">
						<div style="background-color: #ffffff; max-width:600px; margin: 20px auto; padding: 20px; border: 1px solid #ddd;">
							
							<!-- Header / Logo -->
							<div style="text-align: center; margin-bottom: 20px;">
								<img src="${logoUrl}" alt="Serene Jannat Logo" style="max-width: 200px;" />
							</div>

							<!-- Title / Greeting -->
							<h2 style="color: #333; text-align: center;">Order #${updatedOrder.invoiceNumber} Update</h2>

							<!-- Body -->
							<p>Hello ${updatedOrder.customerDetails.name},</p>
							<p>We wanted to let you know that some changes have been made to your order. ${detailLine}</p>
							
							<p>If you have any questions, please send an email at <strong>sally.abdelrazak@serenejannat.com</strong> 
							   or call <strong>951 565 7568</strong>.
							</p>

							<p>Thank you,<br/>Serene Jannat</p>
						</div>
					</body>
				</html>
			`;

			// 1) Send to the Customer (if email exists)
			if (customerEmail) {
				await sgMail.send({
					to: customerEmail,
					from: fromEmail,
					subject: subjectLine,
					html: htmlContent,
				});
				console.log("Order update email sent to customer:", customerEmail);
			} else {
				console.log("No customer email found, skipping customer update email.");
			}

			// 2) Send a separate email to Admins (as 'to')
			await sgMail.send({
				to: adminEmails, // array of emails
				from: fromEmail,
				subject: subjectLine,
				html: htmlContent,
			});
			console.log("Order update email sent to admins:", adminEmails);
		} catch (emailError) {
			console.error("Error sending order update emails:", emailError);
		}
		// === End of Email Notification Logic ===

		res.json(updatedOrder);
	} catch (error) {
		console.error("Error updating the order:", error);
		res.status(500).json({ message: "Server error. Please try again later." });
	}
};

exports.orderSearch = async (req, res) => {
	try {
		const query = req.params.orderquery;

		if (!query) {
			return res.status(400).json({ message: "No search query provided." });
		}

		// Create a regex for case-insensitive search
		const regex = new RegExp(query, "i");

		// Find orders that match the search query
		const orders = await Order.find({
			$or: [
				{ "customerDetails.name": { $regex: regex } },
				{ "customerDetails.email": { $regex: regex } },
				{ "customerDetails.phone": { $regex: regex } },
				{ "customerDetails.address": { $regex: regex } },
				{ "customerDetails.state": { $regex: regex } },
				{ "customerDetails.zipcode": { $regex: regex } },
				{ trackingNumber: { $regex: regex } },
				{ invoiceNumber: { $regex: regex } },
				{ "paymentDetails.payment.id": { $regex: regex } },
				{ "paymentDetails.payment.status": { $regex: regex } },
				{
					"paymentDetails.payment.cardDetails.receiptNumber": { $regex: regex },
				},
				{ "paymentDetails.payment.cardDetails.receiptUrl": { $regex: regex } },
			],
		});

		if (orders.length === 0) {
			return res
				.status(404)
				.json({ message: "No orders found matching the query." });
		}

		res.json(orders);
	} catch (error) {
		console.error("Error searching for orders:", error);
		res.status(500).json({ message: "Server error. Please try again later." });
	}
};
