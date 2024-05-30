/** @format */

const Ads = require("../models/topAds");

exports.adsById = (req, res, next, id) => {
	Ads.findById(id).exec((err, ads) => {
		if (err || !ads) {
			return res.status(400).json({
				error: "ads was not found",
			});
		}
		req.ads = ads;
		next();
	});
};

exports.create = (req, res) => {
	const ads = new Ads(req.body);
	ads.save((err, data) => {
		if (err) {
			return res.status(400).json({
				error: "Cannot Create Ads",
			});
		}
		res.json({ data });
	});
};

exports.read = (req, res) => {
	return res.json(req.ads);
};

exports.update = (req, res) => {
	console.log(req.body);
	const ads = req.ads;
	ads.ad_Name = req.body.ad_Name;
	ads.ad_Name_Arabic = req.body.ad_Name_Arabic;
	ads.show_ad = req.body.show_ad;

	ads.save((err, data) => {
		if (err) {
			return res.status(400).json({
				error: err,
			});
		}
		res.json(data);
	});
};

exports.list = (req, res) => {
	Ads.find().exec((err, data) => {
		if (err) {
			return res.status(400).json({
				error: err,
			});
		}
		res.json(data);
	});
};
