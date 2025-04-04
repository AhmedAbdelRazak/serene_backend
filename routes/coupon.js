/** @format */

const express = require("express");
const router = express.Router();

// middlewares
const { isSeller, requireSignin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

// controller
const {
	create,
	remove,
	list,
	couponById,
	getSingleCoupon,
} = require("../controllers/coupon");

// routes
router.post("/coupon/create/:userId", requireSignin, isSeller, create);
router.get("/coupons", list);
router.delete("/coupon/:couponId/:userId", requireSignin, isSeller, remove);

router.get("/coupon/byname/:coupon", getSingleCoupon);

router.param("userId", userById);
router.param("couponId", couponById);

module.exports = router;
