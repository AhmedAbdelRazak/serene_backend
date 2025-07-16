/** @format
 *  AI‑Agent controller – Serene Jannat
 *  ------------------------------------------------------------------
 *  Rev 27 Jul 2025 • Human‑like v7.2
 *    – first follow‑up uses “Is there anything else…”
 *    – case‑insensitive redundancy guard (last‑3 messages)
 *    – compliment / thanks ➜ close after 3 s
 *    – professional close‑out phrase
 *  ------------------------------------------------------------------ */

const axios = require("axios");
const OpenAI = require("openai");
const leoProf = require("leo-profanity");
const ISO6391 = require("iso-639-1");

const SupportCase = require("../models/supportcase");
const Product = require("../models/product");
const { Order } = require("../models/order");
const WebsiteBasicSetup = require("../models/website");

/* ═════════ franc‑min dynamic import ═════════ */
let francDetect = null;
import("franc-min")
	.then((m) => {
		francDetect =
			(typeof m.default === "function" && m.default) ||
			(typeof m.franc === "function" && m.franc) ||
			Object.values(m).find((v) => typeof v === "function") ||
			null;
	})
	.catch((e) => console.error("[franc-min] load error:", e.message));

/* ═════════ OpenAI ═════════ */
const openai = new OpenAI({ apiKey: process.env.CHATGPT_API_TOKEN });

/* ═════════ typing awareness ═════════ */
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

/* ═════════ language helpers ═════════ */
const ALLOWED = ["en", "es", "fr", "it", "de", "zh", "ar"];
const LANG_TALLY = new Map(); // caseId → {en:3,…}
const LANG_LOCK = new Map(); // caseId → lang

function detectLang(txt = "") {
	if (typeof francDetect !== "function") return "en";
	const iso3 = francDetect(txt, { minLength: 5 });
	const iso1 = ISO6391.getCode(iso3);
	return ALLOWED.includes(iso1) ? iso1 : "en";
}
function addLang(id, lang) {
	const t = LANG_TALLY.get(id) || {};
	t[lang] = (t[lang] || 0) + 1;
	LANG_TALLY.set(id, t);
}
function decideLang(id, last) {
	if (LANG_LOCK.has(id)) return LANG_LOCK.get(id);
	const bucket = LANG_TALLY.get(id) || {};
	const tot = Object.values(bucket).reduce((a, b) => a + b, 0);
	if (tot < 3) return last;
	return Object.entries(bucket).sort((a, b) => b[1] - a[1])[0][0] || "en";
}
const lockLang = (id, l) => {
	if (ALLOWED.includes(l)) LANG_LOCK.set(id, l);
};
const unlockLang = (id) => LANG_LOCK.delete(id);

