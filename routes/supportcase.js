/**
 * Support Case Routes
 *
 * These endpoints handle:
 *  - Creating cases
 *  - Fetching open/closed cases
 *  - Marking messages as seen
 *  - Deleting specific messages
 */

const express = require("express");
const router = express.Router();
const supportCaseController = require("../controllers/supportcase");
const {
	requireSignin,
	isSeller,
	isAuth,
	isAdmin,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");

// Middleware to attach io to req for Socket.IO usage
const attachIo = (req, res, next) => {
	req.io = req.app.get("io");
	next();
};

/**
 * Create a new support case
 */
router.post(
	"/support-cases/new",
	attachIo,
	supportCaseController.createNewSupportCase
);

/**
 * Fetch open support cases (admin or seller opened)
 */
router.get(
	"/support-cases/active/:userId",
	requireSignin,
	isSeller,
	supportCaseController.getOpenSupportCases
);

/**
 * Fetch open support cases by clients only
 */
router.get(
	"/support-cases-clients/active/:userId",
	requireSignin,
	isSeller,
	supportCaseController.getOpenSupportCasesClients
);

/**
 * Fetch open support cases for a specific store
 */
router.get(
	"/support-cases-properties/active/:storeId",
	supportCaseController.getOpenSupportCasesForStore
);

/**
 * Fetch closed support cases (admin or seller opened)
 */
router.get("/support-cases/closed", supportCaseController.getCloseSupportCases);

/**
 * Fetch closed support cases by clients (global)
 */
router.get(
	"/support-cases/closed/clients/:userId",
	supportCaseController.getCloseSupportCasesClients
);

/**
 * Fetch closed support cases for a specific store (admin or seller opened)
 */
router.get(
	"/support-cases-properties/closed/:storeId",
	supportCaseController.getCloseSupportCasesForStore
);

/**
 * Fetch closed support cases for a specific store, client opened
 */
router.get(
	"/support-cases-properties-clients/closed/:storeId",
	supportCaseController.getCloseSupportCasesForStoreClients
);

/**
 * Get a specific support case by ID
 */
router.get("/support-cases/:id", supportCaseController.getSupportCaseById);

/**
 * Update a support case (add message, change status, etc.)
 */
router.put(
	"/support-cases/:id",
	attachIo,
	supportCaseController.updateSupportCase
);

/**
 * Fetch unseen messages count by super admin
 * (Using query param ?userId=xxx)
 */
router.get(
	"/support-cases/:storeId/unseen/admin-owner",
	supportCaseController.getUnseenMessagesCountByAdmin
);

/**
 * Fetch unseen messages count by seller (store owner/seller)
 */
router.get(
	"/support-cases/:storeId/unseen/seller",
	supportCaseController.getUnseenMessagesCountBySeller
);

/**
 * Fetch unseen messages by regular client
 */
router.get(
	"/support-cases-client/:clientId/unseen",
	supportCaseController.getUnseenMessagesByClient
);

/**
 * Update seen status for Admin or Seller
 */
router.put(
	"/support-cases/:id/seen/admin-agent",
	supportCaseController.updateSeenStatusForAdminOrSeller
);

/**
 * Update seen status for Client
 */
router.put(
	"/support-cases/:id/seen/client",
	supportCaseController.updateSeenStatusForClient
);

/**
 * Count all unseen (super admin) messages
 */
router.get(
	"/support-cases/unseen/count",
	supportCaseController.getUnseenMessagesCountByAdmin
);

/**
 * Mark all messages as seen by Admin in a single case
 */
router.put(
	"/support-cases/:id/seen-by-admin",
	supportCaseController.markAllMessagesAsSeenByAdmin
);

/**
 * Mark all messages as seen by Seller in a single case
 */
router.put(
	"/support-cases/:id/seen-by-agent",
	supportCaseController.markAllMessagesAsSeenBySeller
);

/**
 * Mark all messages in all cases as seen by everyone
 */
router.put(
	"/mark-all-cases-as-seen",
	supportCaseController.markEverythingAsSeen
);

/**
 * Delete a specific message from a case's conversation
 */
router.delete(
	"/support-cases/:caseId/messages/:messageId",
	attachIo,
	supportCaseController.deleteMessageFromConversation
);

router.put(
	"/support-cases/:id/seen-by-agent",
	supportCaseController.markAllMessagesAsSeenBySeller
);

router.get(
	"/support-cases/admin/unseen/list",
	supportCaseController.getUnseenMessagesListByAdmin
);

router.get(
	"/admin/support-cases/b2c/open/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	supportCaseController.adminGetActiveB2C
);
router.get(
	"/admin/support-cases/b2c/closed/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	supportCaseController.adminGetClosedB2C
);
router.get(
	"/admin/support-cases/b2b/open/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	supportCaseController.adminGetActiveB2B
);
router.get(
	"/admin/support-cases/b2b/closed/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	supportCaseController.adminGetClosedB2B
);

router.get(
	"/support-cases/:storeId/unseen/seller",
	supportCaseController.getUnseenMessagesCountBySeller
);

router.get(
	"/support-cases/:storeId/unseen/seller/list",
	supportCaseController.getUnseenMessagesListBySeller
);

router.param("userId", userById);

module.exports = router;
