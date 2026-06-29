// netlify/functions/buildr-chat.js
// Secure POZi BUILDr → Anthropic proxy + Supabase chat logging.
//
// Required Netlify env vars:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Recommended:
//   SUPABASE_ANON_KEY
//
// Optional:
//   ANTHROPIC_MODEL              default: claude-haiku-4-5-20251001
//   ANTHROPIC_MAX_TOKENS         default: 900
//   ANTHROPIC_TIMEOUT_MS         default: 9000   (keep BELOW your Netlify function timeout)
//   BUILDR_MAX_PROMPT_CHARS      default: 24000
//   BUILDR_PROFILE_TABLE         only set after paid-tier storage exists
//   BUILDR_PLAN_COLUMN           only set after paid-tier storage exists
//   BUILDR_PROFILE_ID_COLUMN     default: id
//
// Security model:
// - Identity comes only from a verified Supabase bearer token.
// - Paid tier comes only from the database.
// - Body-supplied user_id, email, and account_type are ignored.
// - Missing token = Guest.
// - Supplied but invalid/expired token = 401.
// - Signed-in session IDs are namespaced to the verified user.

const BUILDR_SYSTEM_PROMPT = `You are BUILDr — POZi's AI project planning and sourcing assistant.

You help real people build real things.

You think like:
- a contractor
- estimator
- designer
- sourcing specialist
- material planner
- retail strategist
- practical field reference

You are practical, direct, efficient, and realistic.
You do not behave like a generic chatbot assistant.
You are part of the POZi sourcing engine.

POZi handles search, sourcing, clickable results, and item list generation after the user presses "Source My Items."

Your job is to:
- organize the project
- identify materials
- identify tools
- identify quantities
- identify categories
- prepare clean searchable item-list entries
- provide practical Build Notes when relevant
- explain common construction logic before the user buys materials

BUILDr may provide practical guidance about:
- common spacing
- trenching basics
- drainage
- material suitability
- fasteners
- footings
- framing
- stair and stringer planning basics
- fence installation
- concrete preparation
- plumbing routing basics
- electrical conduit planning
- irrigation and outdoor water routing basics
- installation sequencing
- common contractor practices
- tool recommendations
- beginner-friendly project explanations

BUILDr should answer normal construction questions such as:
- common spacing for screws, clips, joists, studs, hangers, posts, or fasteners
- common clip or fastener quantities for fences, panels, boards, and similar installations
- whether gravel, sand, compacted base, drainage fabric, or bedding material is commonly used
- common trench, post, conduit, pipe, or footing depths
- installation order
- materials and tools usually needed
- mistakes to avoid before purchasing supplies

BUILDr should:
- give concise practical guidance
- explain common building practices
- avoid overexplaining
- tie advice directly to the active project
- distinguish common practice from local code
- ask one smart follow-up question only when the answer materially affects safety, sizing, quantities, or sourcing
- use plain language a homeowner, builder, or contractor can act on

BUILDr is not:
- a licensed engineer
- a building inspector
- a permit authority
- a code-compliance guarantee
- a replacement for local code, utility marking, permits, or licensed professionals

For structural, electrical, plumbing, gas, roofing, excavation, load-bearing, utility, or other safety-critical work:
- recommend verifying local code
- recommend checking permits when appropriate
- recommend calling 811 or the local utility-marking service before digging when relevant
- recommend a qualified professional when real safety or legal risk exists

Use phrases such as:
- "commonly"
- "typically"
- "many contractors"
- "common residential practice"
- "verify local code"
- "before digging, confirm utilities and local requirements"

Never:
- present uncertain guidance as guaranteed
- provide dangerous shortcuts
- present regulated work guidance as final code authority
- invent inventory availability
- fabricate pricing
- overpromise outcomes
- discuss DataForSEO with customers
- discuss internal app architecture
- ask what item-list format the user wants
- ask whether the user wants clickable or printable lists
- ask how checkout should work
- ask whether links should be generated

When enough information exists:
- automatically produce a useful project plan
- include concise Build Notes when relevant
- produce an item-list-ready list
- stop asking unnecessary questions
- move directly into material organization

Communication rules:
- short sentences
- practical wording
- no fluff
- no giant tutorials
- one smart question at a time only when critical information is missing

If the user asks a broad question:
- give a useful first answer
- prepare a starter item list when possible
- ask only the single most important follow-up question if needed

Always think in terms of:
- real-world sourcing
- searchable materials
- contractor logic
- efficient purchasing
- POZi item-list readiness
- project-specific construction guidance

BUILD NOTES
When relevant, include a short section labeled exactly:

Build Notes:

Build Notes should:
- be concise
- contain practical construction guidance
- help the user avoid mistakes
- improve project planning
- stay directly relevant to the project
- use normal builder language

Useful Build Notes may cover:
- spacing
- trench depth
- utility marking
- drainage
- fastener use
- installation sequence
- curing
- material compatibility
- common code checks
- tools and safety

LEARNING LOOP
Treat unusual, repeated, or high-value construction questions as future knowledge candidates.
Answer carefully with current best practical guidance.
Do not claim the system permanently learned anything.
Keep the response safe, code-aware, and useful for later review.
Do not mention internal logging or review unless the user asks.

ITEM-LIST WORKFLOW
BUILDr prepares item-list-ready text.
The user must press "Source My Items" to run POZi sourcing.
Do not imply sourcing has already happened.
Do not encourage early sourcing.
The list should feel ready only after the dialogue, Build Notes, and item list are complete.

RESPONSE STRUCTURE
When a project reaches a usable planning stage, use these exact section labels:

Build Notes:
- short practical notes
- spacing, trenching, installation, drainage, fastener, code, or safety reminders when relevant

POZi Item List:
- short searchable supply items
- materials
- tools only when truly needed

Conversation or explanation may appear above these sections.
Keep Build Notes concise.
Keep POZi Item List entries short and searchable.
Do not mix explanations into item entries.

Item-list entries must:
- be short
- be searchable
- work well for product and store search
- avoid paragraphs
- avoid explanations
- avoid questions
- avoid checkout suggestions

Good entries:
- pressure treated 4x4 post
- galvanized joist hanger
- exterior deck screws
- 80lb concrete mix
- cedar deck board
- PVC electrical conduit
- trench warning tape
- drainage gravel
- galvanized fence clips

After the item-list entries, say exactly:
"Your item list is ready. Press Source My Items when you're finished reviewing the list."

Your goal:
Turn messy project ideas into organized, practical, sourcing-ready project plans for POZi.`;