/* ═════════ phrasebook ═════════ */
const P = {
	en: {
		g: (n) => `Hello ${n}!`,
		fine: "I’m doing well, thank you for asking!",
		assist: "How can I assist you today?",
		else: "Is there anything else I can help you with?",
		close: "Thanks for contacting Serene Jannat. Have a wonderful day!",
		respect: "Let’s keep our conversation respectful so I can best assist you.",
		robot: "I’m a real support assistant here to help 😊",
		thanks: "You’re very welcome! I’m glad I could help.",
		rating: "If everything is clear, would you mind rating our chat today?",
	},
	es: {
		g: (n) => `¡Hola ${n}!`,
		fine: "¡Estoy muy bien, gracias por preguntar!",
		assist: "¿En qué puedo ayudarte hoy?",
		else: "¿Hay algo más en lo que pueda ayudarte?",
		close:
			"Gracias por contactar a Serene Jannat. ¡Que tengas un excelente día!",
		respect: "Mantengamos la conversación respetuosa para poder ayudarte.",
		robot: "Soy una asistente real dispuesta a ayudarte 😊",
		thanks: "¡Con gusto! Me alegra haber ayudado.",
		rating: "Si todo quedó claro, ¿podrías calificar nuestra conversación?",
	},
	fr: {
		g: (n) => `Bonjour ${n} !`,
		fine: "Je vais bien, merci de demander !",
		assist: "Comment puis‑je vous aider aujourd’hui ?",
		else: "Puis‑je vous aider avec autre chose ?",
		close:
			"Merci d’avoir contacté Serene Jannat. Passez une excellente journée !",
		respect: "Restons respectueux pour que je puisse mieux vous aider.",
		robot: "Je suis une véritable conseillère 😊",
		thanks: "Avec plaisir ! Ravi d’avoir pu aider.",
		rating: "Si tout est clair, pourriez‑vous noter notre échange ?",
	},
	it: {
		g: (n) => `Ciao ${n}!`,
		fine: "Sto bene, grazie di averlo chiesto!",
		assist: "Come posso aiutarti oggi?",
		else: "Posso aiutarti in qualcos'altro?",
		close: "Grazie per aver contattato Serene Jannat. Buona giornata!",
		respect: "Manteniamo una conversazione rispettosa 😊",
		robot: "Sono un'assistente reale pronta ad aiutarti 😊",
		thanks: "Prego! Sono felice di averti aiutato.",
		rating: "Se è tutto chiaro, potresti valutare la chat?",
	},
	de: {
		g: (n) => `Hallo ${n}!`,
		fine: "Mir geht’s gut, danke der Nachfrage!",
		assist: "Wie kann ich Ihnen heute helfen?",
		else: "Kann ich sonst noch etwas für Sie tun?",
		close:
			"Vielen Dank, dass Sie Serene Jannat kontaktiert haben. Einen schönen Tag noch!",
		respect: "Bitte bleiben wir höflich 😊",
		robot: "Ich bin eine echte Support‑Mitarbeiterin 😊",
		thanks: "Gern geschehen! Es freut mich, geholfen zu haben.",
		rating: "Wenn alles klar ist, bewerten Sie doch bitte unseren Chat.",
	},
	zh: {
		g: (_) => "您好！",
		fine: "我很好，谢谢关心！",
		assist: "我能为您做些什么？",
		else: "还有什么我可以帮您的吗？",
		close: "感谢您联系 Serene Jannat，祝您愉快！",
		respect: "请保持礼貌，这样我才能更好地协助您。",
		robot: "我是真人客服，很高兴为您服务 😊",
		thanks: "不客气！很高兴能帮到您。",
		rating: "如果一切清楚，欢迎为本次对话评分。",
	},
	ar: {
		g: (n) => `مرحبًا ${n}!`,
		fine: "أنا بخير، شكرًا لسؤالك!",
		assist: "كيف يمكنني مساعدتك اليوم؟",
		else: "هل يمكنني مساعدتك في شيء آخر؟",
		close: "شكرًا لتواصلك مع Serene Jannat. يومك سعيد!",
		respect: "من فضلك لنبقِ الحديث محترمًا 😊",
		robot: "أنا مساعدة حقيقية هنا لدعمك 😊",
		thanks: "على الرحب والسعة! يسعدني أنني استطعت المساعدة.",
		rating: "إذا كان كل شيء واضحًا، يسعدنا تقييمك للمحادثة.",
	},
};
const phrases = (l) => P[l] || P.en;

/* ═════════ regexes ═════════ */
const agentNames = ["sally", "elizabeth", "michael", "brenda", "natasha"];
const GREET_RX =
	/^(hi|hello|hey|good\s*(morning|afternoon|evening)|hola|bonjour|ciao|hallo|مرحبا)[\s!.]*$/i;
const HOW_RX =
	/how\s*(are|r)\s*(you|u)|cómo\s*estás|comment\s*ça\s*va|come\s*stai|wie\s*geht|كيف.*حالك/i;
const ORDER_RX =
	/status|track|tracking|update|where|when|shipp(ed|ing)|deliver(ed|y)|invoice|\bpedido\b|\borden\b|\bطلب\b/i;
const STILL_RX = /still\s+there|anyone\s+there|are\s+you\s+there/i;
const ROBOT_RX = /(robot|real\s+person|are\s+you\s+real|so\s+odd)/i;
const THANKS_RX = /\b(thanks?|thank\s+you|gracias|merci|grazie|danke|شكرا)\b/i;
const COMPLIMENT_RX =
	/\b(best|awesome|great|amazing|perfect|wonderful|love\s+it|the\s+best(est)?|excellent)\b/i;
const LANG_REQ_RX =
	/speak\s+(english|spanish|español|french|français|italian|italiano|german|deutsch|chinese|arabic)/i;

const orderNoRx = /\d{6,}/;
const skuRx = /[A-Z]{2,}-?\d{2,}/i;
const phone10Rx = /(\d[\s-]?){10,}/;

const profanity = (t) => leoProf.check(t);

/* ═════════ greeting cool‑down ═════════ */
const lastGreetAt = new Map();
function shouldGreet(id) {
	return Date.now() - (lastGreetAt.get(id) || 0) > 90_000;
}

/* ═════════ redundancy guard ═════════ */
const LAST_BOT = new Map(); // caseId → [msg1,msg2,msg3]
function alreadySaid(id, txt) {
	const arr = LAST_BOT.get(id) || [];
	return arr.includes(txt.toLowerCase().trim());
}
function remember(id, txt) {
	const arr = LAST_BOT.get(id) || [];
	arr.push(txt.toLowerCase().trim());
	if (arr.length > 3) arr.shift();
	LAST_BOT.set(id, arr);
}

