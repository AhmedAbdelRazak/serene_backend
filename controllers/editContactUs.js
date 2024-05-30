/** @format */

const Contact = require("../models/editContactUs");

exports.contactById = async (req, res, next, id) => {
    try {
        const contact = await Contact.findById(id).exec();
        if (!contact) {
            return res.status(400).json({ error: "Contact was not found" });
        }
        req.contact = contact;
        next();
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.create = async (req, res) => {
    const contact = new Contact(req.body);

    try {
        const data = await contact.save();
        res.json({ data });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.read = (req, res) => {
	return res.json(req.contact);
};

exports.update = (req, res) => {
	console.log(req.body);
	const contact = req.contact;
	contact.header_1 = req.body.header_1;
	contact.description_1 = req.body.description_1;
	contact.thumbnail = req.body.thumbnail;
	contact.categoryStatus = req.body.categoryStatus;

	contact.save((err, data) => {
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
        const data = await Contact.find().exec();
        res.json(data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};
