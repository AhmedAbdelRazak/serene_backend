/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");

const {
	userById,
	read,
	update,
	purchaseHistory,
	like,
	unlike,
	allUsersList,
	updateUserByAdmin,
	updatedUserId,
} = require("../controllers/user");

router.get("/secret/:userId", requireSignin, isAuth, isAdmin, (req, res) => {
	res.json({
		user: req.profile,
	});
});

// like unlike
router.put("/user/like", requireSignin, like);
router.put("/user/unlike", requireSignin, unlike);
router.get("/user/:userId", requireSignin, isAuth, read);
router.put("/user/:userId", requireSignin, isAuth, update);
router.get("/orders/by/user/:userId", requireSignin, isAuth, purchaseHistory);
router.get("/allUsers/:userId", requireSignin, isAuth, isAdmin, allUsersList);

router.put(
	"/user/:updatedUserId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	updateUserByAdmin,
);

router.param("userId", userById);
router.param("updatedUserId", updatedUserId);

module.exports = router;
