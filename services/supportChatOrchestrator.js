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
const TYPING_IDLE_MS = 1500;
const TYPING_ABORT_MS = 2500;
const TYPING_RETRY_DELAY_MS = TYPING_ABORT_MS + 350;
const MAX_TYPING_RETRIES = 2;
const INTER_SEGMENT_PAUSE_MS = 450;
const FIRST_REPLY_MIN_DELAY_MS = 5000;
const FIRST_REPLY_MAX_DELAY_MS = 10000;

const lastTypingAt = new Map();
const typingRetryState = new Map();

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
	if (!normalizedCaseId || !latestClientTurn) return false;

	const turnKey = getMessageIdentity(
		latestClientTurn.message,
		latestClientTurn.index,
	);
	if (!turnKey) return false;

	const existing = typingRetryState.get(normalizedCaseId);
	const isSameTurn = existing?.turnKey === turnKey;
	const attempts = isSameTurn ? (existing?.attempts || 0) + 1 : 1;

	if (isSameTurn && attempts > MAX_TYPING_RETRIES) {
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
			return;
		}

		typingRetryState.delete(normalizedCaseId);

		try {
			await respondToSupportCase({
				caseId: normalizedCaseId,
				triggerType:
					triggerType === "post_typing_retry"
						? triggerType
						: "post_typing_retry",
			});
		} catch (error) {
			console.error("[support-ai-typing-retry] failed:", error.message);
		}
	}, TYPING_RETRY_DELAY_MS);

	typingRetryState.set(normalizedCaseId, {
		turnKey,
		attempts,
		timer,
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
		)
	);
}

function buildHumanHandoffReply(caseDoc = {}) {
	const firstName = getFirstName(getCustomerName(caseDoc));
	if (firstName) {
		return `Of course, ${firstName}. I'm getting a customer service rep into this chat now. Please give us a moment.`;
	}

	return "Of course. I'm getting a customer service rep into this chat now. Please give us a moment.";
}

async function disableAiForCase(caseId = "") {
	const normalizedCaseId = normalizeString(caseId);
	if (!normalizedCaseId) return null;

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

	const lookup = await toolFindProducts({
		query: productText,
		limit: 3,
	});

	if (!lookup?.found) {
		return `${greeting} I'd be happy to help with that product. Could you send the full product name, or tell me what you'd like help with?`;
	}

	const [firstMatch, secondMatch] = lookup.products || [];
	if (firstMatch && !secondMatch) {
		return `${greeting} Just to make sure I'm looking at the right item, are you asking about ${firstMatch.name}? If so, what can I help you with?`;
	}

	if (firstMatch) {
		return `${greeting} I want to make sure I'm looking at the right product. Are you asking about ${firstMatch.name}, or something else?`;
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
	const email = normalizeLower(message?.messageBy?.customerEmail);
	if (isSupportEmail(email)) return "ai";
	if (normalizeString(message?.messageBy?.userId)) return "staff";
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

function hasHumanStaffMessages(caseDoc = {}) {
	return getConversationArray(caseDoc).some(
		(message) => classifyConversationMessage(message) === "staff",
	);
}

function isAiAllowed(flags = {}, caseDoc = {}) {
	return Boolean(
		flags?.aiAgentToRespond &&
		!flags?.deactivateChatResponse &&
		caseDoc?.aiToRespond &&
		caseDoc?.caseStatus === "open" &&
		caseDoc?.openedBy === "client",
	);
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
		"If latestPendingCustomerWindow shows several back-to-back customer messages, combine them into one unresolved thought before you answer. Do not treat a quick nudge like 'Michael?' as the real question.",
		"Before sending, make sure every direct question in the latest customer message has been addressed if the data is available.",
		"If the customer says you did not answer fully, apologize briefly and then give the missing answer right away in that same reply if you can verify it.",
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
		"Use the assigned agent name naturally in first-person if helpful, but do not overuse it.",
	].join("\n");
}

function buildUserPrompt({ caseDoc, flags, agentName, triggerType }) {
	const transcript = buildTranscript(caseDoc);
	const firstMessage = transcript[0] || {};
	const latestClientTurn = getLatestClientTurn(caseDoc);
	const latestPendingClientTurn = getLatestRelevantPendingClientTurn(caseDoc);
	const latestPendingClientWindow = getLatestPendingClientWindow(caseDoc);
	const storeId = normalizeString(caseDoc?.storeId?._id || caseDoc?.storeId);
	const customerName = getCustomerName(caseDoc);
	const rootInquiryAbout = firstMessage?.inquiryAbout || "";
	const rootInquiryDetails = firstMessage?.inquiryDetails || "";
	const replyStylePreferences = getReplyStylePreferences(caseDoc);

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
			task: "Decide the best next reply to the customer. Prioritize the latest unresolved customer turn over older product context. If a human teammate already replied earlier in the same chat, continue naturally from that conversation instead of restarting it. Call tools whenever product, custom-gift, order, shipping, policy, tracking, or store facts would improve the answer. Return only the customer-facing chat reply.",
		},
		null,
		2,
	);
}

