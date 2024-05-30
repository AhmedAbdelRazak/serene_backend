/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	sizesById,
	read,
	update,
	list,
	remove,
} = require("../controllers/sizes");

router.get("/size/:sizeId", read);

router.post("/size/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put("/size/:sizeId/:userId", requireSignin, isAuth, isAdmin, update);

router.delete("/size/:sizeId/:userId", requireSignin, isAuth, isAdmin, remove);

router.get("/sizes", list);

router.param("userId", userById);
router.param("sizeId", sizesById);

module.exports = router;
