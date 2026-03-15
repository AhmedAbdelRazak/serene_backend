/** @format */

const WebVital = require("../models/webvital");

const ALLOWED_METRICS = new Set(["CLS", "LCP", "INP", "FCP", "TTFB"]);
const SUMMARY_METRICS = ["CLS", "LCP", "INP"];

function clampNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
	const numericValue = Number(value);
	if (!Number.isFinite(numericValue)) return null;
	return Math.min(max, Math.max(min, numericValue));
}

function sanitizeString(value, { maxLength = 255, defaultValue = "" } = {}) {
	if (typeof value !== "string") return defaultValue;
	return value.trim().slice(0, maxLength);
}

function sanitizePath(value) {
	const safePath = sanitizeString(value, { maxLength: 320, defaultValue: "/" });
	if (!safePath) return "/";
	return safePath.startsWith("/") ? safePath : `/${safePath}`;
}

function sanitizeRating(value) {
	const rating = sanitizeString(value, { maxLength: 32, defaultValue: "unknown" }).toLowerCase();
	if (["good", "needs-improvement", "poor", "unknown"].includes(rating)) {
		return rating;
	}
	return "unknown";
}

function sanitizeMetric(value) {
	const metric = sanitizeString(value, { maxLength: 16 }).toUpperCase();
	return ALLOWED_METRICS.has(metric) ? metric : "";
}

function sanitizeAttribution(value, depth = 0) {
	if (value == null || depth > 3) return null;
	if (Array.isArray(value)) {
		const items = value
			.slice(0, 8)
			.map((entry) => sanitizeAttribution(entry, depth + 1))
			.filter((entry) => entry != null && entry !== "");
		return items.length ? items : null;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value)
			.slice(0, 20)
			.map(([key, entry]) => [
				sanitizeString(key, { maxLength: 48 }),
				sanitizeAttribution(entry, depth + 1),
			])
			.filter(([key, entry]) => key && entry != null && entry !== "");
		return entries.length ? Object.fromEntries(entries) : null;
	}
	if (typeof value === "string") return sanitizeString(value, { maxLength: 320 });
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "boolean") return value;
	return null;
}

function createMetricAccumulator() {
	return {
		values: [],
		ratingBreakdown: {
			good: 0,
			"needs-improvement": 0,
			poor: 0,
			unknown: 0,
		},
	};
}

function pushMetricSummary(container, metric, value, rating) {
	if (!container[metric]) {
		container[metric] = createMetricAccumulator();
	}
	container[metric].values.push(value);
	container[metric].ratingBreakdown[rating] =
		(container[metric].ratingBreakdown[rating] || 0) + 1;
}

function percentile(values = [], p = 75) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return Number(sorted[index].toFixed(4));
}

function average(values = []) {
	if (!values.length) return null;
	const total = values.reduce((sum, value) => sum + value, 0);
	return Number((total / values.length).toFixed(4));
}

function finalizeMetricSummary(metrics = {}) {
	const output = {};
	for (const metric of Object.keys(metrics).sort()) {
		const values = metrics[metric].values || [];
		output[metric] = {
			samples: values.length,
			p75: percentile(values, 75),
			average: average(values),
			min: values.length ? Number(Math.min(...values).toFixed(4)) : null,
			max: values.length ? Number(Math.max(...values).toFixed(4)) : null,
			ratingBreakdown: metrics[metric].ratingBreakdown,
		};
	}
	return output;
}

