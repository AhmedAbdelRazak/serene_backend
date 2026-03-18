const mongoose = require("mongoose");
const sgMail = require("@sendgrid/mail");
const twilio = require("twilio");
// Import Models
const SupportCase = require("../models/supportcase");
const StoreManagement = require("../models/storeManagement");
const User = require("../models/user");
const WebsiteBasicSetup = require("../models/website");
const {
	classifyConversationMessage,
	isAiAllowed,
	respondToSupportCase,
} = require("../services/supportChatOrchestrator");
// Example email template function (Adjust as needed)
const { newSupportCaseEmail } = require("./assets");

const SUPPORT_CASE_INACTIVITY_CLOSE_MS =
	Number(process.env.SUPPORT_CASE_INACTIVITY_CLOSE_MS) > 0
		? Number(process.env.SUPPORT_CASE_INACTIVITY_CLOSE_MS)
		: 10 * 60 * 1000;

const orderStatusSMS = twilio(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

function triggerAiResponseInBackground(caseId, triggerType) {
	respondToSupportCase({ caseId, triggerType }).catch((error) => {
		console.error("[support-ai-trigger] failed:", error.message);
	});
}

function getConversationDefaults(caseDoc) {
	const rootMessage = caseDoc?.conversation?.[0] || {};
	return {
		inquiryAbout: rootMessage.inquiryAbout || "other",
		inquiryDetails: rootMessage.inquiryDetails || "",
	};
}

function normalizeConversationEntry(conversation, caseDoc) {
	if (!conversation || typeof conversation !== "object") {
		return conversation;
	}

	const defaults = getConversationDefaults(caseDoc);
	const normalizedInquiryAbout = conversation.inquiryAbout || defaults.inquiryAbout;
	const hasInquiryDetails = Object.prototype.hasOwnProperty.call(
		conversation,
		"inquiryDetails"
	);

	return {
		...conversation,
		inquiryAbout: normalizedInquiryAbout,
		inquiryDetails: hasInquiryDetails
			? conversation.inquiryDetails
			: defaults.inquiryDetails,
	};
}

function getIoFromRequest(req) {
	return req?.io || req?.app?.get?.("io") || global.io || null;
}

function getSupportCaseLastActivityAt(caseDoc = {}) {
	const messageDates = Array.isArray(caseDoc?.conversation)
		? caseDoc.conversation
				.map((entry) => new Date(entry?.date || 0))
				.filter((date) => Number.isFinite(date.getTime()))
		: [];

	if (messageDates.length) {
		return new Date(
			Math.max(...messageDates.map((date) => date.getTime()))
		);
	}

	const createdAt = new Date(caseDoc?.createdAt || 0);
	return Number.isFinite(createdAt.getTime()) ? createdAt : null;
}

async function loadSupportCaseForRealtime(caseId) {
	return SupportCase.findById(caseId)
		.populate("supporterId")
		.populate({ path: "storeId", select: "belongsTo addStoreName" })
		.exec();
}

function buildRealtimeCasePayload(supportCase) {
	if (!supportCase) return null;

	const plainCase =
		typeof supportCase.toObject === "function"
			? supportCase.toObject()
			: supportCase;
	const targetSellerId =
		plainCase?.storeId?.belongsTo?.toString?.() ||
		plainCase?.storeId?.belongsTo ||
		null;

	return {
		...plainCase,
		targetSellerId,
	};
}

async function closeSupportCaseAndBroadcast(
	caseId,
	{ closedBy = null, rating, additionalSetFields = {}, io = null } = {}
) {
	if (!mongoose.Types.ObjectId.isValid(caseId)) {
		return null;
	}

	const setFields = {
		caseStatus: "closed",
		aiToRespond: false,
		"conversation.$[].seenByAdmin": true,
		"conversation.$[].seenBySeller": true,
		"conversation.$[].seenByClient": true,
		...additionalSetFields,
	};

	if (closedBy !== undefined) {
		setFields.closedBy = closedBy;
	}

	if (rating !== undefined) {
		setFields.rating = rating;
	}

	const result = await SupportCase.updateOne(
		{
			_id: new mongoose.Types.ObjectId(caseId),
			caseStatus: "open",
		},
		{
			$set: setFields,
		}
	);

	if (result.matchedCount === 0) {
		return null;
	}

	const updatedCase = await loadSupportCaseForRealtime(caseId);
	if (!updatedCase) {
		return null;
	}

	const realtimePayload = buildRealtimeCasePayload(updatedCase);
	if (io && realtimePayload) {
		io.emit("supportCaseUpdated", realtimePayload);
		io.emit("closeCase", {
			case: realtimePayload,
			closedBy,
		});
	}

	return updatedCase;
}

async function canStaffManageCase(caseDoc, profile) {
	if (!caseDoc || !profile) return false;
	if (profile.role === 1) return true;

	if (profile.role === 2000 || profile.role === 3000 || profile.role === 7000) {
		if (
			caseDoc.supporterId &&
			caseDoc.supporterId.toString() === profile._id.toString()
		) {
			return true;
		}

		if (!caseDoc.storeId) return false;

		const ownsStore = await StoreManagement.exists({
			_id: caseDoc.storeId?._id || caseDoc.storeId,
			belongsTo: profile._id,
		});
		return Boolean(ownsStore);
	}

	return false;
}

exports.getSupportCases = async (req, res) => {
	try {
		const userId = req.user._id;
		const role = req.user.role;

		let cases;
		if (role === "SuperAdmin") {
			// Super admin sees all cases
			cases = await SupportCase.find()
				.populate("supporterId") // from the schema
				.populate("storeId");
		} else {
			// For simplicity, filter by store or user if needed
			// Adjust logic as you wish (e.g., if seller or client)
			cases = await SupportCase.find({
				$or: [
					{ supporterId: userId },
					// If you also store "sellerId" or "ownerId" in the doc, add that here
					// { sellerId: userId }, etc.
				],
			})
				.populate("supporterId")
				.populate("storeId");
		}

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get a specific support case by ID
 */
exports.getSupportCaseById = async (req, res) => {
	try {
		const supportCase = await SupportCase.findById(req.params.id)
			.populate("supporterId")
			.populate("storeId");

		if (!supportCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		// Restrict if seller
		if (req.user?.role === "Seller") {
			if (
				!supportCase.supporterId ||
				supportCase.supporterId.toString() !== req.user._id.toString()
			) {
				return res.status(403).json({ error: "Forbidden" });
			}
		}

		// Otherwise superadmin or others can see
		return res.status(200).json(supportCase);
	} catch (error) {
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Update a support case (e.g., add a new message, change status, etc.)
 */
exports.updateSupportCase = async (req, res) => {
	try {
		const {
			supporterId,
			caseStatus,
			conversation,
			closedBy,
			rating,
			supporterName,
			storeId,
		} = req.body;

		const currentCase = await SupportCase.findById(req.params.id);
		if (!currentCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		const io = getIoFromRequest(req);

		const normalizedConversation = conversation
			? normalizeConversationEntry(conversation, currentCase)
			: null;

		if (normalizedConversation) {
			const senderType = classifyConversationMessage(normalizedConversation);
			if (senderType === "staff") {
				const flags = await WebsiteBasicSetup.findOne({}).lean();
				if (isAiAllowed(flags, currentCase)) {
					return res.status(409).json({
						error:
							"AI replies are currently enabled for this chat. Turn AI replies off for this case before sending a manual response.",
					});
				}
			}
		}

		const updateFields = {};

		if (supporterId) updateFields.supporterId = supporterId;
		if (caseStatus) updateFields.caseStatus = caseStatus;
		if (normalizedConversation) {
			updateFields.$push = { conversation: normalizedConversation };
		}
		if (Object.prototype.hasOwnProperty.call(req.body, "closedBy")) {
			updateFields.closedBy = closedBy;
		}
		if (Object.prototype.hasOwnProperty.call(req.body, "rating")) {
			updateFields.rating = rating;
		}
		if (Object.prototype.hasOwnProperty.call(req.body, "supporterName")) {
			updateFields.supporterName = supporterName;
		}
		if (Object.prototype.hasOwnProperty.call(req.body, "storeId")) {
			updateFields.storeId = storeId;
		}

		if (Object.keys(updateFields).length === 0) {
			return res
				.status(400)
				.json({ error: "No valid fields provided for update" });
		}

		if (caseStatus === "closed") {
			const additionalSetFields = {};
			if (supporterId) additionalSetFields.supporterId = supporterId;
			if (Object.prototype.hasOwnProperty.call(req.body, "supporterName")) {
				additionalSetFields.supporterName = supporterName;
			}
			if (Object.prototype.hasOwnProperty.call(req.body, "storeId")) {
				additionalSetFields.storeId = storeId;
			}

			const closedCase = await closeSupportCaseAndBroadcast(req.params.id, {
				closedBy,
				rating:
					Object.prototype.hasOwnProperty.call(req.body, "rating")
						? rating
						: undefined,
				additionalSetFields,
				io,
			});

			if (closedCase) {
				return res.status(200).json(closedCase);
			}

			const existingCase = await loadSupportCaseForRealtime(req.params.id);
			if (existingCase?.caseStatus === "closed") {
				return res.status(200).json(existingCase);
			}

			return res
				.status(404)
				.json({ error: "Support case not found or already closed" });
		}

		const updatedCase = await SupportCase.findByIdAndUpdate(
			req.params.id,
			updateFields,
			{ new: true }
		);

		if (normalizedConversation) {
			io?.emit("receiveMessage", updatedCase);

			if (classifyConversationMessage(normalizedConversation) === "client") {
				triggerAiResponseInBackground(updatedCase._id.toString(), "client_message");
			}
		}

		return res.status(200).json(updatedCase);
	} catch (error) {
		console.log("Error in updateSupportCase:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Create a new support case
 */
exports.createNewSupportCase = async (req, res) => {
	try {
		const {
			customerName,
			customerEmail,
			inquiryAbout,
			inquiryDetails,
			supporterId, // Possibly your admin or default support user
			ownerId, // The store owner or seller's ID if relevant
			storeId,
			role, // The role of user creating the case: 1=super admin, 2000/3000/7000=seller, else client
			displayName1,
			displayName2,
			supporterName,
		} = req.body;

		console.log("Received Payload:", req.body);

		// Basic validation
		if (
			!customerName ||
			!inquiryAbout ||
			!inquiryDetails ||
			!supporterId ||
			!ownerId ||
			!displayName1 ||
			!displayName2
		) {
			return res.status(400).json({ error: "All fields are required" });
		}

		// Determine who opened the case
		let openedBy = "client"; // default
		if (role === 1) {
			openedBy = "super admin";
		} else if (role === 2000 || role === 3000 || role === 7000) {
			openedBy = "seller";
		}

		// First conversation entry
		const conversation = [
			{
				messageBy: {
					customerName,
					customerEmail: customerEmail || "no-email@example.com",
					userId:
						openedBy === "client"
							? ""
							: role === 1
							? supporterId
							: ownerId,
				},
				message:
					openedBy === "client"
						? inquiryDetails
						: `New support case created by ${
								openedBy === "super admin"
									? "Platform Administration"
									: openedBy
						  }`,
				inquiryAbout,
				inquiryDetails,
				seenByAdmin: role === 1,
				seenBySeller: role === 2000 || role === 3000 || role === 7000,
				seenByClient: openedBy === "client",
			},
		];

		// Build the support case doc
		const newCase = new SupportCase({
			supporterId,
			storeId,
			caseStatus: "open",
			openedBy,
			conversation,
			displayName1,
			displayName2,
			supporterName,
			aiToRespond: openedBy === "client",
		});

		// 1) Save to DB
		await newCase.save();

		if (openedBy === "client") {
			triggerAiResponseInBackground(newCase._id.toString(), "case_opened");
		}

		// 2) Populate storeId to get 'belongsTo'
		const populatedCase = await SupportCase.findById(newCase._id).populate({
			path: "storeId",
			select: "belongsTo addStoreName",
		});

		// 3) Attach a 'targetSellerId' to the event payload if the store belongs to an seller
		const belongsTo = populatedCase?.storeId?.belongsTo?.toString() || null;
		const eventPayload = {
			...populatedCase.toObject(),
			targetSellerId: belongsTo, // for front-end filtering
		};

		// 4) Emit Socket.IO event for new chat (broadcast to everyone)
		// The front-end will ignore it unless 'targetSellerId' matches their user._id (or if super admin)
		req.io.emit("newChat", eventPayload);

		// 5) Fetch the store's name for the email subject/body
		let storeName = "Unknown Store";
		if (storeId && mongoose.Types.ObjectId.isValid(storeId)) {
			const storeDoc = await StoreManagement.findById(storeId).select(
				"storeName"
			);
			if (storeDoc && storeDoc.addStoreName) {
				storeName = storeDoc.addStoreName;
			}
		}

		// 6) Generate the HTML from your email template
		const emailHtml = newSupportCaseEmail(newCase, storeName);

		// 7) Send the email notification
		await sgMail.send({
			from: "noreply@serenejannat.com",
			to: ["ahmed.abdelrazak@serenejannat.com"],
			subject: `New Support Case | ${storeName}`,
			html: emailHtml,
		});

		const adminPhoneNumber = "+19515657568";
		const adminPhoneNumber2 = "+19512591528";
		const fromPhoneNumber = "+19094884148";
		const smsText =
			"Hi Sally, Please login to your admin dashboard, there's a client needs help.";

		// try {
		// 	await orderStatusSMS.messages.create({
		// 		body: smsText,
		// 		from: fromPhoneNumber,
		// 		// to: adminPhoneNumber2,
		// 		to: adminPhoneNumber,
		// 	});
		// 	console.log(`SMS sent to ${adminPhoneNumber}`);
		// } catch (smsError) {
		// 	console.error(`Error sending SMS to ${adminPhoneNumber}:`, smsError);
		// }

		return res.status(201).json(newCase);
	} catch (error) {
		console.error("Error creating support case:", error);
		return res.status(400).json({ error: error.message });
	}
};

exports.updateCaseAiResponder = async (req, res) => {
	try {
		const { id } = req.params;
		const { aiToRespond } = req.body;

		if (typeof aiToRespond !== "boolean") {
			return res
				.status(400)
				.json({ error: "aiToRespond must be a boolean value." });
		}

		const supportCase = await SupportCase.findById(id).populate("storeId", "belongsTo");
		if (!supportCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		if (supportCase.openedBy !== "client") {
			return res.status(400).json({
				error: "AI replies can only be toggled for customer chats.",
			});
		}

		const allowed = await canStaffManageCase(supportCase, req.profile);
		if (!allowed) {
			return res.status(403).json({ error: "Forbidden" });
		}

		const updatedCase = await SupportCase.findByIdAndUpdate(
			id,
			{ $set: { aiToRespond } },
			{ new: true }
		).populate("storeId", "belongsTo");

		req.io?.emit("supportCaseUpdated", updatedCase?.toObject());

		if (aiToRespond) {
			triggerAiResponseInBackground(id, "ai_reenabled");
		}

		return res.status(200).json(updatedCase);
	} catch (error) {
		console.error("Error updating ai responder state:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Get all unassigned support cases (i.e. no supporterId)
 */
exports.getUnassignedSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find({ supporterId: null });
		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get count of all unassigned support cases
 */
exports.getUnassignedSupportCasesCount = async (req, res) => {
	try {
		const count = await SupportCase.countDocuments({ supporterId: null });
		res.status(200).json({ count });
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

// Define buildSellerFilter FIRST
function buildSellerFilter(user) {
	if (!user) return {};
	if (user.role === "SuperAdmin") return {};
	if (user.role === "Seller") {
		return { supporterId: user._id };
	}
	return { _id: { $exists: false } }; // block others
}

/**
 * Get open support cases (filter for those opened by super admin or seller)
 */
exports.getOpenSupportCases = async (req, res) => {
	try {
		const userFilter = buildSellerFilter(req.user);

		console.log(req.user, "req.user");

		// Merged final query: everything that was already in your code
		// plus the new filter for an seller.
		const query = {
			caseStatus: "open",
			openedBy: { $in: ["super admin", "seller"] },
			...userFilter, // This becomes supporterId = req.user._id if seller
		};

		const cases = await SupportCase.find(query)
			.populate("supporterId")
			.populate("storeId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get open support cases for a specific store
 */
exports.getOpenSupportCasesForStore = async (req, res) => {
	try {
		const { storeId } = req.params;

		if (!mongoose.Types.ObjectId.isValid(storeId)) {
			return res.status(400).json({ error: "Invalid store ID" });
		}

		const cases = await SupportCase.find({
			caseStatus: "open",
			openedBy: { $in: ["super admin", "seller"] },
			storeId: new mongoose.Types.ObjectId(storeId),
		})
			.populate("supporterId")
			.populate("storeId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get open support cases opened by clients
 */
exports.getOpenSupportCasesClients = async (req, res) => {
	try {
		// 1) Pull userId from URL params (e.g. "/support-cases-clients/active/:userId")
		const { userId } = req.params;

		console.log("Received userId:", userId);

		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ error: "Invalid user ID" });
		}

		// 2) Find the user doc in Mongo to get their role
		const user = await User.findById(userId).select("_id role");
		if (!user) {
			return res.status(404).json({ error: "User not found" });
		}

		// Prepare a base query for "open" + "openedBy: 'client'"
		let query = {
			caseStatus: "open",
			openedBy: "client",
		};

		// 3) Check user role
		if (user.role === 1) {
			// role === 1 => super admin
			// => They see ALL open cases by clients, so do nothing extra.
			// query stays as is: { caseStatus: "open", openedBy: "client" }
		} else if (user.role === 2000 || user.role === 3000 || user.role === 7000) {
			// role === 2000 => seller (or 3000/7000 if you treat them similarly)
			// => They see ONLY the cases whose storeId belongs to them

			// A) Fetch all store IDs owned by this seller
			const storeIds = await StoreManagement.find({
				belongsTo: user._id,
			}).distinct("_id");

			// B) Narrow the query to only those store IDs
			// So we add a filter: "storeId must be in that list"
			query.storeId = { $in: storeIds };
		} else {
			// 4) If it's any other role, decide what to do.
			// Option A: Return empty array
			return res.json([]);
			// Option B: return res.status(403).json({ error: "Not authorized" });
		}

		// 5) Finally, find the support cases with the final query
		const cases = await SupportCase.find(query)
			.populate("supporterId")
			.populate("storeId");

		// 6) Return them
		res.status(200).json(cases);
	} catch (error) {
		console.error("Error fetching open support cases (B2C):", error);
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get closed support cases (filter for those opened by super admin or seller)
 */
exports.getCloseSupportCases = async (req, res) => {
	try {
		const userFilter = buildSellerFilter(req.user);

		const query = {
			caseStatus: "closed",
			openedBy: { $in: ["super admin", "seller"] },
			...userFilter,
		};

		const cases = await SupportCase.find(query)
			.populate("supporterId")
			.populate("storeId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get closed support cases for a specific store, opened by super admin or seller
 */
exports.getCloseSupportCasesForStore = async (req, res) => {
	try {
		const { storeId } = req.params;

		if (!mongoose.Types.ObjectId.isValid(storeId)) {
			return res.status(400).json({ error: "Invalid store ID" });
		}

		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: { $in: ["super admin", "seller"] },
			storeId: new mongoose.Types.ObjectId(storeId),
		})
			.populate("supporterId")
			.populate("storeId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get closed support cases for a specific store, opened by clients
 */
exports.getCloseSupportCasesForStoreClients = async (req, res) => {
	try {
		const { storeId } = req.params;

		if (!mongoose.Types.ObjectId.isValid(storeId)) {
			return res.status(400).json({ error: "Invalid store ID" });
		}

		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: "client",
			storeId: new mongoose.Types.ObjectId(storeId),
		})
			.populate("supporterId")
			.populate("storeId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Get closed support cases opened by clients (globally)
 */
exports.getCloseSupportCasesClients = async (req, res) => {
	try {
		// 1) Pull userId from URL params (e.g. "/support-cases-clients/closed/:userId")
		const { userId } = req.params;

		console.log("Received userId:", userId);

		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ error: "Invalid user ID" });
		}

		// 2) Find the user doc in Mongo to get their role
		const user = await User.findById(userId).select("_id role");
		if (!user) {
			return res.status(404).json({ error: "User not found" });
		}

		// Prepare a base query for "closed" + "openedBy: 'client'"
		let query = {
			caseStatus: "closed",
			openedBy: "client",
		};

		// 3) Check user role
		if (user.role === 1) {
			// SuperAdmin (role=1) => sees ALL closed B2C
			// do nothing extra
		} else if (user.role === 2000 || user.role === 3000 || user.role === 7000) {
			// Seller => sees ONLY the cases whose storeId belongs to them
			const storeIds = await StoreManagement.find({
				belongsTo: user._id,
			}).distinct("_id");

			query.storeId = { $in: storeIds };
		} else {
			// For other roles, return empty or 403
			return res.json([]);
		}

		// 5) Finally, find the support cases
		const cases = await SupportCase.find(query)
			.populate("supporterId")
			.populate("storeId");

		// 6) Return them
		res.status(200).json(cases);
	} catch (error) {
		console.error("Error fetching closed support cases (B2C):", error);
		res.status(400).json({ error: error.message });
	}
};
/**
 * Count unseen messages by Admin (super admin),
 * excluding messages that the admin themselves sent.
 */
exports.getUnseenMessagesCountByAdmin = async (req, res) => {
	try {
		const { userId } = req.query;
		console.log("Received userId:", userId);

		// Count the unseen messages where messageBy.userId != current admin
		const count = await SupportCase.aggregate([
			{ $unwind: "$conversation" },
			{
				$match: {
					"conversation.seenByAdmin": false,
					"conversation.messageBy.userId": { $ne: userId },
				},
			},
			{ $count: "unseenCount" },
		]);

		const unseenCount = count.length > 0 ? count[0].unseenCount : 0;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error("Error fetching unseen messages count:", error);
		res.status(400).json({ error: error.message });
	}
};

/**
 * Fetch unseen messages count by Seller (store owner/listing seller)
 */
exports.getUnseenMessagesCountBySeller = async (req, res) => {
	try {
		const { storeId } = req.params; // ID of the store the seller owns

		console.log("Received storeId:", storeId);

		if (!mongoose.Types.ObjectId.isValid(storeId)) {
			return res.status(400).json({ error: "Invalid store ID" });
		}

		const count = await SupportCase.aggregate([
			{ $match: { storeId: new mongoose.Types.ObjectId(storeId) } },
			{ $unwind: "$conversation" },
			{
				$match: {
					"conversation.seenBySeller": false,
				},
			},
			{ $count: "unseenCount" },
		]);

		const unseenCount = count.length > 0 ? count[0].unseenCount : 0;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error("Error fetching unseen messages count for seller:", error);
		res.status(400).json({ error: error.message });
	}
};

/**
 * Fetch unseen messages by a Regular Client
 */
exports.getUnseenMessagesByClient = async (req, res) => {
	try {
		const { clientId } = req.params;

		if (!mongoose.Types.ObjectId.isValid(clientId)) {
			return res.status(400).json({ error: "Invalid client ID" });
		}

		// Example approach; tailor to your actual logic of "unseen by the client"
		const unseenMessages = await SupportCase.find({
			"conversation.messageBy.userId": new mongoose.Types.ObjectId(clientId),
			caseStatus: { $ne: "closed" },
			"conversation.seenByClient": false,
		}).select(
			"conversation._id conversation.messageBy conversation.message conversation.date"
		);

		res.status(200).json(unseenMessages);
	} catch (error) {
		console.error("Error fetching unseen messages for client:", error);
		res.status(400).json({ error: error.message });
	}
};

/**
 * Fetch unseen messages count for a specific support case from the customer's view
 */
exports.getUnseenMessagesCountForCaseByClient = async (req, res) => {
	try {
		const { id } = req.params;

		if (!mongoose.Types.ObjectId.isValid(id)) {
			return res.status(400).json({ error: "Invalid support case ID" });
		}

		const supportCase = await SupportCase.findById(id)
			.select("conversation.seenByClient")
			.lean();

		if (!supportCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		const count = Array.isArray(supportCase.conversation)
			? supportCase.conversation.filter((entry) => entry?.seenByClient === false)
					.length
			: 0;

		return res.status(200).json({ count });
	} catch (error) {
		console.error(
			"Error fetching unseen messages count for customer case:",
			error
		);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Update seen status for Super Admin or Seller
 */
exports.updateSeenStatusForAdminOrSeller = async (req, res) => {
	try {
		const { id } = req.params; // SupportCase ID
		const role = req.user.role; // "SuperAdmin" or "Seller" etc.

		// Decide which field to update based on role
		const updateField =
			role === "SuperAdmin"
				? { "conversation.$[].seenByAdmin": true }
				: { "conversation.$[].seenBySeller": true };

		const result = await SupportCase.updateOne(
			{ _id: id },
			{ $set: updateField }
		);

		if (result.nModified === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or no unseen messages" });
		}

		res.status(200).json({ message: "Seen status updated" });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

/**
 * Update seen status for Client
 */
exports.updateSeenStatusForClient = async (req, res) => {
	try {
		const { id } = req.params;

		if (!mongoose.Types.ObjectId.isValid(id)) {
			return res.status(400).json({ error: "Invalid support case ID" });
		}

		const result = await SupportCase.updateOne(
			{ _id: id },
			{ $set: { "conversation.$[].seenByClient": true } }
		);

		if (result.matchedCount === 0) {
			return res.status(404).json({ error: "Support case not found" });
		}

		return res.status(200).json({
			message:
				result.modifiedCount > 0
					? "Seen status updated for client"
					: "Messages were already marked as seen for client",
			alreadySeen: result.modifiedCount === 0,
		});
	} catch (error) {
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Mark all messages as seen by Admin in a specific case
 */
exports.markAllMessagesAsSeenByAdmin = async (req, res) => {
	try {
		const { id } = req.params; // support case ID
		const { userId } = req.body; // the admin's userID

		// If you want to only skip messages that the admin wrote, keep the arrayFilters
		// Or you can do a blanket update if you always want admin to see them as read.
		const result = await SupportCase.updateOne(
			{ _id: new mongoose.Types.ObjectId(id) },
			{
				$set: {
					"conversation.$[].seenByAdmin": true,
				},
			}
			// If skipping your own messages, keep arrayFilters approach
		);

		if (result.matchedCount === 0) {
			return res
				.status(404)
				.json({ error: "No unseen messages found or already updated" });
		}

		const updatedCase = await SupportCase.findById(id)
			.populate("supporterId")
			.populate("storeId");

		if (updatedCase) {
			req.app.get("io")?.emit("supportCaseUpdated", updatedCase.toObject());
		}

		return res.status(200).json({
			message: "All messages marked as seen by Admin",
			case: updatedCase,
			userId,
		});
	} catch (error) {
		console.error("Error in markAllMessagesAsSeenByAdmin:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Mark all messages as seen by Seller in a specific case
 */
exports.markAllMessagesAsSeenBySeller = async (req, res) => {
	try {
		const { id } = req.params;

		// Instead of arrayFilters, just update ALL conversation entries
		const result = await SupportCase.updateOne(
			{ _id: id },
			{
				$set: {
					"conversation.$[].seenBySeller": true,
					// removed "conversation.$[].seenByAdmin": true
				},
			}
		);

		if (result.matchedCount === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or no unread messages" });
		}

		return res.status(200).json({
			message: "All messages marked as seen by Seller",
		});
	} catch (error) {
		console.error("Error in markAllMessagesAsSeenBySeller:", error);
		return res.status(400).json({ error: error.message });
	}
};

/**
 * Mark every message in every case as seen by everyone
 */
exports.markEverythingAsSeen = async (req, res) => {
	try {
		const result = await SupportCase.updateMany(
			{},
			{
				$set: {
					"conversation.$[].seenByAdmin": true,
					"conversation.$[].seenBySeller": true,
					"conversation.$[].seenByClient": true,
				},
			}
		);

		res.status(200).json({
			message: "All messages in all cases marked as seen",
			updatedCases: result.modifiedCount,
		});
	} catch (error) {
		console.error("Error marking everything as seen:", error);
		res.status(500).json({ error: error.message });
	}
};

/**
 * Delete a message from a conversation in a specific support case
 */
exports.deleteMessageFromConversation = async (req, res) => {
	try {
		const { caseId, messageId } = req.params;

		if (
			!mongoose.Types.ObjectId.isValid(caseId) ||
			!mongoose.Types.ObjectId.isValid(messageId)
		) {
			return res.status(400).json({ error: "Invalid case ID or message ID" });
		}

		const updatedCase = await SupportCase.findByIdAndUpdate(
			caseId,
			{
				$pull: { conversation: { _id: messageId } },
			},
			{ new: true }
		);

		if (!updatedCase) {
			return res
				.status(404)
				.json({ error: "Support case or message not found" });
		}

		// Emit socket event if needed
		req.io.to(caseId).emit("messageDeleted", { caseId, messageId });

		res
			.status(200)
			.json({ message: "Message deleted successfully", updatedCase });
	} catch (error) {
		console.error("Error deleting message:", error);
		res.status(500).json({ error: error.message });
	}
};

/**
 * Admin: Get Active B2C
 *  => caseStatus="open", openedBy="client"
 */
exports.adminGetActiveB2C = async (req, res) => {
	try {
		// Must be superadmin
		if (!req.profile || req.profile.role !== 1) {
			return res.status(403).json({ error: "Forbidden: Admin only." });
		}

		const cases = await SupportCase.find({
			openedBy: "client",
			caseStatus: "open",
		})
			.populate("supporterId")
			.populate("storeId");

		return res.json(cases);
	} catch (err) {
		console.error("Error in adminGetActiveB2C:", err);
		return res.status(400).json({ error: err.message });
	}
};

/**
 * Admin: Get Closed B2C
 * => caseStatus="closed", openedBy="client"
 */
exports.adminGetClosedB2C = async (req, res) => {
	try {
		if (!req.profile || req.profile.role !== 1) {
			return res.status(403).json({ error: "Forbidden: Admin only." });
		}

		const cases = await SupportCase.find({
			openedBy: "client",
			caseStatus: "closed",
		})
			.populate("supporterId")
			.populate("storeId");

		return res.json(cases);
	} catch (err) {
		console.error("Error in adminGetClosedB2C:", err);
		return res.status(400).json({ error: err.message });
	}
};

/**
 * Admin: Get Active B2B
 * => caseStatus="open", openedBy in ["seller", "super admin"]
 */
exports.adminGetActiveB2B = async (req, res) => {
	try {
		if (!req.profile || req.profile.role !== 1) {
			return res.status(403).json({ error: "Forbidden: Admin only." });
		}

		const cases = await SupportCase.find({
			openedBy: { $in: ["seller", "super admin"] },
			caseStatus: "open",
		})
			.populate("supporterId")
			.populate("storeId");

		return res.json(cases);
	} catch (err) {
		console.error("Error in adminGetActiveB2B:", err);
		return res.status(400).json({ error: err.message });
	}
};

/**
 * Admin: Get Closed B2B
 * => caseStatus="closed", openedBy in ["seller", "super admin"]
 */
exports.adminGetClosedB2B = async (req, res) => {
	try {
		if (!req.profile || req.profile.role !== 1) {
			return res.status(403).json({ error: "Forbidden: Admin only." });
		}

		const cases = await SupportCase.find({
			openedBy: { $in: ["seller", "super admin"] },
			caseStatus: "closed",
		})
			.populate("supporterId")
			.populate("storeId");

		return res.json(cases);
	} catch (err) {
		console.error("Error in adminGetClosedB2B:", err);
		return res.status(400).json({ error: err.message });
	}
};

// In controllers/supportcase.js
exports.getUnseenMessagesCountBySeller = async (req, res) => {
	try {
		const { storeId } = req.params; // ID of the store the seller owns

		console.log("Received storeId:", storeId);

		if (!mongoose.Types.ObjectId.isValid(storeId)) {
			return res.status(400).json({ error: "Invalid store ID" });
		}

		const count = await SupportCase.aggregate([
			{ $match: { storeId: storeId } },
			{ $unwind: "$conversation" },
			{
				$match: {
					"conversation.seenBySeller": false,
				},
			},
			{ $count: "unseenCount" },
		]);

		const unseenCount = count.length > 0 ? count[0].unseenCount : 0;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error("Error fetching unseen messages count for seller:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnseenMessagesListBySeller = async (req, res) => {
	try {
		const { storeId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(storeId)) {
			return res.status(400).json({ error: "Invalid store ID" });
		}

		// Approach A: Return entire cases that have any message with "seenBySeller = false"
		// Approach B: Return just the messages themselves.

		// Example: Return an array of all cases with unseen messages,
		// populating only the fields you need.
		const unseenCases = await SupportCase.aggregate([
			{
				$match: {
					storeId: new mongoose.Types.ObjectId(storeId),
					"conversation.seenBySeller": false,
				},
			},
			{
				// Possibly filter out messages that are seenBySeller:true
				// so you only return the unseen messages in the array
				$project: {
					caseStatus: 1,
					openedBy: 1,
					conversation: {
						$filter: {
							input: "$conversation",
							as: "msg",
							cond: { $eq: ["$$msg.seenBySeller", false] },
						},
					},
					createdAt: 1,
				},
			},
		]);

		res.status(200).json(unseenCases);
	} catch (error) {
		console.error("Error fetching unseen messages list for seller:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnseenMessagesListByAdmin = async (req, res) => {
	try {
		// e.g. Find all cases that have at least one message with seenByAdmin=false
		// Possibly also exclude messages that the admin wrote themselves
		// Adjust the logic to your needs, similar to "getUnseenMessagesListBySeller"

		const unseenCases = await SupportCase.aggregate([
			{
				$match: {
					"conversation.seenByAdmin": false,
					// Optionally: { "conversation.messageBy.userId": { $ne: req.adminId } }
				},
			},
			{
				$project: {
					caseStatus: 1,
					openedBy: 1,
					conversation: {
						$filter: {
							input: "$conversation",
							as: "msg",
							cond: { $eq: ["$$msg.seenByAdmin", false] },
						},
					},
					createdAt: 1,
				},
			},
		]);
		res.status(200).json(unseenCases);
	} catch (error) {
		console.error("Error fetching unseen messages for admin:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.closeInactiveSupportCases = async ({
	io = global.io,
	idleMs = SUPPORT_CASE_INACTIVITY_CLOSE_MS,
} = {}) => {
	const normalizedIdleMs =
		Number(idleMs) > 0 ? Number(idleMs) : SUPPORT_CASE_INACTIVITY_CLOSE_MS;
	const now = Date.now();

	const openCases = await SupportCase.find({ caseStatus: "open" })
		.select("createdAt conversation.date")
		.lean();

	let closedCount = 0;

	for (const supportCase of openCases) {
		const lastActivityAt = getSupportCaseLastActivityAt(supportCase);
		if (!lastActivityAt) continue;
		if (now - lastActivityAt.getTime() < normalizedIdleMs) continue;

		const closedCase = await closeSupportCaseAndBroadcast(supportCase._id, {
			closedBy: "system",
			io,
		});

		if (closedCase) {
			closedCount += 1;
		}
	}

	return {
		scannedCount: openCases.length,
		closedCount,
		idleMs: normalizedIdleMs,
	};
};
