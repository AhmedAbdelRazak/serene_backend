const Coupon = require("../models/coupon");

exports.couponById = async (req, res, next, id) => {
	try {
		const coupon = await Coupon.findById(id).exec();
		if (!coupon) {
			return res.status(400).json({
				error: "Coupon not found",
			});
		}
		req.coupon = coupon;
		next();
	} catch (err) {
		return res.status(400).json({
			error: "Error fetching coupon",
		});
	}
};

exports.create = async (req, res) => {
	try {
		const coupon = new Coupon(req.body);
		const data = await coupon.save();
		res.json({ data });
		console.log(data);
	} catch (err) {
		res.status(400).json({
			err: "Error in coupon creation",
		});
	}
};

exports.remove = async (req, res) => {
	try {
		const coupon = req.coupon;
		await Coupon.deleteOne({ _id: coupon._id });
		res.json({ message: "Coupon deleted" });
	} catch (err) {
		return res.status(400).json({
			error: "Error while removing coupon",
		});
	}
};

exports.list = async (req, res) => {
	try {
		const coupons = await Coupon.find({}).sort({ createdAt: -1 }).exec();
		res.json(coupons);
	} catch (err) {
		res.status(400).json({
			error: "Error listing coupons",
		});
	}
};

exports.getSingleCoupon = async (req, res) => {
	try {
		console.log(req.params.coupon, "coupon");
		const coupons = await Coupon.find({
			name: {
				$in: [req.params.coupon.toUpperCase()],
			},
		}).exec();

		res.json(coupons);
		console.log(coupons);
	} catch (err) {
		return res.status(400).json({
			error: "Error listing coupons",
		});
	}
};
