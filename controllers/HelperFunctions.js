/* ---------------------------------------------------------------------------
   HelperFunctions.js
   Centralised helpers for Order / Payment flow   (Stripe edition)
   --------------------------------------------------------------------------- */
"use strict";

/* ─────────────────────────────────  External libs  ───────────────────────── */
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const PDFDocument = require("pdfkit");
const sgMail = require("@sendgrid/mail");
const twilio = require("twilio");

/* ───────────────────────────────────  Models  ────────────────────────────── */
const { Order } = require("../models/order");
const Product = require("../models/product");
const StoreManagement = require("../models/storeManagement");
const Colors = require("../models/colors");

/* ─────────────────────────────  E‑mail templates  ────────────────────────── */
const {
	formatOrderEmail,
	formatOrderEmailPOS,
	formatPaymentLinkEmail,
	formatSellerEmail,
} = require("./Helper"); //  ← your existing HTML helpers

/* ────────────────────────────  SendGrid / Twilio  ────────────────────────── */
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const orderStatusSMS = twilio(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

/* ────────────────────────────────  Constants  ────────────────────────────── */
const BusinessName = "Serene Jannat";
const fromEmail = "noreply@serenejannat.com";
const defaultEmail = "ahmed.abdelrazak@jannatbooking.com";
const owners = [
	"ahmedandsally14@gmail.com",
	"ahmed.abdelrazak20@gmail.com",
	"sally.abdelrazak@serenejannat.com",
];
const shopLogo = path.join(__dirname, "../shopLogo/logo.png");

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  1. STOCK & INVENTORY – EXACT COPY of your previous logic               ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

const checkStockAvailability = async (order) => {
	// ─────────────  A) Simple (no‑variable) products  ─────────────
	for (const item of order.productsNoVariable) {
		console.log("      checking simple item ->", item.name);
		if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true) {
			/* POD – check variant availability inside printifyProductDetails */
			const cartColor = (item.chosenAttributes?.color || "").toLowerCase();
			const cartSize = (item.chosenAttributes?.size || "").toLowerCase();

			const matchedVariant = item.printifyProductDetails.variants.find((v) => {
				const titleLC = v.title.toLowerCase().replace(/["']/g, "");
				return (
					titleLC.includes(cartColor.replace(/["']/g, "")) &&
					titleLC.includes(cartSize.replace(/["']/g, ""))
				);
			});

			if (!matchedVariant)
				return `No matching POD variant found for product ${item.name}.`;
			if (!matchedVariant.is_available)
				return `Variant is not available for product ${item.name}.`;
		} else {
			/* Local stock */
			const product = await Product.findById(item.productId);
			if (!product) return `Product not found for ID ${item.productId}.`;
			if (product.quantity < item.ordered_quantity)
				return `Insufficient stock for product ${product.productName}.`;
		}
	}

	// ─────────────  B) Variable products  ─────────────
	for (const item of order.chosenProductQtyWithVariables) {
		console.log("      checking variant item ->", item.name);
		if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true) {
			const cartColor = (item.chosenAttributes?.color || "").toLowerCase();
			const cartSize = (item.chosenAttributes?.size || "").toLowerCase();

			const matchedVariant = item.printifyProductDetails.variants.find((v) => {
				const titleLC = v.title.toLowerCase().replace(/["']/g, "");
				return (
					titleLC.includes(cartColor.replace(/["']/g, "")) &&
					titleLC.includes(cartSize.replace(/["']/g, ""))
				);
			});

			if (!matchedVariant)
				return `No matching POD variant found for product ${item.name}.`;
			if (!matchedVariant.is_available)
				return `Variant is not available for product ${item.name}.`;
		} else {
			const product = await Product.findById(item.productId);
			if (!product) return `Product not found for ID ${item.productId}.`;

			const attribute = product.productAttributes.find(
				(a) =>
					(a.color || "").toLowerCase() ===
						(item.chosenAttributes.color || "").toLowerCase() &&
					(a.size || "").toLowerCase() ===
						(item.chosenAttributes.size || "").toLowerCase()
			);

			if (!attribute)
				return `Attribute not found for product ${product.productName}.`;
			if (attribute.quantity < item.ordered_quantity)
				return `Insufficient stock for product ${product.productName} with color ${attribute.color} and size ${attribute.size}.`;
		}
	}
	return null; // all good
};

/* --------  updateStock   (original bulk‑write logic – unchanged)  -------- */
const updateStock = async (order) => {
	try {
		const bulkOps = [];

		// ───────── simple items
		for (const item of order.productsNoVariable) {
			if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true)
				continue; // POD handled by Printify
			bulkOps.push({
				updateOne: {
					filter: { _id: item.productId },
					update: { $inc: { quantity: -item.ordered_quantity } },
					upsert: false,
				},
			});
		}

		// ───────── variable items
		for (const item of order.chosenProductQtyWithVariables) {
			if (item.isPrintifyProduct && item.printifyProductDetails?.POD === true)
				continue;
			const product = await Product.findById(item.productId);
			if (!product)
				throw new Error(`Product not found for ID ${item.productId}`);

			const attr = product.productAttributes.find(
				(a) =>
					(a.color || "").toLowerCase() ===
						(item.chosenAttributes.color || "").toLowerCase() &&
					(a.size || "").toLowerCase() ===
						(item.chosenAttributes.size || "").toLowerCase()
			);
			if (!attr)
				throw new Error(
					`Attribute not found for product ${product.productName}`
				);

			attr.quantity -= item.ordered_quantity;
			if (attr.quantity < 0)
				throw new Error(
					`Insufficient stock for ${product.productName} color ${attr.color} size ${attr.size}`
				);

			bulkOps.push({
				updateOne: {
					filter: { _id: product._id, "productAttributes._id": attr._id },
					update: { $set: { "productAttributes.$.quantity": attr.quantity } },
					upsert: false,
				},
			});
		}

		if (bulkOps.length > 0) await Product.bulkWrite(bulkOps);
	} catch (err) {
		console.error("Error updating stock:", err);
		throw err;
	}
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  2. INVOICE NUMBERS                                                     ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

const generateRandomInvoiceNumber = () =>
	Math.floor(1000000000 + Math.random() * 9000000000).toString();

const isInvoiceNumberUnique = async (invoiceNumber) => {
	const order = await Order.findOne({ invoiceNumber });
	return !order;
};

const generateUniqueInvoiceNumber = async () => {
	let invoiceNumber,
		isUnique = false;
	while (!isUnique) {
		invoiceNumber = generateRandomInvoiceNumber();
		isUnique = await isInvoiceNumberUnique(invoiceNumber);
	}
	return invoiceNumber;
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  3. PRINTIFY  (identical logic – copied verbatim)                       ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

/* ---------- helper to upload design screenshot ---------- */
async function uploadIfNeeded(imageUrl, token) {
	try {
		const payload = { file_name: "custom-design.png", url: imageUrl };
		const resp = await axios.post(
			"https://api.printify.com/v1/uploads/images.json",
			payload,
			{ headers: { Authorization: `Bearer ${token}` } }
		);
		console.log(`✓ Design uploaded to Printify – ID: ${resp.data.id}`);
		return resp.data.id; // e.g. "623e0f87f•••"
	} catch (error) {
		console.error("Printify upload error:", error?.response?.data || error);
		return null;
	}
}

/* ----------  for POD items with custom design (ephemeral product) ---------- */
async function createOnTheFlyPOD(item, order, token) {
	try {
		const shopId = item.printifyProductDetails?.shop_id;
		if (!shopId) throw new Error("No Printify shop_id found for POD item");

		/* 1) locate correct variant ID */
		const cartColorNorm = (item.chosenAttributes.color || "")
			.toLowerCase()
			.replace(/["']/g, "")
			.trim();
		const cartSizeNorm = (item.chosenAttributes.size || "")
			.toLowerCase()
			.replace(/["']/g, "")
			.trim();

		const matchedVariant = item.printifyProductDetails.variants.find((v) => {
			const title = v.title.toLowerCase().replace(/["']/g, "").trim();
			return title.includes(cartColorNorm) && title.includes(cartSizeNorm);
		});

		if (!matchedVariant)
			throw new Error("No real variant found for chosen color/size");

		const realVariantId = matchedVariant.id;

		/* 2) upload bare screenshot */
		if (!item?.customDesign?.bareScreenshotUrl)
			throw new Error("No bareScreenshotUrl found for custom design");

		const uploadedId = await uploadIfNeeded(
			item.customDesign.bareScreenshotUrl,
			token
		);
		if (!uploadedId) throw new Error("Design upload failed");

		/* 3) placement params */
		const {
			x = 0.5,
			y = 0.5,
			scale = 1,
			angle = 0,
		} = item.customDesign?.placementParams || {};

		/* 4) create temporary product */
		const productPayload = {
			title: "Custom One‑Time Product",
			description: "User‑personalised product",
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
					placeholders: [
						{
							position: "front",
							images: [
								{ id: uploadedId, type: "image/png", x, y, scale, angle },
							],
						},
					],
				},
			],
		};

		const createR = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/products.json`,
			productPayload,
			{ headers: { Authorization: `Bearer ${token}` } }
		);
		if (!createR.data?.id)
			throw new Error("Failed to create POD product on Printify");

		const newProductId = createR.data.id;

		/* 5) place order */
		const orderPayload = {
			external_id: `custom-order-${Date.now()}`,
			line_items: [
				{
					product_id: newProductId,
					variant_id: realVariantId,
					quantity: item.ordered_quantity,
				},
			],
			shipping_method: 1,
			send_shipping_notification: false,
			address_to: {
				first_name: order.customerDetails.name.split(" ")[0],
				last_name: order.customerDetails.name.split(" ").slice(1).join(" "),
				email: order.customerDetails.email,
				phone: order.customerDetails.phone,
				country: "US",
				region: order.customerDetails.state,
				city: order.customerDetails.city,
				address1: order.customerDetails.address,
				zip: order.customerDetails.zipcode,
			},
		};

		const orderR = await axios.post(
			`https://api.printify.com/v1/shops/${shopId}/orders.json`,
			orderPayload,
			{ headers: { Authorization: `Bearer ${token}` } }
		);

		/* 6) disable the temporary product */
		await axios.put(
			`https://api.printify.com/v1/shops/${shopId}/products/${newProductId}.json`,
			{ visible: false },
			{ headers: { Authorization: `Bearer ${token}` } }
		);

		console.log(
			`✓ POD product created on Printify – ID: ${newProductId}, Order ID: ${orderR.data.id}`
		);

		/* 7) persist POD info */
		await Order.findByIdAndUpdate(order._id, {
			$push: {
				printifyOrderDetails: {
					ephemeralProductId: newProductId,
					ephemeralOrder: orderR.data,
				},
			},
		});
	} catch (err) {
		console.error("createOnTheFlyPOD error:", err?.response?.data || err);
		throw err; // bubble up so the whole order can be flagged / refunded
	}
}

/* ----------  Post order to Printify (normal + POD)  ---------- */
const postOrderToPrintify = async (order) => {
	const normalToken = process.env.PRINTIFY_TOKEN;
	const designToken = process.env.DESIGN_PRINTIFY_TOKEN || normalToken;

	const allItems = [
		...order.productsNoVariable,
		...order.chosenProductQtyWithVariables,
	];

	for (const item of allItems) {
		if (!item.isPrintifyProduct) continue;

		/* POD with user design → create temporary product */
		if (item.printifyProductDetails?.POD === true && item.customDesign) {
			await createOnTheFlyPOD(item, order, designToken);
			continue;
		}

		/* existing Printify catalogue item */
		const headers = {
			Authorization: `Bearer ${normalToken}`,
			"Content-Type": "application/json",
		};

		let variantId;
		if (item.chosenAttributes && item.chosenAttributes.SubSKU) {
			const matched = item.printifyProductDetails.variants.find(
				(v) => v.sku === item.chosenAttributes.SubSKU
			);
			if (!matched)
				throw new Error(
					`No matching variant for SKU ${item.chosenAttributes.SubSKU}`
				);
			variantId = matched.id;
		} else {
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

		const response = await axios.post(
			`https://api.printify.com/v1/shops/${item.printifyProductDetails.shop_id}/orders.json`,
			printifyOrder,
			{ headers }
		);

		console.log(
			`Printify order created for item ${item.name} – ID: ${response.data.id}`
		);

		/* save to DB */
		await Order.findByIdAndUpdate(order._id, {
			$set: { printifyOrderDetails: response.data },
		});
	}
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  4.  PDF + EMAIL + SMS                                                  ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

/* ----------  PDF invoice generator  ---------- */
const createPdfBuffer = (order) =>
	new Promise(async (resolve, reject) => {
		const doc = new PDFDocument({ margin: 50 });
		const buffers = [];

		doc.on("data", (b) => buffers.push(b));
		doc.on("end", () => resolve(Buffer.concat(buffers)));
		doc.on("error", reject);

		if (fs.existsSync(shopLogo))
			doc.image(shopLogo, 50, 45, { width: 120 }).moveDown();
		else doc.text("Serene Jannat", 50, 45).moveDown();

		doc.fontSize(25).text("Order Invoice", { align: "center" }).moveDown();
		doc
			.fontSize(16)
			.text(`Invoice Number: ${order.invoiceNumber}`)
			.text(`Customer Name: ${order.customerDetails.name}`)
			.text(
				`Order Date: ${moment(order.createdAt).format(
					"MMMM Do YYYY, h:mm:ss a"
				)}`
			)
			.text(`Phone: ${order.customerDetails.phone}`)
			.text(`Ship to State: ${order.customerDetails.state}`)
			.text(`Shipping Address: ${order.customerDetails.address}`)
			.text(`Ship to Zipcode: ${order.customerDetails.zipcode}`)
			.text(`Status: ${order.status}`)
			.text(`Carrier: ${order.chosenShippingOption.carrierName}`)
			.text(`Shipping Price: $${order.chosenShippingOption.shippingPrice}`)
			.moveDown()
			.fontSize(20)
			.text("Product Details:", { underline: true });

		/* no‑variable */
		order.productsNoVariable.forEach((p, i) => {
			doc
				.moveDown()
				.fontSize(16)
				.text(`Product ${i + 1}`);
			doc
				.fontSize(14)
				.text(`Name: ${p.name}`)
				.text(`Quantity: ${p.ordered_quantity}`)
				.text(`Price: ${p.price}`);
		});

		/* variable */
		for (const item of order.chosenProductQtyWithVariables) {
			const product = await Product.findById(item.productId);
			if (product) {
				const color = await Colors.findOne({
					hexa: item.chosenAttributes.color,
				});
				doc.moveDown().fontSize(16).text(`Product: ${product.productName}`);
				doc.text(`Color: ${color ? color.color : item.chosenAttributes.color}`);
				doc.text(`Size: ${item.chosenAttributes.size}`);
				doc.text(`Quantity: ${item.ordered_quantity}`);
				doc.text(`Price: ${item.price}`);
			}
		}

		doc
			.moveDown()
			.fontSize(16)
			.text(
				`Total Amount: $${Number(order.totalAmountAfterDiscount).toFixed(2)}`
			);

		doc.end();
	});

/* ----------  Email notifications  ---------- */
const sendOrderConfirmationEmail = async (order) => {
	try {
		const pdfBuffer = await createPdfBuffer(order);
		const htmlContent = await formatOrderEmail(order);
		const recipient = order.customerDetails.email || defaultEmail;

		const msgBase = {
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

		/* A) Customer */
		await sgMail.send({ ...msgBase, to: recipient });
		console.log(`✓ Order confirmation sent to ${recipient}`);

		/* B) Internal team (bcc) */
		const bccEmails = owners.filter((e) => e !== recipient);
		if (bccEmails.length) await sgMail.send({ ...msgBase, to: bccEmails });

		/* C) Seller e‑mails */
		const storeIds = [
			...order.productsNoVariable.map((p) => p.storeId),
			...order.chosenProductQtyWithVariables.map((p) => p.storeId),
		].filter(Boolean);

		const distinctStoreIds = [...new Set(storeIds)];
		if (!distinctStoreIds.length) return;

		const storeDocs = await StoreManagement.find({
			_id: { $in: distinctStoreIds },
		})
			.populate("belongsTo", "name email")
			.exec();

		for (const storeDoc of storeDocs) {
			if (!storeDoc?.belongsTo?.email) continue;

			const sellerEmail = storeDoc.belongsTo.email.trim().toLowerCase();
			const firstName = (storeDoc.belongsTo.name || "Seller").split(" ")[0];
			const storeName = storeDoc.addStoreName || "Your Store";
			const htmlSeller = await formatSellerEmail(firstName, storeName);

			await sgMail.send({
				...msgBase,
				to: sellerEmail,
				html: htmlSeller,
				attachments: [], // sellers do not need the PDF
			});
		}
	} catch (error) {
		console.error(
			"Error sending order e‑mail:",
			error?.response?.body || error
		);
	}
};

/* ----------  SMS notification  ---------- */
const sendOrderConfirmationSMS = async (order) => {
	const smsData = {
		phone: order.customerDetails.phone,
		text: `Hi ${order.customerDetails.name} - Your order was successfully placed. Thank you for choosing Serene Jannat Gifts.`,
	};

	let formattedPhone = smsData.phone;
	if (!formattedPhone.startsWith("+1")) formattedPhone = `+1${formattedPhone}`;

	try {
		await orderStatusSMS.messages.create({
			body: smsData.text,
			from: "+19094884148",
			to: formattedPhone,
		});
	} catch (err) {
		console.error("Error sending SMS:", err);
	}
};

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  5. UTILS                                                               ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

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

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  6. EXPORTS                                                             ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
module.exports = {
	/* inventory */
	checkStockAvailability,
	updateStock,

	/* invoice numbers */
	generateUniqueInvoiceNumber,

	/* Printify & fulfilment */
	postOrderToPrintify,

	/* notifications */
	sendOrderConfirmationEmail,
	sendOrderConfirmationSMS,

	/* utils */
	convertBigIntToString,
};
