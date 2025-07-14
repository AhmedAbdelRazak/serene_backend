/** @format */

const express = require("express");
const router = express.Router();
const { autoRespond } = require("../controllers/chataiagent");

// 🔒  Internal endpoint – no auth middleware because it is called by the
//     server itself after validating master password sign‑in.
router.post("/aiagent/respond/:caseId", autoRespond);

module.exports = router;
