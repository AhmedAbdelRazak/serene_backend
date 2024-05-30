/** @format */

const About = require("../models/editAboutUs");

exports.aboutById = async (req, res, next, id) => {
    try {
        const about = await About.findById(id).exec();
        if (!about) {
            return res.status(400).json({ error: "About was not found" });
        }
        req.about = about;
        next();
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};


exports.create = async (req, res) => {
    const about = new About(req.body);

    try {
        const data = await about.save();
        res.json({ data });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.read = (req, res) => {
	return res.json(req.about);
};

exports.update = (req, res) => {
	console.log(req.body);
	const about = req.about;
	about.header_1 = req.body.header_1;
	about.description_1 = req.body.description_1;
	about.thumbnail = req.body.thumbnail;
	about.categoryStatus = req.body.categoryStatus;

	about.save((err, data) => {
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
        const data = await About.find().exec();
        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};