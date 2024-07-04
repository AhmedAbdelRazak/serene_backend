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

const { formatOrderEmail } = require("./Helper");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const orderStatusSMS = require("twilio")(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

// Square setup
const squareClient = new Client({
	environment: Environment.Sandbox,
	accessToken: process.env.SQUARE_ACCESS_TOKEN_TEST,
});

const BusinessName = "Serene Jannat";
const fromEmail = "noreply@serenejannat.com";
const defaultEmail = "ahmed.abdelrazak@infinite-apps.com";
const shopLogo = path.join(__dirname, "../shopLogo/logo.png");

exports.orderById = async (req, res, next, id) => {
	try {
		const order = await Order.findById(id).exec();
		if (!order) {
			return res.status(404).json({
				error: "Order not found",
			});
		}
		req.order = order;
		next();
	} catch (err) {
		return res.status(400).json({
			error: "Error Getting Order by Id",
		});
	}
};

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
		doc.text(`Phone: ${order.customerDetails.phone}`);
		doc.text(`Ship to State: ${order.customerDetails.state}`);
		doc.text(`Shipping Address: ${order.customerDetails.address}`);
		doc.text(`Ship to Zipcode: ${order.customerDetails.zipcode}`);
		doc.text(`Status: ${order.status}`);
		doc.text(`Carrier: ${order.chosenShippingOption.carrierName}`);
		doc.text(`Shipping Price: $${order.chosenShippingOption.shippingPrice}`);
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

const sendOrderConfirmationEmail = async (order) => {
	try {
		const pdfBuffer = await createPdfBuffer(order);
		const htmlContent = await formatOrderEmail(order);

		const FormSubmittionEmail = {
			to: order.customerDetails.email || defaultEmail,
			from: fromEmail,
			bcc: [
				{ email: "ahmed.abdelrazak20@gmail.com" },
				{ email: "ahmedandsally14@gmail.com" },
			],
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
	}
};

const sendOrderConfirmationSMS = async (order) => {
	const smsData = {
		phone: order.customerDetails.phone,
		text: `Hi ${order.customerDetails.name} - Your order was successfully placed. Thank you for choosing Serene Jannat for Fashion.`,
	};

	let formattedPhone = smsData.phone;
	if (!formattedPhone.startsWith("+1")) {
		formattedPhone = `+1${formattedPhone}`;
	}

	console.log(formattedPhone, "formattedPhone");

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

const checkStockAvailability = async (order) => {
	for (const item of order.productsNoVariable) {
		const product = await Product.findById(item.productId);
		if (!product) {
			return `Product not found for ID ${item.productId}`;
		}

		if (product.quantity < item.ordered_quantity) {
			return `Insufficient stock for product ${product.productName}. Please remove it from the cart or try another product.`;
		}
	}

	for (const item of order.chosenProductQtyWithVariables) {
		const product = await Product.findById(item.productId);
		if (!product) {
			return `Product not found for ID ${item.productId}`;
		}

		const attribute = product.productAttributes.find(
			(attr) =>
				attr.color === item.chosenAttributes.color &&
				attr.size === item.chosenAttributes.size
		);

		if (!attribute) {
			return `Attribute not found for product ${product.productName}`;
		}

		if (attribute.quantity < item.ordered_quantity) {
			const color = await Colors.findOne({ hexa: attribute.color });

			return `Insufficient stock for product ${
				product.productName
			} with color ${
				color && color.color ? color.color : attribute.color
			} and size ${
				attribute.size
			}. Please remove it from the cart or try another size or color.`;
		}
	}

	return null; // No stock issues
};

const updateStock = async (order) => {
	try {
		const bulkOps = [];

		// Update stock for products without variables
		for (const item of order.productsNoVariable) {
			bulkOps.push({
				updateOne: {
					filter: { _id: item.productId },
					update: { $inc: { quantity: -item.ordered_quantity } },
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
					attribute.quantity -= item.ordered_quantity;

					if (attribute.quantity < 0) {
						throw new Error(
							`Insufficient stock for product ${product.productName} with color ${attribute.color} and size ${attribute.size}`
						);
					}

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
		throw error; // Rethrow the error to handle it in the order creation flow
	}
};

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

const processSquarePayment = async (
	amount,
	nonce,
	zipCode,
	customerDetails
) => {
	const idempotencyKey = crypto.randomBytes(12).toString("hex");

	const requestBody = {
		sourceId: nonce,
		idempotencyKey: idempotencyKey,
		amountMoney: {
			amount: Math.round(amount * 100), // amount in cents
			currency: "USD",
		},
		autocomplete: true,
		billingAddress: {
			postal_code: zipCode, // include the zip code
		},
		customerDetails: {
			givenName: customerDetails.name.split(" ")[0],
			familyName: customerDetails.name.split(" ").slice(1).join(" "),
			emailAddress: customerDetails.email,
			phoneNumber: customerDetails.phone,
			address: {
				addressLine1: customerDetails.address,
				locality: customerDetails.state,
				postal_code: zipCode,
			},
		},
	};

	try {
		const response = await squareClient.paymentsApi.createPayment(requestBody);
		return response.result;
	} catch (error) {
		throw new Error(error.message);
	}
};

// Helper function to convert BigInt to string
const convertBigIntToString = (obj) => {
	if (typeof obj !== "object" || obj === null) {
		return obj;
	}

	for (const key in obj) {
		if (typeof obj[key] === "bigint") {
			obj[key] = obj[key].toString();
		} else if (typeof obj[key] === "object") {
			obj[key] = convertBigIntToString(obj[key]);
		}
	}

	return obj;
};

exports.create = async (req, res) => {
	try {
		const { paymentToken, orderData, zipCode } = req.body;

		if (!orderData || !orderData.totalAmount) {
			throw new Error("Order data or totalAmount is missing");
		}

		// Check stock availability before processing payment
		const stockIssue = await checkStockAvailability(orderData);

		// If there is a stock issue, send a response to the frontend
		if (stockIssue) {
			return res.status(400).json({ error: stockIssue });
		}

		// Process payment with Square
		const paymentResult = await processSquarePayment(
			orderData.totalAmount,
			paymentToken,
			zipCode,
			orderData.customerDetails
		);

		// Generate a unique invoice number
		const invoiceNumber = await generateUniqueInvoiceNumber();

		// Create the order object with the unique invoice number
		const order = new Order({
			...orderData,
			invoiceNumber,
			paymentDetails: paymentResult,
		});

		// Save the order
		const data = await order.save();

		await updateStock(order);

		// Send email and SMS, but do not block the response in case of an error
		sendOrderConfirmationEmail(order).catch((error) => {
			console.error("Error sending confirmation email:", error);
		});
		sendOrderConfirmationSMS(order).catch((error) => {
			console.error("Error sending confirmation SMS:", error);
		});

		// Convert BigInt values to strings before sending the response
		const responseOrder = convertBigIntToString(data.toObject());

		res.json(responseOrder);
	} catch (error) {
		console.error("Error creating order:", error);
		res.status(400).json({ error: error.message });
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
		filters.status = { $nin: ["Shipped", "Delivered", "Cancelled"] };
	} else if (status === "closed") {
		filters.status = { $in: ["Shipped", "Delivered", "Cancelled"] };
	}

	try {
		const matchStage = { $match: filters };
		const countStage = { $count: "count" };
		const ordersStage = [
			{ $sort: { createdAt: -1 } },
			{ $skip: (pageNum - 1) * recordsNum },
			{ $limit: recordsNum },
		];

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

		const result = await Order.aggregate(aggregateQuery);

		const totalRecords = result[0]?.totalRecords || 0;
		const orders = result[0]?.orders || [];

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
