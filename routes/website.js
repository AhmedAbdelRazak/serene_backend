// routes/websiteBasicSetup.js

const express = require("express");
const router = express.Router();
const {
	createSingleSetup,
	getSingleSetup,
	updateSingleSetup,
	deleteSingleSetup,
} = require("../controllers/website");

const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

// CREATE the single doc (only once)
router.post(
	"/website-basic-setup/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	createSingleSetup
);

// READ the single doc
router.get("/website-basic-setup", getSingleSetup);

// UPDATE the single doc
router.put(
	"/website-basic-setup/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	updateSingleSetup
);

// DELETE the single doc
router.delete(
	"/website-basic-setup/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	deleteSingleSetup
);

// Param
router.param("userId", userById);

module.exports = router;
