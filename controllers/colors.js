/** @format */

const Colors = require("../models/colors");

exports.colorsById = async (req, res, next, id) => {
	try {
		const color = await Colors.findById(id).exec();
		if (!color) {
			return res.status(400).json({
				error: "Color was not found",
			});
		}
		req.color = color;
		next();
	} catch (err) {
		res.status(400).json({ error: "Color not found" });
	}
};

exports.create = async (req, res) => {
	const color = new Colors(req.body);

	try {
		const data = await color.save();
		res.json({ data });
	} catch (err) {
		res.status(400).json({ error: "Cannot Create color" });
	}
};

exports.read = (req, res) => {
	return res.json(req.color);
};

exports.update = async (req, res) => {
	console.log(req.body);
	const color = req.color;
	color.color = req.body.color;
	color.hexa = req.body.hexa;

	try {
		const data = await color.save();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.list = async (req, res) => {
	try {
		const data = await Colors.find().exec();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.remove = async (req, res) => {
	try {
		const { colorId } = req.params; // Get the color ID directly from params

		// Find the color by its ID and remove it
		const deletedColor = await Colors.findByIdAndDelete(colorId);

		// Check if the color was found and deleted
		if (!deletedColor) {
			return res.status(404).json({ error: "Color not found" });
		}

		res.json({ message: "Color deleted" });
	} catch (err) {
		console.log(err);
		res.status(400).json({ error: "Error while removing color" });
	}
};
