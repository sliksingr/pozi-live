// netlify/functions/usage-status.js
// READ-ONLY Foreman usage status for the POZi Go account card and the website plan strip.
//
// This endpoint NEVER inserts rows, increments counters, calls Anthropic, or enforces a
// request. It only reports what the server currently sees, so a client can show usage on open.
// Enforcement + usage mutation live in buildr-chat-stream.mjs and buildr-vision.js.
//
// IMPORTANT: the limit constants below must stay identical to the ones in
// buildr-chat-stream.mjs and buildr-vision.js. If they drift, a client reports one number
// and the server enforces another.
//
// NOTE ON NAMING: the assistant is "POZi Foreman" in everything a customer sees. The
// filename, table names, and env vars intentionally keep their original `buildr` names.
//
// Required Netlify env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Recommended:
//   SUPABASE_ANON_KEY
// Optional:
//   BUILDR_PROFILE_TABLE
//   BUILDR_PLAN_COLUMN
//   BUILDR_PROFILE_ID_COLUMN     default: id

// REPLIES, FLAT. Sessions are gone from enforcement entirely.
//
// The old model was two nested limits: sessions per day, and messages inside each session.
// Nobody ever saw a session — they were crossed automatically — so the number a customer
// cared about was the product of two invisible things, and no single reset time could be
// named because two clocks were running. These are those products, unchanged: 1x5, 3x5,
// 5x10 and 6x12. Nothing shifts for anyone; it simply stops being multiplication.
const BUILDR_REPLY_LIMITS = Object.freeze({ guest: 5, free: 15, consumer: 50, pro: 72 });
// Build the Plan. Sonnet, up to 2,600 output tokens — roughly five times the cost of a
// chat message and previously uncapped, so one person could rebuild a plan all day.
const BUILDR_PLAN_LIMITS = Object.freeze({ guest: 1, free: 2, consumer: 5, pro: 10 });
const BUILDR_VISION_LIMITS = Object.freeze({ guest: 0, free: 1, consumer: 10, pro: 20 });
const BUILDR_TEST_UNLIMITED_EMAILS = new Set(["info@pozi.live"]);

function normalizePlanTier(value, hasUser) {
  const tier = String(value || "").toLowerCase().trim();
  if (tier === "pro") return "pro";
  if (["consumer", "consumer_paid", "paid"].includes(tier)) return "consumer";
  if (["free", "free_account"].includes(tier)) return "free";
  if (tier === "guest") return "guest";
  return hasUser ? "free" : "guest";
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

// ── THE 24-HOUR USAGE WINDOW ─────────────────────────────────────────────────
// ONE window per account, shared by Foreman replies, plan builds and photo analyses.
// The first billable action opens it; 24 hours later everything comes back together and
// the next action opens a fresh one.
//
// This replaced a rolling window that aged each row out individually 24 hours after it
// happened. That model was un-explainable: allowances dribbled back one at a time, so
// there was never a single moment to name, and every attempt to word it either said
// "today" (wrong — there is no midnight) or needed a paragraph. A window with a start
// has exactly one reset time, which is what the app now shows.
//
// The start is persisted in buildr_usage_windows because it cannot be derived from usage
// rows: the oldest row inside the last 24 hours slides forward as rows age out, which is
// the rolling behaviour again wearing a different hat.
//
// Duplicated in buildr-chat-stream.mjs and buildr-vision.js. The ONLY difference between
// the three copies is how the client IP is reached — the .mjs handler is given `req`,
// these two are given `event`. All three must otherwise agree, or one account gets two
// different reset times depending on which function it asked.
//
// THIS FILE NEVER OPENS A WINDOW. It is the read-only endpoint: reporting usage must not
// start somebody's 24 hours just because a screen was opened.
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const USAGE_WINDOW_TABLE = "buildr_usage_windows";

function usageOwnerKey({ userId, event }) {
  const user = cleanIdentity(userId);
  if (user) return `user_${user}`;
  const ip = cleanIdentity(getClientIp(event));
  return ip ? `guest_ip_${ip}` : "guest_unknown_ip";
}

function windowResetISO(windowStart) {
  if (!windowStart) return null;
  return new Date(windowStart.getTime() + USAGE_WINDOW_MS).toISOString();
}

// Returns the CURRENT window's start, or null when no window is open. An expired row
// reads as null rather than being cleaned up here — the next billable action overwrites
// it, so there is nothing to tidy and no write on a read path.
async function readUsageWindow(ownerKey) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const url = `${supabaseUrl}/rest/v1/${USAGE_WINDOW_TABLE}` +
    `?owner_key=eq.${encodeURIComponent(ownerKey)}&select=window_start`;
  const response = await fetch(url, {
    method: "GET",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });
  if (!response.ok) throw new Error((await response.text()) || "Unable to read the usage window.");

  const rows = await response.json().catch(() => []);
  const raw = Array.isArray(rows) && rows[0] ? rows[0].window_start : null;
  if (!raw) return null;

  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) return null;
  if (Date.now() >= start.getTime() + USAGE_WINDOW_MS) return null;
  return start;
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
      console.warn("Foreman tier lookup failed:", await response.text());
      return "free";
    }

    const rows = await response.json().catch(() => []);
    const plan = Array.isArray(rows) && rows[0] ? rows[0][planColumn] : null;
    return normalizePlanTier(plan, true);
  } catch (error) {
    console.warn("Foreman tier lookup error:", error?.message || error);
    return "free";
  }
}

