/** @format */

const express = require("express");
const router = express.Router();

const {
	signup,
	signin,
	signout,
	forgotPassword,
	resetPassword,
	googleLogin,
} = require("../controllers/auth");

router.post("/signup", signup);
router.post("/signin", signin);
router.get("/signout", signout);

router.put("/forgot-password", forgotPassword);
router.put("/reset-password", resetPassword);

router.post("/google-login", googleLogin);

module.exports = router;
