/** @format */
const express = require("express");
const router = express.Router();

const {
	createSingleStore,
	getSingleStore,
	updateSingleStore,
	deleteSingleStore,
	getAllSellersWithStores,
	toggleStoreActivationByAdmin,
} = require("../controllers/storeManagement");

const {
	requireSignin,
	isSeller,
	isAuth,
	isAdmin,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");

// CREATE the single store doc (only once per user)
router.post(
	"/store-management/:userId",
	requireSignin,
	isSeller,
	createSingleStore
);

// READ the single store doc
router.get("/store-management/:userId", getSingleStore);

// UPDATE the single store doc
router.put(
	"/store-management/:userId",
	requireSignin,
	isSeller,
	updateSingleStore
);

// DELETE the single store doc
router.delete(
	"/store-management/:userId",
	requireSignin,
	isSeller,
	deleteSingleStore
);

router.get(
	"/all-user-store-management/foradmin/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	getAllSellersWithStores
);

router.put(
	"/all-user-store-management/foradmin/activate/:storeId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	toggleStoreActivationByAdmin
);

// Param middleware
router.param("userId", userById);

module.exports = router;
