/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	StoreManagementById,
	list,
} = require("../controllers/storeManagement");

router.post(
	"/store-management/create/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	create,
);

router.get("/store-management", list);

router.param("userId", userById);
router.param("serviceId", StoreManagementById);

module.exports = router;
