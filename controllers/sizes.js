/** @format */

const Sizes = require("../models/sizes");

exports.sizesById = async (req, res, next, id) => {
	try {
		const size = await Sizes.findById(id).exec();
		if (!size) {
			return res.status(400).json({
				error: "Size was not found",
			});
		}
		req.size = size;
		next();
	} catch (err) {
		res.status(400).json({ error: "Size not found" });
	}
};

exports.create = async (req, res) => {
	const size = new Sizes(req.body);

	try {
		const data = await size.save();
		res.json({ data });
	} catch (err) {
		res.status(400).json({ error: "Cannot Create size" });
	}
};

exports.read = (req, res) => {
	return res.json(req.size);
};

exports.update = async (req, res) => {
	console.log(req.body);
	const size = req.size;
	size.size = req.body.size;

	try {
		const data = await size.save();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.list = async (req, res) => {
	try {
		const data = await Sizes.find().exec();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.remove = async (req, res) => {
	try {
		const { sizeId } = req.params;
		const size = await Sizes.findByIdAndDelete(sizeId);

		if (!size) {
			return res.status(404).json({ error: "Size not found" });
		}

		res.json({ message: "Size deleted" });
	} catch (err) {
		res.status(400).json({ error: "Error while removing" });
	}
};
