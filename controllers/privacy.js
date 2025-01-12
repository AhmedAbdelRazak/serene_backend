const Janat = require("../models/privacy");
const mongoose = require("mongoose");

exports.createUpdateDocument = async (req, res) => {
	const { documentId } = req.params;

	try {
		if (documentId && mongoose.Types.ObjectId.isValid(documentId)) {
			const condition = { _id: new mongoose.Types.ObjectId(documentId) };
			const update = req.body;

			const updatedDocument = await Janat.findOneAndUpdate(condition, update, {
				new: true,
				upsert: true, // Creates a new document if none is found
			});

			return res.status(200).json({
				message: "Document updated successfully",
				data: updatedDocument,
			});
		} else {
			// If documentId is not provided, create a new document
			const newDocument = new Janat(req.body);
			const savedDocument = await newDocument.save();

			return res.status(201).json({
				message: "New document created successfully",
				data: savedDocument,
			});
		}
	} catch (err) {
		console.error(err);
		return res.status(500).json({
			error: "Error in creating or updating the document",
		});
	}
};

exports.list = async (req, res) => {
	try {
		const documents = await Janat.find({}).exec();
		res.json(documents);
	} catch (err) {
		res.status(500).json({
			error: "There was an error retrieving the documents",
		});
	}
};
