/** @format */

const StoreManagement = require("../models/storeManagement");

exports.StoreManagementById = async (req, res, next, id) => {
    try {
        const store_management = await StoreManagement.findById(id).exec();
        if (!store_management) {
            return res.status(400).json({ error: "Store management was not found" });
        }
        req.store_management = store_management;
        next();
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.create = async (req, res) => {
    const store_management = new StoreManagement(req.body);

    try {
        const data = await store_management.save();
        res.json({ data });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.read = (req, res) => {
	return res.json(req.store_management);
};

exports.list = async (req, res) => {
    try {
        const data = await StoreManagement.find().exec();
        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};
