const axios = require("axios");
const OpenAI = require("openai");

const SupportCase = require("../models/supportcase");
const Product = require("../models/product");
const { Order } = require("../models/order");
const ShippingOptions = require("../models/shippingoptions");
const StoreManagement = require("../models/storeManagement");
const WebsiteBasicSetup = require("../models/website");

const openai = new OpenAI({ apiKey: process.env.CHATGPT_API_TOKEN });

const agentNames = [
	"sally",
	"elizabeth",
	"michael",
	"andrew",
	"patrick",
	"brenda",
	"natasha",
];

const SUPPORT_EMAIL = "support@serenejannat.com";
const ADMIN_EMAIL = "admin@serenejannat.com";
const DEFAULT_MODEL = process.env.SUPPORT_CHAT_MODEL || "gpt-5.4";
const MAX_TOOL_ROUNDS = 6;
const MAX_REPLY_SEGMENTS = 2;
const REPLY_SEGMENT_MARKER = "[[send]]";
const END_CHAT_SUGGESTION_MARKER = "[[suggest_end_chat]]";
const TYPING_IDLE_MS = 3500;
const TYPING_ABORT_MS = 8000;
const TYPING_RETRY_DELAY_MS = TYPING_ABORT_MS + 500;
const MAX_TYPING_RETRIES = 2;
const INTER_SEGMENT_PAUSE_MS = 450;
const FIRST_REPLY_MIN_DELAY_MS = 5000;
const FIRST_REPLY_MAX_DELAY_MS = 10000;
const IDLE_FOLLOW_UP_MIN_DELAY_MS = 45000;
const IDLE_FOLLOW_UP_MAX_DELAY_MS = 60000;
const IDLE_FOLLOW_UP_RETRY_DELAY_MS = 8000;
const MAX_IDLE_FOLLOW_UP_TYPING_RETRIES = 2;
const NO_FOLLOW_UP_MARKER = "[[no_follow_up]]";
const LIGHTWEIGHT_REPEAT_NUDGE_WINDOW_MS = 90000;
const HAS_SUPPORT_AI_API_KEY = Boolean(
	`${process.env.CHATGPT_API_TOKEN || ""}`.trim(),
);
const SUPPORT_AI_LOG_PREFIX = "[support-ai]";

if (!HAS_SUPPORT_AI_API_KEY) {
	console.warn(
		"[support-ai] CHATGPT_API_TOKEN is not configured. Support AI replies will not work.",
	);
}

const lastTypingAt = new Map();
const typingRetryState = new Map();
const idleFollowUpState = new Map();

function ensureTypingHook() {
	if (global.__supportChatTypingHookInstalled) return;
	const io = global.io;
	if (!io) return;

	global.__supportChatTypingHookInstalled = true;
	io.on("connection", (socket) => {
		socket.on("typing", ({ caseId }) => {
			if (caseId) {
				lastTypingAt.set(String(caseId), Date.now());
			}
		});

		socket.on("stopTyping", ({ caseId }) => {
			if (caseId) {
				lastTypingAt.delete(String(caseId));
			}
		});
	});
}

function normalizeString(value = "") {
	return `${value || ""}`.trim();
}

function normalizeLower(value = "") {
	return normalizeString(value).toLowerCase();
}

function previewText(value = "", maxLength = 140) {
	const normalized = normalizeString(value).replace(/\s+/g, " ");
	if (!normalized) return "";
	return normalized.length > maxLength
		? `${normalized.slice(0, maxLength - 3)}...`
		: normalized;
}

function logSupportAi(event, details = {}, level = "log") {
	const logger =
		typeof console[level] === "function" ? console[level] : console.log;
	logger(`${SUPPORT_AI_LOG_PREFIX} ${event}:`, details);
}

function summarizeSupportAiError(error) {
	return {
		message: error?.message || "Unknown error",
		status: error?.status || error?.statusCode || null,
		code: error?.code || null,
		type: error?.type || null,
		requestId:
			error?.request_id ||
			error?.requestId ||
			error?.headers?.["x-request-id"] ||
			null,
	};
}

function summarizeCaseForLogs(caseDoc = {}, flags = null) {
	const conversation = Array.isArray(caseDoc?.conversation)
		? caseDoc.conversation
		: [];
	const latestMessage = conversation[conversation.length - 1] || null;
	return {
		caseId: normalizeString(caseDoc?._id),
		caseStatus: caseDoc?.caseStatus || "",
		openedBy: caseDoc?.openedBy || "",
		caseAiEnabled: Boolean(caseDoc?.aiToRespond),
		globalAiEnabled:
			flags === null
				? null
				: Boolean(flags?.aiAgentToRespond && !flags?.deactivateChatResponse),
		globalAiSwitch: flags === null ? null : Boolean(flags?.aiAgentToRespond),
		chatPaused: flags === null ? null : Boolean(flags?.deactivateChatResponse),
		conversationCount: conversation.length,
		latestMessageSender: latestMessage
			? classifyConversationMessage(latestMessage)
			: null,
		latestMessagePreview: latestMessage
			? previewText(latestMessage?.message || "")
			: "",
	};
}

function summarizeToolResult(result) {
	if (result === null || result === undefined) {
		return { type: "empty" };
	}

	if (Array.isArray(result)) {
		return { type: "array", count: result.length };
	}

	if (typeof result !== "object") {
		return {
			type: typeof result,
			value: previewText(String(result), 80),
		};
	}

	const summary = {
		type: "object",
		keys: Object.keys(result).slice(0, 12),
	};

	for (const key of [
		"found",
		"message",
		"requestedOccasion",
		"requestedOccasionSupported",
		"supportedOccasionCount",
	]) {
		if (Object.prototype.hasOwnProperty.call(result, key)) {
			summary[key] =
				key === "message" ? previewText(result[key], 120) : result[key];
		}
	}

	for (const [key, value] of Object.entries(result)) {
		if (Array.isArray(value)) {
			summary[`${key}Count`] = value.length;
		}
	}

	return summary;
}

function getAiBlockReason(flags = {}, caseDoc = {}) {
	if (!flags) return "website_setup_missing";
	if (!flags?.aiAgentToRespond) return "global_ai_disabled";
	if (flags?.deactivateChatResponse) return "chat_responses_paused";
	if (!caseDoc?.aiToRespond) return "case_ai_disabled";
	if (caseDoc?.caseStatus !== "open") {
		return `case_${normalizeLower(caseDoc?.caseStatus || "not_open")}`;
	}
	if (caseDoc?.openedBy !== "client") return "not_client_opened";
	return null;
}

