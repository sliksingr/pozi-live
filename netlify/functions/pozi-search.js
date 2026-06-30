// netlify/functions/pozi-search.js
// Secure POZi → DataForSEO proxy.
// Retail-only filtered search for POZi sourcing results.

const DATAFORSEO_ENDPOINT =
  "https://api.dataforseo.com/v3/serp/google/organic/live/regular";

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

  if (!query) {
    return jsonResponse(400, {
      ok: false,
      error: "Missing search query."
    });
  }

  const depth = Number(payload.depth || 30);
  const retailKeyword = makeRetailKeyword(query, location);

  const dataForSeoBody = [
    {
      keyword: retailKeyword,
      location_name: location,
      language_name: language,
      device: "desktop",
      os: "windows",
      depth
    }
  ];

  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  try {
    console.log("Sending retail-filtered request to DataForSEO:", {
      original_query: query,
      retail_keyword: retailKeyword,
      location,
      language,
      depth
    });

    const response = await fetch(DATAFORSEO_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(dataForSeoBody)
    });

    const raw = await response.json();

    console.log(
      "DataForSEO raw response:",
      JSON.stringify(raw).slice(0, 1200)
    );

    if (!response.ok) {
      console.error("DataForSEO HTTP error:", {
        status: response.status,
        statusText: response.statusText,
        raw
      });

      return jsonResponse(response.status, {
        ok: false,
        error:
          raw?.status_message ||
          raw?.tasks?.[0]?.status_message ||
          raw?.message ||
          "DataForSEO request failed.",
        dataforseo_status: raw?.status_code || null,
        dataforseo_message: raw?.status_message || null,
        dataforseo: raw
      });
    }

    const results = simplifyOrganicResults(raw);

    return jsonResponse(200, {
      ok: true,
      query,
      retail_keyword: retailKeyword,
      location,
      source: "dataforseo_google_organic_retail_filtered",
      count: results.length,
      results
    });
  } catch (error) {
    console.error("POZi Search server error:", error);

    return jsonResponse(500, {
      ok: false,
      error: error.message || "Unknown server error."
    });
  }
};
