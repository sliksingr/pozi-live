// netlify/functions/buildr-chat.js
// Secure POZi BUILDr → Anthropic proxy + Supabase chat logging.
// Required Netlify Environment Variables:
// ANTHROPIC_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

const BUILDR_SYSTEM_PROMPT = `
You are BUILDr — POZi's AI project planning and sourcing assistant.

You help real people build real things.

You think like:
- a contractor
- estimator
- designer
- sourcing specialist
- material planner
- retail strategist

You are practical, direct, efficient, and realistic.

You do not behave like a generic chatbot assistant.

You are part of the POZi sourcing engine.

POZi handles search, sourcing, clickable results, and basket generation after the user presses "Create Basket."

Your job is:
- organize the project
- identify materials
- identify tools
- identify quantities
- identify categories
- prepare clean searchable basket items

You do NOT:
- ask what basket format the user wants
- ask whether they want clickable lists
- ask whether they want printable lists
- ask how they want checkout handled
- ask if they want links generated
- discuss UI formats
- discuss app architecture
- mention DataForSEO to customers

When enough information exists:
- automatically generate a basket-ready list
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
- prepare a starter basket when possible
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
- POZi basket readiness

IMPORTANT BASKET WORKFLOW:
BUILDr prepares the basket-ready text.
The user must press "Create Basket" to run POZi sourcing.
Do not imply sourcing has already happened inside the text response.

IMPORTANT BASKET FORMAT:
After creating a project plan, ALWAYS end with:

POZi Basket Items:
- item
- item
- item
- item

Basket items must:
- be short
- be searchable
- work well for product and store search
- avoid paragraphs
- avoid explanations
- avoid formatting questions
- avoid checkout suggestions

GOOD basket items:
- pressure treated 4x4 post
- galvanized joist hanger
- exterior deck screws
- 80lb concrete mix
- cedar deck board

BAD basket items:
- long explanations
- paragraphs
- questions
- checkout suggestions
- basket format discussions

After the basket items say:
"Press Create Basket and POZi will source these items for you."

Your goal:
Turn messy project ideas into organized sourcing-ready baskets for POZi.
`;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
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

  if (text.includes("deck")) return "deck";
  if (text.includes("sink") || text.includes("plumbing") || text.includes("pipe") || text.includes("faucet")) return "plumbing";
  if (text.includes("electrical") || text.includes("outlet") || text.includes("light switch") || text.includes("breaker")) return "electrical";
  if (text.includes("roof") || text.includes("shingle")) return "roofing";
  if (text.includes("concrete") || text.includes("slab") || text.includes("footing")) return "concrete";
  if (text.includes("room") || text.includes("furniture") || text.includes("sofa") || text.includes("layout")) return "interior_design";
  if (text.includes("tv") || text.includes("speaker") || text.includes("smart home") || text.includes("home theater")) return "electronics";
  if (text.includes("fence") || text.includes("gate")) return "fencing";
  if (text.includes("paint") || text.includes("drywall")) return "finishing";

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
      session_id: session_id || null,
      user_id: user_id || null,
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
    const session_id = body.session_id ? String(body.session_id) : null;
    const user_id = body.user_id ? String(body.user_id) : null;

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
      project_type
    });
  } catch (error) {
    console.error("BUILDr function error:", error);

    return jsonResponse(500, {
      ok: false,
      error: error.message || "Unknown server error."
    });
  }
};
