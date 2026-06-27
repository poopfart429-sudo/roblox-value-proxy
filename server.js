/*
	Roblox Value Proxy Server

	Purpose: Roblox's HttpService cannot call *.roblox.com domains directly
	(catalog.roblox.com, economy.roblox.com, avatar.roblox.com, etc — this is
	a hard, permanent block with no setting to disable). This proxy sits in
	between: your Roblox game calls THIS server, and THIS server calls Roblox's
	APIs (which is allowed, since the call isn't coming from inside Roblox's
	sandbox).

	ENDPOINTS:
	  GET /avatar-value?userId=123
		-> Returns { totalValue, items: [{ assetId, name, assetType, price }] }
		   Sums the CURRENT LISTED PRICE of every equipped avatar asset,
		   EXCLUDING shirts and pants.

	DEPLOY:
	  1. npm install
	  2. node server.js   (or deploy to Render/Railway/Glitch/a VPS)
	  3. Note your server's public URL (e.g. https://your-app.onrender.com)
	     You'll paste that URL into the Roblox-side ValueService script.
*/

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Asset type IDs to EXCLUDE (Shirt = 11, Pants = 12)
const EXCLUDED_ASSET_TYPE_IDS = new Set([11, 12]);

// Simple in-memory cache to avoid re-hitting Roblox's API constantly
const priceCache = new Map(); // assetId -> { price, name, assetType, expires }
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

// Fetches a URL, retrying on 429 (rate limit) with backoff.
// Respects the Retry-After header when Roblox provides one.
async function fetchWithRetry(url, maxRetries = 3) {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const res = await fetch(url);

		if (res.status !== 429) {
			return res;
		}

		if (attempt === maxRetries) {
			return res; // give up, let caller handle the failed response
		}

		const retryAfterHeader = res.headers.get("retry-after");
		const retryAfterSeconds = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
		const waitMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 500 * Math.pow(2, attempt);

		console.warn(`429 received, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
}

async function getAvatarAssetIds(userId) {
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

// Gets current listed price for a single asset using the no-auth
// economy.roblox.com endpoint (the catalog/items/details endpoint requires
// POST + token validation and is unreliable without a logged-in session,
// so we avoid it here).
async function getCurrentPrice(assetId) {
	const cached = priceCache.get(assetId);
	if (cached && cached.expires > Date.now()) {
		return cached;
	}

	const url = `https://economy.roblox.com/v2/assets/${assetId}/details`;
	const res = await fetchWithRetry(url);
	if (!res.ok) {
		throw new Error(`economy.roblox.com responded ${res.status}`);
	}
	const data = await res.json();

	// Limiteds: current price = lowest active resale listing (already folded
	// into PriceInRobux for limiteds on this endpoint).
	// Non-limiteds: fixed sale price, also in PriceInRobux.
	const price =
		typeof data.PriceInRobux === "number"
			? data.PriceInRobux
			: typeof data.LowestPrice === "number"
			? data.LowestPrice
			: 0;

	const result = {
		price,
		name: data.Name || "Unknown",
		assetType: data.AssetTypeId ?? data.assetTypeId ?? null,
		isLimited: Boolean(data.IsLimited || data.IsLimitedUnique),
		expires: Date.now() + CACHE_MS,
	};

	priceCache.set(assetId, result);
	return result;
}

app.get("/avatar-value", async (req, res) => {
	const userId = parseInt(req.query.userId, 10);
	if (!userId || Number.isNaN(userId)) {
		return res.status(400).json({ error: "Missing or invalid userId query param" });
	}

	try {
		const assets = await getAvatarAssetIds(userId);

		let totalValue = 0;
		const items = [];

		for (const asset of assets) {
			if (EXCLUDED_ASSET_TYPE_IDS.has(asset.assetType)) {
				continue; // skip shirts/pants from the avatar list itself
			}

			const priced = await getCurrentPrice(asset.id);

			if (EXCLUDED_ASSET_TYPE_IDS.has(priced.assetType)) {
				continue; // also skip based on catalog's own assetType, as a safety net
			}

			totalValue += priced.price;
			items.push({
				assetId: asset.id,
				name: priced.name,
				assetType: priced.assetType,
				price: priced.price,
			});
		}

		res.json({ userId, totalValue, items });
	} catch (err) {
		console.error("Error fetching avatar value:", err.message);
		res.status(502).json({ error: "Failed to fetch avatar value", detail: err.message });
	}
});

app.get("/", (req, res) => {
	res.send("Roblox Value Proxy is running. Use /avatar-value?userId=123");
});

app.listen(PORT, () => {
	console.log(`Proxy server listening on port ${PORT}`);
});
