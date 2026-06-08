// netlify/functions/buildr-vision.js
// Secure POZi BUILDr Vision → Anthropic vision proxy + Supabase logging.
// Required Netlify Environment Variables:
// ANTHROPIC_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

const BUILDR_VISION_SYSTEM_PROMPT = `You are BUILDr Vision — POZi's photo-powered project planning assistant.

You help real people inspect one visible project area, repair, installation, or improvement from a photo.

You think like:
- a practical contractor
- estimator
- material planner
- sourcing specialist
- field reference
- safety-aware project helper

Your job is NOT to design entire buildings from one image.
Your job is to help the user understand a focused visible project area and prepare useful Build Notes and a POZi Item List.

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
- shed door
- cracked concrete section
- small drainage problem
- room corner / wall area
- visible hardware, fasteners, brackets, lumber, tools, fixtures

BAD photo scopes:
- entire house build
- whole-property assessment
- full structural engineering
- complete remodel estimate from one image
- code approval
- final permit guidance
- hidden conditions behind walls, floors, roofing, or soil
- load-bearing decisions from image alone

If the image is too broad, unclear, unsafe, or missing scale, say so directly and ask for one focused photo or one key measurement.

Vision rules:
- Describe only what is visible or reasonably inferable.
- Do not pretend to see hidden damage, hidden wiring, hidden plumbing, structural loads, or exact dimensions.
- Use words like "appears", "looks like", "likely", "visible", "confirm", and "measure".
- Ask for measurements when size affects the item list.
- Keep advice practical and field-friendly.
- Keep the scope small enough for a homeowner, DIYer, builder, or contractor to act on.
- Do not overwhelm the user with a giant tutorial.
- Do not invent pricing or inventory.
- Do not mention DataForSEO or app architecture.

Safety/code rules:
For structural, electrical, plumbing, gas, roofing, excavation, load-bearing, utility, or safety-critical work:
- recommend verifying local code
- recommend checking permits when appropriate
- recommend calling 811 before digging when relevant
- recommend a qualified professional when the risk is real
- never present image-based guidance as code approval or engineering approval

Response style:
- short sentences
- practical wording
- mobile-friendly
- no fluff
- one smart follow-up question only if needed

Always structure useful photo responses like this:

What I can see:
- concise visible observations

Likely project / issue:
- the focused repair, installation, or improvement this photo appears to show

Build Notes:
- short practical notes
- measurements to confirm
- safety/code reminders when relevant
- common mistakes to avoid

POZi Item List:
- short searchable supply items
- materials only
- tools only when truly needed

Item list entries must be short, searchable, and suitable for sourcing.

GOOD item list entries:
- pressure treated 4x4 post
- galvanized joist hanger
- exterior deck screws
- SharkBite coupling
- PEX tubing cutter
- irrigation valve box
- drainage gravel
- concrete screws
- galvanized angle bracket

BAD item list entries:
- paragraphs
- long explanations
- checkout suggestions
- pricing guesses
- code guarantees
- hidden-condition assumptions

End with:
"Your item list is ready. Source one item at a time when you're ready."

Your goal:
Turn one focused project photo into realistic Build Notes and a POZi sourcing-ready item list.`;

const BUILDR_VISION_DAILY_LIMITS = {
  guest: 1,
  free: 3,
  consumer: 10,
  pro: 25
};

const BUILDR_TEST_UNLIMITED_EMAILS = [
  "info@pozi.live"
];

const MAX_IMAGE_BASE64_LENGTH = 7_000_000; // about 5MB binary before base64 overhead
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isUnlimitedTestUser(...values) {
  return values
    .map(normalizeEmail)
    .some((value) => BUILDR_TEST_UNLIMITED_EMAILS.includes(value));
}

function normalizePlanTier(value, hasUser) {
  const tier = String(value || "").toLowerCase().trim();

  if (tier === "pro") return "pro";
  if (tier === "consumer" || tier === "consumer_paid" || tier === "paid") return "consumer";
  if (tier === "free" || tier === "free_account" || tier === "account_free") return "free";
  if (tier === "guest") return "guest";

  return hasUser ? "free" : "guest";
}

function unlimitedVisionUsagePayload(session_id) {
  return {
    allowed: true,
    tier: "test_unlimited",
    limit: 999999,
    used: 0,
    remaining: 999999,
    vision_based: true,
    current_session_id: session_id,
    unlimited_test_access: true
  };
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
    return rawSession || `user_${user}_default_vision_session`;
  }

  const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
  return rawSession ? `${guestBase}__${rawSession}` : `${guestBase}__default_vision_session`;
}

