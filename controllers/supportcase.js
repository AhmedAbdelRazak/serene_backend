const SupportCase = require("../models/supportcase");

// Create a new support case
exports.createSupportCase = async (req, res) => {
	try {
		const newCase = new SupportCase(req.body);
		await newCase.save();

		// Emit new chat event
		req.io.emit("newChat", newCase);
		console.log("Support case created:", newCase);

		res.status(201).json(newCase);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Get all support cases
exports.getSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find()
			.populate("supporterId")
			.populate("conversation.messageBy");
		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Get a specific support case by ID
exports.getSupportCaseById = async (req, res) => {
	try {
		const supportCase = await SupportCase.findById(req.params.id)
			.populate("supporterId")
			.populate("conversation.messageBy");

		if (!supportCase) {
			console.log("Support case not found:", req.params.id);
			return res.status(404).json({ error: "Support case not found" });
		}

		console.log("Support case fetched:", supportCase);
		res.status(200).json(supportCase);
	} catch (error) {
		console.error("Error fetching support case:", error);
		res.status(400).json({ error: error.message });
	}
};

// Update a support case by ID
exports.updateSupportCase = async (req, res) => {
	try {
		const {
			supporterId,
			caseStatus,
			conversation,
			closedBy,
			rating,
			supporterName,
		} = req.body;

		const updateFields = {};
		if (supporterId) updateFields.supporterId = supporterId;
		if (caseStatus) updateFields.caseStatus = caseStatus;
		if (conversation) updateFields.$push = { conversation: conversation };
		if (closedBy) updateFields.closedBy = closedBy;
		if (rating) updateFields.rating = rating;
		if (supporterName) updateFields.supporterName = supporterName;

		if (Object.keys(updateFields).length === 0) {
			return res
				.status(400)
				.json({ error: "No valid fields provided for update" });
		}

		const updatedCase = await SupportCase.findByIdAndUpdate(
			req.params.id,
			updateFields,
			{
				new: true,
			}
		);

		if (!updatedCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		if (caseStatus === "closed") {
			req.io.emit("closeCase", { case: updatedCase, closedBy });
		} else if (conversation) {
			req.io.emit("receiveMessage", updatedCase);
		}

		res.status(200).json(updatedCase);
	} catch (error) {
		console.log(error, "error");
		res.status(400).json({ error: error.message });
	}
};

// Delete a support case by ID
exports.deleteSupportCase = async (req, res) => {
	try {
		const deletedCase = await SupportCase.findByIdAndDelete(req.params.id);
		if (!deletedCase) {
			return res.status(404).json({ error: "Support case not found" });
		}
		res.status(200).json({ message: "Support case deleted successfully" });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Create a new support case with specific fields
exports.createNewSupportCase = async (req, res) => {
	try {
		const { customerName, customerEmail, inquiryAbout, inquiryDetails } =
			req.body;

		console.log("Received Payload:", req.body); // Add this line

		// Validate the required fields
		if (!customerName || !customerEmail || !inquiryAbout || !inquiryDetails) {
			return res.status(400).json({ error: "All fields are required" });
		}

		const newCase = new SupportCase({
			conversation: [
				{
					messageBy: { customerName, customerEmail },
					message: "New support case created",
					inquiryAbout,
					inquiryDetails,
				},
			],
		});

		await newCase.save();

		// Emit new chat event
		req.io.emit("newChat", newCase);

		res.status(201).json(newCase);
	} catch (error) {
		console.error("Error creating support case:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnassignedSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find({ supporterId: null });
		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};
