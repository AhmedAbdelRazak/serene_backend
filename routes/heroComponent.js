/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	heroById,
	read,
	update,
	list,
	remove,
} = require("../controllers/heroComponent");

router.get("/hero/:heroId", read);

router.post("/hero/create/:userId", requireSignin, isAuth, isAdmin, create);

router.put("/hero/:heroId/:userId", requireSignin, isAuth, isAdmin, update);

router.delete("/hero/:heroId/:userId", requireSignin, isAuth, isAdmin, remove);

router.get("/heroes", list);

router.param("userId", userById);
router.param("heroId", heroById);

module.exports = router;
