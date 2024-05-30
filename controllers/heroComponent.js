/** @format */

const HeroComponent = require("../models/heroComponent");

exports.heroById = async (req, res, next, id) => {
	try {
		const hero = await HeroComponent.findById(id).exec();
		if (!hero) {
			return res.status(400).json({ error: "Hero was not found" });
		}
		req.hero = hero;
		next();
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.create = async (req, res) => {
	const hero = new HeroComponent(req.body);

	try {
		const data = await hero.save();
		res.json({ data });
	} catch (err) {
		console.log(err, "err");
		res.status(400).json({ error: "Cannot Create hero" });
	}
};

exports.read = (req, res) => {
	return res.json(req.hero);
};

exports.update = (req, res) => {
	console.log(req.body);
	const hero = req.hero;
	hero.heroComponentStatus = req.body.heroComponentStatus;
	hero.thumbnail = req.body.thumbnail;
	hero.thumbnail2 = req.body.thumbnail2;
	hero.thumbnail3 = req.body.thumbnail3;
	hero.thumbnail_Phone = req.body.thumbnail_Phone;
	hero.thumbnail2_Phone = req.body.thumbnail2_Phone;
	hero.thumbnail3_Phone = req.body.thumbnail3_Phone;
	hero.hyper_link = req.body.hyper_link;
	hero.hyper_link2 = req.body.hyper_link2;
	hero.hyper_link3 = req.body.hyper_link3;

	hero.save((err, data) => {
		if (err) {
			return res.status(400).json({
				error: err,
			});
		}
		res.json(data);
	});
};

exports.list = async (req, res) => {
	try {
		const data = await HeroComponent.find().exec();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.remove = async (req, res) => {
	const hero = req.hero;

	try {
		await hero.remove();
		res.json({ message: "Hero deleted" });
	} catch (err) {
		res.status(400).json({ error: "Error while removing" });
	}
};
