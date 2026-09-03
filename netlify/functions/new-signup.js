// netlify/functions/new-signup.js
// Notifies you when someone creates a POZi account.
//
// HOW THIS WORKS, AND WHY IT IS BUILT THIS WAY
// Supabase fires a webhook at this function whenever a row lands in auth.users. The
// function then submits to the "new-signup" Netlify form, and Netlify emails you exactly
// the way the contact form already does.
//
// The obvious alternative was a real email service — Resend, SendGrid, Postmark. That
// means another account, another API key, another domain to verify, and another bill.
// Netlify Forms is already wired up, already emailing info@pozi.live, and already proven.
// This adds nothing new to break.
//
// The trade: Netlify's free tier allows 100 form submissions a month, shared with the
// contact form. Early on that is plenty. If signups ever push past it, that is a good
// problem and the right moment to move to a real sending service.
//
// Required Netlify env var:
//   POZI_SIGNUP_HOOK_SECRET   any long random string; must match the header Supabase sends
// Optional:
//   POZI_SITE_URL             defaults to https://pozi.live

const SITE_URL = String(process.env.POZI_SITE_URL || "https://pozi.live").replace(/\/+$/, "");
const FORM_NAME = "new-signup";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

// Timing-safe enough for a shared secret of this kind: compare full length every time
// rather than bailing at the first differing character.
function secretMatches(supplied, expected) {
  const a = String(supplied || "");
  const b = String(expected || "");
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  // This endpoint is public, so it must prove the caller is Supabase. Without this
  // anyone could POST fake signups and burn the form quota.
  const expected = process.env.POZI_SIGNUP_HOOK_SECRET;
  if (!expected) {
    console.error("POZI_SIGNUP_HOOK_SECRET is not set — refusing to run.");
    return jsonResponse(500, { ok: false, error: "Server not configured." });
  }
  const headers = event.headers || {};
  const supplied = headers["x-pozi-hook-secret"] || headers["X-Pozi-Hook-Secret"] || "";
  if (!secretMatches(supplied, expected)) {
    return jsonResponse(401, { ok: false, error: "Unauthorized." });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return jsonResponse(400, { ok: false, error: "Invalid JSON body." }); }

  // Supabase database webhooks send { type, table, record, old_record }.
  const record = payload.record || payload.new || payload || {};
  const email = String(record.email || "").trim();
  const userId = String(record.id || "").trim();
  const createdAt = String(record.created_at || new Date().toISOString());

  // No email means nothing worth notifying about — and a 200 stops Supabase retrying
  // something that will never succeed.
  if (!email) return jsonResponse(200, { ok: true, skipped: "no email on record" });

  const body = new URLSearchParams({
    "form-name": FORM_NAME,
    email,
    user_id: userId,
    signed_up_at: createdAt,
    // Netlify shows the form name in the notification subject; this makes the email
    // itself readable at a glance on a phone without opening the dashboard.
    summary: `New POZi account: ${email}`
  }).toString();

  try {
    const res = await fetch(`${SITE_URL}/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) {
      // Logged, not thrown. A failed notification must never make Supabase think the
      // signup itself failed — the account exists either way and the user comes first.
      console.warn("Netlify Forms submission failed:", res.status, await res.text().catch(() => ""));
      return jsonResponse(200, { ok: true, notified: false, status: res.status });
    }
    return jsonResponse(200, { ok: true, notified: true });
  } catch (e) {
    console.warn("new-signup notify error:", e?.message || e);
    return jsonResponse(200, { ok: true, notified: false });
  }
};