// Shared row counter for the CURRENT window. sourcePage selects which kind of usage:
//   "pozi.live"   chat replies
//   "pozi.plan"   Build the Plan calls
//   "pozi.vision" photo analyses
// Signed-in users are counted by verified user_id; guests by client IP.
async function countRowsInWindow({ userId, event, sourcePage, windowStart, selectColumn = "id" }) {
  // No open window means nothing has been used yet — no query needed at all.
  if (!windowStart) return [];

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const user = cleanIdentity(userId);
  const ip = cleanIdentity(getClientIp(event));
  const since = encodeURIComponent(windowStart.toISOString());
  let url;

  if (user) {
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=${encodeURIComponent(selectColumn)}` +
      `&user_id=eq.${encodeURIComponent(user)}` +
      `&source_page=eq.${encodeURIComponent(sourcePage)}` +
      `&created_at=gte.${since}`;
  } else {
    const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=${encodeURIComponent(selectColumn)}` +
      `&session_id=like.${encodeURIComponent(`${guestBase}__*`)}` +
      `&source_page=eq.${encodeURIComponent(sourcePage)}` +
      `&created_at=gte.${since}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });

  if (!response.ok) throw new Error((await response.text()) || "Unable to read Foreman usage.");
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function countRepliesInWindow({ userId, event, windowStart }) {
  return (await countRowsInWindow({ userId, event, sourcePage: "pozi.live", windowStart })).length;
}

async function countPlansInWindow({ userId, event, windowStart }) {
  return (await countRowsInWindow({ userId, event, sourcePage: "pozi.plan", windowStart })).length;
}

async function countVisionUsesInWindow({ userId, event, windowStart }) {
  return (await countRowsInWindow({ userId, event, sourcePage: "pozi.vision", windowStart })).length;
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

// The ?debug=1 tier diagnostic that used to live here was REMOVED on 2026-09-01.
// It returned env var names, the constructed query URL, and raw database rows to anyone
// with a valid session — useful while tiers were being wired up, and an information
// disclosure once they worked. Read tier problems from the function logs instead.

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

    if (bearerToken && !verifiedIdentity) {
      return jsonResponse(401, {
        ok: false,
        error: "Your session has expired or is invalid. Please sign in again."
      });
    }

    const userId = verifiedIdentity?.user_id || null;
    const userEmail = verifiedIdentity?.user_email || "";

    if (isUnlimitedTestUser(userEmail)) {
      return jsonResponse(200, {
        ok: true,
        tier: "test_unlimited",
        authenticated: true,
        window: "fixed_24h_from_first_use",
        window_start: null,
        reset_at: null,
        replies: { limit: 999999, used: 0, remaining: 999999 },
        plans: { limit: 999999, daily_limit: 999999, used: 0, remaining: 999999 },
        vision: { limit: 999999, daily_limit: 999999, used: 0, remaining: 999999 },
        // Legacy fields for app builds already on phones — see the note in the main
        // response below.
        limit: 999999,
        used: 0,
        remaining: 0,
        messages_per_session: 999999,
        messages: { limit: 999999, used: 0, remaining: 999999, message_based: true },
        buildr: { daily_limit: 999999, sessions_used: 0, sessions_remaining: 0, messages_per_session: 999999 }
      });
    }

    const tier = userId ? await getVerifiedTier(userId) : "guest";
    const replyLimit = BUILDR_REPLY_LIMITS[tier] ?? BUILDR_REPLY_LIMITS.guest;
    const planLimit = BUILDR_PLAN_LIMITS[tier] ?? BUILDR_PLAN_LIMITS.guest;
    const visionLimit = BUILDR_VISION_LIMITS[tier] ?? BUILDR_VISION_LIMITS.guest;

    // Read only. A closed window reports a full allowance and no reset time, which is the
    // truth: nothing has been spent, and the clock starts on the next billable action.
    const ownerKey = usageOwnerKey({ userId, event });
    const windowStart = await readUsageWindow(ownerKey);

    const repliesUsed = await countRepliesInWindow({ userId, event, windowStart });
    const repliesRemaining = Math.max(replyLimit - repliesUsed, 0);

    const plansUsed = await countPlansInWindow({ userId, event, windowStart });
    const plansRemaining = Math.max(planLimit - plansUsed, 0);

    const visionUsed = await countVisionUsesInWindow({ userId, event, windowStart });
    const visionRemaining = Math.max(visionLimit - visionUsed, 0);

    return jsonResponse(200, {
      ok: true,
      tier,
      authenticated: Boolean(userId),
      window: "fixed_24h_from_first_use",
      window_start: windowStart ? windowStart.toISOString() : null,
      reset_at: windowResetISO(windowStart),
      replies: { limit: replyLimit, used: repliesUsed, remaining: repliesRemaining },
      plans: { limit: planLimit, daily_limit: planLimit, used: plansUsed, remaining: plansRemaining },
      vision: { limit: visionLimit, daily_limit: visionLimit, used: visionUsed, remaining: visionRemaining },

      // ── LEGACY FIELDS ────────────────────────────────────────────────────────
      // App builds already on phones read usage.messages and multiply it by the
      // sessions they think are left. Sessions therefore report as ZERO and the whole
      // allowance rides in messages, which makes their arithmetic — sessions x
      // per-session + remaining — come out at exactly the reply count. Those builds
      // keep showing correct numbers until the new counter line ships, at which point
      // this block can come out.
      limit: replyLimit,
      used: repliesUsed,
      remaining: 0,
      messages_per_session: replyLimit,
      messages: {
        limit: replyLimit,
        used: repliesUsed,
        remaining: repliesRemaining,
        message_based: true
      },
      buildr: {
        daily_limit: replyLimit,
        sessions_used: 0,
        sessions_remaining: 0,
        messages_per_session: replyLimit
      }
    });
  } catch (error) {
    console.error("usage-status error:", error);
    return jsonResponse(500, { ok: false, error: error?.message || "Unknown server error." });
  }
};
