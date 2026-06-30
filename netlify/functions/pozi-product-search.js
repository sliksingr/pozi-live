// netlify/functions/pozi-product-search.js
// POZi rich-pass product search using DataForSEO Google Shopping / Merchant API.
//
// Retailer policy is CLOSED: only approved retailers pass (allow-list), matching
// pozi-search.js and the frontend. The backend is the single source of truth.
//
// Flow:
// 1. Create a Google Shopping task.
// 2. Poll briefly while the fast organic POZi search is already visible.
// 3. Flatten all returned Shopping result groups/carousels (recursively).
// 4. Return normalized product cards (approved retailers only) with store,
//    price, image, and link.
// 5. If cards are not ready in time, return pending:true so the app keeps the
//    organic retailer links visible.

const DATAFORSEO_TASK_POST =
  "https://api.dataforseo.com/v3/merchant/google/products/task_post";

const DATAFORSEO_TASK_GET =
  "https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced";

// DataForSEO processing states, not terminal failures. Keep polling on these.
const PENDING_TASK_STATUSES = new Set([40601, 40602]);

// Approved-retailer policy. SINGLE SOURCE OF TRUTH is pozi-search.js — keep this
// list identical to RETAIL_ALLOW_DOMAINS there. Product cards are held to the
// same standard as organic results: approved retailers only, nothing online-only.
const RETAIL_ALLOW_DOMAINS = [
  "homedepot.com",
  "lowes.com",
  "acehardware.com",
  "walmart.com",
  "target.com",
  "bestbuy.com",
  "tractorsupply.com",
  "truevalue.com",
  "harborfreight.com",
  "flooranddecor.com",
  "menards.com",
  "grainger.com",
  "fastenal.com",
  "ferguson.com",
  "sherwin-williams.com",
  "autozone.com",
  "oreillyauto.com",
  "napaonline.com",
  "costco.com",
  "samsclub.com",
  "staples.com",
  "officedepot.com"
];

// Retailer name tokens derived from the allow list (domain minus its TLD, with
// punctuation stripped). Google Shopping exposes the seller as a spaced NAME or a
// redirect URL more often than a clean domain, so these are matched against a
// space/punctuation-stripped haystack ("The Home Depot" -> "thehomedepot").
const RETAIL_ALLOW_TOKENS = RETAIL_ALLOW_DOMAINS.map((d) =>
  d.split(".")[0].replace(/[^a-z0-9]/g, "")
);

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const POLL_ATTEMPTS = clampInteger(process.env.POZI_PRODUCT_POLL_ATTEMPTS, 1, 20, 10);

const FIRST_POLL_DELAY_MS = clampInteger(
  process.env.POZI_PRODUCT_FIRST_POLL_DELAY_MS,
  500,
  5000,
  1200
);

const POLL_INTERVAL_MS = clampInteger(
  process.env.POZI_PRODUCT_POLL_INTERVAL_MS,
  500,
  5000,
  1500
);

const REQUEST_TIMEOUT_MS = clampInteger(
  process.env.POZI_PRODUCT_REQUEST_TIMEOUT_MS,
  3000,
  30000,
  12000
);

// Overall polling budget. 23s is safe on every Netlify function tier (even the
// older 26s cap). Raise this env var if you confirm a 60s tier and want to catch
// slower tasks — but also raise POZI_PRODUCT_POLL_ATTEMPTS, since the loop stops
// at whichever limit it hits first.
const MAX_TOTAL_POLL_MS = clampInteger(
  process.env.POZI_PRODUCT_MAX_POLL_MS,
  5000,
  50000,
  23000
);

// priority 2 = high-priority (faster) but carries an extra DataForSEO charge.
// Set DATAFORSEO_PRIORITY=1 in Netlify to use standard priority and save cost.
const TASK_PRIORITY = clampInteger(process.env.DATAFORSEO_PRIORITY, 1, 2, 2);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns the first usable scalar. Rejects objects/arrays so nested shapes can
// never leak into a card field as "[object Object]".
function firstScalar(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return "";
}

