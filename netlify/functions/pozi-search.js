// netlify/functions/pozi-search.js
// Secure POZi → DataForSEO proxy.
// Retail-only filtered search for POZi sourcing results.
//
// SPLIT START/POLL (same fix as pozi-product-search.js): this used to make one
// synchronous call to DataForSEO's "live" endpoint and wait for the whole
// response inside a single Netlify invocation. When DataForSEO ran slow,
// Netlify killed the function at its 10s limit mid-fetch and the search never
// resolved — the intermittent "never loads" searches. Now it uses DataForSEO's
// task-based standard endpoints instead of "live", split the same way:
//   mode:"start" - POST creates the organic search task and returns
//                  { ok, task_id } immediately. No polling. ~1s.
//   mode:"poll"  - POST with task_id checks the task ONCE and returns either
//                  { ok, pending:true } or { ok, pending:false, results:[...] }.
//                  ~1s. The frontend polls this every ~1.5s for up to ~20s.
//
// Same filename and endpoint (/.netlify/functions/pozi-search) as before —
// the two call shapes are distinguished purely by the "mode" field in the
// POST body, exactly like pozi-product-search.js.

const DATAFORSEO_TASK_POST =
  "https://api.dataforseo.com/v3/serp/google/organic/task_post";

const DATAFORSEO_TASK_GET =
  "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced";

// DataForSEO processing states, not terminal failures. Keep polling on these.
// Same codes used across every DataForSEO task-based endpoint, including
// pozi-product-search.js.
const PENDING_TASK_STATUSES = new Set([40601, 40602]);

// SINGLE SOURCE OF TRUTH for approved retailers across the whole backend.
// pozi-product-search.js mirrors this exact list — if you add or remove a store
// here, make the same change there so organic and product stay in lockstep.
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

const INFO_BLOCK_DOMAINS = [
  "wikipedia.org",
  "wiktionary.org",
  "britannica.com",
  "mayoclinic.org",
  "clevelandclinic.org",
  "webmd.com",
  "healthline.com",
  "nih.gov",
  "ncbi.nlm.nih.gov",
  "cdc.gov",
  "epa.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "sciencedirect.com",
  "springer.com",
  "researchgate.net",
  "journal",
  "vinylinfo.org",
  "ecocenter.org"
];

const INFO_BLOCK_KEYWORDS = [
  "wikipedia",
  "definition",
  "meaning",
  "symptoms",
  "disease",
  "medical",
  "health",
  "risks",
  "risk",
  "toxic",
  "toxicity",
  "environmental",
  "study",
  "research",
  "properties",
  "benefits",
  "uses",
  "what is",
  "history of",
  "cited by",
  "abstract"
];

// Strong, shopping-specific signals. A non-approved domain needs only ONE of
// these — they almost never appear outside a real store or product page, and
// they include the local-store cues (near me, store locator, in-store pickup)
// that POZi wants to surface.
const STRONG_RETAIL_SIGNALS = [
  "add to cart",
  "add to bag",
  "in stock",
  "out of stock",
  "in-store",
  "store pickup",
  "pick up in store",
  "buy online pick up",
  "free shipping",
  "buy now",
  "checkout",
  "store locator",
  "find a store",
  "near me",
  "aisle",
  "sku",
  "$"
];

// Weak signals: generic retail words that also show up in articles and blog
// posts. One alone is NOT enough (an article about a "pipe" or a "tool" must not
// qualify) — a non-approved domain must show at least TWO of these.
const WEAK_RETAIL_SIGNALS = [
  "buy",
  "shop",
  "shopping",
  "price",
  "prices",
  "pickup",
  "delivery",
  "store",
  "stores",
  "department",
  "product",
  "products",
  "supply",
  "supplies",
  "hardware",
  "lumber",
  "tool",
  "tools"
];

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const REQUEST_TIMEOUT_MS = clampInteger(
  process.env.POZI_SEARCH_REQUEST_TIMEOUT_MS,
  3000,
  30000,
  12000
);

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