exports.captureWebVital = async (req, res) => {
	try {
		const metric = sanitizeMetric(req.body?.name || req.body?.metric);
		const path = sanitizePath(req.body?.path);
		const pageGroup = sanitizeString(req.body?.pageGroup, {
			maxLength: 80,
			defaultValue: "",
		});
		const value = clampNumber(req.body?.value, { min: 0, max: 600000 });
		const delta = clampNumber(req.body?.delta, { min: -600000, max: 600000 });

		if (!metric || !pageGroup || value == null) {
			return res.status(400).json({
				error: "Invalid web-vitals payload",
			});
		}

		await WebVital.create({
			metric,
			reportId: sanitizeString(req.body?.id || req.body?.reportId, {
				maxLength: 120,
			}),
			path,
			pageGroup,
			href: sanitizeString(req.body?.href, { maxLength: 500 }),
			value,
			delta: delta == null ? 0 : delta,
			rating: sanitizeRating(req.body?.rating),
			navigationType: sanitizeString(req.body?.navigationType, {
				maxLength: 32,
			}),
			effectiveConnectionType: sanitizeString(
				req.body?.effectiveConnectionType,
				{ maxLength: 24 },
			),
			deviceMemory: clampNumber(req.body?.deviceMemory, { min: 0, max: 1024 }),
			hardwareConcurrency: clampNumber(req.body?.hardwareConcurrency, {
				min: 0,
				max: 256,
			}),
			userAgent: sanitizeString(req.body?.userAgent, { maxLength: 320 }),
			attribution: sanitizeAttribution(req.body?.attribution),
		});

		return res.status(202).json({ ok: true });
	} catch (error) {
		console.error("captureWebVital error:", error);
		return res.status(500).json({
			error: "Failed to store web-vitals sample",
		});
	}
};

exports.getWebVitalsSummary = async (req, res) => {
	try {
		const days = clampNumber(req.query?.days, { min: 1, max: 90 }) || 7;
		const pageGroup = sanitizeString(req.query?.pageGroup, {
			maxLength: 80,
			defaultValue: "",
		});
		const path = req.query?.path ? sanitizePath(req.query.path) : "";
		const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

		const query = {
			createdAt: { $gte: since },
			metric: { $in: SUMMARY_METRICS },
		};
		if (pageGroup) query.pageGroup = pageGroup;
		if (path) query.path = path;

		const samples = await WebVital.find(query)
			.select("metric value rating pageGroup path createdAt")
			.sort({ createdAt: -1 })
			.lean();

		const overall = {};
		const byPageGroup = new Map();
		const byPath = new Map();

		for (const sample of samples) {
			if (!sample?.metric || typeof sample.value !== "number") continue;
			const safeRating = sanitizeRating(sample.rating);
			pushMetricSummary(overall, sample.metric, sample.value, safeRating);

			if (!byPageGroup.has(sample.pageGroup)) {
				byPageGroup.set(sample.pageGroup, {
					pageGroup: sample.pageGroup,
					sampleCount: 0,
					metrics: {},
				});
			}
			const pageGroupEntry = byPageGroup.get(sample.pageGroup);
			pageGroupEntry.sampleCount += 1;
			pushMetricSummary(
				pageGroupEntry.metrics,
				sample.metric,
				sample.value,
				safeRating,
			);

			if (!byPath.has(sample.path)) {
				byPath.set(sample.path, {
					path: sample.path,
					sampleCount: 0,
					metrics: {},
				});
			}
			const pathEntry = byPath.get(sample.path);
			pathEntry.sampleCount += 1;
			pushMetricSummary(pathEntry.metrics, sample.metric, sample.value, safeRating);
		}

		const pageGroups = Array.from(byPageGroup.values())
			.sort((a, b) => b.sampleCount - a.sampleCount)
			.map((entry) => ({
				pageGroup: entry.pageGroup,
				sampleCount: entry.sampleCount,
				metrics: finalizeMetricSummary(entry.metrics),
			}));

		const paths = Array.from(byPath.values())
			.sort((a, b) => b.sampleCount - a.sampleCount)
			.slice(0, 25)
			.map((entry) => ({
				path: entry.path,
				sampleCount: entry.sampleCount,
				metrics: finalizeMetricSummary(entry.metrics),
			}));

		return res.json({
			days,
			since,
			filters: {
				pageGroup: pageGroup || null,
				path: path || null,
			},
			totalSamples: samples.length,
			metrics: finalizeMetricSummary(overall),
			pageGroups,
			paths,
		});
	} catch (error) {
		console.error("getWebVitalsSummary error:", error);
		return res.status(500).json({
			error: "Failed to summarize web-vitals samples",
		});
	}
};
