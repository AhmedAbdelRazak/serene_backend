/** @format */

const express = require("express");
const router = express.Router();
const { userById } = require("../controllers/user");
const {
	printifyProducts,
	syncPrintifyProducts,
	removeAllPrintifyProducts,
	printifyOrders,
	getSpecificPrintifyProducts,
	publishPrintifyProducts,
	forceRepublishPrintifyProducts,
	getSinglePrintifyProductById,
	createCustomPrintifyOrder,
	updatePrintifyProduct,
	revertPrintifyProductsToBePlainNoDesign,
} = require("../controllers/printify");

router.get("/get-shop-products", printifyProducts);
router.post("/add-printify-products", syncPrintifyProducts);
router.delete("/delete-printify-products", removeAllPrintifyProducts);
router.get("/get-printify-orders", printifyOrders);

// New routes
router.get("/specific-printify-products", getSpecificPrintifyProducts);
//get request to get shop id "https://api.printify.com/v1/shops.json"
router.post("/publish-printify-products", publishPrintifyProducts);
router.post("/force-publish-printify-products", forceRepublishPrintifyProducts);

router.get(
	"/single-printify-product/:product_id",
	getSinglePrintifyProductById
);

router.put("/update-printify-product/:product_id", updatePrintifyProduct);
router.post(
	"/update-printify-products-to-default",
	revertPrintifyProductsToBePlainNoDesign
);

router.post("/create-custom-order", createCustomPrintifyOrder);

router.param("userId", userById);

module.exports = router;
