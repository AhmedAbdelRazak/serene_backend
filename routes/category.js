/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	categoryById,
	read,
	update,
	list,
	remove,
	getSubs,
} = require("../controllers/category");

router.get("/category/:categoryId", read);

router.post("/category/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put(
	"/category/:categoryId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	update
);

router.delete(
	"/category/:categoryId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	remove
);

router.get("/categories", list);
router.get("/category/subs/:_id", getSubs);

router.param("userId", userById);
router.param("categoryId", categoryById);

module.exports = router;
