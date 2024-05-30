/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	colorsById,
	read,
	update,
	list,
	remove,
} = require("../controllers/colors");

router.get("/color/:colorId", read);

router.post("/color/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put("/color/:colorId/:userId", requireSignin, isAuth, isAdmin, update);

router.delete(
	"/color/:colorId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	remove,
);

router.get("/colors", list);

router.param("userId", userById);
router.param("colorId", colorsById);

module.exports = router;
