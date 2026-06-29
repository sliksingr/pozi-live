// netlify/functions/usage-status.js
// READ-ONLY BUILDr usage status for the POZi Go account card.
//
// This endpoint NEVER inserts rows, increments counters, calls Anthropic, or enforces a
// request. It only reports what the server currently sees, so the app can show usage on open.
// Enforcement + usage mutation live in buildr-chat.js (and later buildr-vision.js).
//
// Identity + tier + counting logic mirror buildr-chat.js exactly so the numbers always agree.
//
// Required Netlify env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Recommended:
//   SUPABASE_ANON_KEY
// Optional (only once paid-tier storage exists):
//   BUILDR_PROFILE_TABLE
//   BUILDR_PLAN_COLUMN
//   BUILDR_PROFILE_ID_COLUMN     default: id

const BUILDR_DAILY_LIMITS = Object.freeze({ guest: 1, free: 3, consumer: 10, pro: 25 });
const BUILDR_MESSAGES_PER_SESSION = Object.freeze({ guest: 5, free: 5, consumer: 10, pro: 15 });
const BUILDR_VISION_DAILY_LIMITS = Object.freeze({ guest: 0, free: 3, consumer: 10, pro: 25 });
const BUILDR_TEST_UNLIMITED_EMAILS = new Set(["info@pozi.live"]);

function normalizePlanTier(value, hasUser) {
  const tier = String(value || "").toLowerCase().trim();
  if (tier === "pro") return "pro";
  if (["consumer", "consumer_paid", "paid"].includes(tier)) return "consumer";
  if (["free", "free_account"].includes(tier)) return "free";
  if (tier === "guest") return "guest";
  return hasUser ? "free" : "guest";
}

function todayStartISO() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function cleanIdentity(value) {
  return String(value || "").trim().slice(0, 160).replace(/[^a-zA-Z0-9._:@-]/g, "_");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isUnlimitedTestUser(email) {
  return BUILDR_TEST_UNLIMITED_EMAILS.has(normalizeEmail(email));
}

function getClientIp(event) {
  const headers = event?.headers || {};
  const raw = headers["x-nf-client-connection-ip"] || headers["client-ip"] || headers["x-forwarded-for"] || "";
  return String(raw).split(",")[0].trim();
}

function getBearerToken(event) {
  const headers = event?.headers || {};
  const header = headers.authorization || headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function getVerifiedIdentity(token) {
  if (!token) return null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !apiKey) throw new Error("Missing SUPABASE_URL or a Supabase API key for token verification.");

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: apiKey, Authorization: `Bearer ${token}` }
    });

    if (!response.ok) return null;
    const user = await response.json().catch(() => null);
    if (!user?.id) return null;

    return { user_id: String(user.id), user_email: normalizeEmail(user.email) };
  } catch (error) {
    console.warn("Supabase token verification failed:", error?.message || error);
    return null;
  }
}

async function getVerifiedTier(userId) {
  if (!userId) return "guest";

  const table = String(process.env.BUILDR_PROFILE_TABLE || "").trim();
  const planColumn = String(process.env.BUILDR_PLAN_COLUMN || "").trim();
  const idColumn = String(process.env.BUILDR_PROFILE_ID_COLUMN || "id").trim();

  // Paid-tier storage is not configured yet, so verified users safely default to Free.
  if (!table || !planColumn) return "free";

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return "free";

  try {
    const url =
      `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}` +
      `?${encodeURIComponent(idColumn)}=eq.${encodeURIComponent(userId)}` +
      `&select=${encodeURIComponent(planColumn)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });

    if (!response.ok) {
      console.warn("BUILDr tier lookup failed:", await response.text());
      return "free";
    }

    const rows = await response.json().catch(() => []);
    const plan = Array.isArray(rows) && rows[0] ? rows[0][planColumn] : null;
    return normalizePlanTier(plan, true);
  } catch (error) {
    console.warn("BUILDr tier lookup error:", error?.message || error);
    return "free";
  }
}

// READ-ONLY: count distinct BUILDr sessions already logged today.
// Signed-in users are counted by verified user_id; guests by client IP.
// This never writes — it only reads what buildr-chat has already logged.
async function countBuildrSessionsToday({ userId, event }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const user = cleanIdentity(userId);
  const ip = cleanIdentity(getClientIp(event));
  const since = encodeURIComponent(todayStartISO());
  let url;

  if (user) {
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=session_id` +
      `&user_id=eq.${encodeURIComponent(user)}` +
      `&source_page=eq.pozi.live` +
      `&created_at=gte.${since}`;
  } else {
    const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=session_id` +
      `&session_id=like.${encodeURIComponent(`${guestBase}__*`)}` +
      `&source_page=eq.pozi.live` +
      `&created_at=gte.${since}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });

  if (!response.ok) throw new Error((await response.text()) || "Unable to count BUILDr sessions.");

  const rows = await response.json().catch(() => []);
  const sessionSet = new Set();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const id = cleanIdentity(row?.session_id);
      if (id) sessionSet.add(id);
    }
  }

  return sessionSet.size;
}