async function runOrchestrator({ caseDoc, flags, agentName, triggerType }) {
	const messages = [
		{ role: "system", content: buildSystemPrompt() },
		{
			role: "user",
			content: buildUserPrompt({ caseDoc, flags, agentName, triggerType }),
		},
	];

	for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
		const completion = await openai.chat.completions.create({
			model: DEFAULT_MODEL,
			temperature: 0.45,
			messages,
			tools: toolDefinitions,
			tool_choice: "auto",
		});

		const choice = completion?.choices?.[0]?.message;
		if (!choice) break;

		messages.push(choice);

		if (!Array.isArray(choice.tool_calls) || !choice.tool_calls.length) {
			return stripResponseText(choice.content || "");
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

			const result = await executeToolCall(
				toolCall?.function?.name,
				parsedArgs,
			);

			messages.push({
				role: "tool",
				tool_call_id: toolCall.id,
				content: JSON.stringify(result),
			});
		}
	}

	return "";
}

async function appendAiMessage(caseId, segment, agentName) {
	const liveCase = await SupportCase.findById(caseId).lean();
	if (!liveCase) return null;

	const root = liveCase.conversation[0] || {};
	const messagePayload = {
		messageBy: {
			customerName: agentName,
			customerEmail: SUPPORT_EMAIL,
		},
		message: segment,
		inquiryAbout: root.inquiryAbout || "follow-up",
		inquiryDetails: root.inquiryDetails || "",
		seenByClient: false,
		seenByAdmin: true,
		seenBySeller: true,
		date: new Date(),
	};

	const updatedCase = await SupportCase.findByIdAndUpdate(
		caseId,
		{
			$push: { conversation: messagePayload },
			$set: { supporterName: agentName },
		},
		{ new: true },
	);

	if (!updatedCase) return null;

	return { liveCase: updatedCase, messagePayload };
}

