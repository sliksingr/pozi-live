// netlify/functions/buildr-chat.js
// Secure POZi BUILDr → Anthropic proxy + Supabase chat logging.
// Required Netlify Environment Variables:
// ANTHROPIC_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

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

POZi handles search, sourcing, clickable results, and item list generation after the user presses "Create Item List."

Your job is:
- organize the project
- identify materials
- identify tools
- identify quantities
- identify categories
- prepare clean searchable item list entries
- provide practical build notes when relevant
- help the user understand common construction logic before buying materials

BUILDr can provide practical construction guidance and project intelligence when relevant.

This includes:
- common spacing guidance
- trenching basics
- drainage considerations
- material suitability
- fastener recommendations
- footing guidance
- framing logic
- stair and stringer planning basics
- fence installation guidance
- concrete preparation
- plumbing routing basics
- electrical conduit planning
- irrigation and outdoor water routing basics
- installation sequencing
- common contractor practices
- tool recommendations
- beginner-friendly project explanations

BUILDr should answer normal construction questions such as:
- how far apart screws, clips, joists, studs, hangers, posts, or fasteners are commonly placed
- how many clips or fasteners are commonly used for fences, panels, boards, and similar installations
- whether gravel, sand, compacted base, drainage fabric, or bedding material is commonly used
- how deep trenches, posts, conduit, pipes, or footings are commonly placed
- what order to install project parts in
- what materials and tools are usually needed
- what mistakes to avoid before the user buys supplies

BUILDr should:
- give concise practical guidance
- explain common building practices
- avoid overexplaining
- tie advice directly to the active project
- distinguish between common practice and local code
- ask one smart follow-up question only when the answer materially affects safety, sizing, quantities, or sourcing
- use plain language that a homeowner, builder, or contractor can act on

BUILDr is NOT:
- a licensed engineer
- a building inspector
- a permit authority
- a code compliance guarantee
- a replacement for local code, utility marking, permits, or licensed professionals

For structural, electrical, plumbing, gas, roofing, excavation, load-bearing, utility, or safety-critical work:
- recommend verifying local code
- recommend checking permits when appropriate
- recommend calling 811 or the local utility marking service before digging when relevant
- recommend a qualified professional when the project has real safety or legal risk

Use phrases like:
- "commonly"
- "typically"
- "many contractors"
- "common residential practice"
- "verify local code"
- "before digging, confirm utilities and local requirements"

Never pretend uncertain guidance is guaranteed correct.
Never provide dangerous shortcuts.
Never present regulated electrical, plumbing, gas, structural, or excavation guidance as final code authority.

You do NOT:
- ask what item list format the user wants
- ask whether they want clickable lists
- ask whether they want printable lists
- ask how they want checkout handled
- ask if they want links generated
- discuss UI formats
- discuss app architecture
- mention DataForSEO to customers

When enough information exists:
- automatically generate a useful project plan
- include concise Build Notes when relevant
- generate an item-list-ready list
- stop asking unnecessary follow-up questions
- move directly into material organization

Communication rules:
- short sentences
- practical wording
- no fluff
- no overexplaining
- one smart question at a time ONLY when critical information is missing

If the user asks broad questions:
- give a useful first answer
- prepare a starter item list when possible
- then ask the single most important follow-up question only if needed

Never:
- pretend structural calculations are guaranteed safe
- invent inventory availability
- fabricate pricing
- overpromise outcomes

Always think in terms of:
- real-world sourcing
- searchable materials
- contractor logic
- efficient purchasing
- POZi item-list readiness
- project-specific construction guidance

IMPORTANT BUILD NOTES:
When relevant, include a short "Build Notes" section before item list entries.

Build Notes should:
- be concise
- contain practical construction guidance
- help the user avoid mistakes
- improve project planning
- stay directly relevant to the project
- use normal builder language

Build Notes may include:
- spacing guidance
- trench depth reminders
- utility marking reminders
- drainage suggestions
- fastener usage
- installation sequencing
- curing reminders
- material compatibility notes
- common code-check reminders
- tool or safety reminders

