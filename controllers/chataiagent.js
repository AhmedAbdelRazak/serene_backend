/** @format
 *  AI‑Agent controller – Serene Jannat
 *  ------------------------------------------------------------------
 *  Rev. 18 Jul 2025‑b  • Auto‑greeting on first message (fallback)
 *  ------------------------------------------------------------------ */

const axios = require("axios");
const OpenAI = require("openai");
const leoProfanity = require("leo-profanity");
const SupportCase = require("../models/supportcase");
const Product = require("../models/product");
const { Order } = require("../models/order");
const WebsiteBasicSetup = require("../models/website");

/* ═════════ OpenAI ═════════ */
const openai = new OpenAI({ apiKey: process.env.CHATGPT_API_TOKEN });

/* ═════════ Typing awareness ═════════ */
const lastTypingAt = new Map();
if (!global.__typingHookInstalled) {
	global.__typingHookInstalled = true;
	const io = global.io;
	if (io) {
		io.on("connection", (s) => {
			s.on("typing", ({ caseId }) => lastTypingAt.set(caseId, Date.now()));
		});
	}
}

/* ═════════ Regex & helpers ═════════ */
const agentNames = ["sally", "elizabeth", "michael", "brenda"];
const GREETING_RX =
	/^(hi|hello|hey|good\s*(morning|afternoon|evening)|thanks|thank you)[\s!.]*$/i;
const SMALL_TALK_RX =
	/how\s*(are|r)\s*(you|u)|how's it going|why.*not.*answer/i;
const ORDER_QUERY_RX =
	/status|track|tracking|update|where|when|shipp(ed|ing)|deliver(ed|y)|invoice/i;

const orderNoRx = /\d{6,}/;
const skuRx = /[A-Z]{2,}-?\d{2,}/i;
const phone10Rx = /(\d[\s-]?){10,}/;

const profanity = (t = "") => leoProfanity.check(t);
const looksArabic = (txt = "") =>
	(txt.match(/[\u0600-\u06FF]/g) || []).length / txt.length > 0.3;

/* ═════════ Validation guard ═════════ */
function ensureConversationDefaults(caseDoc) {
	let fix = false;
	caseDoc.conversation.forEach((m) => {
		if (!m.inquiryAbout) {
			m.inquiryAbout = "follow‑up";
			fix = true;
		}
		if (m.inquiryDetails === undefined) {
			m.inquiryDetails = "";
			fix = true;
		}
	});
	if (fix) caseDoc.markModified("conversation");
}

/* ═════════ Quick heuristics ═════════ */
const isGreeting = (t) =>
	GREETING_RX.test(
		t
			.toLowerCase()
			.replace(new RegExp(agentNames.join("|"), "g"), "")
			.trim()
	);
const isSmallTalk = (t) => SMALL_TALK_RX.test(t.toLowerCase());
const isOrderQuery = (t) => ORDER_QUERY_RX.test(t.toLowerCase());

/* ═════════ POD helpers (unchanged) ═════════ */
function isPOD(o) {
	return (
		o?.chosenProductQtyWithVariables?.some(
			(p) =>
				p.customDesign?.finalScreenshotUrl ||
				p.chosenAttributes?.isPrintifyProduct
		) || false
	);
}
async function fetchPrintify(id) {
	const token = process.env.DESIGN_PRINTIFY_TOKEN;
	if (!token) return null;
	try {
		const { data: shops = [] } = await axios.get(
			"https://api.printify.com/v1/shops.json",
			{ headers: { Authorization: `Bearer ${token}` } }
		);
		for (const { id: shopId } of shops) {
			try {
				const { data } = await axios.get(
					`https://api.printify.com/v1/shops/${shopId}/orders/${id}.json`,
					{ headers: { Authorization: `Bearer ${token}` } }
				);
				if (data?.id)
					return {
						status: data.status,
						tracking: data.printify_connect?.url || null,
						carrier: data.shipping_carrier,
						printProviderStatus: data.print_provider_status,
					};
			} catch (_) {}
		}
	} catch (e) {
		console.error("[POD] Printify:", e.message);
	}
	return null;
}

