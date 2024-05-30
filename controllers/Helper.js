const Product = require("../models/product"); // Adjust the path as necessary
const Colors = require("../models/colors"); // Adjust the path as necessary
const moment = require("moment");
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const BusinessName = "Serene Jannat";
const BusinessWebsite = "https://serenejannat.com/";
const shopLogo =
	"https://res.cloudinary.com/infiniteapps/image/upload/v1715488895/serene_janat/1715488896602.png";

const formatOrderEmail = async (order) => {
	const firstName = order.customerDetails.name.split(" ")[0];

	let productRowsNoVariable = order.productsNoVariable
		.map(
			(item) => `
                      <tr>
                        <td><img src="${item.image}" alt="${item.name}" width="50"></td>
                        <td>${item.name}</td>
                        <td>${item.ordered_quantity}</td>
                        <td>$${item.price}</td>
                      </tr>
                    `
		)
		.join("");

	let productRowsWithVariables = "";

	for (const item of order.chosenProductQtyWithVariables) {
		const product = await Product.findById(item.productId);
		const color = await Colors.findOne({ hexa: item.chosenAttributes.color });
		productRowsWithVariables += `
                    <tr>
                      <td><img src="${item.image}" alt="${
			item.name
		}" width="50"></td>
                      <td>${product.productName}</td>
                      <td>${
												color ? color.color : item.chosenAttributes.color
											}</td>
                      <td>${item.chosenAttributes.size}</td>
                      <td>${item.ordered_quantity}</td>
                      <td>$${item.price}</td>
                    </tr>
                  `;
	}

	const emailContent = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Order Confirmation</title>
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                        background-color: #f5f8fa !important;
                        font-family: Montserrat, Helvetica, Arial, sans-serif !important;
                    }
                    .container {
                        max-width: 600px;
                        margin: 0 auto;
                        padding: 20px;
                        background-color: #ffffff;
                        border-radius: 10px;
                        box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
                    }
                    .header {
                        text-align: center;
                        padding: 10px 0;
                    }
                    .header img {
                        max-width: 150px;
                        height: auto;
                    }
                    .content {
                        padding: 20px 0;
                    }
                    h1 {
                        font-size: 24px;
                        color: #333333;
                    }
                    h2 {
                        font-size: 20px;
                        color: #333333;
                        border-bottom: 2px solid #cccccc;
                        padding-bottom: 5px;
                    }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        margin: 20px 0;
                    }
                    table, th, td {
                        border: 1px solid #dddddd;
                    }
                    th, td {
                        padding: 8px;
                        text-align: left;
                    }
                    th {
                        background-color: #f4f4f4;
                    }
                    .footer {
                        text-align: center;
                        padding: 20px 0;
                        background-color: #f4f4f4;
                        border-top: 1px solid #cccccc;
                    }
                    .footer img {
                        max-width: 100px;
                        height: auto;
                    }
                    .footer p {
                        font-size: 14px;
                        color: #666666;
                    }
                    @media (max-width: 600px) {
                        .container {
                            padding: 10px;
                        }
                        h1 {
                            font-size: 20px;
                        }
                        h2 {
                            font-size: 18px;
                        }
                        th, td {
                            font-size: 14px;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <img src="${shopLogo}" alt="Shop Logo">
                    </div>
                    <div class="content">
                        <h1>Order Confirmation</h1>
                        <p>Thank you for your order, ${firstName}!</p>
                        <h2>Shipment Details:</h2>
                        <p>Invoice Number: ${order.invoiceNumber}</p>
                        <p>Order Date: ${moment(order.createdAt).format(
													"MMMM Do YYYY, h:mm:ss a"
												)}</p>
                        <p>Ship to State: ${order.customerDetails.state}</p>
                        <p>Ship to Address: ${order.customerDetails.address}</p>
                        <p>Ship to Zipcode: ${order.customerDetails.zipcode}</p>
                        <p>Carrier Name: ${
													order.chosenShippingOption.carrierName
												}</p>
                        <p>Shipping Price: $${
													order.chosenShippingOption.shippingPrice
												}</p>
                        <h2>Product Details:</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th>Image</th>
                                    <th>Product</th>
                                    <th>Color</th>
                                    <th>Size</th>
                                    <th>Quantity</th>
                                    <th>Price</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${productRowsWithVariables}
                            </tbody>
                        </table>
                        <br />
                        <table>
                            <thead>
                                <tr>
                                    <th>Image</th>
                                    <th>Product</th>
                                    <th>Quantity</th>
                                    <th>Price</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${productRowsNoVariable}
                            </tbody>
                        </table>
                        <h2>Total Amount: $${Number(
													order.totalAmountAfterDiscount
												)}</h2>
                    </div>
                    <div class="footer">
                        <img src="${shopLogo}" alt="Shop Logo">
                        <p>${BusinessName} | <a href="${BusinessWebsite}">${BusinessWebsite}</a></p>
                        <p>For support please contact 951 565 7568, Email: support@serenejannat.com</p>
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${BusinessWebsite}" alt="QR Code">
                    </div>
                </div>
            </body>
            </html>
          `;

	return emailContent; // Ensure the function returns a string
};

module.exports = {
	formatOrderEmail,
};