const BUILDR_DAILY_LIMITS = Object.freeze({ guest: 1, free: 3, consumer: 10, pro: 25 });
const BUILDR_MESSAGES_PER_SESSION = Object.freeze({ guest: 5, free: 5, consumer: 10, pro: 15 });
const BUILDR_TEST_UNLIMITED_EMAILS = new Set(["info@pozi.live"]);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ANTHROPIC_MODEL = String(process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001").trim();
const ANTHROPIC_MAX_TOKENS = positiveInteger(process.env.ANTHROPIC_MAX_TOKENS, 900);
// Keep this BELOW your Netlify function timeout (Netlify default is 10s, max 26s) so this
// AbortController fires first and returns a clean 504 instead of an opaque platform timeout.
const ANTHROPIC_TIMEOUT_MS = positiveInteger(process.env.ANTHROPIC_TIMEOUT_MS, 9000);
const MAX_PROMPT_CHARS = positiveInteger(process.env.BUILDR_MAX_PROMPT_CHARS, 24000);

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

function unlimitedUsagePayload(sessionId) {
  return {
    allowed: true,
    tier: "test_unlimited",
    limit: 999999,
    used: 0,
    remaining: 999999,
    session_based: true,
    current_session_seen: true,
    current_session_id: sessionId,
    unlimited_test_access: true
  };
}

function unlimitedMessagePayload() {
  return {
    allowed: true,
    limit: 999999,
    used: 0,
    remaining: 999999,
    message_based: true,
    unlimited_test_access: true
  };
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

  if (user) {
    return `user_${user}__${rawSession || "default_session"}`;
  }

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

async function getBuildrSessionsToday({ sessionId, userId, event }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const currentSession = cleanIdentity(sessionId);
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

  return {
    session_count: sessionSet.size,
    current_session_seen: currentSession ? sessionSet.has(currentSession) : false,
    current_session_id: currentSession
  };
}

async function checkBuildrDailyLimit({ sessionId, userId, userEmail, accountType, event }) {
  if (isUnlimitedTestUser(userEmail)) return unlimitedUsagePayload(sessionId);

  const tier = normalizePlanTier(accountType, Boolean(userId));
  const limit = BUILDR_DAILY_LIMITS[tier] ?? BUILDR_DAILY_LIMITS.guest;
  const sessionUsage = await getBuildrSessionsToday({ sessionId, userId, event });
  const isExistingSession = Boolean(sessionUsage.current_session_seen);
  const usedToday = sessionUsage.session_count;
  const wouldUse = isExistingSession ? usedToday : usedToday + 1;

  if (!isExistingSession && usedToday >= limit) {
    return {
      allowed: false,
      tier,
      limit,
      used: usedToday,
      remaining: 0,
      session_based: true,
      current_session_seen: false,
      current_session_id: sessionUsage.current_session_id
    };
  }

  return {
    allowed: true,
    tier,
    limit,
    used: wouldUse,
    remaining: Math.max(limit - wouldUse, 0),
    session_based: true,
    current_session_seen: isExistingSession,
    current_session_id: sessionUsage.current_session_id
  };
}

async function checkBuildrMessageLimit({ sessionId, tier, userEmail }) {
  if (tier === "test_unlimited" || isUnlimitedTestUser(userEmail)) return unlimitedMessagePayload();

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const limit = BUILDR_MESSAGES_PER_SESSION[tier] ?? BUILDR_MESSAGES_PER_SESSION.guest;

  // True per-session limit. New Chat must rotate the session ID.
  const url = `${supabaseUrl}/rest/v1/buildr_chats?select=id` +
    `&session_id=eq.${encodeURIComponent(sessionId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });

  if (!response.ok) throw new Error((await response.text()) || "Unable to count BUILDr session messages.");

  const rows = await response.json().catch(() => []);
  const currentUsed = Array.isArray(rows) ? rows.length : 0;
  const nextUsed = currentUsed + 1;

  return {
    allowed: currentUsed < limit,
    limit,
    used: nextUsed,
    remaining: Math.max(limit - nextUsed, 0),
    message_based: true
  };
}

function buildrLimitMessage(tier) {
  if (tier === "guest") return "You’ve used your free guest BUILDr session for today. Create a free account to keep planning.";
  if (tier === "free") return "You’ve used your free BUILDr sessions for today. Upgrade to Consumer or Pro to keep building.";
  if (tier === "consumer") return "You’ve reached today’s Consumer BUILDr session limit. Upgrade to Pro for higher project usage.";
  return "You’ve reached today’s BUILDr usage limit.";
}

function buildrMessageLimitMessage(tier) {
  if (tier === "guest") return "You’ve reached the 5-message limit for this guest BUILDr session. Create a free account to keep planning.";
  if (tier === "free") return "You’ve reached the 5-message limit for this free BUILDr session. Start a new BUILDr session if you have sessions remaining today.";
  if (tier === "consumer") return "You’ve reached the 10-message limit for this Consumer BUILDr session. Start a new BUILDr session if you have sessions remaining today.";
  if (tier === "pro") return "You’ve reached the 15-message limit for this Pro BUILDr session. Start a new BUILDr session if you have sessions remaining today.";
  return "You’ve reached the message limit for this BUILDr session.";
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

function detectMode(prompt) {
  const text = String(prompt || "").toLowerCase();
  const proWords = ["client","job","bid","quote","deadline","crew","install","materials","linear feet","square feet","sq ft","studs","joists","rafters","concrete","deck","framing","permit","takeoff","estimate"];
  const consumerWords = ["room","couch","sofa","tv","speaker","decor","lighting","apartment","bedroom","living room","kitchen","style","furniture","home theater"];
  if (proWords.some((word) => text.includes(word))) return "pro";
  if (consumerWords.some((word) => text.includes(word))) return "consumer";
  return "general";
}

function detectProjectType(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (["deck","stairs","stair","stringer","joist"].some((x) => text.includes(x))) return "deck";
  if (["sink","plumbing","pipe","faucet","drain","water line"].some((x) => text.includes(x))) return "plumbing";
  if (["electrical","outlet","light switch","breaker","conduit","wire","trench"].some((x) => text.includes(x))) return "electrical";
  if (["roof","shingle"].some((x) => text.includes(x))) return "roofing";
  if (["concrete","slab","footing"].some((x) => text.includes(x))) return "concrete";
  if (["room","furniture","sofa","layout"].some((x) => text.includes(x))) return "interior_design";
  if (["tv","speaker","smart home","home theater"].some((x) => text.includes(x))) return "electronics";
  if (["fence","gate","post","wire clip","fence clip"].some((x) => text.includes(x))) return "fencing";
  if (["paint","drywall","floor","flooring","screw spacing"].some((x) => text.includes(x))) return "finishing";
  if (["irrigation","sprinkler","drip line"].some((x) => text.includes(x))) return "irrigation";
  if (["drainage","french drain","gravel trench"].some((x) => text.includes(x))) return "drainage";
  return "general";
}

async function logToSupabase({ prompt, reply, mode, projectType, sessionId, userId }) {
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
      prompt,
      reply,
      mode,
      project_type: projectType,
      session_id: sessionId || null,
      user_id: userId || null,
      source_page: "pozi.live",
      thumb_rating: null
    })
  });

  if (!response.ok) {
    console.warn("Supabase logging failed:", await response.text());
    return null;
  }

  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function callAnthropic(prompt) {
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
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: BUILDR_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: { message: raw || "Anthropic returned an invalid response." } };
    }

    if (!response.ok) {
      const error = new Error(data?.error?.message || "Anthropic request failed.");
      error.statusCode = response.status;
      error.details = data?.error || data;
      throw error;
    }

    return data?.content?.find((item) => item.type === "text")?.text ||
      data?.content?.[0]?.text ||
      data?.completion ||
      "No response returned.";
  } finally {
    clearTimeout(timeout);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });

  try {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { ok: false, error: "Invalid JSON request body." });
    }

    const prompt = String(body.prompt || "").trim();
    const rawSessionId = body.session_id ? String(body.session_id) : "";

    if (!prompt) return jsonResponse(400, { ok: false, error: "Missing prompt." });
    if (prompt.length > MAX_PROMPT_CHARS) {
      return jsonResponse(413, {
        ok: false,
        error: `Prompt is too long. Maximum length is ${MAX_PROMPT_CHARS} characters.`
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return jsonResponse(500, { ok: false, error: "Missing ANTHROPIC_API_KEY environment variable." });
    }

    const bearerToken = getBearerToken(event);
    const verifiedIdentity = bearerToken ? await getVerifiedIdentity(bearerToken) : null;

    if (bearerToken && !verifiedIdentity) {
      return jsonResponse(401, {
        ok: false,
        error: "Your session has expired or is invalid. Please sign in again."
      });
    }

    const userId = verifiedIdentity?.user_id || null;
    const userEmail = verifiedIdentity?.user_email || "";
    const accountType = userId ? await getVerifiedTier(userId) : "guest";
    const sessionId = makeStableSessionId({ rawSessionId, userId, event });
    const mode = detectMode(prompt);
    const projectType = detectProjectType(prompt);

    const usage = await checkBuildrDailyLimit({
      sessionId,
      userId,
      userEmail,
      accountType,
      event
    });

    if (!usage.allowed) {
      return jsonResponse(429, {
        ok: false,
        error: buildrLimitMessage(usage.tier),
        usage
      });
    }

    const messageUsage = await checkBuildrMessageLimit({
      sessionId,
      tier: usage.tier,
      userEmail
    });

    if (!messageUsage.allowed) {
      return jsonResponse(429, {
        ok: false,
        error: buildrMessageLimitMessage(usage.tier),
        usage: { ...usage, messages: messageUsage }
      });
    }

    const reply = await callAnthropic(prompt);
    const savedChat = await logToSupabase({
      prompt,
      reply,
      mode,
      projectType,
      sessionId,
      userId
    });

    return jsonResponse(200, {
      ok: true,
      reply,
      chat_id: savedChat?.id || null,
      mode,
      project_type: projectType,
      authenticated: Boolean(userId),
      usage: { ...usage, messages: messageUsage }
    });
  } catch (error) {
    console.error("BUILDr function error:", error);

    if (error?.name === "AbortError") {
      return jsonResponse(504, {
        ok: false,
        error: "BUILDr took too long to respond. Please try again."
      });
    }

    if (error?.statusCode) {
      return jsonResponse(error.statusCode, {
        ok: false,
        error: error.message || "Anthropic request failed.",
        anthropic_error: error.details || null
      });
    }

    return jsonResponse(500, {
      ok: false,
      error: error?.message || "Unknown server error."
    });
  }
};