/* ═════════ Context builder ═════════ */
async function getContext(userMsg, caseDoc) {
	const blob = [
		caseDoc.conversation?.[0]?.inquiryAbout,
		caseDoc.conversation?.[0]?.inquiryDetails,
		userMsg,
	].join(" ");

	const ord = (blob.match(orderNoRx) || [])[0];

	/* POD */
	if (ord) {
		const local = await Order.findOne({
			"printifyOrderDetails.0.ephemeralOrder": { $exists: true },
			$or: [
				{ invoiceNumber: ord },
				{ trackingNumber: ord },
				{ "printifyOrderDetails.0.ephemeralOrder.id": ord },
			],
		}).lean();
		if (local && isPOD(local)) {
			const pid = local.printifyOrderDetails?.[0]?.ephemeralOrder?.id;
			const live = pid ? await fetchPrintify(pid) : null;
			const delivered =
				["completed", "delivered"].includes(
					(live?.status || "").toLowerCase()
				) || /fulfilled|delivered|completed/i.test(local.status || "");
			return {
				inquiryType: "pod",
				found: true,
				delivered,
				record: { local, live },
			};
		}
	}

	/* Regular order */
	if (ord) {
		const o = await Order.findOne({
			$or: [{ invoiceNumber: ord }, { trackingNumber: ord }],
		})
			.select("invoiceNumber status trackingNumber")
			.lean();
		if (o)
			return {
				inquiryType: "order",
				found: true,
				delivered: /delivered|completed/i.test(o.status || ""),
				record: o,
			};
	}

	/* Product */
	const sku = (blob.match(skuRx) || [])[0];
	if (sku) {
		const p = await Product.findOne({
			$or: [
				{ productSKU: new RegExp(`^${sku}$`, "i") },
				{ productName: new RegExp(blob, "i") },
			],
		})
			.select("productName productSKU price")
			.lean();
		if (p) return { inquiryType: "product", found: true, record: p };
	}

	return { inquiryType: "other", found: false };
}

/* ═════════ Timers (typing aware) ═════════ */
const T_MAP = new Map(); // caseId -> timers
const PING_MS = 15_000;
const CLOSE_MS = 120_000;
function resetTimers(caseId) {
	const t = T_MAP.get(caseId);
	if (t) {
		clearTimeout(t.ping);
		clearTimeout(t.close);
		clearTimeout(t.silent);
		T_MAP.delete(caseId);
	}
}
function courtesyPing(caseDoc) {
	resetTimers(caseDoc._id);
	const ping = setTimeout(async () => {
		if (Date.now() - (lastTypingAt.get(caseDoc._id.toString()) || 0) < 5_000)
			return;
		const live = await SupportCase.findById(caseDoc._id).lean();
		if (live?.caseStatus === "open")
			await post(caseDoc, "Is there anything else I can help you with?");
	}, PING_MS);
	const close = setTimeout(async () => {
		const live = await SupportCase.findById(caseDoc._id);
		if (live?.caseStatus === "open") {
			await post(
				live,
				"I haven’t heard back, so I'll close this chat for now. Please rate our service when convenient."
			);
			live.caseStatus = "closed";
			live.closedBy = "super admin";
			await live.save();
			global.io.emit("closeCase", { case: live.toObject(), closedBy: "AI" });
		}
		resetTimers(caseDoc._id);
	}, CLOSE_MS);
	T_MAP.set(caseDoc._id.toString(), { ping, close });
}
function silentClose(caseDoc) {
	const silent = setTimeout(async () => {
		const live = await SupportCase.findById(caseDoc._id);
		if (live?.caseStatus === "open") {
			live.caseStatus = "closed";
			live.closedBy = "super admin";
			await live.save();
			global.io.emit("closeCase", { case: live.toObject(), closedBy: "AI" });
		}
		resetTimers(caseDoc._id);
	}, 5_000);
	T_MAP.set(caseDoc._id.toString(), { silent });
}

/* ═════════ post helper ═════════ */
async function post(caseDoc, text) {
	const io = global.io;
	if (!io) throw new Error("global.io missing");
	ensureConversationDefaults(caseDoc);

	const agent =
		caseDoc.supporterName ||
		["Sally", "Elizabeth", "Natasha", "Brenda"][Math.floor(Math.random() * 4)];

	/* typing simulation */
	const delay = Math.min(Math.max(text.length * 50, 1_000), 7_000);
	io.to(caseDoc._id.toString()).emit("typing", {
		caseId: caseDoc._id,
		user: agent,
	});
	await new Promise((r) => setTimeout(r, delay));
	io.to(caseDoc._id.toString()).emit("stopTyping", {
		caseId: caseDoc._id,
		user: agent,
	});

	const root = caseDoc.conversation[0] || {};
	const msg = {
		messageBy: {
			customerName: agent,
			customerEmail: "support@serenejannat.com",
		},
		message: text,
		inquiryAbout: root.inquiryAbout || "follow‑up",
		inquiryDetails: root.inquiryDetails || "",
		seenByClient: false,
		seenByAdmin: true,
		seenBySeller: true,
		date: new Date(),
	};

	caseDoc.conversation.push(msg);
	caseDoc.supporterName = agent;
	await caseDoc.save();
	io.to(caseDoc._id.toString()).emit("receiveMessage", {
		caseId: caseDoc._id,
		...msg,
	});
}

