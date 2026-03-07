/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	isAdmin,
	isSeller,
} = require("../controllers/auth");
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
	listPODProducts,
	listProductsNoFilterForSeller,
	autoCompleteProducts,
	createDistinctCategoriesActiveProducts,
	listProductsForSeo,
} = require("../controllers/product");

router.post("/product/create/:userId", requireSignin, isSeller, create);
router.put("/product/:productId/:userId", requireSignin, isSeller, update);

router.get("/products", listProductsNoFilter);
router.get("/seo/products/:page/:records", listProductsForSeo);
router.get("/products/:storeId", listProductsNoFilterForSeller);
router.get("/products/pod/print-on-demand-products", listPODProducts);
router.get("/product/:productId", read);
router.get("/single-product/:slug/:categorySlug/:productId", readSingleProduct);

//get distinct categories & subcategories

router.post(
	"/create/product/categories/subcategories",
	createDistinctCategoriesActiveProducts
);

router.get(
	"/product/categories/subcategories",
	getDistinctCategoriesActiveProducts
);

//Get Specific Set of products
router.get(
	"/specific/products/:featured/:newArrivals/:customDesigns/:sortByRate/:offers/:records",
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

// Backward-compatible fallback:
// Some stale clients may call /products//:page/:records (empty filters segment).
// Route those requests to the filteredProducts handler with "all" filters.
router.get("/products//:page/:records", (req, res, next) => {
	const page = `${req.params.page || ""}`.trim();
	const records = `${req.params.records || ""}`.trim();
	if (!/^\d+$/.test(page) || !/^\d+$/.test(records)) {
		return next();
	}
	req.params.filters = "all";
	return filteredProducts(req, res, next);
});

router.get("/products/:page/:records", (req, res, next) => {
	const page = `${req.params.page || ""}`.trim();
	const records = `${req.params.records || ""}`.trim();
	if (!/^\d+$/.test(page) || !/^\d+$/.test(records)) {
		return next();
	}
	req.params.filters = "all";
	return filteredProducts(req, res, next);
});

router.get("/products/:filters/:page/:records", filteredProducts);

router.get("/products/wishlist/:userId", requireSignin, isAuth, likedProducts);

router.get(
	"/products/autocomplete/for-client-chat-support",
	(req, res, next) => {
		console.log("IN AUTOCOMPLETE ROUTE, query =", req.query);
		next();
	},
	autoCompleteProducts
);

router.param("userId", userById);
router.param("productId", productById);

module.exports = router;
