/** @format */
const StoreManagement = require("../models/storeManagement");
const User = require("../models/user");

/**
 * Create Single Store Management Doc for a specific user
 *    - Now allows multiple stores per user.
 *    - After saving, push storeId into the user's storeIds array (avoiding duplication).
 */
exports.createSingleStore = async (req, res) => {
	try {
		const { userId } = req.params;

		// Simply create a new store doc belonging to userId
		const newDoc = new StoreManagement({
			...req.body,
			belongsTo: userId,
		});

		const saved = await newDoc.save();

		// Update the User schema by adding this store's _id to storeIds (avoid duplicates)
		await User.findByIdAndUpdate(
			userId,
			{ $addToSet: { storeIds: saved._id } }, // $addToSet prevents duplicates
			{ new: true }
		);

		return res.status(201).json(saved);
	} catch (error) {
		console.error("Error in createSingleStore:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Get the Single Store Management Doc (per user)
 *    - If not found, return 404
 *    - Note: This still returns only ONE store doc if it exists.
 *      If you want all user stores, change findOne -> find.
 */
exports.getSingleStore = async (req, res) => {
	try {
		const { userId } = req.params;

		const storeDoc = await StoreManagement.findOne({ belongsTo: userId });
		if (!storeDoc) {
			return res
				.status(404)
				.json({ error: "No store management found for this user" });
		}
		return res.json(storeDoc);
	} catch (error) {
		console.error("Error in getSingleStore:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Update the Single Store Management Doc
 *    - If it doesn't exist, create one (keeping original logic).
 *    - After saving, ensure the _id is in the user's storeIds array.
 */
exports.updateSingleStore = async (req, res) => {
	try {
		const { userId } = req.params;

		let storeDoc = await StoreManagement.findOne({ belongsTo: userId });
		if (!storeDoc) {
			// If none found, create one
			storeDoc = new StoreManagement({ belongsTo: userId });
		}

		// Merge incoming fields
		Object.assign(storeDoc, req.body);

		const saved = await storeDoc.save();

		// Ensure user has this storeId in storeIds (avoid duplicates)
		await User.findByIdAndUpdate(
			userId,
			{ $addToSet: { storeIds: saved._id } },
			{ new: true }
		);

		return res.json(saved);
	} catch (error) {
		console.error("Error in updateSingleStore:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Delete the Single Store Management Doc
 *    - If not found, return 404
 *    - Also remove this storeId from the user's storeIds array.
 */
exports.deleteSingleStore = async (req, res) => {
	try {
		const { userId } = req.params;

		const storeDoc = await StoreManagement.findOne({ belongsTo: userId });
		if (!storeDoc) {
			return res
				.status(404)
				.json({ error: "No store management found for this user to delete" });
		}

		await storeDoc.remove();

		// Pull this storeId out of the user's storeIds
		await User.findByIdAndUpdate(
			userId,
			{ $pull: { storeIds: storeDoc._id } },
			{ new: true }
		);

		return res.json({
			message: "Store management document removed successfully",
		});
	} catch (error) {
		console.error("Error in deleteSingleStore:", error);
		return res.status(400).json({ error: error.message });
	}
};

exports.getAllSellersWithStores = async (req, res) => {
	try {
		// Find all users with role=2000
		const sellers = await User.find({ role: 2000 })
			// Populate the storeIds with all fields from StoreManagement
			.populate("storeIds")
			.exec();

		return res.json(sellers);
	} catch (error) {
		console.error("Error in getAllSellersWithStores:", error);
		return res.status(400).json({ error: error.message });
	}
};

exports.toggleStoreActivationByAdmin = async (req, res) => {
	try {
		const { storeId } = req.params;
		const { activeStoreByAdmin } = req.body; // A boolean

		// Find the store by its _id
		const storeDoc = await StoreManagement.findById(storeId);
		if (!storeDoc) {
			return res.status(404).json({ error: "Store not found" });
		}

		// Update the field
		storeDoc.activeStoreByAdmin = activeStoreByAdmin;

		// Save the updated document
		const updatedStore = await storeDoc.save();

		return res.json({
			message: `Store '${updatedStore._id}' updated successfully`,
			store: updatedStore,
		});
	} catch (error) {
		console.error("Error in toggleStoreActivationByAdmin:", error);
		return res.status(400).json({ error: error.message });
	}
};