function normalizeDomain(domainOrUrl) {
  const text = String(domainOrUrl || "").trim().toLowerCase();
  if (!text) return "";

  try {
    const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    return new URL(candidate).hostname.replace(/^www\./, "");
  } catch {
    return text
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .trim();
  }
}

function getStore(item) {
  return firstScalar(
    item.seller,
    item.shop_name,
    item.merchant,
    item.source,
    item.domain,
    item.website,
    "Retail result"
  );
}

function isApprovedRetailer(row) {
  // Exact or true-subdomain match when DataForSEO gives a real merchant domain.
  const domain = normalizeDomain(row.domain || row.url);
  if (
    domain &&
    RETAIL_ALLOW_DOMAINS.some((a) => domain === a || domain.endsWith("." + a))
  ) {
    return true;
  }

  // Fallback: match a retailer name token against the seller / domain / url with
  // spaces and punctuation stripped out. The product title is deliberately
  // excluded — it is just the item name, not the seller.
  const compact = [row.store, row.domain, row.url]
    .map((v) => String(v || "").toLowerCase())
    .join(" ")
    .replace(/[^a-z0-9]/g, "");

  return RETAIL_ALLOW_TOKENS.some(
    (token) => token.length >= 4 && compact.includes(token)
  );
}

function getImageUrl(item) {
  const direct = [
    item.image_url,
    item.image,
    item.thumbnail,
    item.thumbnail_url,
    item.product_image,
    item.product_image_url,
    item.main_image,
    item.main_image_url
  ];

  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === "object") {
      const nested = firstScalar(candidate.url, candidate.image_url, candidate.src);
      if (nested) return nested;
    }
  }

  for (const list of [item.images, item.product_images]) {
    if (!Array.isArray(list) || !list.length) continue;
    const first = list[0];
    if (typeof first === "string" && first.trim()) {
      return first.trim();
    }
    if (first && typeof first === "object") {
      const nested = firstScalar(first.url, first.image_url, first.src);
      if (nested) return nested;
    }
  }

  return "";
}

function formatPriceValue(value, currency = "") {
  if (value === undefined || value === null || value === "") return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    const prefix =
      currency === "USD" || currency === "$" ? "$" : currency ? `${currency} ` : "$";
    return `${prefix}${value.toFixed(2)}`;
  }

  const text = String(value).trim();
  if (!text || text === "[object Object]") return "";
  if (text.includes("$")) return text;

  const numeric = Number(text.replace(/[^0-9.-]/g, ""));
  if (Number.isFinite(numeric) && /\d/.test(text)) {
    const prefix =
      currency === "USD" || currency === "$" ? "$" : currency ? `${currency} ` : "$";
    return `${prefix}${numeric.toFixed(2)}`;
  }

  return text;
}

function normalizePrice(item) {
  const currency = firstScalar(
    item.currency,
    item.price_currency,
    item.currency_code,
    item.price?.currency
  );

  if (typeof item.price === "number" || typeof item.price === "string") {
    return formatPriceValue(item.price, currency);
  }

  if (item.price && typeof item.price === "object") {
    const nested = firstScalar(
      item.price.current,
      item.price.value,
      item.price.amount,
      item.price.sale,
      item.price.regular,
      item.price.base,
      item.price.displayed,
      item.price.displayed_price
    );
    if (nested !== "") return formatPriceValue(nested, currency);
  }

  const fallback = firstScalar(
    item.price_value,
    item.price_amount,
    item.price_displayed,
    item.price_text,
    item.sale_price,
    item.current_price,
    item.offer_price,
    item.base_price,
    item.total_price,
    item.price_from,
    item.extracted_price,
    item.extracted_price_value
  );

  return formatPriceValue(fallback, currency);
}

function normalizeRating(item) {
  if (typeof item.rating === "number" || typeof item.rating === "string") {
    return item.rating;
  }
  if (item.rating && typeof item.rating === "object") {
    return firstScalar(item.rating.value, item.rating.rating, item.rating.score);
  }
  if (item.product_rating && typeof item.product_rating === "object") {
    return firstScalar(
      item.product_rating.value,
      item.product_rating.rating,
      item.product_rating.score
    );
  }
  return firstScalar(item.product_rating, item.shop_rating?.value);
}

