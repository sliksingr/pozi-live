// netlify/functions/buildr-chat.js
// Secure POZi BUILDr → Anthropic proxy.
// Keep ANTHROPIC_API_KEY in Netlify Environment Variables.
// Never put API keys in index.html or public JavaScript.

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
    const { prompt } = JSON.parse(event.body || "{}");

    if (!prompt || !String(prompt).trim()) {
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
            content: String(prompt).trim()
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

    return jsonResponse(200, {
      ok: true,
      reply
    });

  } catch (error) {
    console.error("BUILDr function error:", error);

    return jsonResponse(500, {
      ok: false,
      error: error.message || "Unknown server error."
    });
  }
};
