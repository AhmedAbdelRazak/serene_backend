const Product = require("../models/product");
const Colors = require("../models/colors");
// IMPORTANT: Use moment-timezone instead of plain moment
const moment = require("moment-timezone");
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const BusinessName = "Serene Jannat";
const BusinessWebsite = "https://serenejannat.com";
const shopLogo =
	"https://res.cloudinary.com/infiniteapps/image/upload/v1719198504/serene_janat/1719198503886.png";

/**
 * Generates the HTML for an Order Confirmation email (detailed),
 * with PST date.
 */
const formatOrderEmail = async (order) => {
	const firstName = order.customerDetails.name.split(" ")[0];

	// -- Build NO-VARIABLE ROWS --
	let productRowsNoVariable = "";
	for (const item of order.productsNoVariable) {
		// Fallback image if none
		let displayImage =
			item.image && item.image.length > 0
				? item.image
				: item.isPrintifyProduct && item.customDesign?.originalPrintifyImageURL
				? item.customDesign.originalPrintifyImageURL
				: "https://via.placeholder.com/50";

		// Additional POD details if isPrintifyProduct
		let podDetails = "";
		if (item.isPrintifyProduct && item.printifyProductDetails?.POD) {
			podDetails += `<br/><small><strong>Source:</strong>Serene Jannat Print On Demand</small>`;
			if (item.customDesign) {
				// Show final screenshot
				if (item.customDesign.finalScreenshotUrl) {
					podDetails += `
            <br/><strong>Final Design Preview:</strong>
            <br/><img src="${item.customDesign.finalScreenshotUrl}" alt="Final Design" width="50" style="margin:5px 0"/>
          `;
				}
				// Show custom texts
				if (item.customDesign.texts && item.customDesign.texts.length > 0) {
					podDetails += `<br/><strong>Custom Text(s):</strong>`;
					podDetails += `<ul style="margin:5px 0">`;
					item.customDesign.texts.forEach((txt) => {
						podDetails += `<li>${txt.text} - Color: ${txt.color}</li>`;
					});
					podDetails += `</ul>`;
				}
			}
		}

		productRowsNoVariable += `
      <tr>
        <td><img src="${displayImage}" alt="${item.name}" width="50"></td>
        <td>${item.name}${podDetails}</td>
        <td>${item.ordered_quantity}</td>
        <td>$${item.price}</td>
      </tr>
    `;
	}

	// -- Build VARIABLE ROWS --
	let productRowsWithVariables = "";
	for (const item of order.chosenProductQtyWithVariables) {
		const productDoc = await Product.findById(item.productId);
		const colorDoc = await Colors.findOne({
			hexa: item.chosenAttributes.color,
		});

		// Fallback image if none
		let displayImage =
			item.image && item.image.length > 0
				? item.image
				: item.isPrintifyProduct && item.customDesign?.originalPrintifyImageURL
				? item.customDesign.originalPrintifyImageURL
				: "https://via.placeholder.com/50";

		// Additional POD details
		let podDetails = "";
		if (item.isPrintifyProduct && item.printifyProductDetails?.POD) {
			podDetails += `<br/><small><strong>Source:</strong> Print On Demand</small>`;
			if (item.customDesign) {
				// final screenshot
				if (item.customDesign.finalScreenshotUrl) {
					podDetails += `
            <br/><strong>Final Design Preview:</strong>
            <br/><img src="${item.customDesign.finalScreenshotUrl}" alt="Final Design" width="50" style="margin:5px 0"/>
          `;
				}
				// custom text(s)
				if (item.customDesign.texts && item.customDesign.texts.length > 0) {
					podDetails += `<br/><strong>Custom Text(s):</strong>`;
					podDetails += `<ul style="margin:5px 0">`;
					item.customDesign.texts.forEach((txt) => {
						podDetails += `<li>${txt.text} - Color: ${txt.color}</li>`;
					});
					podDetails += `</ul>`;
				}
			}
		}

		productRowsWithVariables += `
      <tr>
        <td><img src="${displayImage}" alt="${item.name}" width="50"></td>
        <td>${productDoc?.productName || item.name}${podDetails}</td>
        <td>${colorDoc ? colorDoc.color : item.chosenAttributes.color}</td>
        <td>${item.chosenAttributes.size}</td>
        <td>${item.ordered_quantity}</td>
        <td>$${item.price}</td>
      </tr>
    `;
	}

	// Format createdAt in PST:
	const orderDatePST = moment(order.createdAt)
		.tz("America/Los_Angeles")
		.format("MMMM Do YYYY, h:mm:ss a");

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
          p {
              font-size: 16px;
              line-height: 1.5;
              color: #333333;
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
              <p>Order Date: ${orderDatePST}</p>
              <p>Ship to State: ${order.customerDetails.state}</p>
              <p>Ship to Address: ${order.customerDetails.address}</p>
              <p>Ship to Zipcode: ${order.customerDetails.zipcode}</p>
              <p>Carrier Name: ${order.chosenShippingOption.carrierName}</p>
              <p>Shipping Price: $${
								order.chosenShippingOption.shippingPrice
							}</p>

              <h2>Product Details (with variables):</h2>
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
              <h2>Product Details (no variables):</h2>
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
							).toFixed(2)}</h2>
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

	return emailContent;
};

/**
 * Generates the HTML for a POS-style Order Confirmation email (also PST).
 */
