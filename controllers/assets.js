const moment = require("moment-timezone");

function newSupportCaseEmail(supportCase, hotelName) {
	// Convert creation date to Indian time (Asia/Kolkata)
	const createdAtIndia = supportCase.createdAt
		? moment(supportCase.createdAt)
				.tz("Asia/Kolkata")
				.format("dddd, MMMM Do YYYY, h:mm A")
		: moment().tz("Asia/Kolkata").format("dddd, MMMM Do YYYY, h:mm A");

	// Extract first conversation entry for top-level inquiry details
	const firstMessage = supportCase?.conversation?.[0] || {};

	// Safe fallback if no inquiry details
	const inquiryAbout = firstMessage.inquiryAbout || "N/A";
	const inquiryDetails = firstMessage.inquiryDetails || "N/A";

	// The openedBy field (e.g., "client", "hotel owner", "super admin")
	const openedBy = supportCase.openedBy || "Unknown";

	// Display name(s) from the schema
	const displayName1 = supportCase.displayName1 || "N/A";

	return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>New Support Case</title>
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

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 15px;
        }

        th, td {
          border: 1px solid var(--border-color-light);
          padding: 10px;
          text-align: left;
        }

        th {
          background-color: var(--primaryBlueDarker);
          color: var(--mainWhite);
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
          table, th, td {
            font-size: 0.9rem;
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
          <h1>New Support Case</h1>
        </div>

        <!-- Content -->
        <div class="content">
          <p>Hi Jannat Booking Admins,</p>
          <p>There's a new support case opened for <strong>${hotelName}</strong>.</p>
          <p>Below are some details regarding this case:</p>

          <table>
            <tr>
              <th>Case ID</th>
              <td>${supportCase._id}</td>
            </tr>
            <tr>
              <th>Created At (IST)</th>
              <td>${createdAtIndia}</td>
            </tr>
            <tr>
              <th>Opened By</th>
              <td>${openedBy}</td>
            </tr>
            <tr>
              <th>Display Name</th>
              <td>${displayName1}</td>
            </tr>
            <tr>
              <th>Inquiry About</th>
              <td>${inquiryAbout}</td>
            </tr>
            <tr>
              <th>Inquiry Details</th>
              <td>${inquiryDetails}</td>
            </tr>
          </table>

          <div class="button-container">
            <a
              href="https://serenejannat/admin/customer-service?tab=active-client-cases"
              class="button"
              target="_blank"
              rel="noopener noreferrer"
            >
              View Support Cases
            </a>
          </div>

          <p>
            Please log in to your admin panel to review and respond to this new case.
          </p>
        </div>

        <!-- Footer -->
        <div class="footer">
          <p>
            &copy; ${new Date().getFullYear()} Jannat Booking.
            Need help? <a href="https://jannatbooking.com">Contact us</a>
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

function transformOrderForSeller(order, storeIdString) {
	// Convert storeIdString to actual string in case we have an ObjectId
	const storeId = storeIdString.toString();

	// Filter arrays
	const filteredNoVar = (order.productsNoVariable || []).filter(
		(p) => p.storeId?.toString() === storeId
	);
	const filteredVar = (order.chosenProductQtyWithVariables || []).filter(
		(p) => p.storeId?.toString() === storeId
	);
	const filteredExNoVar = (order.exchangedProductsNoVariable || []).filter(
		(p) => p.storeId?.toString() === storeId
	);
	const filteredExVar = (order.exchangedProductQtyWithVariables || []).filter(
		(p) => p.storeId?.toString() === storeId
	);

	// Compute store sub-total (just sum price * quantity)
	const storeSubtotal = [
		...filteredNoVar.map((p) => p.price * p.ordered_quantity),
		...filteredVar.map((p) => p.price * p.orderedQty),
		...filteredExNoVar.map((p) => p.price * p.ordered_quantity),
		...filteredExVar.map((p) => p.price * p.orderedQty),
	].reduce((a, b) => a + b, 0);

	// Compute storeQty
	const storeQty = [
		...filteredNoVar.map((p) => p.ordered_quantity),
		...filteredVar.map((p) => p.orderedQty),
		...filteredExNoVar.map((p) => p.ordered_quantity),
		...filteredExVar.map((p) => p.orderedQty),
	].reduce((a, b) => a + b, 0);

	// Entire order quantity:
	let entireQty = 0;
	entireQty += (order.productsNoVariable || []).reduce(
		(acc, x) => acc + (x.ordered_quantity || 0),
		0
	);
	entireQty += (order.chosenProductQtyWithVariables || []).reduce(
		(acc, x) => acc + (x.orderedQty || 0),
		0
	);
	entireQty += (order.exchangedProductsNoVariable || []).reduce(
		(acc, x) => acc + (x.ordered_quantity || 0),
		0
	);
	entireQty += (order.exchangedProductQtyWithVariables || []).reduce(
		(acc, x) => acc + (x.orderedQty || 0),
		0
	);

	const shippingFees = order.shippingFees || 0;
	const totalAmount = order.customerDetails?.totalAmount || 0;
	const totalAmountAfterDiscount =
		order.customerDetails?.totalAmountAfterDiscount || totalAmount;
	const entireDiscount = totalAmount - totalAmountAfterDiscount;

	// Partial shipping & discount
	let partialShipping = 0;
	let partialDiscount = 0;
	if (entireQty > 0) {
		partialShipping = shippingFees * (storeQty / entireQty);
		partialDiscount = entireDiscount * (storeQty / entireQty);
	}

	// final partial net
	const storeTotalAfterDiscount =
		storeSubtotal - partialDiscount + partialShipping;

	// Build a new plain object so we can override arrays
	const obj = order.toObject ? order.toObject() : { ...order };
	return {
		...obj,
		productsNoVariable: filteredNoVar,
		chosenProductQtyWithVariables: filteredVar,
		exchangedProductsNoVariable: filteredExNoVar,
		exchangedProductQtyWithVariables: filteredExVar,
		sellerView: {
			storeQty,
			storeSubtotal: +storeSubtotal.toFixed(2),
			partialShipping: +partialShipping.toFixed(2),
			partialDiscount: +partialDiscount.toFixed(2),
			storeTotalAfterDiscount: +storeTotalAfterDiscount.toFixed(2),
		},
	};
}

/**
 * Exports
 */
module.exports = {
	newSupportCaseEmail,
	transformOrderForSeller,
};