function detectProjectType(textValue) {
  const text = String(textValue || "").toLowerCase();

  if (text.includes("deck") || text.includes("stairs") || text.includes("stair") || text.includes("stringer") || text.includes("joist")) return "deck";
  if (text.includes("sink") || text.includes("plumbing") || text.includes("pipe") || text.includes("faucet") || text.includes("drain") || text.includes("water line") || text.includes("pex")) return "plumbing";
  if (text.includes("electrical") || text.includes("outlet") || text.includes("light switch") || text.includes("breaker") || text.includes("conduit") || text.includes("wire") || text.includes("trench")) return "electrical";
  if (text.includes("roof") || text.includes("shingle")) return "roofing";
  if (text.includes("concrete") || text.includes("slab") || text.includes("footing") || text.includes("crack")) return "concrete";
  if (text.includes("room") || text.includes("furniture") || text.includes("sofa") || text.includes("layout")) return "interior_design";
  if (text.includes("tv") || text.includes("speaker") || text.includes("smart home") || text.includes("home theater")) return "electronics";
  if (text.includes("fence") || text.includes("gate") || text.includes("post") || text.includes("wire clip") || text.includes("fence clip")) return "fencing";
  if (text.includes("paint") || text.includes("drywall") || text.includes("floor") || text.includes("flooring") || text.includes("trim")) return "finishing";
  if (text.includes("irrigation") || text.includes("sprinkler") || text.includes("drip line") || text.includes("valve")) return "irrigation";
  if (text.includes("drainage") || text.includes("french drain") || text.includes("gravel trench")) return "drainage";

  return "vision_general";
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
  if (raw.startsWith("data:image/") && commaIndex !== -1) {
    return raw.slice(commaIndex + 1);
  }
  return raw;
}

function getImageDataFromBody(body) {
  const data =
    body.image_base64 ||
    body.imageData ||
    body.image_data ||
    body.photo_base64 ||
    body.photoData ||
    "";

  return stripBase64Prefix(data).replace(/\s/g, "");
}

function buildVisionPrompt({ prompt, project_title }) {
  const userPrompt = String(prompt || "").trim();
  const title = String(project_title || "").trim();

  return [
    title ? `Active project: ${title}` : "Active project: not named yet",
    "",
    userPrompt || "Analyze this photo as one focused repair, installation, improvement, or project area.",
    "",
    "Use the photo to create practical Build Notes and a POZi Item List.",
    "If the photo is too broad, unclear, or missing scale, explain what can be seen and ask for one focused measurement or closer photo.",
    "Do not attempt to estimate an entire house or full property from one image."
  ].join("\n");
}

async function countVisionUsesToday({ session_id, user_id, account_type, event }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  const user = cleanIdentity(user_id);
  const ip = cleanIdentity(getClientIp(event));
  const hasUser = !!(user && user !== "guest" && user !== "anonymous");
  const since = encodeURIComponent(todayStartISO());

  let url = "";

  if (hasUser) {
    url =
      `${supabaseUrl}/rest/v1/buildr_chats?select=id` +
      `&user_id=eq.${encodeURIComponent(user)}` +
      `&source_page=eq.pozi.vision` +
      `&created_at=gte.${since}`;
  } else {
    const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
    url =
      `${supabaseUrl}/rest/v1/buildr_chats?select=id` +
      `&session_id=like.${encodeURIComponent(guestBase + "__*")}` +
      `&source_page=eq.pozi.vision` +
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
    throw new Error(errorText || "Unable to count BUILDr Vision usage.");
  }

  const rows = await response.json().catch(() => []);
  const count = Array.isArray(rows) ? rows.length : 0;

  return {
    count,
    tier: normalizePlanTier(account_type, hasUser),
    current_session_id: cleanIdentity(session_id)
  };
}

async function checkVisionDailyLimit({ session_id, user_id, user_email, account_email, account_type, event }) {
  if (isUnlimitedTestUser(user_id, user_email, account_email)) {
    return unlimitedVisionUsagePayload(session_id);
  }

  const hasUser = !!(user_id && user_id !== "guest" && user_id !== "anonymous");
  const tier = normalizePlanTier(account_type, hasUser);
  const limit = BUILDR_VISION_DAILY_LIMITS[tier] ?? BUILDR_VISION_DAILY_LIMITS.guest;
  const usage = await countVisionUsesToday({ session_id, user_id, account_type, event });
  const usedToday = usage.count;
  const nextUsed = usedToday + 1;

  if (usedToday >= limit) {
    return {
      allowed: false,
      tier,
      limit,
      used: usedToday,
      remaining: 0,
      vision_based: true,
      current_session_id: session_id
    };
  }

  return {
    allowed: true,
    tier,
    limit,
    used: nextUsed,
    remaining: Math.max(limit - nextUsed, 0),
    vision_based: true,
    current_session_id: session_id
  };
}

