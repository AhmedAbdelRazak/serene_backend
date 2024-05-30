/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	isAdmin,
	isOperations,
} = require("../controllers/auth");
const {
	upload,
	remove,
	uploadCommentImage,
	removeCommentImage,
} = require("../controllers/cloudinary");
const { userById } = require("../controllers/user");
router.post(
	"/admin/uploadimages/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	upload,
);
router.post(
	"/admin/removeimage/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	remove,
);

router.post(
	"/admin/uploadimagesimagecomment/:userId",
	requireSignin,
	isAuth,
	uploadCommentImage,
);
router.post(
	"/admin/removeimagecomment/:userId",
	requireSignin,
	isAuth,
	removeCommentImage,
);

router.post(
	"/admin/uploadimages/operations/:userId",
	requireSignin,
	isAuth,
	isOperations,
	upload,
);
router.post(
	"/admin/removeimage/operations/:userId",
	requireSignin,
	isAuth,
	isOperations,
	remove,
);

router.param("userId", userById);

module.exports = router;