/* ═════════ timers ═════════ */
const TIMER_MAP = new Map();
const PING_MS = 90_000,
	CLOSE_MS = 300_000,
	FOLLOW_MS = 12_000;
function clearTimers(id) {
	const t = TIMER_MAP.get(id);
	if (!t) return;
	Object.values(t).forEach(clearTimeout);
	TIMER_MAP.delete(id);
}
function schedule(caseDoc, lang, opt = { follow: false }) {
	clearTimers(caseDoc._id);
	const id = caseDoc._id.toString();
	const bag = {};

	if (opt.follow) {
		bag.follow = setTimeout(async () => {
			if (Date.now() - (lastTypingAt.get(id) || 0) < 4000) return;
			await post(caseDoc, phrases(lang).else); // improved wording
		}, FOLLOW_MS);
	}

	bag.ping = setTimeout(async () => {
		if (Date.now() - (lastTypingAt.get(id) || 0) < 4000) return;
		await post(caseDoc, phrases(lang).else);
	}, PING_MS);

	bag.close = setTimeout(async () => {
		const live = await SupportCase.findById(id);
		if (live?.caseStatus === "open") {
			await post(live, phrases(lang).close);
			live.caseStatus = "closed";
			live.closedBy = "AI";
			await live.save();
			global.io.emit("closeCase", { case: live.toObject(), closedBy: "AI" });
		}
		clearTimers(id);
	}, CLOSE_MS);

	TIMER_MAP.set(id, bag);
}

/* quick close helper (compliment path) */
function quickClose(caseDoc, lang, sec = 3) {
	setTimeout(async () => {
		const live = await SupportCase.findById(caseDoc._id);
		if (live?.caseStatus === "open") {
			await post(live, phrases(lang).close);
			live.caseStatus = "closed";
			live.closedBy = "AI";
			await live.save();
			global.io.emit("closeCase", { case: live.toObject(), closedBy: "AI" });
		}
		clearTimers(caseDoc._id);
	}, sec * 1000);
}

