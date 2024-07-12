/** @format */

const express = require("express");
const router = express.Router();
const { userById } = require("../controllers/user");
const {
	printifyProducts,
	syncPrintifyProducts,
	removeAllPrintifyProducts,
} = require("../controllers/printify");

router.get("/get-shop-products", printifyProducts);
router.post("/add-printify-products", syncPrintifyProducts);
router.delete("/delete-printify-products", removeAllPrintifyProducts);

router.param("userId", userById);

module.exports = router;
