/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");

const { userById } = require("../controllers/user");
const { createUpdateDocument, list } = require("../controllers/privacy");

router.post(
	"/serene-jannat-website/:documentId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	createUpdateDocument
);

router.get("/janat-website-document", list);

router.param("userId", userById);

module.exports = router;