function visionLimitMessage(tier) {
  if (tier === "guest") return "You’ve used today’s Guest – Free photo analysis. Create a free account to analyze more project photos.";
  if (tier === "free") return "You’ve used today’s Account – Free photo analyses. Upgrade to Consumer or Pro for more photo-powered BUILDr help.";
  if (tier === "consumer") return "You’ve reached today’s Consumer photo analysis limit. Upgrade to Pro for higher photo usage.";
  return "You’ve reached today’s BUILDr Vision usage limit.";
}

async function logVisionToSupabase({ prompt, reply, project_type, session_id, user_id, image_meta }) {
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
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
      "Prefer": "return=representation"
    },
    body: JSON.stringify({
      prompt: `[VISION]\n${prompt}\n\nImage: ${JSON.stringify(image_meta || {})}`,
      reply,
      mode: "vision",
      project_type,
      session_id:
        session_id && session_id !== "guest" && session_id !== "anonymous"
          ? session_id
          : null,
      user_id:
        user_id && user_id !== "guest" && user_id !== "anonymous"
          ? user_id
          : null,
      source_page: "pozi.vision",
      thumb_rating: null
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn("Supabase vision logging failed:", errorText);
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

    const prompt = String(body.prompt || body.caption || body.context || "").trim();
    const project_title = body.project_title ? String(body.project_title) : "";
    const raw_session_id = body.session_id ? String(body.session_id) : null;
    const user_id = body.user_id ? String(body.user_id) : null;
    const user_email = body.user_email ? String(body.user_email) : null;
    const account_email = body.account_email || body.email ? String(body.account_email || body.email) : null;
    const account_type = body.account_type ? String(body.account_type) : null;
    const media_type = normalizeMediaType(body.media_type || body.image_media_type || body.mime_type);
    const imageData = getImageDataFromBody(body);

    const session_id = makeStableSessionId({ raw_session_id, user_id, event });

    if (!imageData) {
      return jsonResponse(400, {
        ok: false,
        error: "Missing image data. Send image_base64 or imageData."
      });
    }

    if (imageData.length > MAX_IMAGE_BASE64_LENGTH) {
      return jsonResponse(413, {
        ok: false,
        error: "Image is too large for BUILDr Vision. Please compress or resize the photo before sending."
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return jsonResponse(500, {
        ok: false,
        error: "Missing ANTHROPIC_API_KEY environment variable."
      });
    }

    const visionPrompt = buildVisionPrompt({ prompt, project_title });
    const project_type = detectProjectType(`${project_title}\n${prompt}`);

    const usage = await checkVisionDailyLimit({
      session_id,
      user_id,
      user_email,
      account_email,
      account_type,
      event
    });

    if (!usage.allowed) {
      return jsonResponse(429, {
        ok: false,
        error: visionLimitMessage(usage.tier),
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
        model: body.model || DEFAULT_MODEL,
        max_tokens: Math.min(Number(body.max_tokens || 900), 1200),
        system: BUILDR_VISION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type,
                  data: imageData
                }
              },
              {
                type: "text",
                text: visionPrompt
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return jsonResponse(response.status, {
        ok: false,
        error: data?.error?.message || "Anthropic vision request failed.",
        anthropic_error: data?.error || data
      });
    }

    const reply =
      data?.content?.find((item) => item.type === "text")?.text ||
      data?.content?.[0]?.text ||
      "No vision response returned.";

    const savedChat = await logVisionToSupabase({
      prompt: visionPrompt,
      reply,
      project_type,
      session_id,
      user_id,
      image_meta: {
        media_type,
        image_base64_length: imageData.length,
        project_title: project_title || null
      }
    });

    return jsonResponse(200, {
      ok: true,
      reply,
      chat_id: savedChat?.id || null,
      mode: "vision",
      project_type,
      usage
    });
  } catch (error) {
    console.error("BUILDr Vision function error:", error);

    return jsonResponse(500, {
      ok: false,
      error: error.message || "Unknown BUILDr Vision server error."
    });
  }
};