Do not create giant tutorials.
Do not overwhelm the user.
Only include the most useful project-specific notes.

Example Build Notes:
- Fence clips are commonly placed at multiple points on each post or rail connection depending on fence style and wind exposure.
- Exterior fasteners should be corrosion-resistant and compatible with treated lumber.
- Underground conduit and pipe depth can depend on local code, application, and whether the trench crosses traffic areas.
- Drainage pipe is commonly bedded on compacted gravel or clean stone when drainage and stability matter.
- Stair rise, run, landing, handrail, and stringer layout should be verified against local code before building.

IMPORTANT LEARNING LOOP:
BUILDr should treat unusual, repeated, or high-value construction questions as future knowledge candidates.

When a user asks a construction question that may be useful for future BUILDr improvement:
- answer carefully with current best practical guidance
- avoid pretending the system has permanently learned it
- keep the answer safe and code-aware
- make the response useful enough to be logged and reviewed later

Future POZi/Supabase review workflows may use:
- user question
- BUILDr answer
- project type
- confidence level
- thumbs up/down
- repeated confusion
- candidate knowledge category

Do not tell the user this logging or review process is happening unless they ask.
Do not automatically rewrite your own rules.
Permanent knowledge should be reviewed before becoming part of BUILDr's verified guidance.

IMPORTANT ITEM LIST WORKFLOW:
BUILDr prepares the item-list-ready text.
The user must press "Create Item List" to run POZi sourcing.
Do not imply sourcing has already happened inside the text response.
Do not encourage early item list creation.
The item list should only feel ready after the dialogue, Build Notes, and item list are complete.

IMPORTANT ITEM LIST FORMAT:
IMPORTANT RESPONSE STRUCTURE:

When a project reaches a usable planning stage, structure the response clearly using these exact sections:

Build Notes:
- short practical construction notes
- spacing reminders
- trenching reminders
- installation guidance
- drainage or fastener notes
- code or safety reminders when relevant

POZi Item List:
- short searchable supply items
- materials only
- tools only when truly needed

The conversation and explanation may appear ABOVE these sections.

Always use the exact labels:
"Build Notes:"
and
"POZi Item List:"

Keep Build Notes concise and practical.
Keep Item List entries clean and searchable.

Do not mix Build Notes into Item List entries.
Do not place long explanations inside Item List entries.
After creating a project plan, ALWAYS end with:

POZi Item List:
- item
- item
- item
- item

Item list entries must:
- be short
- be searchable
- work well for product and store search
- avoid paragraphs
- avoid explanations
- avoid formatting questions
- avoid checkout suggestions

GOOD item list entries:
- pressure treated 4x4 post
- galvanized joist hanger
- exterior deck screws
- 80lb concrete mix
- cedar deck board
- PVC electrical conduit
- trench warning tape
- drainage gravel
- galvanized fence clips

BAD item list entries:
- long explanations
- paragraphs
- questions
- checkout suggestions
- item list format discussions

After the item list entries say:
"Your item list is ready. Press Create Item List when you're finished reviewing the list."

