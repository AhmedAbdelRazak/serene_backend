/** @format */

const Subcategory = require("../models/subcategory");

exports.subcategoryById = async (req, res, next, id) => {
    try {
        const subcategory = await Subcategory.findById(id).exec();
        if (!subcategory) {
            return res.status(400).json({
                error: "Subcategory was not found",
            });
        }
        req.subcategory = subcategory;
        next();
    } catch (err) {
        res.status(400).json({ error: "Subcategory not found" });
    }
};


exports.create = async (req, res) => {
    const subcategory = new Subcategory(req.body);

    try {
        const data = await subcategory.save();
        res.json({ data });
    } catch (err) {
        res.status(400).json({ error: "Cannot Create Subcategory" });
    }
};


exports.read = (req, res) => {
	return res.json(req.subcategory);
};

exports.update = async (req, res) => {
    console.log(req.body);
    const subcategory = req.subcategory;
    subcategory.SubcategoryName = req.body.SubcategoryName;
    subcategory.SubcategoryName_Arabic = req.body.SubcategoryName_Arabic;
    subcategory.SubcategorySlug = req.body.SubcategorySlug;
    subcategory.SubcategorySlug_Arabic = req.body.SubcategorySlug_Arabic;
    subcategory.subCategoryStatus = req.body.subCategoryStatus;
    subcategory.thumbnail = req.body.thumbnail;
    subcategory.categoryId = req.body.categoryId;

    try {
        const data = await subcategory.save();
        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};


exports.list = async (req, res) => {
    try {
        const data = await Subcategory.find()
            .populate("categoryId")
            .exec();

        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.remove = (req, res) => {
	const subcategory = req.subcategory;

	subcategory.remove((err, data) => {
		if (err) {
			return res.status(400).json({
				err: "error while removing",
			});
		}
		res.json({ message: "Subcategory deleted" });
	});
};
