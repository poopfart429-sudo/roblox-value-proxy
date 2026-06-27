/*
	Roblox Value Proxy Server (v4 — hybrid: Rolimons for limiteds + live lookup for everything else)

	WHY THIS DESIGN (history, so future-you understands the choice):
	v1 fetched prices live, per player, from economy.roblox.com — hit 429
	rate limits fast on shared-IP free hosting.
	v2 tried bulk-scanning Roblox's own catalog.roblox.com search endpoint
	in the background instead — but that endpoint turned out to have
	inconsistent, partly-undocumented parameters and a 504 timeout.
	v3 switched to Rolimons (https://www.rolimons.com/itemapi/itemdetails)
	for limited-item pricing — reliable, one request, no rate-limit dance.
	BUT Rolimons only tracks limiteds, not regular catalog items (shirts,
	gear, free hats, etc), and the goal is to value EVERYTHING worn, not
	just limiteds.

	v4 (this version) is a hybrid:
	  - Limiteds: priced from the Rolimons table (background refresh, cached,
		no per-request cost).
	  - Everything else: priced live, per item, via economy.roblox.com —
		but ONLY for the handful of items a specific player actually has
		equipped (not a bulk scan), and cached per-item for 6 hours since
		non-limited prices rarely change. This keeps the live-call volume
		low enough to avoid the 429s v1 ran into, while still covering
		every equipped item's value, not just limiteds.

	ENDPOINTS:
	  GET /avatar-value?userId=123
		-> { userId, totalValue, exclusiveCount, items: [...], priceTableAge }
	  GET /refresh-status
		-> shows when the limiteds price table last refreshed, how many cached
	  GET /force-refresh
		-> manually trigger a limiteds refresh (useful for testing)

	DEPLOY: npm install, then host on Render (or similar).
*/

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const EXCLUDED_ASSET_TYPE_IDS = new Set([11, 12]); // Shirt, Pants (AssetTypeId scheme)

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // refresh every 30 min (Rolimons allows 1/min, this is well under that)

// ---- Shared in-memory price table, built by the background job ----
// assetId (number) -> { name, rap, value }
let priceTable = new Map();
let lastRefreshTime = null;
let isRefreshing = false;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, maxRetries = 3) {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const res = await fetch(url, options);
		if (res.status !== 429) return res;
		if (attempt === maxRetries) return res;

		const retryAfterHeader = res.headers.get("retry-after");
		const retryAfterSeconds = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
		// Cap exponential growth at 10s per wait so background retries don't
		// stack up into very long waits when several items retry at once.
		const waitMs = retryAfterSeconds
			? retryAfterSeconds * 1000
			: Math.min(2000 * Math.pow(2, attempt), 10000);
		console.warn(`429 on ${url} — retrying in ${waitMs}ms`);
		await sleep(waitMs);
	}
}

// Pulls EVERY limited item's pricing data from Rolimons in a single request.
async function buildPriceTable() {
	if (isRefreshing) return;
	isRefreshing = true;
	console.log("[refresh] Fetching item details from Rolimons...");

	try {
		const res = await fetchWithRetry("https://www.rolimons.com/itemapi/itemdetails", {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; RobloxValueProxy/1.0)",
			},
		});

		if (!res.ok) {
			const bodyText = await res.text().catch(() => "(could not read body)");
			throw new Error(`Rolimons responded ${res.status}: ${bodyText}`);
		}

		const data = await res.json();
		if (!data.success || !data.items) {
			throw new Error("Rolimons response missing items data");
		}

		const newTable = new Map();
		// Each entry: [Name, Acronym, Rap, Value, DefaultValue, Demand, Trend, Projected, Hyped, Rare]
		for (const [itemIdStr, fields] of Object.entries(data.items)) {
			const itemId = parseInt(itemIdStr, 10);
			if (!itemId) continue;

			const name = fields[0];
			const rap = fields[2];
			const value = fields[3];
			// Rolimons uses -1 for "no value set" — fall back to RAP in that case.
			const resolvedValue = value > 0 ? value : rap;

			newTable.set(itemId, {
				name: name || "Unknown",
				rap: typeof rap === "number" ? rap : 0,
				value: typeof resolvedValue === "number" ? resolvedValue : 0,
			});
		}

		priceTable = newTable;
		lastRefreshTime = Date.now();
		console.log(`[refresh] Done. Cached ${priceTable.size} limited items.`);
	} catch (err) {
		console.error("[refresh] Failed:", err.message);
		// keep serving the OLD priceTable on failure rather than wiping it
	} finally {
		isRefreshing = false;
	}
}

// ---- Per-player lookup (this part stays live — cheap, single call) ----
async function getEquippedAssets(userId) {
	const url = `https://avatar.roblox.com/v1/users/${userId}/avatar`;
	const res = await fetchWithRetry(url);
	if (!res.ok) {
		throw new Error(`avatar.roblox.com responded ${res.status}`);
	}
	const data = await res.json();
	return (data.assets || []).map((a) => ({
		id: a.id,
		name: a.name,
		assetType: a.assetType ? a.assetType.id : null,
	}));
}

