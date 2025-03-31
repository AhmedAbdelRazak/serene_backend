// controllers/websiteBasicSetup.js

const WebsiteBasicSetup = require("../models/website");

/**
 * 1) Create single WebsiteBasicSetup if none exists
 *    - If it already exists, return an error
 */
exports.createSingleSetup = async (req, res) => {
	try {
		// Check if doc already exists
		const existing = await WebsiteBasicSetup.findOne({});
		if (existing) {
			return res.status(400).json({
				error: "Website setup already exists. Use update instead.",
			});
		}

		// Otherwise, create a new doc with req.body
		const newDoc = new WebsiteBasicSetup(req.body);
		const saved = await newDoc.save();
		return res.status(201).json(saved);
	} catch (error) {
		console.error("Error in createSingleSetup:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * 2) Get the single WebsiteBasicSetup doc
 *    - If not found, return 404
 */
exports.getSingleSetup = async (req, res) => {
	try {
		const setup = await WebsiteBasicSetup.findOne({});
		if (!setup) {
			return res.status(404).json({ error: "No website setup found" });
		}
		return res.json(setup);
	} catch (error) {
		console.error("Error in getSingleSetup:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * 3) Update the single WebsiteBasicSetup doc
 *    - If it doesn't exist, create one
 *    - If it exists, merge in req.body
 */
exports.updateSingleSetup = async (req, res) => {
	try {
		let setup = await WebsiteBasicSetup.findOne({});
		if (!setup) {
			// If none found, create one
			setup = new WebsiteBasicSetup({});
		}

		// Merge incoming fields
		Object.assign(setup, req.body);
		const saved = await setup.save();
		return res.json(saved);
	} catch (error) {
		console.error("Error in updateSingleSetup:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * 4) Delete the single WebsiteBasicSetup doc (optional)
 *    - If not found, return 404
 */
exports.deleteSingleSetup = async (req, res) => {
	try {
		const setup = await WebsiteBasicSetup.findOne({});
		if (!setup) {
			return res
				.status(404)
				.json({ error: "No website setup found to delete" });
		}

		await setup.remove();
		return res.json({ message: "Website setup removed successfully" });
	} catch (error) {
		console.error("Error in deleteSingleSetup:", error);
		return res.status(400).json({ error: error.message });
	}
};