function escapeRegex(value = "") {
	return normalizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripResponseText(value = "") {
	return normalizeString(value)
		.replace(/```[a-z]*\n?|```/gi, "")
		.trim();
}

function sanitizeReplyText(value = "") {
	return stripResponseText(value)
		.replace(/\r/g, "\n")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/__(.*?)__/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function extractReplyUiDirectives(value = "") {
	const pattern = new RegExp(
		`\\s*${escapeRegex(END_CHAT_SUGGESTION_MARKER)}\\s*`,
		"gi",
	);
	const rawValue = `${value || ""}`;

	return {
		shouldSuggestEndChat: pattern.test(rawValue),
		replyText: sanitizeReplyText(rawValue.replace(pattern, " ")),
	};
}

function extractIdleFollowUpDecision(value = "") {
	const pattern = new RegExp(
		`\\s*${escapeRegex(NO_FOLLOW_UP_MARKER)}\\s*`,
		"gi",
	);
	const rawValue = `${value || ""}`;
	const replyText = sanitizeReplyText(rawValue.replace(pattern, " "));

	return {
		shouldSkipFollowUp: pattern.test(rawValue) && !replyText,
		replyText,
	};
}

function hasRecentTyping(caseId, thresholdMs = TYPING_IDLE_MS) {
	const lastSeen = lastTypingAt.get(String(caseId)) || 0;
	return Date.now() - lastSeen < thresholdMs;
}

function wait(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function randomBetween(min = 0, max = 0) {
	const normalizedMin = Math.max(0, Number(min) || 0);
	const normalizedMax = Math.max(normalizedMin, Number(max) || normalizedMin);
	return (
		Math.floor(Math.random() * (normalizedMax - normalizedMin + 1)) +
		normalizedMin
	);
}

function clearTypingRetry(caseId = "") {
	const normalizedCaseId = normalizeString(caseId);
	if (!normalizedCaseId) return;

	const existing = typingRetryState.get(normalizedCaseId);
	if (existing?.timer) {
		clearTimeout(existing.timer);
	}
	typingRetryState.delete(normalizedCaseId);
}

function clearIdleFollowUp(caseId = "") {
	const normalizedCaseId = normalizeString(caseId);
	if (!normalizedCaseId) return;

	const existing = idleFollowUpState.get(normalizedCaseId);
	if (existing?.timer) {
		clearTimeout(existing.timer);
	}
	idleFollowUpState.delete(normalizedCaseId);
}

function stableHash(value = "") {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) {
		hash = (hash << 5) - hash + value.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash);
}

function toDisplayAgentName(name = "") {
	const normalized = normalizeLower(name);
	if (!normalized) return "";
	return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getFirstName(value = "") {
	return normalizeString(value).split(/\s+/).filter(Boolean)[0] || "";
}

function looksLikeGreeting(value = "") {
	return /^(hi|hello|hey|good\s+(morning|afternoon|evening))\b/i.test(
		normalizeString(value),
	);
}

function isHowAreYouMessage(value = "") {
	return /\b(how are you|how's it going|how is it going|how are things)\b/i.test(
		normalizeString(value),
	);
}

function isFirstSupportReply(caseDoc = {}) {
	return !getConversationArray(caseDoc).some((message) => {
		const senderType = classifyConversationMessage(message);
		return senderType === "staff" || senderType === "ai";
	});
}

function getCustomerName(caseDoc = {}) {
	const clientMessage = getConversationArray(caseDoc).find(
		(message) => classifyConversationMessage(message) === "client",
	);

	return (
		normalizeString(clientMessage?.messageBy?.customerName) ||
		normalizeString(caseDoc?.displayName1) ||
		""
	);
}

function getLikelyOrderReference(caseDoc = {}) {
	const root = getConversationArray(caseDoc)[0] || {};
	const inquiryAbout = normalizeLower(root?.inquiryAbout);
	const inquiryDetails = normalizeString(root?.inquiryDetails);
	if (inquiryAbout !== "order" || !inquiryDetails) return "";
	if (!/^[a-z0-9-]{4,}$/i.test(inquiryDetails)) {
		return inquiryDetails.length <= 40 ? inquiryDetails : "";
	}
	return inquiryDetails.startsWith("#") ? inquiryDetails : `#${inquiryDetails}`;
}

function getMessageIdentity(message = {}, fallbackIndex = -1) {
	return (
		normalizeString(message?._id) ||
		[
			normalizeString(message?.date),
			normalizeString(message?.message),
			fallbackIndex,
		].join("::")
	);
}

function isSameTurn(currentTurn, referenceTurn) {
	if (!currentTurn || !referenceTurn) return false;
	return (
		getMessageIdentity(currentTurn.message, currentTurn.index) ===
		getMessageIdentity(referenceTurn.message, referenceTurn.index)
	);
}

function scheduleTypingRetry({
	caseId,
	latestClientTurn,
	triggerType = "client_message",
}) {
	const normalizedCaseId = normalizeString(caseId);
	if (!normalizedCaseId || !latestClientTurn) {
		logSupportAi(
			"typing-retry-not-scheduled",
			{
				caseId: normalizedCaseId || caseId || "",
				triggerType,
				reason: "missing_case_or_turn",
			},
			"warn",
		);
		return false;
	}

	const turnKey = getMessageIdentity(
		latestClientTurn.message,
		latestClientTurn.index,
	);
	if (!turnKey) {
		logSupportAi(
			"typing-retry-not-scheduled",
			{
				caseId: normalizedCaseId,
				triggerType,
				reason: "missing_turn_key",
			},
			"warn",
		);
		return false;
	}

	const existing = typingRetryState.get(normalizedCaseId);
	const isSameTurn = existing?.turnKey === turnKey;
	const attempts = isSameTurn ? (existing?.attempts || 0) + 1 : 1;

	if (isSameTurn && attempts > MAX_TYPING_RETRIES) {
		logSupportAi(
			"typing-retry-exhausted",
			{
				caseId: normalizedCaseId,
				triggerType,
				attempts,
				latestTurnIndex: latestClientTurn.index,
				latestTurnPreview: previewText(
					latestClientTurn?.message?.message || "",
				),
			},
			"warn",
		);
		return false;
	}

	if (existing?.timer) {
		clearTimeout(existing.timer);
	}

	const timer = setTimeout(async () => {
		const current = typingRetryState.get(normalizedCaseId);
		if (
			!current ||
			current.turnKey !== turnKey ||
			current.attempts !== attempts
		) {
			logSupportAi("typing-retry-stale", {
				caseId: normalizedCaseId,
				triggerType,
				attempts,
			});
			return;
		}

		typingRetryState.delete(normalizedCaseId);

		try {
			logSupportAi("typing-retry-fired", {
				caseId: normalizedCaseId,
				triggerType,
				attempts,
				latestTurnIndex: latestClientTurn.index,
				latestTurnPreview: previewText(
					latestClientTurn?.message?.message || "",
				),
			});
			await respondToSupportCase({
				caseId: normalizedCaseId,
				triggerType:
					triggerType === "post_typing_retry"
						? triggerType
						: "post_typing_retry",
			});
		} catch (error) {
			logSupportAi(
				"typing-retry-failed",
				{
					caseId: normalizedCaseId,
					triggerType,
					attempts,
					...summarizeSupportAiError(error),
				},
				"error",
			);
		}
	}, TYPING_RETRY_DELAY_MS);

	typingRetryState.set(normalizedCaseId, {
		turnKey,
		attempts,
		timer,
	});

	logSupportAi("typing-retry-scheduled", {
		caseId: normalizedCaseId,
		triggerType,
		attempts,
		delayMs: TYPING_RETRY_DELAY_MS,
		latestTurnIndex: latestClientTurn.index,
		latestTurnPreview: previewText(latestClientTurn?.message?.message || ""),
	});

	return true;
}

function scheduleIdleFollowUp({
	caseId,
	referenceSupportTurn,
	originTriggerType = "client_message",
	agentName = "",
	retryAttempt = 0,
	delayMs = randomBetween(
		IDLE_FOLLOW_UP_MIN_DELAY_MS,
		IDLE_FOLLOW_UP_MAX_DELAY_MS,
	),
}) {
	const normalizedCaseId = normalizeString(caseId);
	if (!normalizedCaseId || !referenceSupportTurn) {
		logSupportAi(
			"idle-follow-up-not-scheduled",
			{
				caseId: normalizedCaseId || caseId || "",
				originTriggerType,
				reason: "missing_case_or_support_turn",
			},
			"warn",
		);
		return false;
	}

	const turnKey = getMessageIdentity(
		referenceSupportTurn.message,
		referenceSupportTurn.index,
	);
	if (!turnKey) {
		logSupportAi(
			"idle-follow-up-not-scheduled",
			{
				caseId: normalizedCaseId,
				originTriggerType,
				reason: "missing_turn_key",
			},
			"warn",
		);
		return false;
	}

	clearIdleFollowUp(normalizedCaseId);

	const timer = setTimeout(async () => {
		const current = idleFollowUpState.get(normalizedCaseId);
		if (
			!current ||
			current.turnKey !== turnKey ||
			current.retryAttempt !== retryAttempt
		) {
			logSupportAi("idle-follow-up-stale", {
				caseId: normalizedCaseId,
				originTriggerType,
				retryAttempt,
			});
			return;
		}

		try {
			const [flags, caseDoc] = await Promise.all([
				WebsiteBasicSetup.findOne({}).lean(),
				SupportCase.findById(normalizedCaseId).lean(),
			]);

			if (!caseDoc) {
				clearIdleFollowUp(normalizedCaseId);
				logSupportAi("idle-follow-up-skipped", {
					caseId: normalizedCaseId,
					originTriggerType,
					reason: "case_not_found",
				});
				return;
			}

			const aiBlockReason = getAiBlockReason(flags, caseDoc);
			if (aiBlockReason) {
				clearIdleFollowUp(normalizedCaseId);
				logSupportAi("idle-follow-up-skipped", {
					caseId: normalizedCaseId,
					originTriggerType,
					reason: aiBlockReason,
					caseState: summarizeCaseForLogs(caseDoc, flags),
				});
				return;
			}

			const currentLatestSupportTurn = getLatestSupportTurn(caseDoc);
			if (
				!currentLatestSupportTurn ||
				!isSameTurn(currentLatestSupportTurn, referenceSupportTurn)
			) {
				clearIdleFollowUp(normalizedCaseId);
				logSupportAi("idle-follow-up-skipped", {
					caseId: normalizedCaseId,
					originTriggerType,
					reason: "support_turn_changed",
					referenceTurnIndex: referenceSupportTurn.index,
					currentTurnIndex: currentLatestSupportTurn?.index ?? null,
				});
				return;
			}

			if (hasClientReplyAfter(caseDoc, referenceSupportTurn.index)) {
				clearIdleFollowUp(normalizedCaseId);
				logSupportAi("idle-follow-up-skipped", {
					caseId: normalizedCaseId,
					originTriggerType,
					reason: "client_replied",
					referenceTurnIndex: referenceSupportTurn.index,
				});
				return;
			}

			if (hasRecentTyping(normalizedCaseId, TYPING_ABORT_MS)) {
				if (retryAttempt >= MAX_IDLE_FOLLOW_UP_TYPING_RETRIES) {
					clearIdleFollowUp(normalizedCaseId);
					logSupportAi("idle-follow-up-skipped", {
						caseId: normalizedCaseId,
						originTriggerType,
						reason: "client_typing_retry_exhausted",
						retryAttempt,
					});
					return;
				}

				logSupportAi("idle-follow-up-delayed", {
					caseId: normalizedCaseId,
					originTriggerType,
					reason: "client_typing",
					retryAttempt: retryAttempt + 1,
					delayMs: IDLE_FOLLOW_UP_RETRY_DELAY_MS,
				});

				scheduleIdleFollowUp({
					caseId: normalizedCaseId,
					referenceSupportTurn,
					originTriggerType,
					agentName,
					retryAttempt: retryAttempt + 1,
					delayMs: IDLE_FOLLOW_UP_RETRY_DELAY_MS,
				});
				return;
			}

			clearIdleFollowUp(normalizedCaseId);
			logSupportAi("idle-follow-up-fired", {
				caseId: normalizedCaseId,
				originTriggerType,
				agentName,
				referenceTurnIndex: referenceSupportTurn.index,
				retryAttempt,
			});

			await respondToSupportCase({
				caseId: normalizedCaseId,
				triggerType: "idle_follow_up",
			});
		} catch (error) {
			clearIdleFollowUp(normalizedCaseId);
			logSupportAi(
				"idle-follow-up-failed",
				{
					caseId: normalizedCaseId,
					originTriggerType,
					agentName,
					retryAttempt,
					...summarizeSupportAiError(error),
				},
				"error",
			);
		}
	}, delayMs);

	idleFollowUpState.set(normalizedCaseId, {
		turnKey,
		referenceTurnIndex: referenceSupportTurn.index,
		retryAttempt,
		timer,
	});

	logSupportAi("idle-follow-up-scheduled", {
		caseId: normalizedCaseId,
		originTriggerType,
		agentName,
		referenceTurnIndex: referenceSupportTurn.index,
		delayMs,
		retryAttempt,
		messagePreview: previewText(
			referenceSupportTurn?.message?.message || "",
			160,
		),
	});

	return true;
}

function hasHumanStaffReplyAfter(caseDoc, messageIndex) {
	const conversation = getConversationArray(caseDoc);
	for (let index = messageIndex + 1; index < conversation.length; index += 1) {
		if (classifyConversationMessage(conversation[index]) === "staff") {
			return true;
		}
	}
	return false;
}

function hasWarmOpeningWish(value = "") {
	return /\bhope (you('|’)re|you are|your day is)\b/i.test(
		normalizeString(value),
	);
}

function addWarmOpeningWish(value = "") {
	const trimmed = sanitizeReplyText(value);
	if (!trimmed || hasWarmOpeningWish(trimmed)) return trimmed;

	const greetingMatch = trimmed.match(
		/^(hi|hello|hey|good\s+(morning|afternoon|evening))[^.!?]*[.!?]?/i,
	);

	if (greetingMatch) {
		const greeting = sanitizeReplyText(greetingMatch[0]).replace(
			/[.!?]*$/,
			".",
		);
		const rest = sanitizeReplyText(trimmed.slice(greetingMatch[0].length));
		return [greeting, "Hope you're having a good day.", rest]
			.filter(Boolean)
			.join(" ");
	}

	return `Hope you're having a good day. ${trimmed}`.trim();
}

function getCaseInquiryContext(caseDoc = {}) {
	const root = getConversationArray(caseDoc)[0] || {};
	return {
		inquiryAbout: normalizeLower(root?.inquiryAbout),
		inquiryDetails: normalizeString(root?.inquiryDetails),
	};
}

function isGreetingOnlyMessage(value = "") {
	const normalized = normalizeLower(value);
	if (!normalized) return false;

	return /^(hi|hello|hey|good\s+(morning|afternoon|evening)|how are you|how's it going|how is it going|what's up|sup|yo|hiya)[!. ]*$/i.test(
		normalized,
	);
}

function hasExplicitHelpIntent(value = "", inquiryAbout = "") {
	const normalized = normalizeLower(value);
	if (!normalized) return false;

	if (/\?/.test(value)) return true;

	if (
		/\b(cancel|cancellation|refund|return|exchange|status|track|tracking|where|when|how|what|why|help|need|want|looking for|looking to|problem|issue|shipping|delivery|delay|late|arrive|price|cost|available|availability|stock|custom|customize|personalize|size|sizes|color|colors|material|details|replace|change|update|edit|wrong|damaged|broken|missing)\b/i.test(
			normalized,
		)
	) {
		return true;
	}

	if (
		inquiryAbout === "order" &&
		/\b(order|invoice|tracking|shipment|shipped|delivered|cancel)\b/i.test(
			normalized,
		)
	) {
		return true;
	}

	if (
		inquiryAbout === "product" &&
		/\b(price|cost|stock|shipping|custom|size|color|details|available)\b/i.test(
			normalized,
		)
	) {
		return true;
	}

	if (inquiryAbout === "other" && normalized.split(/\s+/).length >= 6) {
		return true;
	}

	return false;
}

function ensureFriendlyOpening(segment = "", caseDoc = {}, agentName = "") {
	const trimmed = sanitizeReplyText(segment);
	if (!trimmed) return "";

	const firstName = getFirstName(getCustomerName(caseDoc));
	if (!firstName) {
		return isFirstSupportReply(caseDoc) ? addWarmOpeningWish(trimmed) : trimmed;
	}

	if (looksLikeGreeting(trimmed)) {
		const leadingMatch = trimmed.match(
			/^(hi|hello|hey|good\s+(morning|afternoon|evening))\b/i,
		);
		const alreadyNamesCustomer = new RegExp(
			`\\b${escapeRegex(firstName)}\\b`,
			"i",
		).test(trimmed.slice(0, 48));

		if (leadingMatch && !alreadyNamesCustomer) {
			const greetingWord = leadingMatch[0];
			const rest = trimmed.slice(greetingWord.length).replace(/^[,\s-]+/, "");
			return `${greetingWord} ${firstName}, ${rest}`.trim();
		}

		return trimmed;
	}

	const orderReference = getLikelyOrderReference(caseDoc);
	const intro = orderReference
		? `Hi ${firstName}, it's ${agentName}. I pulled up order ${orderReference}.`
		: `Hi ${firstName}, it's ${agentName}.`;

	const withGreeting = `${intro} ${trimmed}`.trim();
	return isFirstSupportReply(caseDoc)
		? addWarmOpeningWish(withGreeting)
		: withGreeting;
}

function splitSentences(value = "") {
	return (
		sanitizeReplyText(value)
			.match(/[^.!?\n]+(?:[.!?]+|$)/g)
			?.map((sentence) => sentence.trim()) || []
	).filter(Boolean);
}

function autoSplitLongReply(value = "") {
	const cleaned = sanitizeReplyText(value);
	if (!cleaned) return [];

	const hasUrl = /https?:\/\/\S+/i.test(cleaned);
	if (cleaned.length <= 320 && !hasUrl) {
		return [cleaned];
	}

	const urlMatch = cleaned.match(/https?:\/\/\S+/i);
	if (urlMatch?.index >= 110) {
		const beforeUrl = cleaned
			.slice(0, urlMatch.index)
			.replace(/[:\s-]+$/, "")
			.trim();
		const afterUrl = cleaned.slice(urlMatch.index).trim();

		if (beforeUrl.length >= 80 && afterUrl) {
			const linkLead = /track|tracking|delivery/i.test(beforeUrl)
				? "Here's the tracking link:"
				: "Here's the link:";

			return [beforeUrl, `${linkLead}\n${afterUrl}`];
		}
	}

	const sentences = splitSentences(cleaned);
	if (sentences.length < 2) {
		return [cleaned];
	}

	const firstSegment = [];
	let currentLength = 0;

	for (let index = 0; index < sentences.length; index += 1) {
		const sentence = sentences[index];
		const nextLength =
			currentLength + (currentLength ? 1 : 0) + sentence.length;
		const remainingSentences = sentences.length - index - 1;

		if (firstSegment.length && nextLength > 240 && remainingSentences > 0) {
			break;
		}

		firstSegment.push(sentence);
		currentLength = nextLength;

		if (currentLength >= 170 && remainingSentences > 0) {
			break;
		}
	}

	const secondSegment = sentences.slice(firstSegment.length).join(" ").trim();
	if (!secondSegment) {
		return [cleaned];
	}

	return [firstSegment.join(" ").trim(), secondSegment];
}

function splitReplyIntoSegments(reply = "", caseDoc = {}, agentName = "") {
	const cleaned = sanitizeReplyText(reply);
	if (!cleaned) return [];
	const stylePreferences = getReplyStylePreferences(caseDoc);

	let segments = cleaned
		.split(new RegExp(`\\s*${escapeRegex(REPLY_SEGMENT_MARKER)}\\s*`, "i"))
		.map((segment) => sanitizeReplyText(segment))
		.filter(Boolean);

	if (segments.length <= 1) {
		const paragraphs = cleaned
			.split(/\n{2,}/)
			.map((segment) => sanitizeReplyText(segment))
			.filter(Boolean);
		if (paragraphs.length > 1) {
			segments = paragraphs;
		}
	}

	if (!segments.length) {
		segments = [cleaned];
	}

	if (segments.length === 1 && stylePreferences.preferTwoMessagesWhenLong) {
		segments = autoSplitLongReply(segments[0]);
	}

	const normalizedSegments = segments
		.slice(0, MAX_REPLY_SEGMENTS)
		.map((segment) => sanitizeReplyText(segment))
		.filter(Boolean);

	if (!normalizedSegments.length) return [];

	if (isFirstSupportReply(caseDoc)) {
		normalizedSegments[0] = ensureFriendlyOpening(
			normalizedSegments[0],
			caseDoc,
			agentName,
		);
	}

	return normalizedSegments;
}

function calculateTypingDelay(segment = "", segmentIndex = 0) {
	const text = normalizeString(segment).replace(/\s+/g, " ");
	const wordCount = text ? text.split(/\s+/).length : 0;
	const baseDelay = segmentIndex === 0 ? 950 : 725;
	const urlBonus = /https?:\/\/\S+/i.test(text) ? 350 : 0;
	const jitter = Math.floor(Math.random() * 180);

	return Math.min(
		Math.max(
			baseDelay + wordCount * 145 + text.length * 7 + urlBonus + jitter,
			950,
		),
		segmentIndex === 0 ? 4400 : 3600,
	);
}

function getFirstReplyDelayRange(caseDoc = {}, triggerType = "") {
	if (!isFirstSupportReply(caseDoc)) return null;
	if (triggerType !== "case_opened") return null;

	return {
		minMs: FIRST_REPLY_MIN_DELAY_MS,
		maxMs: FIRST_REPLY_MAX_DELAY_MS,
	};
}

function getLatestCustomerText(caseDoc = {}) {
	const latestClientTurn = getLatestClientTurn(caseDoc);
	return normalizeString(
		latestClientTurn?.message?.message ||
			latestClientTurn?.message?.inquiryDetails ||
			"",
	);
}

function customerPrefersShortReplies(caseDoc = {}) {
	const customerText = normalizeLower(
		getConversationArray(caseDoc)
			.filter((message) => classifyConversationMessage(message) === "client")
			.map((message) => message?.message || "")
			.join("\n"),
	);

	if (!customerText) return false;

	return (
		/\b(keep it short|keep it shorter|shorter|brief|be brief|to the point|straight to the point)\b/i.test(
			customerText,
		) ||
		/\b(you type a lot|you write a lot|read a lot|too much to read|too long)\b/i.test(
			customerText,
		)
	);
}

function customerDislikesUnaskedExtras(caseDoc = {}) {
	const customerText = normalizeLower(
		getConversationArray(caseDoc)
			.filter((message) => classifyConversationMessage(message) === "client")
			.map((message) => message?.message || "")
			.join("\n"),
	);

	if (!customerText) return false;

	return (
		/\b(i haven'?t asked|i did(?: not|n't) ask|didn'?t ask|wasn'?t asking|just answer|only asked)\b/i.test(
			customerText,
		) || /\b(one question at a time|one thing at a time)\b/i.test(customerText)
	);
}

function customerWantsCompleteAnswers(caseDoc = {}) {
	const customerText = normalizeLower(
		getConversationArray(caseDoc)
			.filter((message) => classifyConversationMessage(message) === "client")
			.map((message) => message?.message || "")
			.join("\n"),
	);

	if (!customerText) return false;

	return (
		/\b(answer (it|that|this) in full|answer(ed)? .* in full|didn'?t fully answer|not answer(ing)? .* in full|fully answer|complete answer|answer my previous question in full)\b/i.test(
			customerText,
		) ||
		/\b(why .* not answering .* in full|you missed .* part|didn'?t answer .* color|didn'?t answer .* size)\b/i.test(
			customerText,
		)
	);
}

function customerRejectedOldTopicAnchoring(caseDoc = {}) {
	const customerText = normalizeLower(
		getConversationArray(caseDoc)
			.filter((message) => classifyConversationMessage(message) === "client")
			.map((message) => message?.message || "")
			.join("\n"),
	);

	if (!customerText) return false;

	return /\b(why .* always ask .* order|stop steering .* order|asking about something else now|what if i need to inquire about a product now|something else now)\b/i.test(
		customerText,
	);
}

function customerHasServiceComplaintHistory(caseDoc = {}) {
	const customerText = normalizeLower(
		getConversationArray(caseDoc)
			.filter((message) => classifyConversationMessage(message) === "client")
			.map((message) => message?.message || "")
			.join("\n"),
	);

	if (!customerText) return false;

	return (
		/\b(horrible|bad|poor|terrible)\s+customer\s+service\b/i.test(
			customerText,
		) ||
		/\b(poor|bad|weak|horrible)\s+reply\b/i.test(customerText) ||
		/\b(didn'?t answer|never answered|never offered)\b/i.test(customerText) ||
		/\b(horrible developer|who trained you|so bad)\b/i.test(customerText)
	);
}

function latestTurnSeemsHostileOrSarcastic(caseDoc = {}) {
	const latestText = normalizeLower(getLatestCustomerText(caseDoc));
	if (!latestText) return false;

	return (
		/\b(stupid|horrible|so bad|awful|terrible|useless)\b/i.test(latestText) ||
		/\bwho trained you\b/i.test(latestText) ||
		/\bhorrible developer\b/i.test(latestText) ||
		/\byou('?re| are)\s+.*ai\b/i.test(latestText) ||
		/^\s*(wow|lol|lmao|sure|right)\s*[.!?]*\s*$/i.test(latestText)
	);
}

function latestTurnIsBareGreetingAfterResolvedExchange(caseDoc = {}) {
	const latestText = getLatestCustomerText(caseDoc);
	if (!isGreetingOnlyMessage(latestText)) return false;

	let hasSupportReply = false;
	let hasGratitudeAfterSupport = false;

	for (const message of getConversationArray(caseDoc)) {
		const senderType = classifyConversationMessage(message);
		const normalizedMessage = normalizeLower(message?.message || "");

		if (senderType === "staff" || senderType === "ai") {
			hasSupportReply = true;
			continue;
		}

		if (
			senderType === "client" &&
			hasSupportReply &&
			/\b(thanks|thank you|awesome|great|helpful|got it|perfect)\b/i.test(
				normalizedMessage,
			)
		) {
			hasGratitudeAfterSupport = true;
		}
	}

	return hasGratitudeAfterSupport;
}

function latestTurnLikelyChangesTopic(caseDoc = {}) {
	const latestText = getLatestCustomerText(caseDoc);
	const rootText = getCaseInquiryContext(caseDoc).inquiryDetails;
	const latestTokens = extractSearchTokens(latestText);
	const rootTokens = extractSearchTokens(rootText);

	if (!latestTokens.length || !rootTokens.length) return false;

	const overlapCount = latestTokens.filter((token) =>
		rootTokens.includes(token),
	).length;
	const overlapRatio =
		overlapCount /
		Math.max(1, Math.min(latestTokens.length, rootTokens.length));

	if (overlapRatio >= 0.45) return false;

	if (
		/\b(actually|instead|what about|another|different|else|also|do you guys have|do you have)\b/i.test(
			latestText,
		)
	) {
		return true;
	}

	return overlapRatio === 0 && latestTokens.length >= 2;
}

function getReplyStylePreferences(caseDoc = {}) {
	const prefersShortReplies = customerPrefersShortReplies(caseDoc);
	const dislikesUnaskedExtras = customerDislikesUnaskedExtras(caseDoc);
	const wantsCompleteAnswers = customerWantsCompleteAnswers(caseDoc);
	const avoidOldTopicAnchoring = customerRejectedOldTopicAnchoring(caseDoc);

	return {
		prefersShortReplies,
		dislikesUnaskedExtras,
		wantsCompleteAnswers,
		avoidOldTopicAnchoring,
		wantsOneQuestionAtATime: dislikesUnaskedExtras,
		preferTwoMessagesWhenLong: !prefersShortReplies,
	};
}

function isHumanHandoffRequest(value = "") {
	const normalized = normalizeLower(value);
	if (!normalized) return false;

	return (
		/\b(csr|customer service rep|customer service representative)\b/i.test(
			normalized,
		) ||
		/\b(real person|actual person|human (agent|rep|representative|being))\b/i.test(
			normalized,
		) ||
		/\b(talk|speak|chat)\s+(to|with)\s+(a|an)\s+(human|person|representative|rep|agent|csr)\b/i.test(
			normalized,
		) ||
		/\b(need|want|prefer)\s+(a|an)\s+(human|person|representative|rep|agent|csr)\b/i.test(
			normalized,
		) ||
		/\b(get|bring|have)\s+(me\s+)?(a|an)\s+(human|representative|rep|agent|csr)\b/i.test(
			normalized,
		) ||
		/\b(someone|somebody|anyone)\s+else\b/i.test(normalized) ||
		/\b(another|different)\s+(person|rep|representative|agent|csr|one)\b/i.test(
			normalized,
		) ||
		/\b(talk|speak|chat)\s+(to|with)\s+(someone|somebody|anyone)\s+else\b/i.test(
			normalized,
		) ||
		/\b(give|get|bring)\s+me\s+(another|someone else|somebody else|anyone else)\b/i.test(
			normalized,
		) ||
		/\b(take over|step in)\b/i.test(normalized)
	);
}

function customerExplicitlyDeclinesHelp(value = "") {
	const normalized = normalizeLower(value);
	if (!normalized) return false;

	return (
		/\b(i do not|i don't|dont)\s+need\s+(your\s+)?help\b/i.test(normalized) ||
		/\b(i do not|i don't|dont)\s+want\s+(your\s+)?help\b/i.test(normalized) ||
		/\b(stop|quit)\s+(helping|asking)\b/i.test(normalized) ||
		/\bleave it\b/i.test(normalized)
	);
}

function isRhetoricalComplaintPrompt(value = "") {
	const normalized = normalizeLower(value);
	if (!normalized) return false;

	return (
		/\bwhat do you think i need\b/i.test(normalized) ||
		/\bwhat do you think i want\b/i.test(normalized)
	);
}

function buildHumanHandoffReply(caseDoc = {}) {
	const firstName = getFirstName(getCustomerName(caseDoc));
	if (firstName) {
		return `Of course, ${firstName}. I'm getting a customer service rep into this chat now. Please give us a moment.`;
	}

	return "Of course. I'm getting a customer service rep into this chat now. Please give us a moment.";
}

function buildComplaintTrapReply(caseDoc = {}) {
	const firstName = getFirstName(getCustomerName(caseDoc));
	const intro = firstName ? `Fair point, ${firstName}.` : "Fair point.";
	return `${intro} You needed a clearer answer from me. If you want to keep going, ask me anything directly and I'll answer straight.`;
}

function buildNoFurtherHelpReply(caseDoc = {}) {
	const firstName = getFirstName(getCustomerName(caseDoc));
	if (firstName) {
		return `Understood, ${firstName}. I’ll pass that feedback along.`;
	}

	return "Understood. I’ll pass that feedback along.";
}

async function disableAiForCase(caseId = "") {
	const normalizedCaseId = normalizeString(caseId);
	if (!normalizedCaseId) return null;

	clearIdleFollowUp(normalizedCaseId);
	clearTypingRetry(normalizedCaseId);

	const updatedCase = await SupportCase.findByIdAndUpdate(
		normalizedCaseId,
		{ $set: { aiToRespond: false } },
		{ new: true },
	);

	if (updatedCase) {
		global.io?.emit("supportCaseUpdated", updatedCase.toObject());
	}

	return updatedCase;
}

function normalizeReferenceToken(value = "") {
	return normalizeString(value).replace(/^#/, "").toLowerCase();
}

function looksLikeSpecificProductReference(value = "") {
	const normalized = normalizeString(value);
	const tokens = extractSearchTokens(normalized);

	if (!normalized) return false;

	return (
		tokens.length >= 3 ||
		normalized.length >= 16 ||
		(tokens.length >= 2 && /\d/.test(normalized))
	);
}

function shouldTrustClarifierMatch(query = "", matchedName = "") {
	const normalizedQuery = normalizeLower(query);
	const normalizedMatch = normalizeLower(matchedName);
	if (!normalizedQuery || !normalizedMatch) return false;

	if (normalizedQuery === normalizedMatch) {
		return true;
	}

	const queryTokens = extractSearchTokens(query);
	const matchTokens = extractSearchTokens(matchedName);
	if (!queryTokens.length || !matchTokens.length) {
		return false;
	}

	const overlappingTokens = queryTokens.filter((token) =>
		matchTokens.includes(token),
	);
	const queryLooksFragmentary =
		queryTokens.length <= 2 || normalizeString(query).length <= 12;

	if (
		queryLooksFragmentary &&
		overlappingTokens.length === queryTokens.length
	) {
		return true;
	}

	if (queryLooksFragmentary && normalizedMatch.includes(normalizedQuery)) {
		return true;
	}

	return false;
}

function shouldClarifyFirstReply(caseDoc = {}) {
	if (!isFirstSupportReply(caseDoc)) return false;
	if (normalizeLower(caseDoc?.openedBy) !== "client") return false;

	const latestText = getLatestCustomerText(caseDoc);
	const { inquiryAbout } = getCaseInquiryContext(caseDoc);
	if (!latestText) return true;
	if (isGreetingOnlyMessage(latestText)) return true;

	if (
		inquiryAbout === "order" &&
		normalizeReferenceToken(latestText) ===
			normalizeReferenceToken(getLikelyOrderReference(caseDoc))
	) {
		return true;
	}

	return !hasExplicitHelpIntent(latestText, inquiryAbout);
}

async function buildOrderIntentClarifierReply(caseDoc = {}, agentName = "") {
	const firstName = getFirstName(getCustomerName(caseDoc));
	const fallbackOrderReference = getLikelyOrderReference(caseDoc);
	const latestText = getLatestCustomerText(caseDoc);
	const greetingBase = firstName
		? `Hi ${firstName}, it's ${agentName}.`
		: `Hi, it's ${agentName}.`;
	const greeting = isHowAreYouMessage(latestText)
		? `${greetingBase} I'm doing well, thanks for asking. Hope you're having a good day too.`
		: `${greetingBase} Hope you're having a good day.`;

	if (!fallbackOrderReference) {
		return `${greeting} I’m here to help. What would you like me to check on that order?`;
	}

	const searchableReference = fallbackOrderReference.replace(/^#/, "");
	let lookup = await toolFindOrders({
		invoiceNumber: searchableReference,
		limit: 1,
	});

	if (!lookup?.found) {
		lookup = await toolFindOrders({
			trackingNumber: searchableReference,
			limit: 1,
		});
	}

	if (!lookup?.found) {
		return `${greeting} I’m not seeing order ${fallbackOrderReference} just yet. Could you double-check the order number for me?`;
	}

	const matchedOrder = lookup.orders?.[0] || {};
	const confirmedReference = normalizeString(matchedOrder.invoiceNumber)
		? matchedOrder.invoiceNumber.startsWith("#")
			? matchedOrder.invoiceNumber
			: `#${matchedOrder.invoiceNumber}`
		: fallbackOrderReference;

	return `${greeting} I found order ${confirmedReference} for you. What can I help you with on it today?`;
}

async function buildOrderIntentClarifierReplyV2(caseDoc = {}, agentName = "") {
	const firstName = getFirstName(getCustomerName(caseDoc));
	const fallbackOrderReference = getLikelyOrderReference(caseDoc);
	const latestText = getLatestCustomerText(caseDoc);
	const greetingBase = firstName
		? `Hi ${firstName}, it's ${agentName}.`
		: `Hi, it's ${agentName}.`;
	const greeting = isHowAreYouMessage(latestText)
		? `${greetingBase} I'm doing well, thanks for asking. Hope you're having a good day too.`
		: `${greetingBase} Hope you're having a good day.`;

	if (!fallbackOrderReference) {
		return `${greeting} I'm here to help with your order. What would you like me to check for you?`;
	}

	const searchableReference = fallbackOrderReference.replace(/^#/, "");
	let lookup = await toolFindOrders({
		invoiceNumber: searchableReference,
		limit: 1,
	});

	if (!lookup?.found) {
		lookup = await toolFindOrders({
			trackingNumber: searchableReference,
			limit: 1,
		});
	}

	if (!lookup?.found) {
		return `${greeting} I'm not seeing order ${fallbackOrderReference} just yet. Could you double-check the order number for me?`;
	}

	const matchedOrder = lookup.orders?.[0] || {};
	const confirmedReference = normalizeString(matchedOrder.invoiceNumber)
		? matchedOrder.invoiceNumber.startsWith("#")
			? matchedOrder.invoiceNumber
			: `#${matchedOrder.invoiceNumber}`
		: fallbackOrderReference;

	return `${greeting} I found order ${confirmedReference} for you. What can I help you with on it today?`;
}

async function buildProductIntentClarifierReply(caseDoc = {}, agentName = "") {
	const firstName = getFirstName(getCustomerName(caseDoc));
	const { inquiryDetails } = getCaseInquiryContext(caseDoc);
	const latestText = getLatestCustomerText(caseDoc);
	const productText = latestText || inquiryDetails;
	const greetingBase = firstName
		? `Hi ${firstName}, it's ${agentName}.`
		: `Hi, it's ${agentName}.`;
	const greeting = isHowAreYouMessage(latestText)
		? `${greetingBase} I'm doing well, thanks for asking. Hope you're having a good day too.`
		: `${greetingBase} Hope you're having a good day.`;

	if (!productText || productText.length < 3) {
		return `${greeting} I'd be happy to help with a product. Which item are you asking about?`;
	}

	if (looksLikeSpecificProductReference(productText)) {
		return `${greeting} Just to make sure I'm looking at the right item, are you asking about ${productText}? If so, what can I help you with?`;
	}

	const lookup = await toolFindProducts({
		query: productText,
		limit: 3,
	});

	if (!lookup?.found) {
		return `${greeting} I'd be happy to help with that product. Could you send the full product name, or tell me what you'd like help with?`;
	}

	const [firstMatch, secondMatch] = lookup.products || [];
	const displayName =
		firstMatch && shouldTrustClarifierMatch(productText, firstMatch.name)
			? firstMatch.name
			: productText;

	if (firstMatch && !secondMatch) {
		return `${greeting} Just to make sure I'm looking at the right item, are you asking about ${displayName}? If so, what can I help you with?`;
	}

	if (firstMatch) {
		return `${greeting} I want to make sure I'm looking at the right product. Are you asking about ${displayName}, or something else?`;
	}

	return `${greeting} What can I help you with on that product today?`;
}

function buildGeneralIntentClarifierReply(caseDoc = {}, agentName = "") {
	const firstName = getFirstName(getCustomerName(caseDoc));
	const latestText = getLatestCustomerText(caseDoc);
	const greetingBase = firstName
		? `Hi ${firstName}, it's ${agentName}.`
		: `Hi, it's ${agentName}.`;

	if (isHowAreYouMessage(latestText)) {
		return `${greetingBase} I'm doing well, thanks for asking. Hope you're having a good day too. How can I help today?`;
	}

	return `${greetingBase} Hope you're having a good day. How can I help today?`;
}

async function buildIntentClarifierReply(caseDoc = {}, agentName = "") {
	const { inquiryAbout } = getCaseInquiryContext(caseDoc);

	if (inquiryAbout === "order") {
		return buildOrderIntentClarifierReplyV2(caseDoc, agentName);
	}

	if (inquiryAbout === "product") {
		return buildProductIntentClarifierReply(caseDoc, agentName);
	}

	return buildGeneralIntentClarifierReply(caseDoc, agentName);
}

function pickAgentName(caseDoc) {
	const existing = normalizeLower(caseDoc?.supporterName);
	if (agentNames.includes(existing)) {
		return toDisplayAgentName(existing);
	}

	const seed = `${caseDoc?._id || ""}:${caseDoc?.createdAt || ""}`;
	return toDisplayAgentName(agentNames[stableHash(seed) % agentNames.length]);
}

function isSupportEmail(email = "") {
	const normalized = normalizeLower(email);
	return normalized === SUPPORT_EMAIL || normalized === ADMIN_EMAIL;
}

function classifyConversationMessage(message = {}) {
	const explicitSenderType = normalizeLower(message?.senderType);
	if (["client", "staff", "ai"].includes(explicitSenderType)) {
		return explicitSenderType;
	}

	const email = normalizeLower(message?.messageBy?.customerEmail);
	if (normalizeString(message?.messageBy?.userId)) return "staff";
	if (isSupportEmail(email)) {
		const senderName = normalizeLower(message?.messageBy?.customerName);
		if (
			agentNames.includes(senderName) ||
			senderName === "platform support" ||
			senderName === "support team"
		) {
			return "ai";
		}
	}
	return "client";
}

function getConversationArray(caseDoc = {}) {
	return Array.isArray(caseDoc?.conversation) ? caseDoc.conversation : [];
}

function getLatestClientTurn(caseDoc) {
	const conversation = getConversationArray(caseDoc);
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		if (classifyConversationMessage(conversation[index]) === "client") {
			return {
				index,
				message: conversation[index],
			};
		}
	}
	return null;
}

function getLatestSupportTurn(caseDoc = {}) {
	const conversation = getConversationArray(caseDoc);
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const senderType = classifyConversationMessage(conversation[index]);
		if (senderType === "staff" || senderType === "ai") {
			return {
				index,
				message: conversation[index],
			};
		}
	}
	return null;
}

function hasClientReplyAfter(caseDoc, messageIndex) {
	const conversation = getConversationArray(caseDoc);
	for (let index = messageIndex + 1; index < conversation.length; index += 1) {
		if (classifyConversationMessage(conversation[index]) === "client") {
			return true;
		}
	}
	return false;
}

function hasSupportReplyAfter(caseDoc, messageIndex) {
	const conversation = getConversationArray(caseDoc);
	for (let index = messageIndex + 1; index < conversation.length; index += 1) {
		const senderType = classifyConversationMessage(conversation[index]);
		if (senderType === "staff" || senderType === "ai") {
			return true;
		}
	}
	return false;
}

function getLatestPendingClientTurn(caseDoc = {}) {
	const conversation = getConversationArray(caseDoc);
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		if (classifyConversationMessage(conversation[index]) !== "client") {
			continue;
		}

		if (!hasSupportReplyAfter(caseDoc, index)) {
			return {
				index,
				message: conversation[index],
			};
		}
	}

	return null;
}

function isLightweightCustomerNudge(value = "") {
	const normalized = normalizeLower(value).replace(/\s+/g, " ").trim();
	if (!normalized) return true;

	const agentNamePattern = agentNames.map(escapeRegex).join("|");
	if (agentNamePattern) {
		const agentOnlyPattern = new RegExp(`^(${agentNamePattern})[!?. ]*$`, "i");
		if (agentOnlyPattern.test(normalized)) {
			return true;
		}
	}

	if (
		/^(hi|hello|hey|hello there|hi there|you there|are you there|still there|anyone there|ping|test)[!?. ]*$/i.test(
			normalized,
		)
	) {
		return true;
	}

	if (hasExplicitHelpIntent(normalized)) {
		return false;
	}

	return normalized.split(/\s+/).length <= 2;
}

function getLatestPendingClientWindow(caseDoc = {}) {
	const conversation = getConversationArray(caseDoc);
	let lastSupportIndex = -1;

	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const senderType = classifyConversationMessage(conversation[index]);
		if (senderType === "staff" || senderType === "ai") {
			lastSupportIndex = index;
			break;
		}
	}

	const pendingTurns = [];
	for (
		let index = lastSupportIndex + 1;
		index < conversation.length;
		index += 1
	) {
		if (classifyConversationMessage(conversation[index]) !== "client") {
			continue;
		}

		pendingTurns.push({
			index,
			message: conversation[index],
		});
	}

	return pendingTurns;
}

function getLatestRelevantPendingClientTurn(caseDoc = {}) {
	const pendingTurns = getLatestPendingClientWindow(caseDoc);
	if (!pendingTurns.length) return null;

	for (let index = pendingTurns.length - 1; index >= 0; index -= 1) {
		if (
			!isLightweightCustomerNudge(pendingTurns[index]?.message?.message || "")
		) {
			return pendingTurns[index];
		}
	}

	return pendingTurns[pendingTurns.length - 1] || null;
}

function getLatestClientTurnBeforeIndex(caseDoc = {}, beforeIndex = Infinity) {
	const conversation = getConversationArray(caseDoc);
	for (
		let index = Math.min(beforeIndex, conversation.length) - 1;
		index >= 0;
		index -= 1
	) {
		if (classifyConversationMessage(conversation[index]) !== "client") {
			continue;
		}

		return {
			index,
			message: conversation[index],
		};
	}

	return null;
}

function isOpenHelpPrompt(message = "") {
	const normalized = normalizeLower(message).replace(/\s+/g, " ").trim();
	if (!normalized) return false;

	return [
		/\bwhat can i help (?:you )?with(?: today)?\b/i,
		/\bhow can i help(?: today)?\b/i,
		/\bwhat would you like to know\b/i,
		/\bwhat would you like me to check\b/i,
		/\bwhat can i check for you\b/i,
		/\bi'?m here(?: with you)?\b/i,
	].some((pattern) => pattern.test(normalized));
}

function getMessageTimestampMs(message = {}) {
	const rawDate = message?.date;
	const parsed = rawDate ? new Date(rawDate).getTime() : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function shouldSkipRepeatedLightweightNudge(
	caseDoc = {},
	latestClientTurn = null,
	latestSupportTurn = null,
) {
	if (!latestClientTurn || !latestSupportTurn) return false;

	const latestClientText = latestClientTurn?.message?.message || "";
	if (!isLightweightCustomerNudge(latestClientText)) {
		return false;
	}

	if (!isOpenHelpPrompt(latestSupportTurn?.message?.message || "")) {
		return false;
	}

	const latestSupportSentAtMs = getMessageTimestampMs(
		latestSupportTurn?.message,
	);
	if (
		latestSupportSentAtMs &&
		Date.now() - latestSupportSentAtMs > LIGHTWEIGHT_REPEAT_NUDGE_WINDOW_MS
	) {
		return false;
	}

	const previousClientTurn = getLatestClientTurnBeforeIndex(
		caseDoc,
		latestSupportTurn.index,
	);
	if (!previousClientTurn) {
		return false;
	}

	return isLightweightCustomerNudge(previousClientTurn?.message?.message || "");
}

function hasHumanStaffMessages(caseDoc = {}) {
	return getConversationArray(caseDoc).some(
		(message) => classifyConversationMessage(message) === "staff",
	);
}

function isAiAllowed(flags = {}, caseDoc = {}) {
	return !getAiBlockReason(flags, caseDoc);
}

function extractOrderItems(order = {}) {
	const lines = [
		...(Array.isArray(order?.productsNoVariable)
			? order.productsNoVariable
			: []),
		...(Array.isArray(order?.chosenProductQtyWithVariables)
			? order.chosenProductQtyWithVariables
			: []),
	];

	return lines.slice(0, 12).map((line) => ({
		name:
			line?.name ||
			line?.productName ||
			line?.product ||
			line?.printifyProductDetails?.title ||
			"Unnamed product",
		quantity:
			line?.ordered_quantity ||
			line?.orderedQty ||
			line?.quantity ||
			line?.orderedQuantity ||
			1,
		price: line?.priceAfterDiscount ?? line?.price ?? line?.amount ?? null,
		storeId: line?.storeId || null,
		isPrintifyProduct: Boolean(
			line?.isPrintifyProduct || line?.printifyProductDetails?.POD,
		),
		chosenAttributes:
			line?.chosenAttributes || line?.chosenProductAttributes || null,
		customDesign: line?.customDesign
			? {
					customText: line.customDesign?.customText || "",
					finalScreenshotUrl: line.customDesign?.finalScreenshotUrl || "",
				}
			: null,
	}));
}

async function fetchPrintifySnapshot(order = {}) {
	const printifyOrderId =
		order?.printifyOrderDetails?.[0]?.ephemeralOrder?.id || null;
	const token = process.env.DESIGN_PRINTIFY_TOKEN;

	if (!printifyOrderId || !token) return null;

	try {
		const { data: shops = [] } = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{
				headers: { Authorization: `Bearer ${token}` },
				timeout: 10000,
			},
		);

		for (const shop of shops) {
			try {
				const { data } = await axios.get(
					`https://api.printify.com/v1/shops/${shop.id}/orders/${printifyOrderId}.json`,
					{
						headers: { Authorization: `Bearer ${token}` },
						timeout: 10000,
					},
				);

				if (data?.id) {
					return {
						id: data.id,
						status: data.status || "",
						printProviderStatus: data.print_provider_status || "",
						trackingUrl: data.printify_connect?.url || "",
						shippingCarrier: data.shipping_carrier || "",
					};
				}
			} catch (error) {
				continue;
			}
		}
	} catch (error) {
		console.error(
			"[support-orchestrator] Printify lookup failed:",
			error.message,
		);
	}

	return null;
}

function buildProductUrl(product = {}) {
	const slug = normalizeString(product?.slug);
	const categorySlug = normalizeString(product?.category?.categorySlug);
	const id = normalizeString(product?._id);

	if (!slug || !categorySlug || !id) return "";

	const baseUrl =
		normalizeString(process.env.CLIENT_URL) || "https://serenejannat.com";
	return `${baseUrl}/single-product/${slug}/${categorySlug}/${id}`;
}

function uniqueList(values = []) {
	const seen = new Set();
	const result = [];

	values.forEach((value) => {
		const normalized = normalizeString(value);
		const key = normalized.toLowerCase();
		if (!normalized || seen.has(key)) return;
		seen.add(key);
		result.push(normalized);
	});

	return result;
}

function isHexColor(value = "") {
	return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalizeString(value));
}

const PRODUCT_QUERY_STOPWORDS = new Set([
	"a",
	"about",
	"actually",
	"an",
	"and",
	"any",
	"are",
	"around",
	"can",
	"could",
	"deal",
	"do",
	"else",
	"for",
	"gift",
	"guys",
	"have",
	"how",
	"i",
	"im",
	"is",
	"it",
	"just",
	"kind",
	"like",
	"looking",
	"lot",
	"me",
	"my",
	"next",
	"of",
	"on",
	"or",
	"please",
	"pod",
	"print",
	"printing",
	"product",
	"products",
	"really",
	"so",
	"some",
	"special",
	"specially",
	"that",
	"the",
	"them",
	"there",
	"thing",
	"this",
	"to",
	"type",
	"want",
	"what",
	"with",
	"would",
	"year",
	"you",
	"your",
]);

function normalizeSearchToken(value = "") {
	let token = normalizeLower(value).replace(/[^a-z0-9]+/g, "");
	if (!token) return "";

	if (token.endsWith("ies") && token.length > 4) {
		token = `${token.slice(0, -3)}y`;
	} else if (
		token.endsWith("es") &&
		token.length > 4 &&
		/(sh|ch|x|z|ss)$/.test(token.slice(0, -2))
	) {
		token = token.slice(0, -2);
	} else if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) {
		token = token.slice(0, -1);
	}

	return token;
}

function extractSearchTokens(value = "") {
	return uniqueList(
		normalizeString(value)
			.split(/[^a-z0-9']+/i)
			.map((token) => normalizeSearchToken(token))
			.filter(
				(token) => token.length >= 2 && !PRODUCT_QUERY_STOPWORDS.has(token),
			),
	);
}

function extractProductOccasions(product = {}) {
	const attributes = Array.isArray(product?.productAttributes)
		? product.productAttributes
		: [];

	return uniqueList(
		attributes.flatMap((attribute) => {
			const defaultDesigns = Array.isArray(attribute?.defaultDesigns)
				? attribute.defaultDesigns
				: [];

			return defaultDesigns.map(
				(entry) => entry?.occassion || entry?.occasion || "",
			);
		}),
	);
}

function extractDefaultDesignImageUrls(entry = {}) {
	const images = Array.isArray(entry?.defaultDesignImages)
		? entry.defaultDesignImages
		: [];

	return uniqueList(
		images.map(
			(image) =>
				image?.cloudinary_url ||
				image?.cloudinaryUrl ||
				image?.url ||
				image?.src ||
				"",
		),
	);
}

function extractProductOccasionDesigns(product = {}) {
	const attributes = Array.isArray(product?.productAttributes)
		? product.productAttributes
		: [];
	const byOccasion = new Map();

	attributes.forEach((attribute) => {
		const defaultDesigns = Array.isArray(attribute?.defaultDesigns)
			? attribute.defaultDesigns
			: [];

		defaultDesigns.forEach((entry) => {
			const occasion = normalizeString(entry?.occassion || entry?.occasion);
			if (!occasion) return;

			const previewImageUrls = extractDefaultDesignImageUrls(entry);
			const summary = {
				occasion,
				imageCount: previewImageUrls.length,
				previewImageUrls: previewImageUrls.slice(0, 3),
			};
			const key = normalizeLower(occasion);
			const existing = byOccasion.get(key);

			if (
				!existing ||
				summary.imageCount > existing.imageCount ||
				summary.previewImageUrls.length > existing.previewImageUrls.length
			) {
				byOccasion.set(key, summary);
			}
		});
	});

	return Array.from(byOccasion.values()).sort((left, right) =>
		left.occasion.localeCompare(right.occasion),
	);
}

function productSupportsCustomGiftDesigns(product = {}) {
	return Boolean(
		product?.isPrintifyProduct ||
		product?.printifyProductDetails?.POD ||
		extractProductOccasions(product).length,
	);
}

function buildCustomGiftCollectionUrl(occasion = "") {
	const baseUrl =
		normalizeString(process.env.CLIENT_URL) || "https://serenejannat.com";
	const normalizedOccasion = normalizeString(occasion);
	if (!normalizedOccasion) {
		return `${baseUrl}/custom-gifts`;
	}

	return `${baseUrl}/custom-gifts?occasion=${encodeURIComponent(
		normalizedOccasion,
	)}`;
}

function buildCustomGiftProductUrl(product = {}, occasion = "") {
	const id = normalizeString(product?._id);
	if (!id) return "";

	const baseUrl =
		normalizeString(process.env.CLIENT_URL) || "https://serenejannat.com";
	const slug = normalizeString(product?.slug);
	const path = slug ? `/custom-gifts/${slug}/${id}` : `/custom-gifts/${id}`;
	const normalizedOccasion = normalizeString(occasion);

	if (!normalizedOccasion) {
		return `${baseUrl}${path}`;
	}

	return `${baseUrl}${path}?occasion=${encodeURIComponent(normalizedOccasion)}`;
}

function extractProductColors(product = {}) {
	const printifyColorOption = Array.isArray(
		product?.printifyProductDetails?.options,
	)
		? product.printifyProductDetails.options.find(
				(option) => normalizeLower(option?.type) === "color",
			)
		: null;

	const printifyColors = Array.isArray(printifyColorOption?.values)
		? printifyColorOption.values.map((value) => value?.title)
		: [];

	const attributeColors = Array.isArray(product?.productAttributes)
		? product.productAttributes.map((attribute) => attribute?.color)
		: [];

	const directColors = [product?.color];
	const mergedColors = uniqueList([
		...printifyColors,
		...attributeColors,
		...directColors,
	]);
	const namedColors = mergedColors.filter((value) => !isHexColor(value));

	return namedColors.length ? namedColors : mergedColors;
}

function extractProductSizes(product = {}) {
	const printifySizeOption = Array.isArray(
		product?.printifyProductDetails?.options,
	)
		? product.printifyProductDetails.options.find(
				(option) => normalizeLower(option?.type) === "size",
			)
		: null;

	const printifySizes = Array.isArray(printifySizeOption?.values)
		? printifySizeOption.values.map((value) => value?.title)
		: [];

	const attributeSizes = Array.isArray(product?.productAttributes)
		? product.productAttributes.map((attribute) => attribute?.size)
		: [];

	const directSizes = [product?.size];

	return uniqueList([...printifySizes, ...attributeSizes, ...directSizes]);
}

function summarizeVariantAvailability(product = {}) {
	const variants = Array.isArray(product?.printifyProductDetails?.variants)
		? product.printifyProductDetails.variants
		: [];

	if (!variants.length) return [];

	return variants
		.filter((variant) => variant?.is_enabled !== false)
		.slice(0, 12)
		.map((variant) => ({
			title: normalizeString(variant?.title),
			sku: normalizeString(variant?.sku),
			available:
				variant?.is_available !== false && variant?.is_enabled !== false,
			price: typeof variant?.price === "number" ? variant.price / 100 : null,
		}))
		.filter((variant) => variant.title);
}

function buildSearchableProductText(product = {}) {
	return normalizeLower(
		[
			product?.productName,
			product?.description,
			product?.productSKU,
			product?.slug,
			product?.brandName,
			product?.category?.categoryName,
			...(product?.printifyProductDetails?.title
				? [product.printifyProductDetails.title]
				: []),
			...extractProductOccasions(product),
			...extractProductColors(product),
			...extractProductSizes(product),
			...summarizeVariantAvailability(product).map((variant) => variant.title),
		]
			.filter(Boolean)
			.join(" "),
	);
}

function scoreProductCandidate(product = {}, rawQuery = "", tokens = []) {
	const lowerQuery = normalizeLower(rawQuery);
	const name = normalizeLower(product?.productName);
	const searchableText = buildSearchableProductText(product);
	const supportedOccasions = extractProductOccasions(product);
	let score = 0;

	if (lowerQuery && name.includes(lowerQuery)) {
		score += 40;
	}

	if (lowerQuery && searchableText.includes(lowerQuery)) {
		score += 12;
	}

	tokens.forEach((token) => {
		if (name.includes(token)) {
			score += 10;
			return;
		}

		if (searchableText.includes(token)) {
			score += 4;
		}
	});

	if (productSupportsCustomGiftDesigns(product)) {
		score += 4;
	}

	if (supportedOccasions.length) {
		score += Math.min(6, supportedOccasions.length > 0 ? 2 : 0);
	}

	if (Boolean(product?.activeProduct)) {
		score += 2;
	}

	if (product?.activeProductBySeller !== false) {
		score += 2;
	}

	return score;
}

function summarizeProductForSupport(product = {}, options = {}) {
	const hasVariants = Boolean(product?.addVariables);
	const variantQuantity = Array.isArray(product?.productAttributes)
		? product.productAttributes.reduce(
				(total, attribute) => total + (attribute?.quantity || 0),
				0,
			)
		: 0;
	const requestedOccasion = normalizeString(options?.occasion);
	const supportedOccasions = extractProductOccasions(product);
	const occasionDesigns = extractProductOccasionDesigns(product).map(
		(design) => ({
			occasion: design.occasion,
			imageCount: design.imageCount,
			previewImageUrls: design.previewImageUrls,
			collectionUrl: buildCustomGiftCollectionUrl(design.occasion),
			productUrl: buildCustomGiftProductUrl(product, design.occasion),
		}),
	);
	const matchingOccasionDesigns = requestedOccasion
		? occasionDesigns.filter(
				(design) =>
					normalizeLower(design.occasion) === normalizeLower(requestedOccasion),
			)
		: [];
	const supportsCustomGiftDesigns = productSupportsCustomGiftDesigns(product);

	return {
		id: String(product._id),
		name: product.productName || "",
		sku: product.productSKU || "",
		price: product.price ?? null,
		priceAfterDiscount: product.priceAfterDiscount ?? null,
		hasVariants,
		quantity: hasVariants ? variantQuantity : (product.quantity ?? null),
		availableColors: extractProductColors(product),
		availableSizes: extractProductSizes(product),
		variantAvailability: summarizeVariantAvailability(product),
		supportedOccasions,
		occasionDesigns,
		requestedOccasion: requestedOccasion || "",
		requestedOccasionSupported: requestedOccasion
			? matchingOccasionDesigns.length > 0
			: null,
		matchingOccasionDesigns,
		supportsCustomGiftDesigns,
		customGiftCollectionUrl: supportsCustomGiftDesigns
			? buildCustomGiftCollectionUrl()
			: "",
		customGiftUrl: supportsCustomGiftDesigns
			? buildCustomGiftProductUrl(product)
			: "",
		requestedOccasionUrl:
			supportsCustomGiftDesigns &&
			requestedOccasion &&
			matchingOccasionDesigns.length
				? buildCustomGiftProductUrl(product, requestedOccasion)
				: "",
		activeProduct: Boolean(product.activeProduct),
		activeProductBySeller: product.activeProductBySeller !== false,
		isPrintifyProduct: Boolean(
			product.isPrintifyProduct || product?.printifyProductDetails?.POD,
		),
		productUrl: buildProductUrl(product),
		policy: product.policy || "",
	};
}

async function searchProductsCatalog({
	query = "",
	sku = "",
	limit = 5,
	customGiftOnly = false,
	occasion = "",
} = {}) {
	const normalizedQuery = normalizeString(query);
	const normalizedOccasion = normalizeString(occasion);
	const tokens = extractSearchTokens(normalizedQuery);
	const cappedLimit = Math.min(
		10,
		Math.max(1, Number.parseInt(limit, 10) || 5),
	);
	const orFilters = [];
	const andFilters = [];

	if (normalizedQuery) {
		const directRegex = new RegExp(escapeRegex(normalizedQuery), "i");
		orFilters.push({ productName: { $regex: directRegex } });
		orFilters.push({ description: { $regex: directRegex } });
		orFilters.push({ slug: { $regex: directRegex } });
		orFilters.push({ "printifyProductDetails.title": { $regex: directRegex } });
		orFilters.push({
			"productAttributes.defaultDesigns.occassion": { $regex: directRegex },
		});
		orFilters.push({
			"productAttributes.defaultDesigns.occasion": { $regex: directRegex },
		});
	}

	if (sku) {
		orFilters.push({
			productSKU: { $regex: new RegExp(escapeRegex(sku), "i") },
		});
	}

	tokens.forEach((token) => {
		const regex = new RegExp(escapeRegex(token), "i");
		orFilters.push({ productName: { $regex: regex } });
		orFilters.push({ description: { $regex: regex } });
		orFilters.push({ productSKU: { $regex: regex } });
		orFilters.push({ slug: { $regex: regex } });
		orFilters.push({ "printifyProductDetails.title": { $regex: regex } });
		orFilters.push({
			"productAttributes.defaultDesigns.occassion": { $regex: regex },
		});
		orFilters.push({
			"productAttributes.defaultDesigns.occasion": { $regex: regex },
		});
	});

	if (orFilters.length) {
		andFilters.push({ $or: orFilters });
	}

	if (normalizedOccasion) {
		const occasionRegex = new RegExp(escapeRegex(normalizedOccasion), "i");
		andFilters.push({
			$or: [
				{
					"productAttributes.defaultDesigns.occassion": {
						$regex: occasionRegex,
					},
				},
				{
					"productAttributes.defaultDesigns.occasion": {
						$regex: occasionRegex,
					},
				},
			],
		});
	}

	if (customGiftOnly) {
		andFilters.push({
			$or: [
				{ isPrintifyProduct: true },
				{ "printifyProductDetails.POD": true },
				{ "productAttributes.defaultDesigns.0": { $exists: true } },
			],
		});
	}

	const mongoQuery = andFilters.length ? { $and: andFilters } : {};
	const candidateLimit = Math.max(cappedLimit * 6, 20);
	const products = await Product.find(mongoQuery)
		.populate("category", "categorySlug categoryName")
		.limit(candidateLimit)
		.lean();

	const scoredProducts = products
		.map((product) => ({
			product,
			score: scoreProductCandidate(product, normalizedQuery || sku, tokens),
		}))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score)
		.slice(0, cappedLimit)
		.map(({ product }) => product);

	return {
		query: normalizedQuery,
		tokens,
		products: scoredProducts,
	};
}

async function listSupportedCustomGiftOccasions() {
	const products = await Product.find({
		$or: [
			{ isPrintifyProduct: true },
			{ "printifyProductDetails.POD": true },
			{ "productAttributes.defaultDesigns.0": { $exists: true } },
		],
	})
		.select("productAttributes.defaultDesigns")
		.lean();

	return uniqueList(
		products.flatMap((product) => extractProductOccasions(product)),
	);
}

async function listSupportedCustomGiftOccasionSummaries() {
	const products = await Product.find({
		$or: [
			{ isPrintifyProduct: true },
			{ "printifyProductDetails.POD": true },
			{ "productAttributes.defaultDesigns.0": { $exists: true } },
		],
	})
		.select("productName slug productAttributes.defaultDesigns")
		.lean();

	const byOccasion = new Map();

	products.forEach((product) => {
		const productName = normalizeString(product?.productName);
		if (!productName) return;

		extractProductOccasionDesigns(product).forEach((design) => {
			const key = normalizeLower(design.occasion);
			const existing = byOccasion.get(key) || {
				occasion: design.occasion,
				productCount: 0,
				sampleProducts: [],
				collectionUrl: buildCustomGiftCollectionUrl(design.occasion),
			};

			existing.productCount += 1;
			if (
				existing.sampleProducts.length < 4 &&
				!existing.sampleProducts.some(
					(sample) =>
						normalizeLower(sample.name) === normalizeLower(productName),
				)
			) {
				existing.sampleProducts.push({
					name: productName,
					productUrl: buildCustomGiftProductUrl(product, design.occasion),
				});
			}

			byOccasion.set(key, existing);
		});
	});

	return Array.from(byOccasion.values()).sort((left, right) =>
		left.occasion.localeCompare(right.occasion),
	);
}

async function toolFindOrders(args = {}) {
	const invoiceNumber = normalizeString(args?.invoiceNumber);
	const trackingNumber = normalizeString(args?.trackingNumber);
	const customerEmail = normalizeString(args?.customerEmail);
	const customerPhone = normalizeString(args?.customerPhone);
	const paypalOrderId = normalizeString(args?.paypalOrderId);
	const limit = Math.min(5, Math.max(1, Number.parseInt(args?.limit, 10) || 3));

	const filters = [];
	if (invoiceNumber) filters.push({ invoiceNumber });
	if (trackingNumber) filters.push({ trackingNumber });
	if (paypalOrderId) filters.push({ paypalOrderId });
	if (customerEmail) {
		filters.push({
			"customerDetails.email": {
				$regex: new RegExp(`^${escapeRegex(customerEmail)}$`, "i"),
			},
		});
	}
	if (customerPhone) {
		filters.push({
			"customerDetails.phone": {
				$regex: new RegExp(escapeRegex(customerPhone), "i"),
			},
		});
	}

	if (!filters.length) {
		return {
			found: false,
			orders: [],
			message: "No searchable order identifiers were provided.",
		};
	}

	const orders = await Order.find({ $or: filters })
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean();

	const summarized = await Promise.all(
		orders.map(async (order) => {
			const printifySnapshot = await fetchPrintifySnapshot(order);

			return {
				id: String(order._id),
				invoiceNumber: order.invoiceNumber || "",
				status: order.status || "",
				paymentStatus: order.paymentStatus || "",
				trackingNumber: order.trackingNumber || "",
				trackingUrl: printifySnapshot?.trackingUrl || "",
				paymentProvider: order.paymentProvider || "",
				orderCreationDate: order.orderCreationDate || order.createdAt || null,
				shipDate: order.shipDate || null,
				returnStatus: order.returnStatus || "",
				refundMethod: order.refundMethod || "",
				returnAmount: order.returnAmount ?? null,
				totalAmount: order.totalAmount ?? null,
				totalAmountAfterDiscount: order.totalAmountAfterDiscount ?? null,
				chosenShippingOption: order.chosenShippingOption || {},
				customerDetails: {
					name: order?.customerDetails?.name || "",
					email: order?.customerDetails?.email || "",
					phone: order?.customerDetails?.phone || "",
					city: order?.customerDetails?.city || "",
					state: order?.customerDetails?.state || "",
				},
				printify: printifySnapshot,
				items: extractOrderItems(order),
			};
		}),
	);

	return {
		found: summarized.length > 0,
		orders: summarized,
	};
}

async function toolFindProducts(args = {}) {
	const query = normalizeString(args?.query);
	const sku = normalizeString(args?.sku);
	const occasion = normalizeString(args?.occasion);
	const customGiftOnly = args?.customGiftOnly === true;
	const limit = Math.min(
		10,
		Math.max(1, Number.parseInt(args?.limit, 10) || 5),
	);

	if (!query && !sku && !occasion) {
		return {
			found: false,
			products: [],
			message: "No searchable product details were provided.",
		};
	}

	const result = await searchProductsCatalog({
		query,
		sku,
		limit,
		customGiftOnly,
		occasion,
	});
	const products = result.products || [];

	return {
		found: products.length > 0,
		requestedOccasion: occasion,
		searchTokens: result.tokens,
		products: products.map((product) =>
			summarizeProductForSupport(product, { occasion }),
		),
	};
}

async function toolGetCustomGiftContext(args = {}) {
	const occasion = normalizeString(args?.occasion);
	const productQuery = normalizeString(args?.productQuery || args?.query);
	const limit = Math.min(
		10,
		Math.max(1, Number.parseInt(args?.limit, 10) || 5),
	);
	const searchQuery = productQuery || occasion;
	const [occasionSummaries, matchingProducts] = await Promise.all([
		listSupportedCustomGiftOccasionSummaries(),
		searchQuery
			? searchProductsCatalog({
					query: searchQuery,
					limit,
					customGiftOnly: true,
					occasion,
				})
			: Promise.resolve({ products: [] }),
	]);
	const supportedOccasions = occasionSummaries.map((entry) => entry.occasion);
	const requestedOccasionSummary = occasion
		? occasionSummaries.find(
				(entry) => normalizeLower(entry.occasion) === normalizeLower(occasion),
			) || null
		: null;

	return {
		found: Boolean(
			supportedOccasions.length || matchingProducts.products?.length,
		),
		requestedOccasion: occasion,
		requestedOccasionSupported: occasion
			? Boolean(requestedOccasionSummary)
			: null,
		supportedOccasions,
		supportedOccasionCount: supportedOccasions.length,
		occasionSummaries,
		collectionUrl: buildCustomGiftCollectionUrl(),
		occasionUrl: occasion ? buildCustomGiftCollectionUrl(occasion) : "",
		matchingProducts: (matchingProducts.products || []).map((product) =>
			summarizeProductForSupport(product, { occasion }),
		),
	};
}

async function toolGetShippingOptions(args = {}) {
	const storeId = normalizeString(args?.storeId);
	const query = { carrierStatus: true };
	if (storeId) {
		query.store = storeId;
	}

	const shippingOptions = await ShippingOptions.find(query)
		.select(
			"carrierName shippingPrice shippingPrice_Unit estimatedDays daysShippingClosed cutoffTimes store",
		)
		.limit(12)
		.lean();

	return {
		found: shippingOptions.length > 0,
		shippingOptions,
	};
}

async function toolGetPolicies() {
	const websiteSetup = await WebsiteBasicSetup.findOne({}).lean();
	return {
		found: Boolean(websiteSetup),
		contactUsPage: websiteSetup?.contactUsPage || {},
		returnsAndRefund: websiteSetup?.returnsAndRefund || "",
		termsAndCondition: websiteSetup?.termsAndCondition || "",
		aiAgentToRespond: Boolean(websiteSetup?.aiAgentToRespond),
		deactivateChatResponse: Boolean(websiteSetup?.deactivateChatResponse),
	};
}

async function toolGetStoreContext(args = {}) {
	const storeId = normalizeString(args?.storeId);
	if (!storeId) {
		return {
			found: false,
			message: "No store id was provided.",
		};
	}

	const store = await StoreManagement.findById(storeId)
		.select(
			"addStoreName storePhone storeAddress activatePayOnDelivery activatePickupInStore activatePayOnline freeShippingLimit activeStoreByAdmin activeStoreBySeller",
		)
		.lean();

	return {
		found: Boolean(store),
		store: store || null,
	};
}

const toolDefinitions = [
	{
		type: "function",
		function: {
			name: "find_orders",
			description:
				"Find one or more orders using invoice number, tracking number, customer email, phone, or PayPal order id.",
			parameters: {
				type: "object",
				properties: {
					invoiceNumber: { type: "string" },
					trackingNumber: { type: "string" },
					customerEmail: { type: "string" },
					customerPhone: { type: "string" },
					paypalOrderId: { type: "string" },
					limit: { type: "integer" },
				},
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "find_products",
			description:
				"Find products by natural-language product query or SKU so you can answer pricing, stock, colors, sizes, custom-gift, and policy questions.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string" },
					sku: { type: "string" },
					occasion: { type: "string" },
					customGiftOnly: { type: "boolean" },
					limit: { type: "integer" },
				},
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_custom_gift_context",
			description:
				"Get dynamic custom-gift context from POD products, including supported default-design occasions and matching customizable products like mugs, tote bags, or shirts.",
			parameters: {
				type: "object",
				properties: {
					occasion: { type: "string" },
					productQuery: { type: "string" },
					query: { type: "string" },
					limit: { type: "integer" },
				},
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_shipping_options",
			description:
				"Get shipping options and estimated timing. Use a store id if the conversation is store-specific.",
			parameters: {
				type: "object",
				properties: {
					storeId: { type: "string" },
				},
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_policies",
			description:
				"Get website-level customer-facing policies such as returns and refunds and contact information.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_store_context",
			description:
				"Get store details and checkout capabilities for a specific store connected to the case.",
			parameters: {
				type: "object",
				properties: {
					storeId: { type: "string" },
				},
				required: ["storeId"],
				additionalProperties: false,
			},
		},
	},
];

async function executeToolCall(toolName, rawArgs = {}) {
	switch (toolName) {
		case "find_orders":
			return toolFindOrders(rawArgs);
		case "find_products":
			return toolFindProducts(rawArgs);
		case "get_custom_gift_context":
			return toolGetCustomGiftContext(rawArgs);
		case "get_shipping_options":
			return toolGetShippingOptions(rawArgs);
		case "get_policies":
			return toolGetPolicies();
		case "get_store_context":
			return toolGetStoreContext(rawArgs);
		default:
			return {
				error: `Unknown tool: ${toolName}`,
			};
	}
}

function buildTranscript(caseDoc = {}) {
	return getConversationArray(caseDoc).map((message, index) => {
		const senderType = classifyConversationMessage(message);
		const rawName = normalizeString(message?.messageBy?.customerName);

		return {
			index: index + 1,
			senderType,
			senderName:
				rawName ||
				(senderType === "client"
					? caseDoc?.displayName1 || "Customer"
					: caseDoc?.supporterName || caseDoc?.displayName2 || "Support"),
			timestamp: message?.date || null,
			message: message?.message || "",
			inquiryAbout: message?.inquiryAbout || "",
			inquiryDetails: message?.inquiryDetails || "",
		};
	});
}

function buildSystemPrompt() {
	return [
		`Use only these approved agent names when naming yourself: ${agentNames
			.map(toDisplayAgentName)
			.join(", ")}.`,
		"You are operating as Serene Jannat's customer support orchestrator.",
		"Review the entire transcript every time before replying.",
		"Sound like a highly capable ecommerce CSR in the United States: warm, direct, respectful, human, and not stiff.",
		"Write like live chat, not email and not a status report.",
		"Use plain text only. Do not use markdown, bold markers, bullet lists, headings, code fences, or tables.",
		"Keep replies concise but complete. Usually 1 to 3 short chat-sized paragraphs or 1 to 4 short sentences.",
		"For the first support reply in a thread, greet the customer by first name if known and make the opening feel friendly and personal.",
		"The first support reply is the beginning of a new issue. Sound like you are just entering the conversation, acknowledging their message naturally, and taking ownership of helping from the start.",
		"On the first support reply, it is good to briefly say you hope they are having a good day when it feels natural.",
		"If the customer has not actually said what they want yet, do not assume. Ask what they need help with first.",
		"If the customer only shares an order number, product name, or another identifier, acknowledge it and ask what they want help with instead of dumping data.",
		"If the customer makes small talk like hello or how are you, reply briefly and naturally first, then help.",
		"If the customer asks a simple product question like colors, sizes, price, stock, material, or shipping, answer that exact question directly from the tool data before offering extra help.",
		"If the customer asks only one thing, answer only that thing unless they ask for more.",
		"If the customer asks more than one direct thing in the same message, answer every part you can in the same reply instead of only answering the first part.",
		"If the customer asks a yes-or-no question plus a detail question, answer both parts together, for example availability plus colors or status plus price.",
		"If the customer asks a category availability question like 'do you carry candles,' answer yes or no and immediately add the next most helpful detail or offer in the same reply instead of stopping at a bare yes or no.",
		"If latestPendingCustomerWindow shows several back-to-back customer messages, combine them into one unresolved thought before you answer. Do not treat a quick nudge like 'Michael?' as the real question.",
		"Before sending, make sure every direct question in the latest customer message has been addressed if the data is available.",
		"If the customer says you did not answer fully, apologize briefly and then give the missing answer right away in that same reply if you can verify it.",
		"Do not assume short reactions like 'wow', 'lol', 'sure', or 'right' are positive. Read them in context because they may be sarcasm or frustration.",
		"If the customer is sarcastic, mocking, or hostile, stay calm and brief. Address the underlying complaint or request instead of taking the wording literally.",
		"Never psychoanalyze the customer and never tell them what they emotionally 'need.'",
		"If the customer asks a rhetorical complaint question like 'what do you think I need,' answer the underlying complaint in a grounded way instead of replying literally.",
		"If the customer says they do not need your help, do not ask another help-opening question. Acknowledge briefly and step back.",
		"Do not add extra size, price, shipping, stock, or policy details when the customer only asked about one attribute.",
		"The latest customer turn has priority over the earlier inquiry context.",
		"If the customer pivots to a different product, product type, occasion, or gift idea, switch context immediately and stop anchoring on the earlier item.",
		"If an earlier issue already seemed resolved and the customer later comes back with only a greeting, greet them and ask what they need help with today without dragging the chat back to the old order or product.",
		"If the customer tells you to stop steering back to the old topic, respect that immediately and do not keep anchoring on the original inquiry unless they explicitly return to it.",
		"Use custom-gift and POD tool data dynamically. Supported occasion designs should come from product defaultDesigns and related custom-gift tool data, not guesses.",
		"For custom-gift questions, be aware that products can have dynamic occasion-specific default designs such as Anniversary, Birthday, Wedding, and others. Use tool data to confirm what is supported.",
		"If tool data shows occasion-specific default designs for a product, answer that directly and briefly. Use the occasion-specific product or collection URL when it would help the customer browse designs faster.",
		"If human teammates have already replied in the transcript and you later resume the chat, continue naturally from their messages. Do not restart the conversation, do not contradict them, and stay aligned with facts or commitments already given.",
		"For order lookups, lead with the direct answer in a friendly way, then the next most useful detail. Do not dump every fact at once.",
		"If a raw link is useful, put it on its own line. Do not bury a raw URL in the middle of a sentence.",
		"If the answer is long, split it into 2 short chat messages using a line that contains exactly [[send]] between message parts.",
		"Do not split short, simple factual answers into 2 messages just to sound chatty.",
		"If you split into 2 messages, the second message must add distinct value and must not repeat the first answer in different words.",
		"If triggerType is idle_follow_up, the customer has not replied for roughly 45 to 60 seconds after your last support message.",
		"If triggerType is idle_follow_up, decide whether a short proactive nudge is useful. If yes, send exactly one short, friendly live-chat sentence.",
		"If triggerType is idle_follow_up, good patterns are brief check-ins like asking whether they are still there or whether there is anything else you can help with.",
		"If triggerType is idle_follow_up, do not restate product facts, do not repeat your previous answer, do not use tools, and do not ask more than one question.",
		"If triggerType is idle_follow_up and a follow-up is not needed, return exactly [[no_follow_up]].",
		"If the customer asks a short confirmation follow-up like 'same colors?' or 'with shipping and everything', answer directly in one sentence unless they asked for more detail.",
		"Only when the conversation truly feels wrapped up, you may add [[suggest_end_chat]] at the very end of your reply for the UI. Use it sparingly.",
		"Use [[suggest_end_chat]] only when the customer's main question appears answered, you are not waiting on more details, and nothing else is pending.",
		"Do not use [[suggest_end_chat]] in clarification replies, handoff replies, or when the customer still seems mid-issue.",
		"Do not mention ending the chat in your visible reply when using [[suggest_end_chat]]. The UI will handle that separately.",
		"Prefer contractions and natural phrasing. Avoid robotic phrases, menu-like questions, or overexplaining.",
		"Use the customer's preferred language when it is explicit. If language preference is not explicit, infer from the full conversation rather than only the latest message.",
		"If the customer suddenly mixes another language and there is no explicit preference yet, you may gently ask whether they would rather continue in that language.",
		"If the customer explicitly prefers another language, keep using it from then on.",
		"Be lightly playful only when it feels natural.",
		"Never expose internal notes, implementation details, tool names, raw database ids, or private reasoning.",
		"Do not guess order, refund, shipping, or product facts when you can look them up with tools.",
		"When product lookup returns available colors or sizes, name them clearly instead of saying the list is unavailable.",
		"When product lookup or custom-gift context shows supported occasions, mention the relevant occasion directly and briefly.",
		"If the customer asks what occasions exist, answer from the actual supported occasion list returned by the tools instead of assuming a fixed list.",
		"If the customer asks for a recommendation, do not force them to send a link or exact product name unless that is actually needed. Give a concise recommendation or ask one focused preference question.",
		"When asked what you think of a category like POD, give a clear opinion and then the most useful next recommendation instead of staying generic.",
		"If the customer has shown they prefer shorter replies, keep your next answers to one short sentence when possible.",
		"If the customer complained about long answers or extra detail, adapt immediately and keep later replies short without repeated explanations about being shorter.",
		"If you do not have enough information, ask one focused follow-up question instead of guessing.",
		"For returns or refunds, be accurate to the available policy and data. Do not promise actions that are not confirmed in the case data or policy.",
		"Do not volunteer that you are AI unless the customer directly asks.",
		"If the customer asks whether you are AI or human, be honest but reassuring. Keep it brief, lead with your support role, avoid cold wording like 'not a human CSR,' and offer a human handoff if they prefer.",
		"If they ask whether you are AI or human, good response patterns are like: 'I'm Sally with Serene Jannat support here in chat. I work alongside our team and can help right away. If you'd rather have a teammate step in, I can have them take over.'",
		"If the customer presses again on whether you are human, answer clearly that you are the virtual support assistant in chat and offer a human handoff instead of pretending to be human.",
		"If the customer explicitly asks for a human, a CSR, a representative, or a real person, treat that as a handoff request. Acknowledge it briefly and do not continue troubleshooting in the same reply.",
		"If you have already told the customer you are getting a human teammate, do not keep chatting as if you still own the conversation.",
		"Use the assigned agent name naturally in first-person if helpful, but do not overuse it.",
	].join("\n");
}

function buildUserPrompt({ caseDoc, flags, agentName, triggerType }) {
	const transcript = buildTranscript(caseDoc);
	const firstMessage = transcript[0] || {};
	const latestClientTurn = getLatestClientTurn(caseDoc);
	const latestPendingClientTurn = getLatestRelevantPendingClientTurn(caseDoc);
	const latestPendingClientWindow = getLatestPendingClientWindow(caseDoc);
	const latestSupportTurn = getLatestSupportTurn(caseDoc);
	const storeId = normalizeString(caseDoc?.storeId?._id || caseDoc?.storeId);
	const customerName = getCustomerName(caseDoc);
	const rootInquiryAbout = firstMessage?.inquiryAbout || "";
	const rootInquiryDetails = firstMessage?.inquiryDetails || "";
	const replyStylePreferences = getReplyStylePreferences(caseDoc);
	const silenceSinceLastSupportMessageMs = latestSupportTurn?.message?.date
		? Math.max(
				0,
				Date.now() - new Date(latestSupportTurn.message.date).getTime(),
			)
		: null;
	const task =
		triggerType === "idle_follow_up"
			? "The customer has not replied for roughly 45 to 60 seconds since your last support message. Decide whether one short proactive follow-up is appropriate. If yes, send exactly one short friendly sentence only. Keep it natural and light, like checking whether they are still there or whether there is anything else you can help with. Do not repeat product facts or restate your previous answer. If no follow-up is needed, return exactly [[no_follow_up]]."
			: "Decide the best next reply to the customer. Prioritize the latest unresolved customer turn over older product context. If a human teammate already replied earlier in the same chat, continue naturally from that conversation instead of restarting it. Call tools whenever product, custom-gift, order, shipping, policy, tracking, or store facts would improve the answer. Return only the customer-facing chat reply.";

	return JSON.stringify(
		{
			now: new Date().toISOString(),
			triggerType,
			assignedAgentName: agentName,
			case: {
				id: String(caseDoc?._id || ""),
				status: caseDoc?.caseStatus || "",
				openedBy: caseDoc?.openedBy || "",
				displayName1: caseDoc?.displayName1 || "",
				displayName2: caseDoc?.displayName2 || "",
				supporterName: caseDoc?.supporterName || "",
				storeId,
				globalAiEnabled: Boolean(
					flags?.aiAgentToRespond && !flags?.deactivateChatResponse,
				),
				caseAiEnabled: Boolean(caseDoc?.aiToRespond),
				isFirstSupportReply: isFirstSupportReply(caseDoc),
			},
			initialInquiry: {
				inquiryAbout: rootInquiryAbout,
				inquiryDetails: rootInquiryDetails,
			},
			customer: {
				name: customerName || "Customer",
				firstName: getFirstName(customerName),
				email: caseDoc?.conversation?.[0]?.messageBy?.customerEmail || "",
			},
			latestCustomerTurn: latestClientTurn
				? {
						message: latestClientTurn.message?.message || "",
						inquiryAbout:
							latestClientTurn.message?.inquiryAbout || rootInquiryAbout,
						inquiryDetails:
							latestClientTurn.message?.inquiryDetails || rootInquiryDetails,
					}
				: null,
			latestPendingCustomerTurn: latestPendingClientTurn
				? {
						message: latestPendingClientTurn.message?.message || "",
						inquiryAbout:
							latestPendingClientTurn.message?.inquiryAbout || rootInquiryAbout,
						inquiryDetails:
							latestPendingClientTurn.message?.inquiryDetails ||
							rootInquiryDetails,
					}
				: null,
			latestPendingCustomerWindow: latestPendingClientWindow.map((turn) => ({
				message: turn.message?.message || "",
				inquiryAbout: turn.message?.inquiryAbout || rootInquiryAbout,
				inquiryDetails: turn.message?.inquiryDetails || rootInquiryDetails,
			})),
			latestSupportTurn: latestSupportTurn
				? {
						message: latestSupportTurn.message?.message || "",
						senderType: classifyConversationMessage(latestSupportTurn.message),
						sentAt: latestSupportTurn.message?.date || null,
						silenceSinceLastSupportMessageMs,
					}
				: null,
			conversationPreferences: {
				prefersShortReplies: replyStylePreferences.prefersShortReplies,
				dislikesUnaskedExtras: replyStylePreferences.dislikesUnaskedExtras,
				wantsCompleteAnswers: replyStylePreferences.wantsCompleteAnswers,
				avoidOldTopicAnchoring: replyStylePreferences.avoidOldTopicAnchoring,
				wantsOneQuestionAtATime: replyStylePreferences.wantsOneQuestionAtATime,
			},
			contextSignals: {
				latestTurnLikelyChangesTopic: latestTurnLikelyChangesTopic(caseDoc),
				latestTurnIsBareGreetingAfterResolvedExchange:
					latestTurnIsBareGreetingAfterResolvedExchange(caseDoc),
				latestTurnSeemsHostileOrSarcastic:
					latestTurnSeemsHostileOrSarcastic(caseDoc),
				latestTurnExplicitlyDeclinesHelp: customerExplicitlyDeclinesHelp(
					getLatestCustomerText(caseDoc),
				),
				customerHasServiceComplaintHistory:
					customerHasServiceComplaintHistory(caseDoc),
				initialInquiryIsSeedContextOnly: true,
				customGiftCollectionUrl: buildCustomGiftCollectionUrl(),
				hasHumanStaffMessages: hasHumanStaffMessages(caseDoc),
			},
			replyStyle: {
				splitMarker: REPLY_SEGMENT_MARKER,
				preferTwoMessagesWhenLong:
					replyStylePreferences.preferTwoMessagesWhenLong,
				preferFriendlyFirstLine: true,
				orderReference: getLikelyOrderReference(caseDoc),
				clarifyIntentBeforeAnswering: shouldClarifyFirstReply(caseDoc),
			},
			transcript,
			task,
		},
		null,
		2,
	);
}

async function runOrchestrator({ caseDoc, flags, agentName, triggerType }) {
	if (!HAS_SUPPORT_AI_API_KEY) {
		throw new Error("CHATGPT_API_TOKEN is not configured");
	}

	const messages = [
		{ role: "system", content: buildSystemPrompt() },
		{
			role: "user",
			content: buildUserPrompt({ caseDoc, flags, agentName, triggerType }),
		},
	];

	logSupportAi("orchestrator-start", {
		caseId: normalizeString(caseDoc?._id),
		triggerType,
		agentName,
		model: DEFAULT_MODEL,
		messageCount: messages.length,
		caseState: summarizeCaseForLogs(caseDoc, flags),
	});

	for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
		logSupportAi("orchestrator-round-request", {
			caseId: normalizeString(caseDoc?._id),
			triggerType,
			round: round + 1,
			messageCount: messages.length,
		});

		const requestPayload = {
			model: DEFAULT_MODEL,
			temperature: 0.45,
			messages,
		};

		if (triggerType !== "idle_follow_up") {
			requestPayload.tools = toolDefinitions;
			requestPayload.tool_choice = "auto";
		}

		const completion = await openai.chat.completions.create(requestPayload);

		const choice = completion?.choices?.[0]?.message;
		logSupportAi("orchestrator-round-response", {
			caseId: normalizeString(caseDoc?._id),
			triggerType,
			round: round + 1,
			finishReason: completion?.choices?.[0]?.finish_reason || null,
			hasToolCalls: Boolean(choice?.tool_calls?.length),
			toolCallCount: Array.isArray(choice?.tool_calls)
				? choice.tool_calls.length
				: 0,
			contentPreview: previewText(choice?.content || ""),
			usage: completion?.usage || null,
		});

		if (!choice) {
			logSupportAi(
				"orchestrator-empty-choice",
				{
					caseId: normalizeString(caseDoc?._id),
					triggerType,
					round: round + 1,
				},
				"warn",
			);
			break;
		}

		messages.push(choice);

		if (!Array.isArray(choice.tool_calls) || !choice.tool_calls.length) {
			const finalReply = stripResponseText(choice.content || "");
			logSupportAi("orchestrator-final-reply", {
				caseId: normalizeString(caseDoc?._id),
				triggerType,
				round: round + 1,
				replyPreview: previewText(finalReply, 220),
			});
			return finalReply;
		}

		for (const toolCall of choice.tool_calls) {
			let parsedArgs = {};
			try {
				parsedArgs = toolCall?.function?.arguments
					? JSON.parse(toolCall.function.arguments)
					: {};
			} catch (error) {
				parsedArgs = {};
			}

			logSupportAi("tool-call-start", {
				caseId: normalizeString(caseDoc?._id),
				triggerType,
				round: round + 1,
				toolName: toolCall?.function?.name || "",
				args: parsedArgs,
			});

			const result = await executeToolCall(
				toolCall?.function?.name,
				parsedArgs,
			);

			logSupportAi("tool-call-result", {
				caseId: normalizeString(caseDoc?._id),
				triggerType,
				round: round + 1,
				toolName: toolCall?.function?.name || "",
				summary: summarizeToolResult(result),
			});

			messages.push({
				role: "tool",
				tool_call_id: toolCall.id,
				content: JSON.stringify(result),
			});
		}
	}

	logSupportAi(
		"orchestrator-max-rounds-reached",
		{
			caseId: normalizeString(caseDoc?._id),
			triggerType,
			maxToolRounds: MAX_TOOL_ROUNDS,
		},
		"warn",
	);

	return "";
}

async function appendAiMessage(caseId, segment, agentName) {
	const liveCase = await SupportCase.findById(caseId).lean();
	if (!liveCase) {
		logSupportAi(
			"append-message-missing-case",
			{
				caseId,
				agentName,
			},
			"warn",
		);
		return null;
	}

	const root = liveCase.conversation[0] || {};
	const messagePayload = {
		messageBy: {
			customerName: agentName,
			customerEmail: SUPPORT_EMAIL,
		},
		senderType: "ai",
		message: segment,
		inquiryAbout: root.inquiryAbout || "follow-up",
		inquiryDetails: root.inquiryDetails || "",
		seenByClient: false,
		seenByAdmin: true,
		seenBySeller: true,
		date: new Date(),
	};

	logSupportAi("append-message-start", {
		caseId,
		agentName,
		messagePreview: previewText(segment, 220),
		rootInquiryAbout: root.inquiryAbout || "",
	});

	const updatedCase = await SupportCase.findByIdAndUpdate(
		caseId,
		{
			$push: { conversation: messagePayload },
			$set: { supporterName: agentName },
		},
		{ new: true },
	);

	if (!updatedCase) {
		logSupportAi(
			"append-message-update-missed",
			{
				caseId,
				agentName,
			},
			"warn",
		);
		return null;
	}

	logSupportAi("append-message-complete", {
		caseId,
		agentName,
		conversationCount: Array.isArray(updatedCase?.conversation)
			? updatedCase.conversation.length
			: null,
	});

	return { liveCase: updatedCase, messagePayload };
}

async function emitTypingAndSend(
	caseDoc,
	replySegments,
	agentName,
	referenceTurn,
	options = {},
) {
	const io = global.io;
	if (!io) {
		throw new Error("Socket.IO is not available.");
	}

	const caseId = String(caseDoc._id);
	const referenceKind = options?.referenceKind || "pending_client";
	logSupportAi("emit-typing-and-send-start", {
		caseId,
		agentName,
		replySegmentCount: replySegments.length,
		shouldSuggestEndChat: Boolean(options?.shouldSuggestEndChat),
		firstReplyDelayRange: options?.firstReplyDelayRange || null,
		referenceKind,
	});

	if (hasRecentTyping(caseId, TYPING_ABORT_MS)) {
		if (referenceKind === "pending_client") {
			scheduleTypingRetry({
				caseId,
				latestClientTurn: referenceTurn,
				triggerType: options?.triggerType || "client_message",
			});
		}
		logSupportAi("emit-typing-and-send-skipped", {
			caseId,
			agentName,
			reason: "client_typing_before_emit",
			referenceKind,
		});
		return {
			skipped: "client_typing",
		};
	}

	let sentSegments = 0;
	let latestAppendedCase = caseDoc;
	let latestSentSupportTurn =
		referenceKind === "support_turn" ? referenceTurn : null;
	const firstReplyDelayRange = options?.firstReplyDelayRange || null;

	for (
		let segmentIndex = 0;
		segmentIndex < replySegments.length;
		segmentIndex += 1
	) {
		const segment = sanitizeReplyText(replySegments[segmentIndex]);
		if (!segment) continue;

		io.to(caseId).emit("typing", { caseId, user: agentName });
		const typingDelay =
			segmentIndex === 0 && firstReplyDelayRange
				? Math.max(
						calculateTypingDelay(segment, segmentIndex),
						randomBetween(
							firstReplyDelayRange.minMs,
							firstReplyDelayRange.maxMs,
						),
					)
				: calculateTypingDelay(segment, segmentIndex);
		logSupportAi("segment-typing-delay", {
			caseId,
			agentName,
			segmentIndex: segmentIndex + 1,
			segmentCount: replySegments.length,
			typingDelay,
			segmentPreview: previewText(segment, 180),
		});
		await wait(typingDelay);

		if (hasRecentTyping(caseId, TYPING_ABORT_MS)) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			if (referenceKind === "pending_client") {
				scheduleTypingRetry({
					caseId,
					latestClientTurn: referenceTurn,
					triggerType: options?.triggerType || "client_message",
				});
			}
			logSupportAi("segment-send-aborted", {
				caseId,
				agentName,
				reason: "client_typing_during_delay",
				segmentIndex: segmentIndex + 1,
				referenceKind,
			});
			return {
				skipped: "client_typing",
				sentSegments,
			};
		}

		const [liveCase, latestFlags] = await Promise.all([
			SupportCase.findById(caseId),
			WebsiteBasicSetup.findOne({}).lean(),
		]);

		if (hasRecentTyping(caseId, TYPING_ABORT_MS)) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			if (referenceKind === "pending_client") {
				scheduleTypingRetry({
					caseId,
					latestClientTurn: referenceTurn,
					triggerType: options?.triggerType || "client_message",
				});
			}
			logSupportAi("segment-send-aborted", {
				caseId,
				agentName,
				reason: "client_typing_after_state_refresh",
				segmentIndex: segmentIndex + 1,
				referenceKind,
			});
			return {
				skipped: "client_typing",
				sentSegments,
			};
		}

		if (!liveCase || !isAiAllowed(latestFlags, liveCase)) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			clearTypingRetry(caseId);
			logSupportAi("segment-send-aborted", {
				caseId,
				agentName,
				reason: liveCase
					? getAiBlockReason(latestFlags, liveCase) || "ai_disabled_before_send"
					: "case_not_found_before_send",
				segmentIndex: segmentIndex + 1,
				caseState: summarizeCaseForLogs(liveCase, latestFlags),
			});
			return {
				skipped: "ai_disabled_before_send",
				sentSegments,
			};
		}

		const currentLatestClientTurn =
			referenceKind === "pending_client"
				? getLatestRelevantPendingClientTurn(liveCase)
				: null;
		const currentLatestSupportTurn =
			referenceKind === "support_turn" ? getLatestSupportTurn(liveCase) : null;
		const referenceTurnIsStale =
			referenceKind === "pending_client"
				? hasHumanStaffReplyAfter(liveCase, referenceTurn.index) ||
					hasClientReplyAfter(liveCase, referenceTurn.index) ||
					Boolean(
						currentLatestClientTurn &&
						!isSameTurn(currentLatestClientTurn, referenceTurn),
					)
				: !currentLatestSupportTurn ||
					!isSameTurn(currentLatestSupportTurn, referenceTurn) ||
					hasClientReplyAfter(liveCase, referenceTurn.index);
		if (referenceTurnIsStale) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			clearTypingRetry(caseId);
			logSupportAi("segment-send-aborted", {
				caseId,
				agentName,
				reason:
					referenceKind === "pending_client"
						? "already_handled"
						: "follow_up_no_longer_needed",
				segmentIndex: segmentIndex + 1,
				currentLatestClientTurnIndex: currentLatestClientTurn?.index ?? null,
				currentLatestSupportTurnIndex: currentLatestSupportTurn?.index ?? null,
				referenceTurnIndex: referenceTurn?.index ?? null,
				referenceKind,
			});
			return {
				skipped:
					referenceKind === "pending_client"
						? "already_handled"
						: "follow_up_no_longer_needed",
				sentSegments,
			};
		}

		const appended = await appendAiMessage(caseId, segment, agentName);
		if (!appended) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			clearTypingRetry(caseId);
			return {
				skipped: "case_not_found",
				sentSegments,
			};
		}

		sentSegments += 1;
		latestAppendedCase = appended.liveCase;
		latestSentSupportTurn = getLatestSupportTurn(appended.liveCase);
		logSupportAi("segment-sent", {
			caseId,
			agentName,
			segmentIndex: segmentIndex + 1,
			segmentCount: replySegments.length,
			segmentPreview: previewText(segment, 220),
			sentSegments,
		});
		io.to(caseId).emit("stopTyping", { caseId, user: agentName });
		io.to(caseId).emit("receiveMessage", {
			caseId,
			...appended.messagePayload,
		});
		io.emit("receiveMessage", appended.liveCase.toObject());

		if (segmentIndex < replySegments.length - 1) {
			await wait(INTER_SEGMENT_PAUSE_MS);
		}
	}

	clearTypingRetry(caseId);
	if (
		sentSegments > 0 &&
		options?.scheduleIdleFollowUp &&
		latestSentSupportTurn
	) {
		scheduleIdleFollowUp({
			caseId,
			referenceSupportTurn: latestSentSupportTurn,
			originTriggerType: options?.triggerType || "client_message",
			agentName,
		});
	}

	if (sentSegments > 0 && options?.shouldSuggestEndChat) {
		logSupportAi("end-chat-suggestion-emitted", {
			caseId,
			agentName,
			sentSegments,
		});
		io.to(caseId).emit("supportEndChatSuggestion", {
			caseId,
			suggestedBy: agentName,
			requestedAt: new Date().toISOString(),
		});
	}

	logSupportAi("emit-typing-and-send-complete", {
		caseId,
		agentName,
		sentSegments,
		ok: sentSegments > 0,
		conversationCount: Array.isArray(latestAppendedCase?.conversation)
			? latestAppendedCase.conversation.length
			: null,
	});

	return {
		ok: sentSegments > 0,
		sentSegments,
	};
}