// ---- Non-limited item pricing (fallback for items not in the Rolimons table) ----
// Rolimons only tracks limiteds, so any regular catalog item (a normal shirt,
// gear, free hat, etc) won't be in priceTable. For those we look up the
// price live, per item — but NEVER make the player's /avatar-value request
// wait on that lookup.
//
// IMPORTANT: firing many background lookups in PARALLEL (one per uncached
// item, all at once) made the 429s worse, not better — economy.roblox.com
// seems to tolerate occasional single requests but chokes on bursts. So
// instead of one fetch per item fired immediately, uncached items get
// pushed into a QUEUE and processed ONE AT A TIME with a delay between
// each, no matter how many items across how many players are waiting.
const nonLimitedPriceCache = new Map(); // assetId -> { price, expires }
const NON_LIMITED_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours — these prices are stable
const queuedAssetIds = new Set(); // assetIds already waiting in the queue, avoid duplicates
const lookupQueue = [];
let queueRunning = false;
const DELAY_BETWEEN_QUEUE_ITEMS_MS = 2500; // be polite, one request at a time

function getNonLimitedPriceInstant(assetId) {
	const now = Date.now();
	const cached = nonLimitedPriceCache.get(assetId);
	if (cached && cached.expires > now) {
		return cached.price;
	}

	if (!queuedAssetIds.has(assetId)) {
		queuedAssetIds.add(assetId);
		lookupQueue.push(assetId);
		runQueue(); // make sure the queue processor is going, but don't await it
	}

	return 0; // best we can do for THIS request; next request will have it cached
}

async function runQueue() {
	if (queueRunning) return; // only one processor loop at a time
	queueRunning = true;

	while (lookupQueue.length > 0) {
		const assetId = lookupQueue.shift();
		queuedAssetIds.delete(assetId);

		await fetchNonLimitedPriceOnce(assetId);

		if (lookupQueue.length > 0) {
			await sleep(DELAY_BETWEEN_QUEUE_ITEMS_MS);
		}
	}

	queueRunning = false;
}

async function fetchNonLimitedPriceOnce(assetId) {
	const now = Date.now();
	try {
		const url = `https://economy.roblox.com/v2/assets/${assetId}/details`;
		// No retries here — the queue itself spaces requests out, and a
		// failed item just gets a short-lived 0 and can be re-queued by a
		// future request rather than retried in a tight loop right now.
		const res = await fetchWithRetry(url, undefined, 0);
		if (!res.ok) {
			nonLimitedPriceCache.set(assetId, { price: 0, expires: now + 30 * 1000 });
			console.warn(`[queue price] Asset ${assetId} failed (status ${res.status})`);
			return;
		}
		const data = await res.json();
		const price =
			typeof data.PriceInRobux === "number"
				? data.PriceInRobux
				: typeof data.LowestPrice === "number"
				? data.LowestPrice
				: 0;

		nonLimitedPriceCache.set(assetId, { price, expires: now + NON_LIMITED_CACHE_MS });
		console.log(`[queue price] Resolved asset ${assetId} -> ${price}`);
	} catch (err) {
		nonLimitedPriceCache.set(assetId, { price: 0, expires: now + 30 * 1000 });
		console.warn(`[queue price] Failed for asset ${assetId}: ${err.message}`);
	}
}

app.get("/avatar-value", async (req, res) => {
	const userId = parseInt(req.query.userId, 10);
	if (!userId || Number.isNaN(userId)) {
		return res.status(400).json({ error: "Missing or invalid userId query param" });
	}

	try {
		const equipped = await getEquippedAssets(userId);

		let totalValue = 0;
		let exclusiveCount = 0;
		const items = [];

		for (const asset of equipped) {
			if (EXCLUDED_ASSET_TYPE_IDS.has(asset.assetType)) continue;

			const cached = priceTable.get(asset.id);
			const isLimited = Boolean(cached);

			let price;
			if (isLimited) {
				price = cached.value;
				exclusiveCount += 1;
			} else {
				// Not a limited — try cache instantly; if uncached, this
				// returns 0 for now and resolves the real price in the
				// background for next time (never blocks this response).
				price = getNonLimitedPriceInstant(asset.id);
			}

			totalValue += price;

			items.push({
				assetId: asset.id,
				name: asset.name,
				price,
				isLimited,
			});
		}

		res.json({
			userId,
			totalValue,
			exclusiveCount,
			items,
			priceTableAge: lastRefreshTime ? Date.now() - lastRefreshTime : null,
		});
	} catch (err) {
		console.error("Error fetching avatar value:", err.message);
		res.status(502).json({ error: "Failed to fetch avatar value", detail: err.message });
	}
});

app.get("/refresh-status", (req, res) => {
	res.json({
		cachedLimitedItemCount: priceTable.size,
		cachedNonLimitedItemCount: nonLimitedPriceCache.size,
		queueLength: lookupQueue.length,
		queueRunning,
		lastRefreshTime,
		isRefreshing,
		ageMs: lastRefreshTime ? Date.now() - lastRefreshTime : null,
	});
});

app.get("/force-refresh", async (req, res) => {
	buildPriceTable(); // fire and forget
	res.json({ message: "Refresh started in background. Check /refresh-status for progress." });
});

app.get("/", (req, res) => {
	res.send("Roblox Value Proxy (Rolimons-backed) is running. Use /avatar-value?userId=123");
});

app.listen(PORT, () => {
	console.log(`Proxy server listening on port ${PORT}`);
	buildPriceTable();
	setInterval(buildPriceTable, REFRESH_INTERVAL_MS);
});
