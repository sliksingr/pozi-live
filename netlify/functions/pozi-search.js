// netlify/functions/pozi-search.js
// Secure POZi → DataForSEO proxy.

const DATAFORSEO_ENDPOINT =
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";

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

function simplifyOrganicResults(data) {
  const tasks = data?.tasks || [];
  const firstResult = tasks[0]?.result?.[0];
  const items = firstResult?.items || [];

  return items
    .filter((item) => item.type === "organic" && item.url)
    .slice(0, 12)
    .map((item) => ({
      title: item.title || "",
      url: item.url || "",
      domain: item.domain || "",
      description: item.description || "",
      rank: item.rank_absolute || item.rank_group || null,
      breadcrumb: item.breadcrumb || ""
    }));
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

  const depth = Number(payload.depth || 10);

  const dataForSeoBody = [
    {
      keyword: query,
      location_name: location,
      language_name: language,
      device: "desktop",
      os: "windows",
      depth
    }
  ];

  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  try {
    console.log("Sending request to DataForSEO:", {
      keyword: query,
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
      location,
      source: "dataforseo_google_organic",
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
