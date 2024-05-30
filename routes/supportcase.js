// routes/supportcase.js
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

// Delete a support case by ID
router.delete("/support-cases/:id", supportCaseController.deleteSupportCase);

// Get unassigned support cases
router.get(
	"/support-cases/unassigned",
	supportCaseController.getUnassignedSupportCases
);

module.exports = router;
