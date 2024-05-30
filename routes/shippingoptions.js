/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	shippingOptionsById,
	read,
	update,
	list,
} = require("../controllers/shippingoptions");

router.get("/shipping/:shippingId", read);

router.post("/shipping/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put(
	"/shipping/:shippingId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	update,
);

router.get("/shipping-options", list);

router.param("userId", userById);
router.param("shippingId", shippingOptionsById);

module.exports = router;
