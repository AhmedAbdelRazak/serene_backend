/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	contactById,
	read,
	update,
	list,
} = require("../controllers/editContactUs");

router.get("/contact/:contactId", read);

router.post("/contact/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put(
	"/contact/:contactId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	update,
);

router.get("/contact", list);

router.param("userId", userById);
router.param("contactId", contactById);

module.exports = router;