async function emitTypingAndSend(
	caseDoc,
	replySegments,
	agentName,
	latestClientTurn,
	options = {},
) {
	const io = global.io;
	if (!io) {
		throw new Error("Socket.IO is not available.");
	}

	const caseId = String(caseDoc._id);
	if (hasRecentTyping(caseId, TYPING_ABORT_MS)) {
		scheduleTypingRetry({
			caseId,
			latestClientTurn,
			triggerType: "client_message",
		});
		return {
			skipped: "client_typing",
		};
	}

	let sentSegments = 0;
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
		await wait(typingDelay);

		if (hasRecentTyping(caseId, TYPING_ABORT_MS)) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			scheduleTypingRetry({
				caseId,
				latestClientTurn,
				triggerType: "client_message",
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

		if (!liveCase || !isAiAllowed(latestFlags, liveCase)) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			clearTypingRetry(caseId);
			return {
				skipped: "ai_disabled_before_send",
				sentSegments,
			};
		}

		const currentLatestClientTurn =
			getLatestRelevantPendingClientTurn(liveCase);
		if (
			!currentLatestClientTurn ||
			!isSameTurn(currentLatestClientTurn, latestClientTurn) ||
			hasHumanStaffReplyAfter(liveCase, latestClientTurn.index)
		) {
			io.to(caseId).emit("stopTyping", { caseId, user: agentName });
			clearTypingRetry(caseId);
			return {
				skipped: "already_handled",
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

	if (sentSegments > 0 && options?.shouldSuggestEndChat) {
		io.to(caseId).emit("supportEndChatSuggestion", {
			caseId,
			suggestedBy: agentName,
			requestedAt: new Date().toISOString(),
		});
	}

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

	if (!normalizeString(caseId)) {
		return {
			skipped: "missing_case_id",
		};
	}

	const [flags, caseDoc] = await Promise.all([
		WebsiteBasicSetup.findOne({}).lean(),
		SupportCase.findById(caseId).lean(),
	]);

	if (!caseDoc) {
		clearTypingRetry(caseId);
		return {
			skipped: "case_not_found",
		};
	}

	if (!isAiAllowed(flags, caseDoc)) {
		clearTypingRetry(caseId);
		return {
			skipped: "ai_disabled",
		};
	}

	const latestClientTurn = getLatestRelevantPendingClientTurn(caseDoc);
	if (!latestClientTurn) {
		clearTypingRetry(caseId);
		return {
			skipped: "no_pending_client_turn",
		};
	}

	if (hasRecentTyping(caseId, TYPING_IDLE_MS)) {
		scheduleTypingRetry({
			caseId,
			latestClientTurn,
			triggerType,
		});
		return {
			skipped: "client_typing",
		};
	}

	const agentName = pickAgentName(caseDoc);
	const firstReplyDelayRange = getFirstReplyDelayRange(caseDoc, triggerType);
	const latestCustomerText = normalizeString(
		latestClientTurn.message?.message ||
			latestClientTurn.message?.inquiryDetails ||
			"",
	);

	if (
		triggerType === "ai_reenabled" &&
		isHumanHandoffRequest(latestCustomerText)
	) {
		clearTypingRetry(caseId);
		return {
			skipped: "awaiting_next_client_turn_after_handoff",
		};
	}

	if (isHumanHandoffRequest(latestCustomerText)) {
		const handoffReply = sanitizeReplyText(buildHumanHandoffReply(caseDoc));
		if (!handoffReply) {
			clearTypingRetry(caseId);
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
		}

		return handoffResult;
	}

	if (shouldClarifyFirstReply(caseDoc)) {
		const clarificationReply = sanitizeReplyText(
			await buildIntentClarifierReply(caseDoc, agentName),
		);

		if (!clarificationReply) {
			clearTypingRetry(caseId);
			return {
				skipped: "empty_reply",
			};
		}

		return emitTypingAndSend(
			caseDoc,
			[clarificationReply],
			agentName,
			latestClientTurn,
			{ firstReplyDelayRange },
		);
	}

	const { replyText, shouldSuggestEndChat } = extractReplyUiDirectives(
		await runOrchestrator({
			caseDoc,
			flags,
			agentName,
			triggerType,
		}),
	);
	const replySegments = splitReplyIntoSegments(replyText, caseDoc, agentName);

	if (!replySegments.length) {
		clearTypingRetry(caseId);
		return {
			skipped: "empty_reply",
		};
	}

	return emitTypingAndSend(
		caseDoc,
		replySegments,
		agentName,
		latestClientTurn,
		{ firstReplyDelayRange, shouldSuggestEndChat },
	);
}

module.exports = {
	agentNames,
	classifyConversationMessage,
	isAiAllowed,
	pickAgentName,
	respondToSupportCase,
};
