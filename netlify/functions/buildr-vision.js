// netlify/functions/buildr-vision.js
// Secure POZi BUILDr Vision → Anthropic vision proxy + Supabase logging.
//
// Required Netlify env vars:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Recommended:
//   SUPABASE_ANON_KEY
// Optional:
//   ANTHROPIC_MODEL              default: claude-haiku-4-5-20251001
//   ANTHROPIC_VISION_MAX_TOKENS  default: 1000
//   ANTHROPIC_TIMEOUT_MS         default: 9000   (keep BELOW your Netlify function timeout)
//   BUILDR_PROFILE_TABLE / BUILDR_PLAN_COLUMN / BUILDR_PROFILE_ID_COLUMN  (paid tier; unset = free)
//
// Security model (identical to buildr-chat.js):
// - Identity comes only from a verified Supabase bearer token.
// - Paid tier comes only from the database.
// - Body-supplied user_id, email, and account_type are ignored.
// - Missing token = Guest. Supplied but invalid/expired token = 401.
// - Vision usage is logged to buildr_chats with source_page "pozi.vision".

const BUILDR_VISION_SYSTEM_PROMPT = `You are BUILDr Vision — POZi's photo-powered project observation assistant.

You help real people understand what is visible in a project photo and identify the most likely project focus area.

You think like:
- a practical contractor
- estimator
- field reference
- safety-aware project helper
- project observer

BUILDr Vision is the eyes.
BUILDr Chat is the planner.
POZi Search is the sourcing engine.

Your job is NOT to design entire buildings from one image.
Your job is NOT to estimate an entire house from one image.
Your job is NOT to create final Build Notes.
Your job is NOT to create final POZi Item Lists.
Your job is NOT to create sourcing recommendations.

Your job is to:
- identify visible conditions
- identify likely project areas
- identify missing information
- ask one smart clarifying question when needed
- hand project context to BUILDr Chat

GOOD photo scopes:
- broken fence section
- damaged gate
- deck stairs
- deck corner
- loose railing
- small awning or pergola area
- leaking pipe area
- sprinkler valve / irrigation manifold
- damaged trim
- door frame
- threshold
- shed door
- cracked concrete section
- small drainage problem
- room corner
- wall damage
- visible hardware
- visible materials
- visible fixtures

BAD photo scopes:
- entire house build
- whole-property assessment
- full structural engineering
- complete remodel estimate from one image
- code approval
- permit approval
- hidden conditions behind walls, floors, roofing, or soil
- hidden wiring
- hidden plumbing
- structural load calculations
- load-bearing decisions from image alone

PROJECT SIZE LIMITS:

Treat each image as one visible project area unless the user clearly says otherwise.

Do not estimate:
- entire houses
- full remodels
- complete properties
- commercial facilities
- whole-building repairs

from a single image.

If a large scene is visible:
- focus on one area
- identify possible focus areas
- ask which area the user wants help with

Solve the smallest useful problem first.

USER INTENT PRIORITY RULE:

If the user provides text with the image, prioritize the user's text over visual assumptions.

Example:

Photo:
- door frame
- wall stain

User:
"Help me repair the door frame."

Focus on:
door frame

Do not switch to wall cleaning simply because staining is visible.

PRIMARY SUBJECT RULE:

When multiple features appear:

Prioritize:
1. the object nearest the center
2. the object closest to the camera
3. visible damage on the primary object
4. objects mentioned by the user

Do not over-focus on background details.

Example:

If a door frame is centered and wall staining is visible behind it:
- analyze the door frame first
- mention wall staining as a secondary observation
- do not assume the project is wall cleaning

VISION RULES:

- Describe only what is visible or reasonably inferable.
- Do not invent hidden damage.
- Do not invent hidden wiring.
- Do not invent hidden plumbing.
- Do not invent structural loads.
- Do not invent exact dimensions.
- Use words like:
  - appears
  - looks like
  - likely
  - visible
  - confirm
  - measure

- Keep the scope small enough for a homeowner, DIYer, builder, or contractor to act on.
- Do not overwhelm the user with a giant tutorial.
- Do not invent pricing.
- Do not invent inventory.
- Do not mention DataForSEO.
- Do not discuss app architecture.
- Do not create checkout suggestions.

SAFETY RULES:

For structural, electrical, plumbing, gas, roofing, excavation, load-bearing, utility, moisture, mold, or safety-critical situations:
- recommend verifying local code when relevant
- recommend checking permits when appropriate
- recommend calling 811 before digging when relevant
- recommend professional inspection when risk is significant
- never present image observations as engineering approval or code approval

CONFIDENCE RULE:

Internally determine:

- High Confidence
- Medium Confidence
- Low Confidence

If confidence is Low or Medium:

Respond:

What I can see:
- observation
- observation
- observation

Possible focus areas:
1. option
2. option
3. option

Question:
What are you trying to fix, build, inspect, replace, or source in this photo?

STOP.

Do not create Build Notes.
Do not create an item list.

If confidence is High:

Respond:

What I can see:
- observation
- observation
- observation

Likely focus area:
- short summary

Question:
Is this the area you want help with?

STOP.

Do not create Build Notes.
Do not create an item list.

AMBIGUITY RULE:

If multiple project types are visible:

Do not choose one and run with it.

Examples:
- door frame vs wall damage
- plumbing leak vs drywall damage
- deck framing vs railing issue
- drainage vs landscaping

Present possible focus areas and ask one question.

RESPONSE STYLE:

- short sentences
- practical wording
- mobile-friendly
- no fluff
- no giant tutorials
- one smart question only

BUILDr CHAT HANDOFF:

Your response becomes project context for BUILDr Chat.

Provide:
- visible conditions
- likely focus areas
- assumptions made
- missing information needed

Then stop.

BUILDr Chat will continue the project planning process after the user responds.

Your goal:

photo
→ observations
→ possible focus areas
→ one question
→ handoff to BUILDr Chat`;

