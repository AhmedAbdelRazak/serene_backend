/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	aboutById,
	read,
	update,
	list,
} = require("../controllers/editAboutUs");

router.get("/about/:aboutId", read);

router.post("/about/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put("/about/:aboutId/:userId", requireSignin, isAuth, isAdmin, update);

router.get("/about", list);

router.param("userId", userById);
router.param("aboutId", aboutById);

module.exports = router;
