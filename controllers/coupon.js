/** @format */

const Coupon = require("../models/coupon");

exports.couponById = (req, res, next, id) => {
	Coupon.findById(id).exec((err, coupon) => {
		if (err || !coupon) {
			return res.status(400).json({
				error: "coupon was not found",
			});
		}
		req.coupon = coupon;
		next();
	});
};

// create, remove, list

// exports.create = async (req, res) => {
//   try {
//     // console.log(req.body);
//     // return;
//     const { name, expiry, discount } = req.body;
//     res.json(await new Coupon({ name, expiry, discount }).save());
//   } catch (err) {
//     console.log(err);
//   }
// };
exports.create = (req, res) => {
	const coupon = new Coupon(req.body);
	coupon.save((err, data) => {
		if (err) {
			return res.status(400).json({
				err: "Error in coupon creation",
			});
		}
		res.json({ data });
		console.log(data);
	});
};
exports.remove = (req, res) => {
	const coupon = req.coupon;

	coupon.remove((err, data) => {
		if (err) {
			return res.status(400).json({
				err: "error while removing",
			});
		}
		res.json({ message: "Category deleted" });
	});
};

// exports.remove = async (req, res) => {
//   try {
//     res.json(await Coupon.findByIdAndDelete(req.params.couponId).exec());
//   } catch (err) {
//     console.log(err);
//   }
// };

exports.list = async (req, res) => {
	try {
		res.json(await Coupon.find({}).sort({ createdAt: -1 }).exec());
	} catch (err) {
		console.log(err);
	}
};

exports.getSingleCoupon = (req, res) => {
	console.log(req.params.coupon, "coupon");
	Coupon.find({
		name: {
			$in: [req.params.coupon.toUpperCase()],
		},
	}).exec((err, coupons) => {
		if (err) {
			return res.status(400).json({
				error: "Error Listing all coupons",
			});
		}
		res.json(coupons);
		console.log(coupons);
	});
};