function normalizeReviewCount(item) {
  return firstScalar(
    item.reviews_count,
    item.review_count,
    item.product_rating?.votes_count,
    item.shop_rating?.votes_count
  );
}

function normalizeDescription(item) {
  const direct = firstScalar(
    item.description,
    item.snippet,
    item.product_description,
    item.details
  );
  if (direct) return direct;

  if (item.delivery_info && typeof item.delivery_info === "object") {
    return firstScalar(
      item.delivery_info.delivery_message,
      item.delivery_info.message,
      item.delivery_info.displayed_text
    );
  }

  return firstScalar(item.delivery_info, item.shipping, item.condition);
}

function getProductUrl(item) {
  // Prefer the supported Shopping URL. Older direct URL fields are fallbacks.
  return firstScalar(
    item.shopping_url,
    item.product_url,
    item.merchant_url,
    item.link,
    item.url,
    item.special_offer_info?.url
  );
}

function looksLikeProduct(item) {
  const title = firstScalar(item?.title, item?.product_title, item?.name);
  if (!title) return false;

  return Boolean(
    firstScalar(item?.seller, item?.shop_name, item?.merchant) ||
      item?.price !== undefined ||
      item?.product_id ||
      item?.gid ||
      item?.data_docid ||
      getImageUrl(item) ||
      getProductUrl(item)
  );
}

// Recursively pull products out of nested Shopping groups / carousels.
function flattenShoppingItems(items, output = []) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    if (looksLikeProduct(item)) output.push(item);
    if (Array.isArray(item.items)) flattenShoppingItems(item.items, output);
  }
  return output;
}

function collectShoppingItems(raw) {
  const resultBlocks = raw?.tasks?.[0]?.result || [];
  const topLevelItems = resultBlocks.flatMap((block) =>
    Array.isArray(block?.items) ? block.items : []
  );
  return flattenShoppingItems(topLevelItems);
}

function simplifyShoppingResults(raw) {
  const items = collectShoppingItems(raw);
  const seen = new Set();

  return items
    .map((item, index) => {
      const title = firstScalar(item.title, item.product_title, item.name, "POZi product");
      const url = getProductUrl(item);
      const store = getStore(item);
      const domain = firstScalar(item.domain, item.website, normalizeDomain(url));

      const row = {
        title,
        url,
        image_url: getImageUrl(item),
        price: normalizePrice(item),
        store,
        domain,
        description: normalizeDescription(item),
        rating: normalizeRating(item),
        reviews_count: normalizeReviewCount(item),
        product_id: firstScalar(item.product_id, item.gid, item.data_docid),
        rank: firstScalar(item.rank_group, item.rank_absolute, item.rank, index + 1),
        source: "dataforseo_google_shopping"
      };

      return { item, row };
    })
    // Must have a title and a usable link (no dead href="#" cards).
    .filter(({ row }) => row.title && row.url)
    // Approved retailers only — same closed policy as organic search.
    .filter(({ row }) => isApprovedRetailer(row))
    // Drop duplicate products.
    .filter(({ row }) => {
      const key = String(
        row.product_id || `${row.store}|${row.title}|${row.url}`
      ).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ row }) => row)
    .slice(0, 16);
}

async function dataForSeoFetch(url, login, password, body = null) {
  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const options = {
      method: body ? "POST" : "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      }
    };

    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const rawText = await response.text();

    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }

    return { response, data, rawText };
  } finally {
    clearTimeout(timer);
  }
}