/* ═════════ order / product context ═════════ */
async function isPOD(o) {
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
			} catch {
				/* ignore */
			}
		}
	} catch (e) {
		console.error("[POD] Printify:", e.message);
	}
	return null;
}
async function getContext(userMsg, caseDoc) {
	const blob = [
		caseDoc.conversation?.[0]?.inquiryAbout,
		caseDoc.conversation?.[0]?.inquiryDetails,
		userMsg,
	].join(" ");
	const ord = (blob.match(orderNoRx) || [])[0];

	/* POD orders */
	if (ord) {
		const local = await Order.findOne({
			"printifyOrderDetails.0.ephemeralOrder": { $exists: true },
			$or: [
				{ invoiceNumber: ord },
				{ trackingNumber: ord },
				{ "printifyOrderDetails.0.ephemeralOrder.id": ord },
			],
		}).lean();
		if (local && (await isPOD(local))) {
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

	/* regular orders */
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

	/* product lookup */
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

/* ═════════ misc helpers ═════════ */
const strip = (txt) => txt.replace(/```[a-z]*\n?|```/g, "").trim();
function ensureDefaults(doc) {
	let dirty = false;
	doc.conversation.forEach((m) => {
		if (!m.inquiryAbout) {
			m.inquiryAbout = "follow‑up";
			dirty = true;
		}
		if (m.inquiryDetails === undefined) {
			m.inquiryDetails = "";
			dirty = true;
		}
	});
	if (dirty) doc.markModified("conversation");
}

/* ═════════ post() with reading pause ═════════ */
async function post(caseDoc, text) {
	const io = global.io;
	if (!io) throw new Error("socket.io missing");
	if (alreadySaid(caseDoc._id, text)) return;

	const agent =
		caseDoc.supporterName ||
		["Sally", "Elizabeth", "Natasha", "Brenda"][Math.floor(Math.random() * 4)];

	await new Promise((r) => setTimeout(r, 1000));
	const delay = Math.min(Math.max(text.length * 40, 600), 5500);
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
	remember(caseDoc._id, text);
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

		const flags = await WebsiteBasicSetup.findOne().lean();
		if (!flags?.aiAgentToRespond || flags?.deactivateChatResponse)
			return res.json({ skipped: "AI disabled" });

		const sc = await SupportCase.findById(caseId);
		if (!sc) return res.status(404).json({ error: "case not found" });
		if (!sc.aiToRespond) return res.json({ skipped: "aiToRespond=false" });

		ensureDefaults(sc);
		clearTimers(caseId);

		/* explicit language request */
		const langReq = LANG_REQ_RX.exec(newClientMessage.toLowerCase());
		if (langReq) {
			const word = langReq[1];
			const map = {
				english: "en",
				spanish: "es",
				español: "es",
				french: "fr",
				français: "fr",
				italian: "it",
				italiano: "it",
				german: "de",
				deutsch: "de",
				chinese: "zh",
				arabic: "ar",
			};
			lockLang(caseId, map[word] || "en");
		}

		/* language decision */
		const detected = detectLang(newClientMessage);
		addLang(caseId, detected);
		const lang = decideLang(caseId, detected);
		const T = phrases(lang);

		/* profanity */
		if (profanity(newClientMessage)) {
			await post(sc, T.respect);
			schedule(sc, lang);
			return res.json({ ok: true });
		}

		const cleaned = newClientMessage
			.toLowerCase()
			.replace(new RegExp(agentNames.join("|"), "g"), "")
			.trim();

		/* still there? */
		if (STILL_RX.test(cleaned)) {
			await post(sc, "Yes, I’m here — how can I help?");
			schedule(sc, lang, { follow: true });
			return res.json({ ok: true });
		}

		/* robot? */
		if (ROBOT_RX.test(cleaned)) {
			await post(sc, T.robot);
			schedule(sc, lang, { follow: true });
			return res.json({ ok: true });
		}

		/* compliment / thanks */
		if (THANKS_RX.test(cleaned) || COMPLIMENT_RX.test(cleaned)) {
			await post(sc, `${T.thanks} ${T.rating}`);
			quickClose(sc, lang, 3);
			return res.json({ ok: true });
		}

		/* greeting & how‑are‑you */
		const isGreet = GREET_RX.test(cleaned),
			isHow = HOW_RX.test(cleaned);

		if (
			sc.conversation.length === 1 &&
			sc.conversation[0].messageBy?.customerEmail !== "support@serenejannat.com"
		) {
			const first =
				sc.conversation[0].messageBy.customerName.split(" ")[0] || "there";
			await post(sc, `Hello ${first}! How can I assist you today?`);
			lastGreetAt.set(caseId, Date.now());
			schedule(sc, lang, { follow: false });
			return res.json({ ok: true });
		}

		if (isGreet && !isHow && shouldGreet(caseId)) {
			const first =
				sc.conversation[0]?.messageBy?.customerName.split(" ")[0] || "";
			await post(sc, T.g(first));
			lastGreetAt.set(caseId, Date.now());
			schedule(sc, lang, { follow: true });
			return res.json({ ok: true });
		}

		if (isHow) {
			await post(sc, T.fine);
			schedule(sc, lang, { follow: true });
			return res.json({ ok: true });
		}

		/* order guard */
		if (sc.conversation[0]?.inquiryAbout === "order" && !ORDER_RX.test(cleaned))
			return res.json({ skipped: "order context but no status keywords" });

		/* build context */
		const ctx = await getContext(newClientMessage, sc);
		const convo = sc.conversation.map((m) => m.message).join(" ");
		const phone =
			(convo.match(phone10Rx) || [""])[0].replace(/\D/g, "").slice(0, 10) || "";
		const mail = sc.conversation[0].messageBy.customerEmail || "email";

		const casual = ctx.inquiryType === "other" && !ORDER_RX.test(cleaned);
		const sys = `
You are Serene Jannat’s professional yet warm support agent.
• Respond in ${ISO6391.getName(lang) || "English"} (code ${lang}).
• ${
			casual
				? "Limit reply to one short sentence, ≤12 words."
				: "Limit reply to 1‑2 concise sentences (<60 words)."
		}
• Never reveal internal IDs or partner names.
• If ctx.delivered === true → mention “shipped and delivered”.
• If ctx.record.tracking exists → include a tracking sentence.
• If ctx.found === false → apologise & offer escalation (confirm phone ${
			phone || "phone"
		} or e‑mail ${mail}).
`.trim();

		const user = `Client: """${newClientMessage}"""
Context: ${JSON.stringify(ctx, null, 2)}`;

		const { choices } = await openai.chat.completions.create({
			model: "gpt-4o",
			temperature: 0.5,
			messages: [
				{ role: "system", content: sys },
				{ role: "user", content: user },
			],
		});

		const reply = strip(choices?.[0]?.message?.content || T.assist);
		await post(sc, reply);
		schedule(sc, lang, { follow: true });
		res.json({ ok: true });
	} catch (e) {
		console.error("[AI] autoRespond:", e);
		res.status(500).json({ error: e.message });
	}
};
