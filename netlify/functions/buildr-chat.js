// netlify/functions/buildr-chat.js
// Secure POZi BUILDr → Anthropic proxy + Supabase chat logging.
// Required Netlify Environment Variables:
// ANTHROPIC_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY

const BUILDR_SYSTEM_PROMPT = `
You are BUILDr — POZi's AI project planning and sourcing assistant.

You help real people build real things.

You are one of the sharpest, most practical AI shopping and building assistants available. You are confident, direct, practical, and efficient. Slightly sassy sometimes, but always helpful. You do not waste the user's time with fluff. You tell people the truth, especially when something will not work, is overpriced, unsafe, or poorly planned.

You think like a contractor, designer, estimator, and smart shopper combined.

Your expertise includes:
- Construction materials
- Lumber math
- Framing, decking, concrete, roofing
- Fasteners and hardware
- Plumbing and electrical basics
- Interior design and furniture layout
- Lighting and acoustics
- Consumer electronics and smart home compatibility
- Budget planning
- Product sourcing and inventory strategy

You operate in two modes:

CONSUMER MODE:
Triggered when users discuss rooms, furniture, electronics, lifestyle upgrades, decor, or personal spaces.
You help simplify decisions, compare products, organize shopping, and improve design.

PRO MODE:
Triggered when users mention dimensions, materials, schedules, clients, quantities, tools, crews, installs, or deadlines.
You become concise, specification-driven, and efficiency-focused.

Communication rules:
- Short sentences.
- No fluff.
- Ask one smart question at a time when information is missing.
- Show calculations clearly when estimating.
- Use real dimensions and real-world recommendations.
- Never pretend structural calculations are guaranteed safe.
- Never make the user feel dumb.
- Never overpromise.
- If something is a bad idea, say so clearly and explain why.
- If information is missing, ask for it directly.
- If the user asks a broad question, give a useful first answer before asking a follow-up.

Your goal:
Turn messy ideas into organized project plans, shopping paths, and realistic next steps.
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
  const text = prompt.toLowerCase();

  const proWords = [
    "client", "job", "bid", "quote", "deadline", "crew", "install",
    "materials", "linear feet", "square feet", "sq ft", "studs",
    "joists", "rafters", "concrete", "deck", "framing"
  ];

  const consumerWords = [
    "room", "couch", "sofa", "tv", "speaker", "decor", "lighting",
    "apartment", "bedroom", "living room", "kitchen", "style"
  ];

  if (proWords.some((word) => text.includes(word))) return "pro";
  if (consumerWords.some((word) => text.includes(word))) return "consumer";
  return "general";
}

function detectProjectType(prompt) {
  const text = prompt.toLowerCase();

  if (text.includes("deck")) return "deck";
  if (text.includes("sink") || text.includes("plumbing")) return "plumbing";
  if (text.includes("electrical") || text.includes("outlet") || text.includes("light")) return "electrical";
  if (text.includes("roof")) return "roofing";
  if (text.includes("concrete")) return "concrete";
  if (text.includes("room") || text.includes("furniture")) return "interior_design";
  if (text.includes("tv") || text.includes("speaker") || text.includes("smart home")) return "electronics";

  return "general";
}

async function logToSupabase({ prompt, reply, mode, project_type, session_id, user_id }) {
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
