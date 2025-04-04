/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isSeller } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	shippingOptionsById,
	read,
	update,
	list,
	remove,
} = require("../controllers/shippingoptions");

router.get("/shipping/:shippingId", read);

router.post("/shipping/create/:userId", requireSignin, isSeller, create);

router.put("/shipping/:shippingId/:userId", requireSignin, isSeller, update);

router.get("/shipping-options", list);

router.delete("/shipping/:shippingId/:userId", requireSignin, isSeller, remove);

router.param("userId", userById);
router.param("shippingId", shippingOptionsById);

module.exports = router;