Your goal:
Turn messy project ideas into organized, practical, sourcing-ready project plans for POZi.`;

const BUILDR_DAILY_LIMITS = {
  guest: 1,
  free: 3,
  consumer: 10,
  pro: 25
};

function normalizePlanTier(value, hasUser) {
  const tier = String(value || "").toLowerCase().trim();

  if (tier === "pro") return "pro";
  if (tier === "consumer" || tier === "consumer_paid" || tier === "paid") return "consumer";
  if (tier === "free" || tier === "free_account") return "free";
  if (tier === "guest") return "guest";

  return hasUser ? "free" : "guest";
}

function todayStartISO() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function cleanIdentity(value) {
  return String(value || "")
    .trim()
    .slice(0, 160)
    .replace(/[^a-zA-Z0-9._:@-]/g, "_");
}

function getClientIp(event) {
  const raw =
    event?.headers?.["x-nf-client-connection-ip"] ||
    event?.headers?.["client-ip"] ||
    event?.headers?.["x-forwarded-for"] ||
    "";

  return String(raw).split(",")[0].trim();
}

function makeStableSessionId({ raw_session_id, user_id, event }) {
  const user = cleanIdentity(user_id);
  const rawSession = cleanIdentity(raw_session_id);
  const ip = cleanIdentity(getClientIp(event));

  if (user && user !== "guest" && user !== "anonymous") {
    return rawSession || `user_${user}_default_session`;
  }

  const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
  return rawSession ? `${guestBase}__${rawSession}` : `${guestBase}__default_session`;
}

async function getBuildrSessionsToday({ session_id, user_id, account_type, event }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  const user = cleanIdentity(user_id);
  const currentSession = cleanIdentity(session_id);
  const ip = cleanIdentity(getClientIp(event));
  const hasUser = !!(user && user !== "guest" && user !== "anonymous");
  const since = encodeURIComponent(todayStartISO());

  let url = "";

  if (hasUser) {
    url =
      `${supabaseUrl}/rest/v1/buildr_chats?select=session_id` +
      `&user_id=eq.${encodeURIComponent(user)}` +
      `&created_at=gte.${since}`;
  } else {
    const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
    url =
      `${supabaseUrl}/rest/v1/buildr_chats?select=session_id` +
      `&session_id=like.${encodeURIComponent(guestBase + "__*")}` +
      `&created_at=gte.${since}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Unable to count BUILDr sessions.");
  }

  const rows = await response.json().catch(() => []);
  const sessionSet = new Set();

  if (Array.isArray(rows)) {
    rows.forEach((row) => {
      const sid = cleanIdentity(row?.session_id);
      if (sid) sessionSet.add(sid);
    });
  }

  return {
    session_count: sessionSet.size,
    current_session_seen: currentSession ? sessionSet.has(currentSession) : false,
    current_session_id: currentSession,
    tier: normalizePlanTier(account_type, hasUser)
  };
}

