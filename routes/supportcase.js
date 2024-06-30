const express = require("express");
const router = express.Router();
const supportCaseController = require("../controllers/supportcase");

// Middleware to attach io to req
const attachIo = (req, res, next) => {
	req.io = req.app.get("io");
	next();
};

// Create a new support case
router.post(
	"/support-cases/new",
	attachIo,
	supportCaseController.createNewSupportCase
);

// Get all support cases
router.get("/support-cases", supportCaseController.getSupportCases);

// Get a specific support case by ID
router.get("/support-cases/:id", supportCaseController.getSupportCaseById);

// Update a support case by ID
router.put(
	"/support-cases/:id",
	attachIo,
	supportCaseController.updateSupportCase
);

// Update seenByAdmin field
router.put(
	"/support-cases-admin/:id/seen",
	supportCaseController.updateSeenByAdmin
);

// Update seenByCustomer field
router.put(
	"/support-cases-customer/:id/seen",
	supportCaseController.updateSeenByCustomer
);

// Delete a support case by ID
router.delete("/support-cases/:id", supportCaseController.deleteSupportCase);

// Get unassigned support cases
router.get(
	"/support-cases/unassigned",
	supportCaseController.getUnassignedSupportCases
);

// Get count of unassigned support cases
router.get(
	"/support-cases/unassigned/count",
	supportCaseController.getUnassignedSupportCasesCount
);

// Get count of unseen messages by admin
router.get(
	"/support-cases/unseen/count",
	supportCaseController.getUnseenMessagesCountByAdmin
);

// Get details of unseen messages
router.get(
	"/support-cases/unseen/details",
	supportCaseController.getUnseenMessagesDetails
);

// Get count of unseen messages by customer
router.get(
	"/support-cases-customer/:id/unseen-count",
	supportCaseController.getUnseenMessagesCountByCustomer
);

// Get details of unseen messages by customer
router.get(
	"/support-cases-customer/unseen/details",
	supportCaseController.getUnseenMessagesDetailsByCustomer
);

module.exports = router;