// READ-ONLY: count BUILDr Vision uses already logged today (source_page "pozi.vision").
// Each vision analysis is one row/one use. Signed-in by user_id; guests by client IP.
async function countVisionUsesToday({ userId, event }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const user = cleanIdentity(userId);
  const ip = cleanIdentity(getClientIp(event));
  const since = encodeURIComponent(todayStartISO());
  let url;

  if (user) {
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=id` +
      `&user_id=eq.${encodeURIComponent(user)}` +
      `&source_page=eq.pozi.vision` +
      `&created_at=gte.${since}`;
  } else {
    const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=id` +
      `&session_id=like.${encodeURIComponent(`${guestBase}__*`)}` +
      `&source_page=eq.pozi.vision` +
      `&created_at=gte.${since}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });

  if (!response.ok) throw new Error((await response.text()) || "Unable to count BUILDr Vision usage.");

  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-pozi-session-id",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });
  if (event.httpMethod !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed. Use GET." });

  try {
    const bearerToken = getBearerToken(event);

    let verifiedIdentity = null;
    try {
      verifiedIdentity = bearerToken ? await getVerifiedIdentity(bearerToken) : null;
    } catch (configError) {
      console.error("usage-status identity config error:", configError);
      return jsonResponse(500, { ok: false, error: configError?.message || "Server configuration error." });
    }

    // Supplied but invalid/expired token = 401 (consistent with buildr-chat).
    if (bearerToken && !verifiedIdentity) {
      return jsonResponse(401, {
        ok: false,
        error: "Your session has expired or is invalid. Please sign in again."
      });
    }

    const userId = verifiedIdentity?.user_id || null;
    const userEmail = verifiedIdentity?.user_email || "";

    // Test-admin unlimited access (keyed on the verified email only).
    if (isUnlimitedTestUser(userEmail)) {
      return jsonResponse(200, {
        ok: true,
        tier: "test_unlimited",
        authenticated: true,
        limit: 999999,
        used: 0,
        remaining: 999999,
        messages_per_session: 999999,
        buildr: {
          daily_limit: 999999,
          sessions_used: 0,
          sessions_remaining: 999999,
          messages_per_session: 999999
        },
        vision: {
          daily_limit: 999999,
          used: 0,
          remaining: 999999
        }
      });
    }

    const tier = userId ? await getVerifiedTier(userId) : "guest";
    const limit = BUILDR_DAILY_LIMITS[tier] ?? BUILDR_DAILY_LIMITS.guest;
    const messagesPerSession = BUILDR_MESSAGES_PER_SESSION[tier] ?? BUILDR_MESSAGES_PER_SESSION.guest;
    const visionLimit = BUILDR_VISION_DAILY_LIMITS[tier] ?? BUILDR_VISION_DAILY_LIMITS.guest;

    const used = await countBuildrSessionsToday({ userId, event });
    const remaining = Math.max(limit - used, 0);

    const visionUsed = await countVisionUsesToday({ userId, event });
    const visionRemaining = Math.max(visionLimit - visionUsed, 0);

    return jsonResponse(200, {
      ok: true,
      tier,
      authenticated: Boolean(userId),
      limit,
      used,
      remaining,
      messages_per_session: messagesPerSession,
      buildr: {
        daily_limit: limit,
        sessions_used: used,
        sessions_remaining: remaining,
        messages_per_session: messagesPerSession
      },
      vision: {
        daily_limit: visionLimit,
        used: visionUsed,
        remaining: visionRemaining
      }
    });
  } catch (error) {
    console.error("usage-status error:", error);
    return jsonResponse(500, { ok: false, error: error?.message || "Unknown server error." });
  }
};
