/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	adsById,
	read,
	update,
	list,
} = require("../controllers/topAds");

router.get("/ads/:addsId", read);

router.post("/ads/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put("/ads/:addsId/:userId", requireSignin, isAuth, isAdmin, update);

router.get("/all-adds", list);

router.param("userId", userById);
router.param("addsId", adsById);

module.exports = router;
