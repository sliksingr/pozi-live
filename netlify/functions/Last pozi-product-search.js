// netlify/functions/pozi-product-search.js
// Secure POZi → DataForSEO Google Shopping / Merchant product search proxy.

const DATAFORSEO_TASK_POST =
  "https://api.dataforseo.com/v3/merchant/google/products/task_post";

const DATAFORSEO_TASK_GET =
  "https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced";

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

function simplifyShoppingResults(raw) {
  const tasks = raw?.tasks || [];
  const resultBlocks = tasks[0]?.result || [];
  const firstResult = resultBlocks[0] || {};
  const items = firstResult.items || [];

  return items
    .filter((item) => item && (item.title || item.product_title || item.name))
    .slice(0, 16)
    .map((item, index) => {
      const url = firstValue(
        item.url,
        item.link,
        item.product_url,
        item.merchant_url,
        item.shopping_url
      );

      return {
        title: firstValue(item.title, item.product_title, item.name, "POZi product"),
        url,
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
    });
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

  const taskBody = [
    {
      keyword: query,
      location_name: location,
      language_name: language,
      depth,
      priority: 2
    }
  ];

  try {
    const post = await dataForSeoFetch(
      DATAFORSEO_TASK_POST,
      login,
      password,
      taskBody
    );

    if (!post.response.ok || post.data?.status_code >= 40000) {
      return jsonResponse(post.response.status || 500, {
        ok: false,
        error:
          post.data?.status_message ||
          post.data?.tasks?.[0]?.status_message ||
          "DataForSEO product task creation failed.",
        dataforseo: post.data
      });
    }

    const taskId = post.data?.tasks?.[0]?.id;

    if (!taskId) {
      return jsonResponse(500, {
        ok: false,
        error: "DataForSEO did not return a product task ID.",
        dataforseo: post.data
      });
    }

    let finalData = null;

    for (let attempt = 0; attempt < 16; attempt++) {
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

      const taskStatus = task?.status_code;
      if (taskStatus && taskStatus >= 40000 && taskStatus !== 40602) {
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
      message:
        "Product results were not ready quickly enough. POZiGo should fallback to organic search."
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error.message || "Unknown POZi product search server error."
    });
  }
};