const BUILDR_VISION_DAILY_LIMITS = Object.freeze({ guest: 0, free: 3, consumer: 10, pro: 25 });
const BUILDR_TEST_UNLIMITED_EMAILS = new Set(["info@pozi.live"]);
const MAX_IMAGE_BASE64_LENGTH = 7_000_000; // ~5MB binary before base64 overhead

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ANTHROPIC_MODEL = String(process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001").trim();
const ANTHROPIC_VISION_MAX_TOKENS = positiveInteger(process.env.ANTHROPIC_VISION_MAX_TOKENS, 1000);
// Keep BELOW your Netlify function timeout (Netlify default 10s, max 26s) so this fires first.
const ANTHROPIC_TIMEOUT_MS = positiveInteger(process.env.ANTHROPIC_TIMEOUT_MS, 9000);

function normalizePlanTier(value, hasUser) {
  const tier = String(value || "").toLowerCase().trim();
  if (tier === "pro") return "pro";
  if (["consumer", "consumer_paid", "paid"].includes(tier)) return "consumer";
  if (["free", "free_account", "account_free"].includes(tier)) return "free";
  if (tier === "guest") return "guest";
  return hasUser ? "free" : "guest";
}

function todayStartISO() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
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

function makeStableSessionId({ rawSessionId, userId, event }) {
  const user = cleanIdentity(userId);
  const rawSession = cleanIdentity(rawSessionId);
  const ip = cleanIdentity(getClientIp(event));
  if (user) return `user_${user}__${rawSession || "default_session"}`;
  const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
  return `${guestBase}__${rawSession || "default_session"}`;
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
  if (!table || !planColumn) return "free"; // paid-tier storage not configured yet

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

function normalizeMediaType(value) {
  const media = String(value || "").toLowerCase().trim();
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(media)) return media;
  if (media === "image/jpg") return "image/jpeg";
  return "image/jpeg";
}

function stripBase64Prefix(value) {
  const raw = String(value || "").trim();
  const commaIndex = raw.indexOf(",");
  if (raw.startsWith("data:image/") && commaIndex !== -1) return raw.slice(commaIndex + 1);
  return raw;
}

function getImageDataFromBody(body) {
  const data =
    body.image_base64 || body.imageData || body.image_data || body.photo_base64 || body.photoData || "";
  return stripBase64Prefix(data).replace(/\s/g, "");
}

function buildVisionPrompt({ prompt, project_title }) {
  const userPrompt = String(prompt || "").trim();
  const title = String(project_title || "").trim();
  return [
    title ? `Active project: ${title}` : "Active project: not named yet",
    "",
    userPrompt || "Analyze this photo as one focused visible project area.",
    "",
    "Use the photo to describe visible conditions and identify possible focus areas.",
    "Do not create Build Notes.",
    "Do not create a POZi Item List.",
    "Do not create sourcing recommendations.",
    "Ask one clear question so BUILDr Chat can continue with the right context.",
    "If the photo is too broad, unclear, or missing scale, explain what can be seen and ask which specific area to focus on.",
    "Do not attempt to estimate an entire house or full property from one image."
  ].join("\n");
}

function detectProjectType(textValue) {
  const text = String(textValue || "").toLowerCase();
  if (["deck","stairs","stair","stringer","joist"].some((x) => text.includes(x))) return "deck";
  if (["sink","plumbing","pipe","faucet","drain","water line","pex"].some((x) => text.includes(x))) return "plumbing";
  if (["electrical","outlet","light switch","breaker","conduit","wire","trench"].some((x) => text.includes(x))) return "electrical";
  if (["roof","shingle"].some((x) => text.includes(x))) return "roofing";
  if (["concrete","slab","footing","crack"].some((x) => text.includes(x))) return "concrete";
  if (["room","furniture","sofa","layout"].some((x) => text.includes(x))) return "interior_design";
  if (["tv","speaker","smart home","home theater"].some((x) => text.includes(x))) return "electronics";
  if (["fence","gate","post","wire clip","fence clip"].some((x) => text.includes(x))) return "fencing";
  if (["paint","drywall","floor","flooring","trim"].some((x) => text.includes(x))) return "finishing";
  if (["irrigation","sprinkler","drip line","valve"].some((x) => text.includes(x))) return "irrigation";
  if (["drainage","french drain","gravel trench"].some((x) => text.includes(x))) return "drainage";
  return "vision_general";
}

// Vision usage = count of vision rows (source_page "pozi.vision") logged today.
// Signed-in users counted by verified user_id; guests by client IP.
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

async function checkVisionDailyLimit({ userId, userEmail, tier, event }) {
  if (isUnlimitedTestUser(userEmail)) {
    return { allowed: true, tier: "test_unlimited", limit: 999999, used: 0, remaining: 999999, vision_based: true, unlimited_test_access: true };
  }
  const limit = BUILDR_VISION_DAILY_LIMITS[tier] ?? BUILDR_VISION_DAILY_LIMITS.guest;
  const usedToday = await countVisionUsesToday({ userId, event });

  if (usedToday >= limit) {
    return { allowed: false, tier, limit, used: usedToday, remaining: 0, vision_based: true };
  }
  const nextUsed = usedToday + 1;
  return { allowed: true, tier, limit, used: nextUsed, remaining: Math.max(limit - nextUsed, 0), vision_based: true };
}

function visionLimitMessage(tier) {
  if (tier === "guest") return "You’ve used today’s Guest – Free photo analysis. Create a free account to analyze more project photos.";
  if (tier === "free") return "You’ve used today’s Account – Free photo analyses. Upgrade to Consumer or Pro for more photo-powered BUILDr help.";
  if (tier === "consumer") return "You’ve reached today’s Consumer photo analysis limit. Upgrade to Pro for higher photo usage.";
  return "You’ve reached today’s BUILDr Vision usage limit.";
}

async function logVisionToSupabase({ prompt, reply, project_type, sessionId, userId, image_meta }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.warn("Supabase logging skipped: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    return null;
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/buildr_chats`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      prompt: `[VISION]\n${prompt}\n\nImage: ${JSON.stringify(image_meta || {})}`,
      reply,
      mode: "vision",
      project_type,
      session_id: sessionId || null,
      user_id: userId || null,
      source_page: "pozi.vision",
      thumb_rating: null
    })
  });

  if (!response.ok) {
    console.warn("Supabase vision logging failed:", await response.text());
    return null;
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function callAnthropicVision({ imageData, mediaType, visionPrompt }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_VISION_MAX_TOKENS,
        system: BUILDR_VISION_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageData } },
            { type: "text", text: visionPrompt }
          ]
        }]
      })
    });

    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { error: { message: raw || "Anthropic returned an invalid response." } }; }

    if (!response.ok) {
      const error = new Error(data?.error?.message || "Anthropic vision request failed.");
      error.statusCode = response.status;
      error.details = data?.error || data;
      throw error;
    }

    return data?.content?.find((item) => item.type === "text")?.text ||
      data?.content?.[0]?.text ||
      "No vision response returned.";
  } finally {
    clearTimeout(timeout);
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-pozi-session-id",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });

  try {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return jsonResponse(400, { ok: false, error: "Invalid JSON request body." }); }

    const prompt = String(body.prompt || body.caption || body.context || "").trim();
    const project_title = body.project_title ? String(body.project_title) : "";
    const rawSessionId = body.session_id ? String(body.session_id) : "";
    const mediaType = normalizeMediaType(body.media_type || body.image_media_type || body.mime_type);
    const imageData = getImageDataFromBody(body);

    if (!imageData) {
      return jsonResponse(400, { ok: false, error: "Missing image data. Send image_base64 or imageData." });
    }
    if (imageData.length > MAX_IMAGE_BASE64_LENGTH) {
      return jsonResponse(413, { ok: false, error: "Image is too large for BUILDr Vision. Please compress or resize the photo before sending." });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return jsonResponse(500, { ok: false, error: "Missing ANTHROPIC_API_KEY environment variable." });
    }

    const bearerToken = getBearerToken(event);
    let verifiedIdentity = null;
    try {
      verifiedIdentity = bearerToken ? await getVerifiedIdentity(bearerToken) : null;
    } catch (configError) {
      console.error("BUILDr Vision identity config error:", configError);
      return jsonResponse(500, { ok: false, error: configError?.message || "Server configuration error." });
    }
    if (bearerToken && !verifiedIdentity) {
      return jsonResponse(401, { ok: false, error: "Your session has expired or is invalid. Please sign in again." });
    }

    const userId = verifiedIdentity?.user_id || null;
    const userEmail = verifiedIdentity?.user_email || "";

    // BUILDr Vision requires an account. Guests are prompted to create one.
    if (!userId) {
      return jsonResponse(401, {
        ok: false,
        error: "Create a free account to use BUILDr Vision photo analysis.",
        requires_account: true
      });
    }

    const tier = await getVerifiedTier(userId);
    const sessionId = makeStableSessionId({ rawSessionId, userId, event });
    const visionPrompt = buildVisionPrompt({ prompt, project_title });
    const project_type = detectProjectType(`${project_title}\n${prompt}`);

    const usage = await checkVisionDailyLimit({ userId, userEmail, tier, event });
    if (!usage.allowed) {
      return jsonResponse(429, { ok: false, error: visionLimitMessage(usage.tier), usage });
    }

    const reply = await callAnthropicVision({ imageData, mediaType, visionPrompt });

    const savedChat = await logVisionToSupabase({
      prompt: visionPrompt,
      reply,
      project_type,
      sessionId,
      userId,
      image_meta: { media_type: mediaType, image_base64_length: imageData.length, project_title: project_title || null }
    });

    return jsonResponse(200, {
      ok: true,
      reply,
      chat_id: savedChat?.id || null,
      mode: "vision",
      project_type,
      authenticated: Boolean(userId),
      usage
    });
  } catch (error) {
    console.error("BUILDr Vision function error:", error);

    if (error?.name === "AbortError") {
      return jsonResponse(504, { ok: false, error: "BUILDr Vision took too long to respond. Please try again." });
    }
    if (error?.statusCode) {
      return jsonResponse(error.statusCode, { ok: false, error: error.message || "Anthropic vision request failed.", anthropic_error: error.details || null });
    }
    return jsonResponse(500, { ok: false, error: error?.message || "Unknown BUILDr Vision server error." });
  }
};
