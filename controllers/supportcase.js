const SupportCase = require("../models/supportcase");

const twilio = require("twilio");

const orderStatusSMS = twilio(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

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
		const status = req.query.status || "open"; // Default to 'open' if status is not provided
		const cases = await SupportCase.find({ caseStatus: status })
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

// Update seenByAdmin field
exports.updateSeenByAdmin = async (req, res) => {
	try {
		const { id } = req.params;
		console.log(`Updating seenByAdmin for case ID: ${id}`);

		const result = await SupportCase.updateOne(
			{ _id: id, "conversation.seenByAdmin": false },
			{ $set: { "conversation.$[].seenByAdmin": true } }
		);

		if (result.nModified === 0) {
			console.log(`No documents were modified. Case ID: ${id}`);
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		console.log(`Seen status updated for case ID: ${id}`);
		res.status(200).json({ message: "Seen status updated" });
	} catch (error) {
		console.error("Error updating seen status:", error);
		res.status(400).json({ error: error.message });
	}
};

// Update seenByCustomer field
exports.updateSeenByCustomer = async (req, res) => {
	try {
		const { id } = req.params;
		const result = await SupportCase.updateOne(
			{ _id: id, "conversation.seenByCustomer": false },
			{ $set: { "conversation.$[].seenByCustomer": true } }
		);

		if (result.nModified === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		res.status(200).json({ message: "Seen status updated" });
	} catch (error) {
		console.error("Error updating seen status:", error);
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
		if (!customerName || !inquiryAbout || !inquiryDetails) {
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

		// Send SMS notification to admin
		const adminPhoneNumber = "+19515657568";
		const adminPhoneNumber2 = "+19512591528";
		const fromPhoneNumber = "+19094884148";
		const smsText =
			"Hi Sally, Please login to your admin dashboard, there's a client needs help.";

		try {
			await orderStatusSMS.messages.create({
				body: smsText,
				from: fromPhoneNumber,
				to: adminPhoneNumber2,
				// to: adminPhoneNumber,
			});
			console.log(`SMS sent to ${adminPhoneNumber}`);
		} catch (smsError) {
			console.error(`Error sending SMS to ${adminPhoneNumber}:`, smsError);
		}

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

exports.getUnassignedSupportCasesCount = async (req, res) => {
	try {
		const count = await SupportCase.countDocuments({ supporterId: null });
		res.status(200).json({ count });
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnseenMessagesCountByAdmin = async (req, res) => {
	try {
		const count = await SupportCase.countDocuments({
			"conversation.seenByAdmin": false,
		});
		res.status(200).json({ count });
	} catch (error) {
		console.error("Error fetching unseen messages count:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnseenMessagesDetails = async (req, res) => {
	try {
		const unseenMessages = await SupportCase.find({
			"conversation.seenByAdmin": false,
		}).populate("conversation.messageBy");

		res.status(200).json(unseenMessages);
	} catch (error) {
		console.error("Error fetching unseen messages details:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnseenMessagesCountByCustomer = async (req, res) => {
	try {
		const { id } = req.params;
		const supportCase = await SupportCase.findById(id);
		if (!supportCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		const unseenCount = supportCase.conversation.filter(
			(msg) => !msg.seenByCustomer
		).length;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error("Error fetching unseen messages count:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnseenMessagesDetailsByCustomer = async (req, res) => {
	try {
		const unseenMessages = await SupportCase.find({
			"conversation.seenByCustomer": false,
		}).populate("conversation.messageBy");

		res.status(200).json(unseenMessages);
	} catch (error) {
		console.error("Error fetching unseen messages details:", error);
		res.status(400).json({ error: error.message });
	}
};