const formatOrderEmailPOS = async (order) => {
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
        <td><img src="${item.image}" alt="${item.name}" width="50"></td>
        <td>${product.productName}</td>
        <td>${color ? color.color : item.chosenAttributes.color}</td>
        <td>${item.chosenAttributes.size}</td>
        <td>${item.ordered_quantity}</td>
        <td>$${item.price}</td>
      </tr>
    `;
	}

	// PST date for POS:
	const orderDatePST = moment(order.createdAt)
		.tz("America/Los_Angeles")
		.format("MMMM Do YYYY, h:mm:ss a");

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
          <h2>Order Details:</h2>
          <p>Invoice Number: ${order.invoiceNumber}</p>
          <p>Order Date: ${orderDatePST}</p>
          <h2>Product Details:</h2>
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
          <br />
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
          <h2>Total Amount: $${Number(order.totalAmountAfterDiscount).toFixed(
						2
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

	return emailContent;
};

/**
 * Generates a Payment Link email. (No explicit date in this template,
 * so no PST needed unless you want to add it.)
 */
const formatPaymentLinkEmail = (order, paymentLink) => {
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

	let productRowsWithVariables = order.chosenProductQtyWithVariables
		.map(
			(item) => `
        <tr>
          <td><img src="${item.image}" alt="${item.name}" width="50"></td>
          <td>${item.name}</td>
          <td>${item.chosenAttributes.color}</td>
          <td>${item.chosenAttributes.size}</td>
          <td>${item.ordered_quantity}</td>
          <td>$${item.price}</td>
        </tr>
      `
		)
		.join("");

	const emailContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Link</title>
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
          <h1>Payment Link</h1>
          <p>Dear ${firstName},</p>
          <p>Please use the following link to complete your payment:</p>
          <p><a href="${paymentLink}">${paymentLink}</a></p>
          <h2>Order Details:</h2>
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
          ${
						productRowsWithVariables
							? `
          <h2>Products with Variables:</h2>
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
          </table>`
							: ""
					}
          <h2>Total Amount: $${Number(order.totalAmountAfterDiscount).toFixed(
						2
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

	return emailContent;
};

/**
 * Generates a short, styled HTML email for Seller Notification,
 * using the same styling approach.
 */
const formatSellerEmail = (firstName, storeName) => {
	return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>New Order Notification</title>
        <style>
          /* --------------------------------- */
          /* Root Variables & Responsive Styling */
          /* --------------------------------- */
          :root {
            --primaryBlue: #1f3a52;
            --primaryBlueDarker: #17293b;
            --orangeDark: #6f2d00;
            --orangeLight: #ffe4cc;
            --mainGrey: #f8f8f8;
            --darkGrey: #5a5a5a;
            --mainWhite: #ffffff;
            --mainBlack: #222222;
            --border-color-light: #e0e0e0;
            --box-shadow-light: 0 2px 4px rgba(0, 0, 0, 0.1);
            --button-bg-primary: var(--primaryBlue);
            --button-font-color: var(--mainWhite);

            --primary-color: var(--primaryBlue);
            --primary-color-dark: var(--primaryBlueDarker);
            --neutral-light: var(--mainGrey);
            --neutral-dark: var(--darkGrey);

            --main-transition: all 0.3s ease-in-out;
            --main-spacing: 0.3rem;
          }

          body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 0;
            background-color: var(--neutral-light);
            color: var(--mainBlack);
          }

          .container {
            background-color: var(--mainWhite);
            max-width: 700px;
            margin: 30px auto;
            padding: 20px;
            border-radius: 8px;
            box-shadow: var(--box-shadow-light);
          }

          .header {
            background-color: var(--primaryBlueDarker);
            color: var(--mainWhite);
            text-align: center;
            padding: 20px;
            border-radius: 8px 8px 0 0;
          }

          .header h1 {
            margin: 0;
            font-size: 1.8rem;
          }

          .content {
            padding: 20px;
            line-height: 1.6;
          }

          .content p {
            margin-bottom: 1em;
          }

          .button-container {
            text-align: center;
            margin: 25px 0;
          }

          .button {
            font-size: 1.1rem;
            background: var(--primaryBlue);
            color: var(--button-font-color);
            text-decoration: none;
            padding: 10px 25px;
            border-radius: 6px;
            font-weight: bold;
            border: none;
            transition: background 0.3s ease-in-out;
            display: inline-block;
          }

          .button:hover {
            background: #2a5070; /* slightly lighter shade of primaryBlue */
          }

          .footer {
            background-color: var(--primaryBlueDarker);
            color: var(--mainWhite);
            text-align: center;
            padding: 15px;
            font-size: 0.9rem;
            border-radius: 0 0 8px 8px;
          }

          .footer a {
            color: var(--orangeLight);
            text-decoration: none;
            font-weight: bold;
          }
          .footer a:hover {
            text-decoration: underline;
          }

          @media (max-width: 600px) {
            .header h1 {
              font-size: 1.4rem;
            }
            .button {
              font-size: 1rem;
              padding: 10px 20px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- Header -->
          <div class="header">
            <h1>New Order Notification</h1>
          </div>

          <!-- Content -->
          <div class="content">
            <p>Hi ${firstName},</p>
            <p>There's a new order containing items from <strong>${storeName}</strong>.</p>
            <p>Please log in to your Serene Jannat seller dashboard for more details.</p>

            <div class="button-container">
              <a
                href="https://serenejannat.com/seller/dashboard"
                class="button"
                target="_blank"
                rel="noopener noreferrer"
              >
                View Orders
              </a>
            </div>

            <p>Best Regards,<br/>
            Serene Jannat Team</p>
          </div>

          <!-- Footer -->
          <div class="footer">
            <p>
              &copy; ${new Date().getFullYear()} Serene Jannat.
              Need help? <a href="https://serenejannat.com/contact">Contact us</a>
            </p>
          </div>
        </div>
      </body>
    </html>
  `;
};

/** Exports everything needed */
module.exports = {
	formatOrderEmail,
	formatOrderEmailPOS,
	formatPaymentLinkEmail,
	formatSellerEmail,
};
