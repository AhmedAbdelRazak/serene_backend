/** @format */

const Category = require("../models/category");
const Subcategory = require("../models/subcategory");

exports.categoryById = async (req, res, next, id) => {
    try {
        const category = await Category.findById(id).exec();
        if (!category) {
            return res.status(400).json({
                error: "Category was not found",
            });
        }
        req.category = category;
        next();
    } catch (err) {
        res.status(400).json({ error: "Category not found" });
    }
};


exports.create = async (req, res) => {
    const category = new Category(req.body);

    try {
        const data = await category.save();
        res.json({ data });
    } catch (err) {
        res.status(400).json({ error: "Cannot Create Category" });
    }
};

exports.read = (req, res) => {
	return res.json(req.category);
};

exports.update = async (req, res) => {
    console.log(req.body);
    const category = req.category;
    category.categoryName = req.body.categoryName;
    category.categoryName_Arabic = req.body.categoryName_Arabic;
    category.categorySlug = req.body.categorySlug;
    category.categorySlug_Arabic = req.body.categorySlug_Arabic;
    category.thumbnail = req.body.thumbnail;
    category.categoryStatus = req.body.categoryStatus;

    try {
        const data = await category.save();
        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};


exports.list = async (req, res) => {
    try {
        const data = await Category.find().exec();
        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.remove = (req, res) => {
	const category = req.category;

	category.remove((err, data) => {
		if (err) {
			return res.status(400).json({
				err: "error while removing",
			});
		}
		res.json({ message: "Category deleted" });
	});
};

exports.getSubs = async (req, res) => {
    try {
        const data = await Subcategory.find({ categoryId: req.params._id }).exec();
        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};