async function respondToSupportCase({
	caseId,
	triggerType = "client_message",
}) {
	ensureTypingHook();
	if (triggerType !== "idle_follow_up") {
		clearIdleFollowUp(caseId);
	}
	logSupportAi("respond-start", {
		caseId: normalizeString(caseId),
		triggerType,
	});

	if (!normalizeString(caseId)) {
		logSupportAi(
			"respond-skipped",
			{
				caseId: normalizeString(caseId),
				triggerType,
				reason: "missing_case_id",
			},
			"warn",
		);
		return {
			skipped: "missing_case_id",
		};
	}

	const [flags, caseDoc] = await Promise.all([
		WebsiteBasicSetup.findOne({}).lean(),
		SupportCase.findById(caseId).lean(),
	]);

	logSupportAi("respond-loaded-state", {
		caseId: normalizeString(caseId),
		triggerType,
		caseState: summarizeCaseForLogs(caseDoc, flags),
	});

	if (!caseDoc) {
		clearTypingRetry(caseId);
		clearIdleFollowUp(caseId);
		logSupportAi(
			"respond-skipped",
			{
				caseId: normalizeString(caseId),
				triggerType,
				reason: "case_not_found",
			},
			"warn",
		);
		return {
			skipped: "case_not_found",
		};
	}

	const aiBlockReason = getAiBlockReason(flags, caseDoc);
	if (aiBlockReason) {
		clearTypingRetry(caseId);
		clearIdleFollowUp(caseId);
		logSupportAi(
			"respond-skipped",
			{
				caseId: normalizeString(caseId),
				triggerType,
				reason: aiBlockReason,
				caseState: summarizeCaseForLogs(caseDoc, flags),
			},
			"warn",
		);
		return {
			skipped: aiBlockReason,
		};
	}

	const latestClientTurn =
		triggerType === "idle_follow_up"
			? getLatestClientTurn(caseDoc)
			: getLatestRelevantPendingClientTurn(caseDoc);
	const latestSupportTurn = getLatestSupportTurn(caseDoc);
	if (triggerType !== "idle_follow_up" && !latestClientTurn) {
		clearTypingRetry(caseId);
		logSupportAi(
			"respond-skipped",
			{
				caseId: normalizeString(caseId),
				triggerType,
				reason: "no_pending_client_turn",
				conversationCount: Array.isArray(caseDoc?.conversation)
					? caseDoc.conversation.length
					: 0,
			},
			"warn",
		);
		return {
			skipped: "no_pending_client_turn",
		};
	}

	if (triggerType === "idle_follow_up") {
		if (!latestSupportTurn) {
			clearTypingRetry(caseId);
			logSupportAi("respond-skipped", {
				caseId: normalizeString(caseId),
				triggerType,
				reason: "no_support_turn_for_follow_up",
			});
			return {
				skipped: "no_support_turn_for_follow_up",
			};
		}

		if (hasClientReplyAfter(caseDoc, latestSupportTurn.index)) {
			clearTypingRetry(caseId);
			logSupportAi("respond-skipped", {
				caseId: normalizeString(caseId),
				triggerType,
				reason: "client_replied_after_support_turn",
				referenceTurnIndex: latestSupportTurn.index,
			});
			return {
				skipped: "client_replied_after_support_turn",
			};
		}

		if (hasRecentTyping(caseId, TYPING_ABORT_MS)) {
			clearTypingRetry(caseId);
			logSupportAi("respond-skipped", {
				caseId: normalizeString(caseId),
				triggerType,
				reason: "client_typing",
				referenceTurnIndex: latestSupportTurn.index,
			});
			return {
				skipped: "client_typing",
			};
		}
	} else if (hasRecentTyping(caseId, TYPING_IDLE_MS)) {
		scheduleTypingRetry({
			caseId,
			latestClientTurn,
			triggerType,
		});
		logSupportAi("respond-skipped", {
			caseId: normalizeString(caseId),
			triggerType,
			reason: "client_typing",
			latestTurnIndex: latestClientTurn.index,
			latestTurnPreview: previewText(latestClientTurn?.message?.message || ""),
		});
		return {
			skipped: "client_typing",
		};
	}

	if (
		triggerType !== "idle_follow_up" &&
		shouldSkipRepeatedLightweightNudge(
			caseDoc,
			latestClientTurn,
			latestSupportTurn,
		)
	) {
		clearTypingRetry(caseId);
		logSupportAi("respond-skipped", {
			caseId: normalizeString(caseId),
			triggerType,
			reason: "duplicate_lightweight_nudge",
			latestTurnIndex: latestClientTurn?.index ?? null,
			latestTurnPreview: previewText(latestClientTurn?.message?.message || ""),
			latestSupportTurnIndex: latestSupportTurn?.index ?? null,
			latestSupportTurnPreview: previewText(
				latestSupportTurn?.message?.message || "",
			),
		});
		return {
			skipped: "duplicate_lightweight_nudge",
		};
	}

	const agentName = pickAgentName(caseDoc);
	const firstReplyDelayRange = getFirstReplyDelayRange(caseDoc, triggerType);
	const latestCustomerText = normalizeString(
		latestClientTurn?.message?.message ||
			latestClientTurn?.message?.inquiryDetails ||
			"",
	);

	console.log("[support-ai] processing:", {
		caseId,
		triggerType,
		model: DEFAULT_MODEL,
		hasApiKey: HAS_SUPPORT_AI_API_KEY,
		agentName,
		latestTurnIndex: latestClientTurn?.index ?? null,
		latestTurnPreview: previewText(latestCustomerText, 200),
		latestSupportTurnIndex: latestSupportTurn?.index ?? null,
		latestSupportTurnPreview: previewText(
			latestSupportTurn?.message?.message || "",
			200,
		),
		firstReplyDelayRange,
	});

	if (
		triggerType === "ai_reenabled" &&
		isHumanHandoffRequest(latestCustomerText)
	) {
		clearTypingRetry(caseId);
		logSupportAi("respond-skipped", {
			caseId: normalizeString(caseId),
			triggerType,
			reason: "awaiting_next_client_turn_after_handoff",
			latestTurnPreview: previewText(latestCustomerText, 200),
		});
		return {
			skipped: "awaiting_next_client_turn_after_handoff",
		};
	}

	if (isHumanHandoffRequest(latestCustomerText)) {
		logSupportAi("handoff-request-detected", {
			caseId: normalizeString(caseId),
			triggerType,
			agentName,
			latestTurnPreview: previewText(latestCustomerText, 200),
		});
		const handoffReply = sanitizeReplyText(buildHumanHandoffReply(caseDoc));
		if (!handoffReply) {
			clearTypingRetry(caseId);
			logSupportAi(
				"respond-skipped",
				{
					caseId: normalizeString(caseId),
					triggerType,
					reason: "empty_reply",
					branch: "handoff",
				},
				"warn",
			);
			return {
				skipped: "empty_reply",
			};
		}

		const handoffResult = await emitTypingAndSend(
			caseDoc,
			[handoffReply],
			agentName,
			latestClientTurn,
		);

		if (handoffResult?.ok || handoffResult?.sentSegments > 0) {
			await disableAiForCase(caseId);
			logSupportAi("handoff-complete", {
				caseId: normalizeString(caseId),
				triggerType,
				agentName,
				sentSegments: handoffResult?.sentSegments || 0,
			});
		}

		return handoffResult;
	}

	if (
		triggerType !== "idle_follow_up" &&
		isRhetoricalComplaintPrompt(latestCustomerText)
	) {
		const complaintTrapReply = sanitizeReplyText(
			buildComplaintTrapReply(caseDoc),
		);

		return emitTypingAndSend(
			caseDoc,
			[complaintTrapReply],
			agentName,
			latestClientTurn,
			{
				firstReplyDelayRange,
				triggerType,
				referenceKind: "pending_client",
				scheduleIdleFollowUp: false,
			},
		);
	}

	if (
		triggerType !== "idle_follow_up" &&
		customerExplicitlyDeclinesHelp(latestCustomerText)
	) {
		const noFurtherHelpReply = sanitizeReplyText(
			buildNoFurtherHelpReply(caseDoc),
		);

		return emitTypingAndSend(
			caseDoc,
			[noFurtherHelpReply],
			agentName,
			latestClientTurn,
			{
				firstReplyDelayRange,
				triggerType,
				referenceKind: "pending_client",
				scheduleIdleFollowUp: false,
			},
		);
	}

	if (shouldClarifyFirstReply(caseDoc)) {
		logSupportAi("clarification-branch", {
			caseId: normalizeString(caseId),
			triggerType,
			agentName,
			latestTurnPreview: previewText(latestCustomerText, 200),
		});
		const clarificationReply = sanitizeReplyText(
			await buildIntentClarifierReply(caseDoc, agentName),
		);

		if (!clarificationReply) {
			clearTypingRetry(caseId);
			logSupportAi(
				"respond-skipped",
				{
					caseId: normalizeString(caseId),
					triggerType,
					reason: "empty_reply",
					branch: "clarification",
				},
				"warn",
			);
			return {
				skipped: "empty_reply",
			};
		}

		return emitTypingAndSend(
			caseDoc,
			[clarificationReply],
			agentName,
			latestClientTurn,
			{
				firstReplyDelayRange,
				triggerType,
				referenceKind: "pending_client",
				scheduleIdleFollowUp: true,
			},
		);
	}

	let orchestratorReply = "";
	try {
		orchestratorReply = await runOrchestrator({
			caseDoc,
			flags,
			agentName,
			triggerType,
		});
	} catch (error) {
		logSupportAi(
			"orchestrator-failed",
			{
				caseId: normalizeString(caseId),
				triggerType,
				agentName,
				...summarizeSupportAiError(error),
			},
			"error",
		);
		throw error;
	}

	const idleFollowUpDecision =
		triggerType === "idle_follow_up"
			? extractIdleFollowUpDecision(orchestratorReply)
			: null;
	if (idleFollowUpDecision?.shouldSkipFollowUp) {
		clearTypingRetry(caseId);
		logSupportAi("respond-skipped", {
			caseId: normalizeString(caseId),
			triggerType,
			reason: "idle_follow_up_not_needed",
		});
		return {
			skipped: "idle_follow_up_not_needed",
		};
	}

	const extractedReply = extractReplyUiDirectives(
		idleFollowUpDecision?.replyText ?? orchestratorReply,
	);
	const replyText = extractedReply.replyText;
	const shouldSuggestEndChat =
		triggerType === "idle_follow_up"
			? false
			: extractedReply.shouldSuggestEndChat;
	const replySegments = splitReplyIntoSegments(replyText, caseDoc, agentName);

	logSupportAi("reply-prepared", {
		caseId: normalizeString(caseId),
		triggerType,
		agentName,
		shouldSuggestEndChat,
		replySegmentCount: replySegments.length,
		replyPreview: previewText(replyText, 240),
	});

	if (!replySegments.length) {
		clearTypingRetry(caseId);
		logSupportAi(
			"respond-skipped",
			{
				caseId: normalizeString(caseId),
				triggerType,
				reason: "empty_reply",
				branch: "orchestrator",
			},
			"warn",
		);
		return {
			skipped: "empty_reply",
		};
	}

	return emitTypingAndSend(
		caseDoc,
		replySegments,
		agentName,
		triggerType === "idle_follow_up" ? latestSupportTurn : latestClientTurn,
		{
			firstReplyDelayRange,
			shouldSuggestEndChat,
			triggerType,
			referenceKind:
				triggerType === "idle_follow_up" ? "support_turn" : "pending_client",
			scheduleIdleFollowUp:
				triggerType !== "idle_follow_up" && !shouldSuggestEndChat,
		},
	);
}

module.exports = {
	agentNames,
	classifyConversationMessage,
	getAiBlockReason,
	isAiAllowed,
	pickAgentName,
	respondToSupportCase,
	summarizeSupportAiError,
};
