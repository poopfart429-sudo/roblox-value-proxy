/*
	Roblox Value Proxy Server (v2 — bulk-cached pricing)

	WHY THIS DESIGN:
	Roblox blocks HttpService from calling catalog.roblox.com / economy.roblox.com
	/ avatar.roblox.com directly from inside a Roblox game server — permanent,
	no setting fixes it. So a separate server (this one) has to fetch that data
	on the game's behalf.

	The FIRST version of this proxy fetched prices live, per player, per
	request. That works but hits Roblox's rate limits (HTTP 429) fast,
	especially on shared-IP free hosting (Render free tier, etc), because
	many players checking values = many rapid calls to economy.roblox.com.

	THIS version instead:
	  1. Runs a background job every REFRESH_INTERVAL_MS that pulls limited
		 item prices in bulk from Roblox's catalog search endpoint (a handful
		 of paginated calls every few hours, not one call per player per item).
	  2. Stores results in an in-memory price table (assetId -> price info).
	  3. When a player's value is requested, it looks up their EQUIPPED ITEM
		 IDS live (this part is unavoidably per-player — there's no bulk way
		 to ask "what is everyone wearing"), but prices come from the cached
		 table, not a live lookup. This means each player check makes ONE
		 cheap call (avatar.roblox.com) instead of one expensive call per item.

	LIMITATION TO KNOW ABOUT:
	The bulk "limiteds" catalog endpoint only reliably surfaces LIMITED items
	(the ones with resale value). Common non-limited catalog accessories
	(most everyday hats/items with no resale market) won't appear in this
	bulk list and will show as price 0 unless you extend buildPriceTable()
	to also sweep additional catalog categories. For a trading/flex-value
	game, limiteds are almost always what actually matters for "Value", so
	this is the right tradeoff to start with.

	ENDPOINTS:
	  GET /avatar-value?userId=123
		-> { userId, totalValue, items: [...], exclusiveCount, priceTableAge }
	  GET /refresh-status
		-> shows when the price table last refreshed, how many items cached

	DEPLOY: same as before — npm install, then host on Render (or similar).
*/

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const EXCLUDED_ASSET_TYPE_IDS = new Set([11, 12]); // Shirt, Pants

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // refresh price table every 4 hours
const PAGES_PER_REFRESH = 100; // no category filter now, so we need more pages to find enough limiteds
const DELAY_BETWEEN_CALLS_MS = 1500; // be polite between bulk calls during refresh

// ---- Shared in-memory price table, built by the background job ----
let priceTable = new Map(); // assetId -> { name, price, isLimited, assetType }
let lastRefreshTime = null;
let isRefreshing = false;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, maxRetries = 3) {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const res = await fetch(url);
		if (res.status !== 429) return res;
		if (attempt === maxRetries) return res;

		const retryAfterHeader = res.headers.get("retry-after");
		const retryAfterSeconds = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
		const waitMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 1000 * Math.pow(2, attempt);
		console.warn(`429 on ${url} — retrying in ${waitMs}ms`);
		await sleep(waitMs);
	}
}

// Pulls a page of currently-trading limited items from Roblox's catalog
// search (Category 2 = Collectibles), in bulk.
// NOTE: this endpoint's query params are case-sensitive (Category, Limit,
// SortType, Cursor — capitalized), unlike most other Roblox endpoints.
async function fetchLimitedsPage(cursor) {
	// Roblox's Category/Subcategory combos on this endpoint are inconsistent
	// and not well documented (confirmed by multiple Roblox dev forum threads
	// reporting incorrect/outdated docs and "not supported" errors on valid-
	// looking combos). Omitting Category and just using SortType=0 (relevance)
	// with no category filter is the most reliably accepted shape; we filter
	// for limited/collectible items client-side afterward instead of relying
	// on the API's category filter.
	let url = "https://catalog.roblox.com/v1/search/items/details?Limit=30&SortType=0";
	if (cursor) {
		url += `&Cursor=${encodeURIComponent(cursor)}`;
	}
	const res = await fetchWithRetry(url);
	if (!res.ok) {
		const bodyText = await res.text().catch(() => "(could not read body)");
		throw new Error(`catalog search responded ${res.status}: ${bodyText}`);
	}
	return res.json();
}

// The background job: walks several pages of the limiteds catalog and
// rebuilds the price table. Runs on a timer, NOT per player request.
async function buildPriceTable() {
	if (isRefreshing) return; // don't overlap refreshes
	isRefreshing = true;
	console.log("[refresh] Starting price table refresh...");

	const newTable = new Map();
	let cursor = null;

	try {
		for (let page = 0; page < PAGES_PER_REFRESH; page++) {
			const data = await fetchLimitedsPage(cursor);
			const items = data.data || [];

			for (const item of items) {
				if (EXCLUDED_ASSET_TYPE_IDS.has(item.assetType)) continue;

				// We no longer filter by Category server-side (that param was
				// unreliable), so filter for limiteds/collectibles ourselves.
				const isLimited = Boolean(item.isLimited || item.isLimitedUnique);
				if (!isLimited) continue;

				newTable.set(item.id, {
					name: item.name || "Unknown",
					price: typeof item.price === "number" ? item.price : 0,
					isLimited: true,
					assetType: item.assetType ?? null,
				});
			}

			cursor = data.nextPageCursor;
			if (!cursor) break; // no more pages

			if (page % 10 === 0) {
				console.log(`[refresh] page ${page}, ${newTable.size} limiteds found so far`);
			}

			await sleep(DELAY_BETWEEN_CALLS_MS);
		}

		priceTable = newTable;
		lastRefreshTime = Date.now();
		console.log(`[refresh] Done. Cached ${priceTable.size} items.`);
	} catch (err) {
		console.error("[refresh] Failed:", err.message);
		// keep serving the OLD priceTable on failure rather than wiping it
	} finally {
		isRefreshing = false;
	}
}

// ---- Per-player lookup (this part stays live, it's cheap) ----
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
			const price = cached ? cached.price : 0;
			const isLimited = cached ? cached.isLimited : false;

			if (isLimited) exclusiveCount += 1;
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
		cachedItemCount: priceTable.size,
		lastRefreshTime,
		isRefreshing,
		ageMs: lastRefreshTime ? Date.now() - lastRefreshTime : null,
	});
});

// Manual trigger, useful for testing without waiting hours for the timer
app.get("/force-refresh", async (req, res) => {
	buildPriceTable(); // fire and forget, don't block the response
	res.json({ message: "Refresh started in background. Check /refresh-status for progress." });
});

app.get("/", (req, res) => {
	res.send("Roblox Value Proxy (bulk-cached) is running. Use /avatar-value?userId=123");
});

app.listen(PORT, () => {
	console.log(`Proxy server listening on port ${PORT}`);
	buildPriceTable(); // build the table once on startup
	setInterval(buildPriceTable, REFRESH_INTERVAL_MS); // then keep it fresh on a timer
});
