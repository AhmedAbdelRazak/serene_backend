/** @format */

const express = require("express");
const router = express.Router();

const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	orderById,
	create,
	usersHistoryOrders,
	listOfAggregatedForPagination,
	updateSingleOrder,
	orderSearch,
} = require("../controllers/order");

router.post("/order/creation/:userId", requireSignin, isAuth, create);
router.get("/order/history/:userId", requireSignin, isAuth, usersHistoryOrders);

router.get(
	"/list-of-orders-aggregated/:page/:records/:startDate/:endDate/:status/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	listOfAggregatedForPagination
);

router.put(
	"/single-order/:orderId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	updateSingleOrder
);

router.get(
	"/search-for-order/:orderquery/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	orderSearch
);

router.param("userId", userById);
router.param("orderId", orderById);

module.exports = router;
