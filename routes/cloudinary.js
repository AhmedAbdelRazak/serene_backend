/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	// isAdmin,
	isOperations,
} = require("../controllers/auth");
const {
	upload,
	remove,
	uploadCommentImage,
	removeCommentImage,
	uploadForPOD,
	removeForPOD,
} = require("../controllers/cloudinary");
const { userById } = require("../controllers/user");
router.post("/admin/uploadimages/:userId", requireSignin, isAuth, upload);
router.post("/admin/removeimage/:userId", remove);

router.post(
	"/admin/uploadimagesimagecomment/:userId",
	requireSignin,
	isAuth,
	uploadCommentImage
);
router.post(
	"/admin/removeimagecomment/:userId",
	requireSignin,
	isAuth,
	removeCommentImage
);

router.post("/admin/uploadimages/operations/:userId", upload);
router.post("/admin/removeimage/operations/:userId", remove);

// For uploading a product image for POD
router.post("/uploadimage/:userId", uploadForPOD);
router.post("/removeimage/:userId", removeForPOD);

router.param("userId", userById);

module.exports = router;
