// netlify/functions/create-checkout.js
// Creates a Stripe Checkout session for a POZi subscription.
//
// SECURITY MODEL: identical to delete-account.js. The client sends its own
// Supabase access token, we verify it server-side, and the session is bound to
// that user. A caller cannot start a subscription on someone else's account.
// The plan is never trusted as a price — it maps to a Price ID held in env.
//
// WHY NOT A PAYMENT LINK: a payment link is one static URL shared by everyone,
// so the webhook has no idea which POZi account paid. Here we attach the
// Supabase user id to the session AND to the subscription, so the webhook can
// write the plan onto the right profile row.
//
// WHY fetch INSTEAD OF THE stripe NPM PACKAGE: every other function in this
// repo talks to its API over fetch with no dependencies. Stripe's REST API is
// form-encoded, not JSON — note the URLSearchParams below.
//
// REQUIRED NETLIFY ENV VARS:
//   STRIPE_SECRET_KEY           — sk_test_... (sk_live_... when you go live)
//   STRIPE_PRICE_DIY            — price_... for POZi DIY $9.99/mo
//   STRIPE_PRICE_CONTRACTOR     — price_... for POZi Contractor $19.99/mo
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ANON_KEY
//
// Going live is three env var changes here — no code edit, no upload.

const SITE_URL = "https://pozi.live";

// Tier names are the same strings used in buildr_profiles.plan and in every
// limit check across the app, website, and buildr-chat-stream.mjs.
const PLAN_TO_PRICE_ENV = {
  consumer: "STRIPE_PRICE_DIY",
  pro: "STRIPE_PRICE_CONTRACTOR"
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

async function getCallerIdentity(supabaseUrl, anonKey, accessToken) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  if (!user?.id) return null;
  return { id: String(user.id), email: String(user.email || "").toLowerCase() };
}

// Reuse the Stripe customer if this person has subscribed before, so they don't
// accumulate duplicate customer records across upgrade/cancel/resubscribe.
async function getExistingCustomerId(supabaseUrl, serviceKey, userId) {
  try {
    const url = `${supabaseUrl}/rest/v1/buildr_profiles` +
      `?id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id`;
    const res = await fetch(url, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (!res.ok) return "";
    const rows = await res.json().catch(() => []);
    const id = Array.isArray(rows) && rows[0] ? rows[0].stripe_customer_id : "";
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!stripeKey) {
    return jsonResponse(500, { ok: false, error: "Checkout is not configured yet. Add STRIPE_SECRET_KEY in Netlify." });
  }
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return jsonResponse(500, { ok: false, error: "Server is missing Supabase credentials." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body." });
  }

  const plan = String(body.plan || "").trim().toLowerCase();
  const priceEnvName = PLAN_TO_PRICE_ENV[plan];
  if (!priceEnvName) {
    return jsonResponse(400, { ok: false, error: "Unknown plan." });
  }

  const priceId = String(process.env[priceEnvName] || "").trim();
  if (!priceId) {
    return jsonResponse(500, {
      ok: false,
      error: `Checkout is not configured yet. Add ${priceEnvName} in Netlify.`
    });
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) {
    return jsonResponse(401, { ok: false, error: "Sign in before starting a subscription." });
  }

  const caller = await getCallerIdentity(supabaseUrl, anonKey, accessToken);
  if (!caller) {
    return jsonResponse(401, { ok: false, error: "Your session has expired. Sign in again." });
  }

  try {
    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");

    // Where Stripe sends the customer afterwards. The plan lands via webhook,
    // not via this redirect — never trust the browser to grant a paid tier.
    //
    // THE DESTINATION DEPENDS ON WHERE CHECKOUT STARTED.
    //
    // From the WEBSITE: back to the site with ?checkout=success, which is what makes
    // index.html poll for the new tier and show its confirmation. That flow works and
    // must not change.
    //
    // From the APP: Stripe's redirect lands inside SFSafariViewController, a browser
    // window with its own cookie jar. Loading pozi.live there renders the site signed
    // out — indistinguishable, to someone who just paid, from being logged out and
    // dumped somewhere. So the app gets a standalone page that needs no session and
    // only says the payment landed and how to get back.
    //
    // An unknown or missing source falls through to the website behaviour, so an older
    // app build that does not send it keeps working exactly as it does today.
    const source = String(body.source || "").trim().toLowerCase();
    if (source === "app") {
      form.set("success_url", `${SITE_URL}/checkout-complete.html?checkout=success&plan=${encodeURIComponent(plan)}`);
      form.set("cancel_url", `${SITE_URL}/checkout-complete.html?checkout=cancelled`);
    } else {
      form.set("success_url", `${SITE_URL}/?checkout=success&plan=${encodeURIComponent(plan)}`);
      form.set("cancel_url", `${SITE_URL}/?checkout=cancelled`);
    }

    // Three separate places the user id travels, because each is read at a
    // different point in Stripe's lifecycle:
    //   client_reference_id      — on the completed session
    //   metadata                 — on the session
    //   subscription_data.metadata — persists on the subscription itself, which
    //                               is what later renewal and cancel events carry
    form.set("client_reference_id", caller.id);
    form.set("metadata[supabase_user_id]", caller.id);
    form.set("metadata[plan]", plan);
    form.set("subscription_data[metadata][supabase_user_id]", caller.id);
    form.set("subscription_data[metadata][plan]", plan);

    const existingCustomer = await getExistingCustomerId(supabaseUrl, serviceKey, caller.id);
    if (existingCustomer) {
      form.set("customer", existingCustomer);
    } else if (caller.email) {
      // Prefills the email field and lets Stripe create the customer record.
      form.set("customer_email", caller.email);
    }

    // Lets the customer manage or cancel from Stripe's own portal later.
    form.set("allow_promotion_codes", "true");

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });

    const session = await res.json().catch(() => null);

    if (!res.ok || !session?.url) {
      const detail = session?.error?.message || "Stripe did not return a checkout URL.";
      console.error("Stripe checkout session failed:", res.status, detail);
      return jsonResponse(502, { ok: false, error: `Checkout could not start. ${detail}` });
    }

    console.log("Checkout session created:", session.id, "user:", caller.id, "plan:", plan, "source:", source || "web");
    return jsonResponse(200, { ok: true, url: session.url, session_id: session.id });
  } catch (error) {
    console.error("create-checkout error:", error);
    return jsonResponse(500, { ok: false, error: "Checkout could not start. Please try again." });
  }
};
