// netlify/functions/stripe-webhook.js
// The only thing that grants or removes a paid tier.
//
// WHY THE WEBHOOK AND NOT THE SUCCESS REDIRECT: the browser coming back to
// pozi.live?checkout=success proves nothing — anyone can type that URL. Stripe
// signs this request with a shared secret, so this is the only place we trust
// enough to write buildr_profiles.plan.
//
// SIGNATURE VERIFICATION uses Node's crypto, not the stripe npm package, to
// match how every other function here works. The signed payload is
// `${timestamp}.${raw body}` — the RAW body, byte for byte. Parsing the JSON
// first and re-stringifying it will produce a different string and every
// signature will fail.
//
// EVENTS HANDLED:
//   checkout.session.completed      — first payment; grant the plan, store ids
//   customer.subscription.updated   — renewal, upgrade, or lapse
//   customer.subscription.deleted   — cancelled or ended; drop to free
//
// Anything else is acknowledged with 200 and ignored. Returning a non-200 makes
// Stripe retry, so we only fail loudly on a bad signature or a write error.
//
// REQUIRED NETLIFY ENV VARS:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET  — whsec_..., from the webhook endpoint in Stripe
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// SETUP IN STRIPE: Developers → Webhooks → Add endpoint
//   URL:    https://pozi.live/.netlify/functions/stripe-webhook
//   Events: checkout.session.completed, customer.subscription.updated,
//           customer.subscription.deleted
// Then copy the signing secret into STRIPE_WEBHOOK_SECRET.

const crypto = require("crypto");

// Subscription statuses that mean the person should still have their tier.
// "past_due" is deliberately included: a failed card is a retry window, not a
// reason to take away access mid-project while Stripe is still trying.
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

// Constant-time compare so a signature can't be guessed by timing the response.
function safeEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Stripe-Signature looks like: t=1234567890,v1=abc...,v1=def...
// There can be more than one v1 when a secret is being rotated, so any match wins.
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  let timestamp = "";
  const signatures = [];
  for (const part of String(signatureHeader).split(",")) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = (value || "").trim();
    if (key === "v1") signatures.push((value || "").trim());
  }
  if (!timestamp || !signatures.length) return false;

  // Reject anything older than five minutes so a captured request can't be
  // replayed later to re-grant a cancelled subscription.
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  return signatures.some((sig) => safeEqual(sig, expected));
}

function restHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };
}

// One place that writes the tier, so every event path stays consistent.
async function updateProfile(supabaseUrl, serviceKey, userId, fields) {
  const url = `${supabaseUrl}/rest/v1/buildr_profiles?id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...restHeaders(serviceKey), Prefer: "return=representation" },
    body: JSON.stringify(fields)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Profile update failed (${res.status}): ${detail}`);
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

// Fetch a subscription when an event doesn't carry the metadata we need.
async function getSubscription(stripeKey, subscriptionId) {
  const res = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  );
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// The user id rides on the subscription metadata set by create-checkout.js.
// Falling back to a customer lookup covers subscriptions created by hand in the
// dashboard, which carry no metadata.
async function resolveUserId(supabaseUrl, serviceKey, subscription) {
  const fromMetadata = subscription?.metadata?.supabase_user_id;
  if (fromMetadata) return String(fromMetadata);

  const customerId = subscription?.customer;
  if (!customerId) return "";

  const url = `${supabaseUrl}/rest/v1/buildr_profiles` +
    `?stripe_customer_id=eq.${encodeURIComponent(String(customerId))}&select=id`;
  const res = await fetch(url, { headers: restHeaders(serviceKey) });
  if (!res.ok) return "";
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? String(rows[0].id) : "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { ok: false, error: "Method not allowed." });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!stripeKey || !webhookSecret || !supabaseUrl || !serviceKey) {
    console.error("stripe-webhook missing environment variables.");
    return response(500, { ok: false, error: "Webhook is not configured." });
  }

  // The raw body exactly as Stripe sent it. Netlify base64-encodes some bodies,
  // so decode before verifying rather than after.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  const signature =
    event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"] || "";

  if (!verifyStripeSignature(rawBody, signature, webhookSecret)) {
    console.warn("Rejected webhook with an invalid signature.");
    return response(400, { ok: false, error: "Invalid signature." });
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return response(400, { ok: false, error: "Invalid JSON." });
  }

  const type = stripeEvent?.type || "";
  const object = stripeEvent?.data?.object || {};

  try {
    if (type === "checkout.session.completed") {
      const userId =
        object.client_reference_id ||
        object.metadata?.supabase_user_id ||
        "";
      const plan = String(object.metadata?.plan || "").toLowerCase();
      const subscriptionId = object.subscription ? String(object.subscription) : "";
      const customerId = object.customer ? String(object.customer) : "";

      if (!userId || !["consumer", "pro"].includes(plan)) {
        console.warn("checkout.session.completed missing user id or plan:", object.id);
        return response(200, { ok: true, ignored: true });
      }

      await updateProfile(supabaseUrl, serviceKey, userId, {
        plan,
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscriptionId || null
      });

      console.log("Plan granted:", plan, "user:", userId, "sub:", subscriptionId);
      return response(200, { ok: true });
    }

    if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      // The event object is the subscription itself.
      const subscription = object.id ? object : await getSubscription(stripeKey, object.id);
      if (!subscription) return response(200, { ok: true, ignored: true });

      const userId = await resolveUserId(supabaseUrl, serviceKey, subscription);
      if (!userId) {
        console.warn("Could not resolve a POZi user for subscription:", subscription.id);
        return response(200, { ok: true, ignored: true });
      }

      const status = String(subscription.status || "");
      const stillPaid = type !== "customer.subscription.deleted" && ACTIVE_STATUSES.has(status);

      if (stillPaid) {
        // Covers an upgrade from DIY to Contractor, where the plan changes but
        // the subscription id stays the same.
        const plan = String(subscription.metadata?.plan || "").toLowerCase();
        if (["consumer", "pro"].includes(plan)) {
          await updateProfile(supabaseUrl, serviceKey, userId, {
            plan,
            stripe_subscription_id: String(subscription.id)
          });
          console.log("Plan confirmed:", plan, "user:", userId, "status:", status);
        }
        return response(200, { ok: true });
      }

      // Cancelled, unpaid, or ended — back to the free tier. The customer id is
      // kept so a returning subscriber reuses their Stripe record.
      await updateProfile(supabaseUrl, serviceKey, userId, {
        plan: "free",
        stripe_subscription_id: null
      });
      console.log("Plan removed for user:", userId, "status:", status, "type:", type);
      return response(200, { ok: true });
    }

    // Everything else is fine, just not ours to act on.
    return response(200, { ok: true, ignored: type });
  } catch (error) {
    // A 500 tells Stripe to retry, which is what we want if Supabase blipped.
    console.error("stripe-webhook error:", type, error);
    return response(500, { ok: false, error: "Webhook processing failed." });
  }
};