function normalizeDomain(domainOrUrl) {
  return String(domainOrUrl || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
}

function domainMatches(domain, list) {
  const d = normalizeDomain(domain);
  return list.some((allowed) => {
    const a = normalizeDomain(allowed);
    // Exact match or true subdomain only. The old `d.includes(a)` check let
    // lookalike/typosquat domains (e.g. "target.com.example.net") pass.
    return d === a || d.endsWith("." + a);
  });
}

function textContainsAny(text, list) {
  const t = String(text || "").toLowerCase();
  return list.some((word) => t.includes(String(word).toLowerCase()));
}

function countMatches(text, list) {
  const t = String(text || "").toLowerCase();
  return list.reduce(
    (count, word) => count + (t.includes(String(word).toLowerCase()) ? 1 : 0),
    0
  );
}

function looksRetail(item) {
  const domain = normalizeDomain(item.domain || item.url);
  const text = [
    item.title || "",
    item.description || "",
    item.url || "",
    item.breadcrumb || "",
    domain
  ].join(" ").toLowerCase();

  if (!domain) return false;

  if (domainMatches(domain, INFO_BLOCK_DOMAINS)) return false;
  if (textContainsAny(text, INFO_BLOCK_KEYWORDS)) return false;

  // Approved retailer domain → always treated as a real store.
  if (domainMatches(domain, RETAIL_ALLOW_DOMAINS)) return true;

  // Any other domain must look like an actual store/product page: either one
  // strong buying signal, or at least two weaker retail signals. A single
  // generic keyword ("pipe", "tool", "product") no longer qualifies a page.
  const strong = countMatches(text, STRONG_RETAIL_SIGNALS);
  const weak = countMatches(text, WEAK_RETAIL_SIGNALS);

  return strong >= 1 || weak >= 2;
}

function retailScore(item) {
  const domain = normalizeDomain(item.domain || item.url);
  const text = [
    item.title || "",
    item.description || "",
    item.url || "",
    item.breadcrumb || "",
    domain
  ].join(" ").toLowerCase();

  let score = 0;

  if (domainMatches(domain, RETAIL_ALLOW_DOMAINS)) score += 100;
  if (text.includes("in stock")) score += 20;
  if (text.includes("pickup")) score += 18;
  if (text.includes("delivery")) score += 12;
  if (text.includes("buy")) score += 10;
  if (text.includes("shop")) score += 10;
  if (text.includes("price")) score += 8;
  if (text.includes("near me")) score += 8;
  if (text.includes("store")) score += 6;
  if (text.includes("products")) score += 6;
  if (item.rank_absolute) score += Math.max(0, 20 - Number(item.rank_absolute));

  return score;
}

function simplifyOrganicResults(data) {
  const tasks = data?.tasks || [];
  const firstResult = tasks[0]?.result?.[0];
  const items = firstResult?.items || [];

  const organic = items
    .filter((item) => item.type === "organic" && item.url)
    .map((item) => ({
      title: item.title || "",
      url: item.url || "",
      domain: normalizeDomain(item.domain || item.url),
      description: item.description || "",
      rank: item.rank_absolute || item.rank_group || null,
      breadcrumb: item.breadcrumb || ""
    }));

  const retailOnly = organic
    .filter(looksRetail)
    .sort((a, b) => retailScore(b) - retailScore(a))
    .slice(0, 12);

  return retailOnly;
}

function makeRetailKeyword(query, location) {
  const cleanQuery = String(query || "").trim();
  const cleanLocation = String(location || "").trim();

  let keyword = cleanQuery;

  const alreadyRetail =
    /\b(buy|shop|price|store|stores|near me|pickup|delivery|in stock)\b/i.test(
      keyword
    );

  if (!alreadyRetail) {
    keyword = `${keyword} buy in store pickup`;
  }

  if (
    cleanLocation &&
    cleanLocation.toLowerCase() !== "united states" &&
    !keyword.toLowerCase().includes(cleanLocation.toLowerCase())
  ) {
    keyword = `${keyword} near ${cleanLocation}`;
  }

  return keyword;
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

// ── mode:"start" — create the task and return immediately, no polling ────────
async function handleStart(payload, login, password) {
  const query = String(payload.query || "").trim();
  const location = String(payload.location || "United States").trim();
  const language = String(payload.language || "English").trim();
  const depth = clampInteger(payload.depth, 1, 100, 30);

  if (!query) {
    return jsonResponse(400, { ok: false, error: "Missing search query." });
  }

  const retailKeyword = makeRetailKeyword(query, location);

  const taskBody = [
    {
      keyword: retailKeyword,
      location_name: location,
      language_name: language,
      device: "desktop",
      os: "windows",
      depth
    }
  ];

  try {
    console.log("Starting retail-filtered organic task:", {
      original_query: query,
      retail_keyword: retailKeyword,
      location,
      language,
      depth
    });

    const post = await dataForSeoFetch(DATAFORSEO_TASK_POST, login, password, taskBody);

    const postTopStatus = Number(post.data?.status_code || 0);
    const postTask = post.data?.tasks?.[0];
    const postTaskStatus = Number(postTask?.status_code || 0);

    if (!post.response.ok || postTopStatus >= 40000 || postTaskStatus >= 40000) {
      console.error("DataForSEO organic task creation error:", post.data);
      return jsonResponse(post.response.ok ? 502 : post.response.status, {
        ok: false,
        error: getDataForSeoError(post.data, "DataForSEO organic task creation failed."),
        dataforseo_status: postTaskStatus || postTopStatus || null
      });
    }

    const taskId = postTask?.id;
    if (!taskId) {
      return jsonResponse(502, {
        ok: false,
        error: "DataForSEO did not return an organic task ID."
      });
    }

    return jsonResponse(200, {
      ok: true,
      pending: true,
      task_id: taskId,
      query,
      retail_keyword: retailKeyword,
      location,
      source: "dataforseo_google_organic_retail_filtered"
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.error("POZi search (start) error:", error);
    return jsonResponse(timedOut ? 504 : 500, {
      ok: false,
      error: timedOut
        ? "POZi search task creation timed out."
        : error?.message || "Unknown POZi search server error."
    });
  }
}

// ── mode:"poll" — check the task exactly ONCE, no internal loop ──────────────
async function handlePoll(payload, login, password) {
  const taskId = String(payload.task_id || "").trim();

  if (!taskId) {
    return jsonResponse(400, { ok: false, error: "Missing task_id for search poll." });
  }

  try {
    const get = await dataForSeoFetch(
      `${DATAFORSEO_TASK_GET}/${encodeURIComponent(taskId)}`,
      login,
      password
    );

    if (!get.response.ok) {
      return jsonResponse(200, {
        ok: true,
        pending: true,
        task_id: taskId,
        message: getDataForSeoError(get.data, "DataForSEO organic result request failed.")
      });
    }

    console.log(
      "DataForSEO organic poll response:",
      JSON.stringify(get.data).slice(0, 1200)
    );

    const topStatus = Number(get.data?.status_code || 0);
    const task = get.data?.tasks?.[0];
    const taskStatus = Number(task?.status_code || 0);
    const taskMessage = task?.status_message || get.data?.status_message || "";

    // Terminal error.
    if (topStatus >= 40000 || taskStatus >= 40000) {
      // ...but not a "still processing" code — those fall through to pending below.
      if (!PENDING_TASK_STATUSES.has(taskStatus)) {
        return jsonResponse(502, {
          ok: false,
          error: taskMessage || "DataForSEO organic task returned an error.",
          dataforseo_status: taskStatus || topStatus || null,
          task_id: taskId
        });
      }
    }

    // 40601 / 40602 are still processing — the frontend will poll again.
    if (PENDING_TASK_STATUSES.has(taskStatus)) {
      return jsonResponse(200, { ok: true, pending: true, task_id: taskId, dataforseo_status: taskStatus });
    }

    // Task completed — return results (possibly empty; that's a valid outcome).
    if (taskStatus === 20000 && Array.isArray(task?.result)) {
      const results = simplifyOrganicResults(get.data);
      return jsonResponse(200, {
        ok: true,
        pending: false,
        task_id: taskId,
        source: "dataforseo_google_organic_retail_filtered",
        count: results.length,
        results
      });
    }

    // Anything else unrecognized: treat as still-processing rather than fail —
    // the frontend's own ~20s budget is the real backstop.
    return jsonResponse(200, {
      ok: true,
      pending: true,
      task_id: taskId,
      dataforseo_status: taskStatus || topStatus || null
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.error("POZi search (poll) error:", error);
    return jsonResponse(timedOut ? 504 : 500, {
      ok: false,
      error: timedOut
        ? "POZi search poll timed out."
        : error?.message || "Unknown POZi search server error."
    });
  }
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

  const mode = String(payload.mode || "").trim().toLowerCase();

  if (mode === "start") return handleStart(payload, login, password);
  if (mode === "poll") return handlePoll(payload, login, password);

  return jsonResponse(400, {
    ok: false,
    error: 'Missing or invalid "mode" — expected "start" or "poll".'
  });
};
