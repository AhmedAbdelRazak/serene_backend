const {
	agentNames,
	respondToSupportCase,
} = require("../services/supportChatOrchestrator");

exports.agentNames = agentNames;

exports.autoRespond = async (req, res) => {
	try {
		const { caseId } = req.params;
		const { triggerType = "manual" } = req.body || {};

		const result = await respondToSupportCase({
			caseId,
			triggerType,
		});

		return res.json(result);
	} catch (error) {
		console.error("[support-ai] autoRespond failed:", error);
		return res.status(500).json({ error: error.message });
	}
};
