const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const conversationSchema = new Schema({
	messageBy: {
		type: Object,
		default: {
			customerName: "",
			customerEmail: "",
		},
	},
	message: {
		type: String,
		required: true,
	},
	date: {
		type: Date,
		default: Date.now,
	},
	inquiryAbout: {
		type: String,
		required: true,
		default: "",
	},
	inquiryDetails: {
		type: String,
		required: false,
		default: "",
	},
	seenByAdmin: {
		type: Boolean,
		default: false,
	},
	seenByCustomer: {
		type: Boolean,
		default: false,
	},
});

const supportCaseSchema = new Schema({
	createdAt: {
		type: Date,
		default: Date.now,
	},
	rating: {
		type: Number,
		default: null,
	},
	closedBy: { type: String, enum: ["client", "csr"], default: null },
	supporterId: {
		type: Schema.Types.ObjectId,
		ref: "User",
	},
	supporterName: {
		type: String,
		default: "",
	},
	caseStatus: {
		type: String,
		default: "open",
	},
	conversation: [conversationSchema],
});

const SupportCase = mongoose.model("SupportCase", supportCaseSchema);

module.exports = SupportCase;
