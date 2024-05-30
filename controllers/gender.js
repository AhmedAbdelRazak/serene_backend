/** @format */

const Gender = require("../models/gender");

exports.genderById = async (req, res, next, id) => {
	try {
		const gender = await Gender.findById(id).exec();
		if (!gender) {
			return res.status(400).json({ error: "Gender was not found" });
		}
		req.gender = gender;
		next();
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.create = async (req, res) => {
	const gender = new Gender(req.body);

	try {
		const data = await gender.save();
		res.json({ data });
	} catch (err) {
		console.log(err, "err");
		res.status(400).json({ error: "Cannot Create gender" });
	}
};

exports.read = (req, res) => {
	return res.json(req.gender);
};

exports.update = async (req, res) => {
	console.log(req.body);
	const gender = req.gender;
	gender.genderName = req.body.genderName;
	gender.genderName_Arabic = req.body.genderName_Arabic;
	gender.genderNameSlug = req.body.genderNameSlug;
	gender.genderNameSlug_Arabic = req.body.genderNameSlug_Arabic;
	gender.thumbnail = req.body.thumbnail;
	gender.genderNameStatus = req.body.genderNameStatus;

	try {
		const data = await gender.save();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.list = async (req, res) => {
	try {
		const data = await Gender.find().exec();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.remove = async (req, res) => {
	const gender = req.gender;

	try {
		await gender.remove();
		res.json({ message: "Gender deleted" });
	} catch (err) {
		res.status(400).json({ error: "Error while removing" });
	}
};
