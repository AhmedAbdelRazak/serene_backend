/** @format */

const express = require("express");
const router = express.Router();

const {
	requireSignin,
	isAuth,
	isAdmin,
	isSeller,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	orderById,
	create,
	usersHistoryOrders,
	listOfAggregatedForPagination,
	updateSingleOrder,
	orderSearch,
	createPOS,
	readSingleOrder,
	processOrderPayment,
	adminOrderReport,
	getDetailedOrders,
	checkInvoiceNumber,
	sellerOrderReport,
	getDetailedOrdersForSeller,
	listOfAggregatedForPaginationSeller,
	orderSearchSeller,
	getStoreIdsInAGivenOrder,
} = require("../controllers/order");

router.post("/order/creation/:userId", requireSignin, isAuth, create);
router.post("/pos-order/creation/:userId", requireSignin, isAuth, createPOS);
router.get("/order/history/:userId", requireSignin, isAuth, usersHistoryOrders);
router.get("/read-order/:singleOrderId", readSingleOrder);
router.post("/process-payment", processOrderPayment);

router.get(
	"/list-of-orders-aggregated/:page/:records/:startDate/:endDate/:status/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	listOfAggregatedForPagination
);

router.get(
	"/seller/list-of-orders-aggregated/:page/:records/:startDate/:endDate/:status/:userId/:storeId",
	requireSignin,
	isAuth,
	isAdmin,
	listOfAggregatedForPaginationSeller
);

router.get(
	"/search-for-order/:orderquery/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	orderSearch
);

router.get(
	"/seller/search-for-order/:orderquery/:userId/:storeId",
	requireSignin,
	isAuth,
	isAdmin,
	orderSearchSeller
);

router.get(
	"/order-report/:orderquery/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	adminOrderReport
);

router.get(
	"/order-report-modal/detailed-orders/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	getDetailedOrders
);

router.put(
	"/single-order/:orderId/:userId",
	requireSignin,
	isSeller,
	updateSingleOrder
);

router.get(
	"/seller/order-report/:orderquery/:userId/:storeId",
	requireSignin,
	isSeller,
	sellerOrderReport
);

router.get(
	"/seller/order-report-modal/detailed-orders/:userId/:storeId",
	requireSignin,
	isSeller,
	getDetailedOrdersForSeller
);

router.get(
	"/get-storeids-connected-to-an-order/:orderId/:userId",
	requireSignin,
	isSeller,
	getStoreIdsInAGivenOrder
);

router.get("/orders/check-invoice/for-chat", checkInvoiceNumber);

router.param("userId", userById);
router.param("orderId", orderById);

module.exports = router;