function getDataForSeoError(data, fallback) {
  return data?.tasks?.[0]?.status_message || data?.status_message || fallback;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    return jsonResponse(500, {
      ok: false,
      error:
        "Missing DataForSEO credentials. Add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in Netlify environment variables."
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body." });
  }

  const query = String(payload.query || "").trim();
  const location = String(payload.location || "United States").trim();
  const language = String(payload.language || "English").trim();
  const depth = clampInteger(payload.depth, 1, 40, 10);

  if (!query) {
    return jsonResponse(400, { ok: false, error: "Missing product search query." });
  }

  if (query.length > 700) {
    return jsonResponse(413, { ok: false, error: "Product search query is too long." });
  }

  const taskBody = [
    {
      keyword: query,
      location_name: location,
      language_name: language,
      depth,
      priority: TASK_PRIORITY
    }
  ];

  try {
    const post = await dataForSeoFetch(DATAFORSEO_TASK_POST, login, password, taskBody);

    const postTopStatus = Number(post.data?.status_code || 0);
    const postTask = post.data?.tasks?.[0];
    const postTaskStatus = Number(postTask?.status_code || 0);

    if (!post.response.ok || postTopStatus >= 40000 || postTaskStatus >= 40000) {
      return jsonResponse(post.response.ok ? 502 : post.response.status, {
        ok: false,
        error: getDataForSeoError(post.data, "DataForSEO product task creation failed."),
        dataforseo_status: postTaskStatus || postTopStatus || null
      });
    }

    const taskId = postTask?.id;
    if (!taskId) {
      return jsonResponse(502, {
        ok: false,
        error: "DataForSEO did not return a product task ID."
      });
    }

    const pollStartedAt = Date.now();
    let lastTaskStatus = null;
    let lastTaskMessage = "";

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const delay = attempt === 0 ? FIRST_POLL_DELAY_MS : POLL_INTERVAL_MS;

      // Stop before the budget so we always return cleanly (never a hard kill).
      if (Date.now() - pollStartedAt + delay > MAX_TOTAL_POLL_MS) break;

      await sleep(delay);

      const get = await dataForSeoFetch(
        `${DATAFORSEO_TASK_GET}/${encodeURIComponent(taskId)}`,
        login,
        password
      );

      if (!get.response.ok) {
        lastTaskMessage = getDataForSeoError(
          get.data,
          "DataForSEO product result request failed."
        );
        continue;
      }

      const topStatus = Number(get.data?.status_code || 0);
      const task = get.data?.tasks?.[0];
      const taskStatus = Number(task?.status_code || 0);

      lastTaskStatus = taskStatus || topStatus || null;
      lastTaskMessage = task?.status_message || get.data?.status_message || "";

      const rawItems = collectShoppingItems(get.data);

      if (rawItems.length > 0) {
        const results = simplifyShoppingResults(get.data);

        return jsonResponse(200, {
          ok: true,
          pending: false,
          query,
          location,
          source: "dataforseo_google_shopping",
          task_id: taskId,
          count: results.length,
          results
        });
      }

      // 40601 / 40602 are still processing — keep polling.
      if (PENDING_TASK_STATUSES.has(taskStatus)) continue;

      // Genuine terminal error — surface it.
      if (topStatus >= 40000 || taskStatus >= 40000) {
        return jsonResponse(502, {
          ok: false,
          error: lastTaskMessage || "DataForSEO product task returned an error.",
          dataforseo_status: lastTaskStatus,
          task_id: taskId
        });
      }

      // Task completed cleanly but with no Shopping products.
      if (taskStatus === 20000 && Array.isArray(task?.result)) {
        return jsonResponse(200, {
          ok: true,
          pending: false,
          query,
          location,
          source: "dataforseo_google_shopping",
          task_id: taskId,
          count: 0,
          results: [],
          message: "No Google Shopping product results were returned."
        });
      }
    }

    return jsonResponse(200, {
      ok: true,
      pending: true,
      query,
      location,
      source: "dataforseo_google_shopping",
      task_id: taskId,
      count: 0,
      results: [],
      dataforseo_status: lastTaskStatus,
      message:
        "Product cards were not ready during this request. Keep the organic retailer links visible."
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";

    console.error("POZi product search error:", error);

    return jsonResponse(timedOut ? 504 : 500, {
      ok: false,
      error: timedOut
        ? "POZi product search timed out. Keep the organic retailer links visible."
        : error?.message || "Unknown POZi product search server error."
    });
  }
};
