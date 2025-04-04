/** @format */

const ShippingOptions = require("../models/shippingoptions");

exports.shippingOptionsById = async (req, res, next, id) => {
	try {
		const shippingOptions = await ShippingOptions.findById(id).exec();
		if (!shippingOptions) {
			return res.status(400).json({ error: "Shipping options were not found" });
		}
		req.shippingOptions = shippingOptions;
		next();
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.create = async (req, res) => {
	const shippingOptions = new ShippingOptions(req.body);

	try {
		const data = await shippingOptions.save();
		res.json({ data });
	} catch (err) {
		console.log(err);
		res.status(400).json({ error: "Cannot Create shipping options" });
	}
};

exports.read = (req, res) => {
	return res.json(req.shippingOptions);
};

exports.update = async (req, res) => {
	console.log(req.body);
	const shippingOptions = req.shippingOptions;
	shippingOptions.carrierName = req.body.carrierName;
	shippingOptions.carrierName_Arabic = req.body.carrierName_Arabic;
	shippingOptions.shippingPrice = req.body.shippingPrice;
	shippingOptions.shippingPrice_Unit = req.body.shippingPrice_Unit;
	shippingOptions.carrierStatus = req.body.carrierStatus;
	shippingOptions.estimatedDays = req.body.estimatedDays;
	shippingOptions.daysShippingClosed = req.body.daysShippingClosed;

	try {
		const data = await shippingOptions.save();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.list = async (req, res) => {
	try {
		const data = await ShippingOptions.find().exec();
		res.json(data);
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};

exports.remove = async (req, res) => {
	try {
		const shippingOptions = req.shippingOptions; // Mongoose doc
		if (!shippingOptions) {
			return res.status(400).json({ error: "No shipping option to delete" });
		}

		await shippingOptions.deleteOne(); // This replaces .remove()
		res.json({ message: "Shipping option removed successfully" });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
};
