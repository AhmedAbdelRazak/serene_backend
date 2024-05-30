/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	genderById,
	read,
	update,
	list,
	remove,
} = require("../controllers/gender");

router.get("/gender/:genderId", read);

router.post("/gender/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put("/gender/:genderId/:userId", requireSignin, isAuth, isAdmin, update);

router.delete(
	"/gender/:genderId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	remove,
);

router.get("/genders", list);

router.param("userId", userById);
router.param("genderId", genderById);

module.exports = router;