/* ═════════ Main controller ═════════ */
exports.autoRespond = async (req, res) => {
	try {
		const { caseId } = req.params;
		const { newClientMessage } = req.body;
		if (!caseId || !newClientMessage)
			return res
				.status(400)
				.json({ error: "caseId + newClientMessage required" });

		/* site‑level flags */
		const wb = await WebsiteBasicSetup.findOne().lean();
		if (!wb?.aiAgentToRespond || wb?.deactivateChatResponse)
			return res.json({ skipped: "AI disabled" });

		const sc = await SupportCase.findById(caseId);
		if (!sc) return res.status(404).json({ error: "case not found" });
		if (!sc.aiToRespond) return res.json({ skipped: "aiToRespond=false" });

		ensureConversationDefaults(sc);
		resetTimers(caseId);

		/* ─── auto‑greet on the very first client stub (NEW) ─── */
		if (
			sc.conversation.length === 1 &&
			sc.conversation[0].messageBy?.customerEmail !== "support@serenejannat.com"
		) {
			const firstName =
				sc.conversation[0].messageBy.customerName.split(" ")[0] || "there";
			await post(sc, `Hello ${firstName}! How can I assist you today?`);
			courtesyPing(sc);
			return res.json({ ok: true, autoGreet: true });
		}

		/* profanity */
		if (profanity(newClientMessage)) {
			await post(
				sc,
				"Let’s please keep our conversation respectful so I can best assist you."
			);
			courtesyPing(sc);
			return res.json({ ok: true });
		}

		if (isGreeting(newClientMessage)) {
			await post(sc, "Hello! How can I help you today?");
			return res.json({ ok: true });
		}

		if (isSmallTalk(newClientMessage)) {
			await post(sc, "I’m doing well, thank you for asking!");
			return res.json({ ok: true });
		}

		if (
			sc.conversation[0]?.inquiryAbout === "order" &&
			!isOrderQuery(newClientMessage)
		) {
			return res.json({ skipped: "no status keywords yet" });
		}

		/* context */
		const ctx = await getContext(newClientMessage, sc);

		/* escalation contacts */
		const convoTxt = sc.conversation.map((m) => m.message).join(" ");
		const phone =
			(convoTxt.match(phone10Rx) || [""])[0].replace(/\D/g, "").slice(0, 10) ||
			"";
		const mail =
			sc.conversation[0].messageBy.customerEmail || "unknown@serene.com";

		const lang = "the same language the customer used";

		const systemPrompt = `
You are a concise, friendly Serene Jannat support agent.
Answer in ${lang}. Max 2 sentences (~50 words).
Never reveal third‑party partners; say "our fulfilment centre".
If context.delivered true → phrase "shipped and delivered".
If context.found false → apologise, offer escalation (confirm phone ${phone} else e‑mail ${mail}).
`.trim();

		const userPrompt = `
Client: """${newClientMessage}"""
Context: ${JSON.stringify(ctx)}
`.trim();

		const { choices } = await openai.chat.completions.create({
			model: "gpt-4o",
			temperature: 0.5,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
		});
		const reply =
			choices?.[0]?.message?.content?.trim() ||
			"I’m here to help – could you clarify your question, please?";

		await post(sc, reply);

		/* reply classification */
		const escal = /escalate|supervisor|call you|e‑mail/i.test(reply);
		const smallTalkAns = /doing well|glad you/i.test(reply);
		if (!escal && !smallTalkAns) courtesyPing(sc);
		else if (/resolved|happy.*help/i.test(reply)) {
			await post(
				sc,
				"If everything is clear, could you please rate our service?"
			);
			silentClose(sc);
		}

		return res.json({ ok: true });
	} catch (e) {
		console.error("[AI] error:", e);
		res.status(500).json({ error: e.message });
	}
};