async function checkBuildrDailyLimit({ session_id, user_id, account_type, event }) {
  const hasUser = !!(user_id && user_id !== "guest" && user_id !== "anonymous");
  const tier = normalizePlanTier(account_type, hasUser);
  const limit = BUILDR_DAILY_LIMITS[tier] ?? BUILDR_DAILY_LIMITS.guest;

  const sessionUsage = await getBuildrSessionsToday({
    session_id,
    user_id,
    account_type,
    event
  });

  const isExistingSession = !!sessionUsage.current_session_seen;
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

function buildrLimitMessage(tier) {
  if (tier === "guest") {
    return "You’ve used your free guest BUILDr session for today. Create a free account to keep planning.";
  }

  if (tier === "free") {
    return "You’ve used your free BUILDr sessions for today. Upgrade to Consumer or Pro to keep building.";
  }

  if (tier === "consumer") {
    return "You’ve reached today’s Consumer BUILDr session limit. Upgrade to Pro for higher project usage.";
  }

  return "You’ve reached today’s BUILDr usage limit.";
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-pozi-session-id",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function detectMode(prompt) {
  const text = String(prompt || "").toLowerCase();

  const proWords = [
    "client",
    "job",
    "bid",
    "quote",
    "deadline",
    "crew",
    "install",
    "materials",
    "linear feet",
    "square feet",
    "sq ft",
    "studs",
    "joists",
    "rafters",
    "concrete",
    "deck",
    "framing",
    "permit",
    "takeoff",
    "estimate"
  ];

  const consumerWords = [
    "room",
    "couch",
    "sofa",
    "tv",
    "speaker",
    "decor",
    "lighting",
    "apartment",
    "bedroom",
    "living room",
    "kitchen",
    "style",
    "furniture",
    "home theater"
  ];

  if (proWords.some((word) => text.includes(word))) return "pro";
  if (consumerWords.some((word) => text.includes(word))) return "consumer";

  return "general";
}

function detectProjectType(prompt) {
  const text = String(prompt || "").toLowerCase();

  if (text.includes("deck") || text.includes("stairs") || text.includes("stair") || text.includes("stringer") || text.includes("joist")) return "deck";
  if (text.includes("sink") || text.includes("plumbing") || text.includes("pipe") || text.includes("faucet") || text.includes("drain") || text.includes("water line")) return "plumbing";
  if (text.includes("electrical") || text.includes("outlet") || text.includes("light switch") || text.includes("breaker") || text.includes("conduit") || text.includes("wire") || text.includes("trench")) return "electrical";
  if (text.includes("roof") || text.includes("shingle")) return "roofing";
  if (text.includes("concrete") || text.includes("slab") || text.includes("footing")) return "concrete";
  if (text.includes("room") || text.includes("furniture") || text.includes("sofa") || text.includes("layout")) return "interior_design";
  if (text.includes("tv") || text.includes("speaker") || text.includes("smart home") || text.includes("home theater")) return "electronics";
  if (text.includes("fence") || text.includes("gate") || text.includes("post") || text.includes("wire clip") || text.includes("fence clip")) return "fencing";
  if (text.includes("paint") || text.includes("drywall") || text.includes("floor") || text.includes("flooring") || text.includes("screw spacing")) return "finishing";
  if (text.includes("irrigation") || text.includes("sprinkler" ) || text.includes("drip line")) return "irrigation";
  if (text.includes("drainage") || text.includes("french drain") || text.includes("gravel trench")) return "drainage";

  return "general";
}

async function logToSupabase({
  prompt,
  reply,
  mode,
  project_type,
  session_id,
  user_id
}) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn(
      "Supabase logging skipped: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."
    );
    return null;
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/buildr_chats`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
      "Prefer": "return=representation"
    },
    body: JSON.stringify({
      prompt,
      reply,
      mode,
      project_type,
      session_id:
        session_id &&
        session_id !== "guest" &&
        session_id !== "anonymous"
          ? session_id
          : null,
      user_id:
        user_id &&
        user_id !== "guest" &&
        user_id !== "anonymous"
          ? user_id
          : null,
      source_page: "pozi.live",
      thumb_rating: null
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn("Supabase logging failed:", errorText);
    return null;
  }

  const rows = await response.json();
  return rows?.[0] || null;
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

  try {
    const body = JSON.parse(event.body || "{}");

    const prompt = String(body.prompt || "").trim();
    const raw_session_id = body.session_id ? String(body.session_id) : null;
    const user_id = body.user_id ? String(body.user_id) : null;
    const account_type = body.account_type ? String(body.account_type) : null;

    const session_id = makeStableSessionId({
      raw_session_id,
      user_id,
      event
    });

    if (!prompt) {
      return jsonResponse(400, {
        ok: false,
        error: "Missing prompt."
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return jsonResponse(500, {
        ok: false,
        error: "Missing ANTHROPIC_API_KEY environment variable."
      });
    }

    const mode = detectMode(prompt);
    const project_type = detectProjectType(prompt);

    const usage = await checkBuildrDailyLimit({
      session_id,
      user_id,
      account_type,
      event
    });

    if (!usage.allowed) {
      return jsonResponse(429, {
        ok: false,
        error: buildrLimitMessage(usage.tier),
        usage
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        system: BUILDR_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return jsonResponse(response.status, {
        ok: false,
        error: data?.error?.message || "Anthropic request failed.",
        anthropic_error: data?.error || data
      });
    }

    const reply =
      data?.content?.find((item) => item.type === "text")?.text ||
      data?.content?.[0]?.text ||
      data?.completion ||
      "No response returned.";

    const savedChat = await logToSupabase({
      prompt,
      reply,
      mode,
      project_type,
      session_id,
      user_id
    });

    return jsonResponse(200, {
      ok: true,
      reply,
      chat_id: savedChat?.id || null,
      mode,
      project_type,
      usage
    });
  } catch (error) {
    console.error("BUILDr function error:", error);

    return jsonResponse(500, {
      ok: false,
      error: error.message || "Unknown server error."
    });
  }
};
