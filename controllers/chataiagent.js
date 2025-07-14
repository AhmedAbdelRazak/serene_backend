/** @format
 *  AI‑Agent controller – Serene Jannat
 *  ---------------------------------------------------------------
 *  New features
 *    • personalised greeting (“Hello Ahmed …”)
 *    • GPT replies ≤ 2 sentences
 *    • typing delay = len × 0.05 s  (1‒7 s clamp)
 *  --------------------------------------------------------------- */

const axios = require("axios");
const OpenAI = require("openai");
const jwt = require("jsonwebtoken");
const leoProfanity = require("leo-profanity");

const SupportCase = require("../models/supportcase");
const Product = require("../models/product");
const { Order } = require("../models/order");
const WebsiteBasicSetup = require("../models/website");

/* ═══ OpenAI & token helper ══════════════════════ */
const openai = new OpenAI({ apiKey: process.env.CHATGPT_API_TOKEN });
let cachedToken = null,
	expMs = 0;
async function getServiceToken() {
	if (cachedToken && Date.now() < expMs - 60_000) return cachedToken;
	const { data } = await axios.post(`${process.env.SERVER_URL}/api/signin`, {
		emailOrPhone: "admin@serenejannat.com",
		password: process.env.MASTER_PASSWORD,
	});
	cachedToken = data.token;
	expMs = jwt.decode(cachedToken).exp * 1_000;
	return cachedToken;
}

/* ═══ helpers ═════════════════════════════════════ */
const agentNames = ["Sally", "Elizabeth", "Natasha", "Brenda"];
const profanity = (t) => leoProfanity.check(t || "");
const orderNoRx = /\d{6,}/;
const skuRx = /[A-Z]{2,}-?\d{2,}/i;
function classify(str = "") {
	if (/order|invoice|tracking/i.test(str)) return "order";
	if (/product|sku/i.test(str)) return "product";
	if (/pod/i.test(str)) return "pod";
	return "other";
}
const extractOrder = (s) => (s.match(orderNoRx) || [])[0] || null;
const extractSku = (s) => (s.match(skuRx) || [])[0] || null;
const looksArabic = (txt = "") =>
	(txt.match(/[\u0600-\u06FF]/g) || []).length / txt.length > 0.3;

/* ═══ context builder (order / product) ═══════════ */
async function buildContext(userMsg, caseDoc) {
	const rootAbout = caseDoc.conversation?.[0]?.inquiryAbout ?? "";
	const rootDetails = caseDoc.conversation?.[0]?.inquiryDetails ?? "";
	const blob = [rootAbout, rootDetails, userMsg].join(" ");

	/* order */
	const ordNo = extractOrder(blob);
	if (ordNo) {
		const ord = await Order.findOne({
			$or: [
				{ invoiceNumber: ordNo },
				{ trackingNumber: ordNo },
				{ "printifyOrderDetails.0.ephemeralOrder.id": ordNo },
			],
		})
			.select("invoiceNumber status trackingNumber")
			.lean();
		if (ord) return { inquiryType: "order", found: true, record: ord };
	}

	/* product */
	const sku = extractSku(blob);
	if (sku) {
		const prod = await Product.findOne({
			$or: [
				{ productSKU: new RegExp(`^${sku}$`, "i") },
				{ productName: new RegExp(blob, "i") },
			],
		})
			.select("productName productSKU price")
			.lean();
		if (prod) return { inquiryType: "product", found: true, record: prod };
	}

	return { inquiryType: classify(rootAbout), found: false };
}

/* ═══ main controller ═════════════════════════════ */
exports.autoRespond = async (req, res) => {
	try {
		const { caseId } = req.params;
		const { newClientMessage } = req.body;
		if (!caseId || !newClientMessage)
			return res
				.status(400)
				.json({ error: "caseId + newClientMessage required" });

		/* site‑level flags */
		const site = await WebsiteBasicSetup.findOne().lean();
		if (!site?.aiAgentToRespond || site?.deactivateChatResponse)
			return res.json({ skipped: "AI disabled" });

		/* load case */
		const sc = await SupportCase.findById(caseId);
		if (!sc) return res.status(404).json({ error: "case not found" });
		if (!sc.aiToRespond) return res.json({ skipped: "aiToRespond=false" });

		/* profanity quick‑response */
		if (profanity(newClientMessage)) {
			await post(
				sc,
				"I understand your frustration, but let’s please stay respectful so I can best help."
			);
			return res.json({ ok: true });
		}

		/* ————————————————————————————————— greeting */
		if (newClientMessage === "__WELCOME__") {
			const full = sc.conversation?.[0]?.messageBy?.customerName || "there";
			const firstName = full.trim().split(/\s+/)[0];
			const greet = `Hello ${firstName}! How can I assist you today?`;
			await post(sc, greet);
			return res.json({ ok: true });
		}

		/* context (order / product) */
		const ctx = await buildContext(newClientMessage, sc);

		/* prompt */
		const systemPrompt = `
You are a concise, friendly Serene Jannat support agent.
ALWAYS respond in **English** unless the customer writes Arabic.
Limit yourself to **max two short sentences** (≈ 50 words total).
If the issue is about payments, say we only accept PayPal and advise contacting PayPal for disputes.
If unsure, politely say you will ask a supervisor and request contact details.
`.trim();

		const userPrompt = `
Customer message: """${newClientMessage}"""
Parsed context (JSON): ${JSON.stringify(ctx)}
`.trim();

		const gpt = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			temperature: 0.6,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
		});

		const reply =
			gpt.choices?.[0]?.message?.content?.trim() ||
			"I’m here to help – could you clarify your question, please?";

		await post(sc, reply);
		res.json({ ok: true });
	} catch (err) {
		console.error("[AI] error:", err);
		res.status(500).json({ error: err.message });
	}
};

/* ═══ helper: save + broadcast with dynamic typing delay ═════ */
async function post(caseDoc, text) {
	/* socket */
	const io = global.io;
	if (!io) throw new Error("global.io missing (set in server.js)");

	/* fix older messages lacking inquiryAbout */
	caseDoc.conversation.forEach((m) => {
		if (!m.inquiryAbout) m.inquiryAbout = "follow‑up";
		if (m.inquiryDetails === undefined) m.inquiryDetails = "";
	});

	const agent =
		caseDoc.supporterName ||
		agentNames[Math.floor(Math.random() * agentNames.length)];

	/* --- typing simulation --- */
	const ms = Math.max(1000, Math.min(text.length * 50, 7000)); // 0.05 s per char
	io.to(caseDoc._id.toString()).emit("typing", {
		caseId: caseDoc._id,
		user: agent,
	});
	await new Promise((r) => setTimeout(r, ms));
	io.to(caseDoc._id.toString()).emit("stopTyping", {
		caseId: caseDoc._id,
		user: agent,
	});

	/* --- build & save message --- */
	const root = caseDoc.conversation?.[0] || {};
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

	/* --- broadcast to room --- */
	io.to(caseDoc._id.toString()).emit("receiveMessage", {
		caseId: caseDoc._id,
		...msg,
	});
}
