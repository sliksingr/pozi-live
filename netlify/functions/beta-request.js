// netlify/functions/beta-request.js
// Someone asks for a POZi Go beta invite from the website or the install page.
//
// HOW THIS WORKS, AND WHY IT IS BUILT THIS WAY
// Two things happen per request, in this order:
//   1. The request is written to buildr_beta_requests. This is the RECORD — the list you
//      work from when sending invites and, later, when reverting everyone's tier.
//   2. The function submits to the "beta-request" Netlify form, which emails you exactly
//      the way new-signup.js and the contact form already do. This is the NOTIFICATION.
//
// The order matters. If the email fails, the row still exists and nothing is lost. If
// the row failed, an email alone would be a request you can see once and never find
// again. Record first, nudge second.
//
// The browser does NOT write to Supabase directly. It posts here instead, so the table
// stays closed to the anon key — other people's email addresses never become readable
// from a browser, and nobody can spam rows straight into the database.
//
// Required Netlify env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   POZI_SITE_URL   defaults to https://pozi.live

const SITE_URL = String(process.env.POZI_SITE_URL || "https://pozi.live").replace(/\/+$/, "");
const FORM_NAME = "beta-request";
const TABLE = "buildr_beta_requests";

// Only two platforms exist, and the client sends a dropdown value — anything else is a
// bot or a hand-rolled POST, and is rejected rather than stored as junk.
const PLATFORMS = Object.freeze({ ios: "iOS", android: "Android" });

const MAX_EMAIL = 160;
const MAX_USE_CASE = 600;

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

function getClientIp(event) {
  const headers = event?.headers || {};
  const raw = headers["x-nf-client-connection-ip"] || headers["client-ip"] || headers["x-forwarded-for"] || "";
  return String(raw).split(",")[0].trim();
}

// Deliberately loose. The point is to catch a typo or an empty box, not to adjudicate
// what a valid address looks like — the real test is whether the invite arrives.
function looksLikeEmail(value) {
  const v = String(value || "").trim();
  return v.length >= 5 && v.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function saveRequest(row) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const response = await fetch(`${supabaseUrl}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation"
    },
    body: JSON.stringify(row)
  });

  if (!response.ok) throw new Error((await response.text()) || "Could not save the request.");
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

// Same mechanism as new-signup.js: submit to a Netlify form and let Netlify send the
// mail. No second email service, no extra key, no extra bill.
//
// NOTE ON QUOTA: Netlify's free tier allows 100 form submissions a month across ALL
// forms — contact, new-signup and now this one together. Fine for a beta; worth watching
// if invites take off.
async function notify({ email, platform, useCase, source }) {
  const body = new URLSearchParams({
    "form-name": FORM_NAME,
    email,
    platform: PLATFORMS[platform] || platform,
    use_case: useCase || "",
    source: source || "",
    requested_at: new Date().toISOString(),
    // Netlify puts the form name in the subject; this line makes the email readable at a
    // glance on a phone without opening the dashboard.
    summary: `Beta testing inquiry — ${PLATFORMS[platform] || platform} — ${email}`
  }).toString();

  const res = await fetch(`${SITE_URL}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error(`Netlify Forms returned ${res.status}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return jsonResponse(400, { ok: false, error: "Invalid JSON body." }); }

  // Honeypot. A real person never sees this field, so anything in it is a bot. Answered
  // with a cheerful 200 so the bot believes it succeeded and does not come back to retry.
  if (String(payload.company || "").trim()) {
    return jsonResponse(200, { ok: true });
  }

  const email = String(payload.email || "").trim().toLowerCase();
  const platform = String(payload.platform || "").trim().toLowerCase();
  const useCase = String(payload.use_case || "").trim().slice(0, MAX_USE_CASE);
  const source = String(payload.source || "website").trim().slice(0, 32);
  const userId = String(payload.user_id || "").trim() || null;

  if (!looksLikeEmail(email)) {
    return jsonResponse(400, { ok: false, error: "That email address doesn't look right. Check it and try again." });
  }
  if (!PLATFORMS[platform]) {
    return jsonResponse(400, { ok: false, error: "Choose iPhone or Android first." });
  }

  // THE RECORD. If this fails the request genuinely did not land, so say so and let them
  // try again — better than a cheerful confirmation for something you will never see.
  try {
    await saveRequest({
      email,
      platform,
      use_case: useCase || null,
      user_id: userId,
      source,
      client_ip: getClientIp(event) || null
    });
  } catch (e) {
    console.error("beta-request save failed:", e?.message || e);
    return jsonResponse(500, { ok: false, error: "Could not send that just now. Please try again in a moment." });
  }

  // THE NUDGE. Logged, never thrown: the request is already saved, so a failed
  // notification must not tell the person their request did not go through.
  try {
    await notify({ email, platform, useCase, source });
  } catch (e) {
    console.warn("beta-request notify failed:", e?.message || e);
    return jsonResponse(200, { ok: true, notified: false });
  }

  return jsonResponse(200, { ok: true, notified: true });
};
