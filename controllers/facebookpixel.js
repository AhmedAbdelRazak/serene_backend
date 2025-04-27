const fetch = require("node-fetch");
const crypto = require("crypto");

const pixelId = process.env.FACEBOOK_PIXEL_ID;
const fbToken = process.env.FACEBOOK_TOKEN;

const sha256Hash = (value) => {
	if (!value) return null;
	return crypto
		.createHash("sha256")
		.update(value.toString().toLowerCase().trim())
		.digest("hex");
};

exports.triggerFacebookConversionAPI = async (req, res) => {
	try {
		const {
			eventName, // e.g. "AddToCart"
			eventId, // for deduplication
			email,
			phone,
			currency, // e.g. "USD"
			value, // e.g. product price
			contentIds, // array of product._id or SKU
			userAgent, // pass from client if available
			clientIpAddress,
		} = req.body;

		if (!eventName) {
			return res.status(400).json({
				error: "Missing eventName in request body",
			});
		}

		// Build user_data (hashed email/phone recommended for matching)
		const userData = {};
		if (email) userData.em = [sha256Hash(email)];
		if (phone) userData.ph = [sha256Hash(phone)];
		// Optionally pass IP, user agent for better match rates
		userData.client_ip_address = clientIpAddress || req.ip;
		userData.client_user_agent = userAgent || req.headers["user-agent"];

		// Construct the single event object
		const eventPayload = {
			event_name: eventName, // "AddToCart"
			event_time: Math.floor(Date.now() / 1000),
			action_source: "website",
			user_data: userData,
			event_id: eventId, // for deduplication
			custom_data: {
				currency: currency || "USD",
				value: value || 0,
				contents: (contentIds || []).map((id) => ({
					id,
					quantity: 1,
				})),
			},
		};

		const body = {
			data: [eventPayload],
		};

		// POST to Facebook Conversions API
		const url = `https://graph.facebook.com/v16.0/${pixelId}/events?access_token=${fbToken}`;
		const fbResponse = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const fbResult = await fbResponse.json();

		if (fbResult.error) {
			console.error("FB Conversions API Error:", fbResult.error);
			return res.status(400).json({ error: fbResult.error });
		}

		return res.json({
			success: true,
			fbResult,
		});
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Internal server error" });
	}
};
