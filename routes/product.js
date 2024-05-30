/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	listProductsNoFilter,
	productById,
	update,
	like,
	unlike,
	comment,
	uncomment,
	read,
	productStar,
	remove,
	getDistinctCategoriesActiveProducts,
	gettingSpecificSetOfProducts,
	readSingleProduct,
	filteredProducts,
	likedProducts,
} = require("../controllers/product");

router.post("/product/create/:userId", requireSignin, isAuth, isAdmin, create);
router.put(
	"/product/:productId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	update
);

router.get("/products", listProductsNoFilter);
router.get("/product/:productId", read);
router.get("/single-product/:slug/:categorySlug/:productId", readSingleProduct);

//get distinct categories & subcategories
router.get(
	"/product/categories/subcategories",
	getDistinctCategoriesActiveProducts
);

//Get Specific Set of products
router.get(
	"/specific/products/:featured/:newArrivals/:sortByRate/:offers/:records",
	gettingSpecificSetOfProducts
);

router.delete(
	"/product/:productId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	remove
);

// like unlike
router.put("/post/like", requireSignin, like);
router.put("/post/unlike", requireSignin, unlike);

// comment uncomment
router.put("/post/comment", requireSignin, comment);
router.put("/post/uncomment", requireSignin, uncomment);

// rating
router.put("/product/star/:productId/:userId", requireSignin, productStar);

router.get("/products/:filters/:page/:records", filteredProducts);

router.get("/products/wishlist/:userId", requireSignin, isAuth, likedProducts);

router.param("userId", userById);
router.param("productId", productById);

module.exports = router;
