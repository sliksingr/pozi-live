// netlify/functions/pozi-product-search.js
// Secure POZi → DataForSEO Google Shopping / Merchant product search proxy.

const DATAFORSEO_TASK_POST =
  "https://api.dataforseo.com/v3/merchant/google/products/task_post";

const DATAFORSEO_TASK_GET =
  "https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced";

// DataForSEO statuses that mean "still processing" — NOT terminal errors.
// 40601 = Task Handed, 40602 = Task In Queue. Polling must continue on these.
const PENDING_STATUSES = new Set([40601, 40602]);

// Approved-retailer policy. SINGLE SOURCE OF TRUTH is pozi-search.js — keep this
// list identical to RETAIL_ALLOW_DOMAINS there. Product cards are now held to the
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

// Retailer name tokens derived from the allow list (domain minus its TLD). Google
// Shopping exposes the seller as a NAME or a redirect URL more often than a clean
// domain, so we also match these tokens against the seller / domain / url text.
const RETAIL_ALLOW_TOKENS = RETAIL_ALLOW_DOMAINS.map((d) => d.split(".")[0]);

function normalizeDomain(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
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

  // Otherwise match a retailer token against the seller name / domain / url only
  // (never the product title, which is just the item name).
  const hay = [row.store, row.domain, row.url]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");

  return RETAIL_ALLOW_TOKENS.some(
    (token) => token.length >= 4 && hay.includes(token)
  );
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
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

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

function getImageUrl(item) {
  const possible =
    item.image_url ||
    item.image ||
    item.thumbnail ||
    item.thumbnail_url ||
    item.product_image ||
    item.product_image_url ||
    item.main_image ||
    item.main_image_url;

  if (possible) return possible;

  if (Array.isArray(item.images) && item.images.length) {
    return typeof item.images[0] === "string"
      ? item.images[0]
      : item.images[0]?.url || "";
  }

  if (Array.isArray(item.product_images) && item.product_images.length) {
    return typeof item.product_images[0] === "string"
      ? item.product_images[0]
      : item.product_images[0]?.url || "";
  }

  return "";
}

function formatPriceValue(value, currency = "") {
  if (value === undefined || value === null || value === "") return "";

  if (typeof value === "number") {
    const prefix =
      currency === "USD" || currency === "$"
        ? "$"
        : currency
          ? `${currency} `
          : "$";

    return `${prefix}${value.toFixed(2)}`;
  }

  const text = String(value).trim();
  if (!text) return "";

  if (text.includes("$")) return text;

  const numberLike = Number(text.replace(/[^0-9.]/g, ""));

  if (Number.isFinite(numberLike) && /[0-9]/.test(text)) {
    const prefix =
      currency === "USD" || currency === "$"
        ? "$"
        : currency
          ? `${currency} `
          : "$";

    return `${prefix}${numberLike.toFixed(2)}`;
  }

  return text;
}

function normalizePrice(item) {
  const currency = firstValue(
    item.currency,
    item.price_currency,
    item.currency_code,
    item.price?.currency
  );

  if (item.price !== undefined && item.price !== null) {
    if (typeof item.price === "string" || typeof item.price === "number") {
      return formatPriceValue(item.price, currency);
    }

    if (typeof item.price === "object") {
      const value = firstValue(
        item.price.current,
        item.price.value,
        item.price.amount,
        item.price.regular,
        item.price.sale,
        item.price.base,
        item.price.price,
        item.price.displayed
      );

      if (value) return formatPriceValue(value, currency);
    }
  }

  const value = firstValue(
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

  return formatPriceValue(value, currency);
}

// Prefer DataForSEO's supported Google Shopping product-page field. The direct
// `url` field is documented as deprecated and can be null, so it goes last.
function getProductUrl(item) {
  return firstValue(
    item.shopping_url,
    item.product_url,
    item.merchant_url,
    item.link,
    item.url
  );
}

function simplifyShoppingResults(raw) {
  const tasks = raw?.tasks || [];
  const resultBlocks = tasks[0]?.result || [];
  const firstResult = resultBlocks[0] || {};

  // Flatten nested Shopping carousels/groups: some elements are containers that
  // hold their own `items` array of products. Pull those products up to the top
  // level so they aren't missed. Container elements with no title are dropped by
  // the title filter below.
  const items = (firstResult.items || []).flatMap((it) =>
    it && Array.isArray(it.items) && it.items.length ? [it, ...it.items] : [it]
  );

  return items
    .filter((item) => item && (item.title || item.product_title || item.name))
    .map((item, index) => {
      return {
        title: firstValue(item.title, item.product_title, item.name, "POZi product"),
        url: getProductUrl(item),
        image_url: getImageUrl(item),
        price: normalizePrice(item),
        store: firstValue(
          item.seller,
          item.shop_name,
          item.merchant,
          item.source,
          item.domain,
          item.website,
          "Retail result"
        ),
        domain: firstValue(item.domain, item.website, item.source),
        description: firstValue(
          item.description,
          item.snippet,
          item.product_description,
          item.details,
          item.delivery_info
        ),
        rating: firstValue(item.rating, item.product_rating),
        reviews_count: firstValue(item.reviews_count, item.review_count),
        product_id: firstValue(item.product_id, item.gid),
        rank: firstValue(item.rank_group, item.rank_absolute, item.rank, index + 1),
        source: "dataforseo_google_shopping"
      };
    })
    // Drop products with no usable link (no dead href="#" cards) and any seller
    // that isn't an approved retailer (organic + product now share one policy).
    .filter((row) => row.title && row.url && isApprovedRetailer(row))
    .slice(0, 16);
}

async function dataForSeoFetch(url, login, password, body = null) {
  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  const options = {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  return { response, data };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "Method not allowed. Use POST."
    });
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
    return jsonResponse(400, {
      ok: false,
      error: "Invalid JSON body."
    });
  }

  const query = String(payload.query || "").trim();
  const location = String(payload.location || "United States").trim();
  const language = String(payload.language || "English").trim();
  const depth = Math.min(Number(payload.depth || 10), 40);

  if (!query) {
    return jsonResponse(400, {
      ok: false,
      error: "Missing product search query."
    });
  }

  // priority 2 = high-priority (faster) but carries an extra DataForSEO charge.
  // Set DATAFORSEO_PRIORITY=1 in Netlify to use standard priority and save cost.
  const priority = Number(process.env.DATAFORSEO_PRIORITY || 2);

  const taskBody = [
    {
      keyword: query,
      location_name: location,
      language_name: language,
      depth,
      priority
    }
  ];

  try {
    const post = await dataForSeoFetch(
      DATAFORSEO_TASK_POST,
      login,
      password,
      taskBody
    );

    // Catch both account-level (auth/balance) and task-level (bad params) errors
    // up front. 40601/40602 are pending, not failures, so they don't count here.
    const postTask = post.data?.tasks?.[0];
    const postTaskStatus = Number(postTask?.status_code) || 0;
    const postTaskFailed =
      postTaskStatus >= 40000 && !PENDING_STATUSES.has(postTaskStatus);

    if (!post.response.ok || post.data?.status_code >= 40000 || postTaskFailed) {
      return jsonResponse(post.response.status || 500, {
        ok: false,
        error:
          postTask?.status_message ||
          post.data?.status_message ||
          "DataForSEO product task creation failed.",
        dataforseo: post.data
      });
    }

    const taskId = postTask?.id;

    if (!taskId) {
      return jsonResponse(500, {
        ok: false,
        error: "DataForSEO did not return a product task ID.",
        dataforseo: post.data
      });
    }

    // Stop polling before any Netlify function timeout can hard-kill us, so the
    // client always gets a clean response and can fall back to organic. Raise
    // PRODUCT_MAX_POLL_MS once netlify.toml confirms a 60s function tier.
    const MAX_POLL_MS = Number(process.env.PRODUCT_MAX_POLL_MS || 23000);
    const pollStartedAt = Date.now();

    let finalData = null;
    let lastTaskError = null;

    for (let attempt = 0; attempt < 16; attempt++) {
      if (Date.now() - pollStartedAt > MAX_POLL_MS) break;

      await sleep(attempt === 0 ? 1200 : 2000);

      const get = await dataForSeoFetch(
        `${DATAFORSEO_TASK_GET}/${taskId}`,
        login,
        password
      );

      finalData = get.data;

      const task = finalData?.tasks?.[0];
      const result = task?.result?.[0];
      const items = result?.items || [];

      if (Array.isArray(items) && items.length > 0) {
        const results = simplifyShoppingResults(finalData);

        return jsonResponse(200, {
          ok: true,
          query,
          location,
          source: "dataforseo_google_shopping",
          task_id: taskId,
          count: results.length,
          results
        });
      }

      const taskStatus = Number(task?.status_code) || 0;

      // 40601 (Task Handed) and 40602 (Task In Queue) are STILL PENDING — keep
      // polling. Only break on a genuine terminal error.
      if (taskStatus >= 40000 && !PENDING_STATUSES.has(taskStatus)) {
        lastTaskError = task?.status_message || `DataForSEO task status ${taskStatus}`;
        break;
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
      task_error: lastTaskError,
      message: lastTaskError
        ? `Product task error: ${lastTaskError}. POZiGo will fall back to organic search.`
        : "Product results were not ready quickly enough. POZiGo should fallback to organic search."
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error.message || "Unknown POZi product search server error."
    });
  }
};
