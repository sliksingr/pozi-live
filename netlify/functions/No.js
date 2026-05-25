// buildr-chat.js
// BUILDr + backend enforcement merged into working function
const POZI_LIMITS = {
  guest: { buildr: 1 },
  free: { buildr: 3 },
  consumer: { buildr: 50 },
  pro: { buildr: 200 }
};
function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, x-pozi-session-id",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
async function supabaseFetch(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing Supabase env vars.");
  }
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Prefer": "return=representation",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!response.ok) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  }
  return data;
}
async function getUser(authHeader) {
  const token = String(authHeader || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return null;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: anon,
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) return null;
  return await response.json();
}
async function getPlanTier(user) {
  if (!user?.id) return "guest";
  const rows = await supabaseFetch(
    `pozi_user_plans?user_id=eq.${user.id}&select=tier&limit=1`
  );
  return rows?.[0]?.tier || "free";
}
async function getCounter(identityType, identityId, usageDate) {
  const rows = await supabaseFetch(
    `pozi_usage_counters?identity_type=eq.${identityType}&identity_id=eq.${identityId}&usage_date=eq.${usageDate}&select=*`
  );
  return rows?.[0] || null;
}
async function saveCounter(counter) {
  const rows = await supabaseFetch(
    "pozi_usage_counters?on_conflict=identity_type,identity_id,usage_date",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(counter)
    }
  );
  return rows?.[0] || counter;
}
async function enforceUsage(event, body) {
  const authHeader =
    event.headers.authorization || event.headers.Authorization;
  const user = await getUser(authHeader);
  const guestSession =
    event.headers["x-pozi-session-id"] ||
    body.session_id ||
    "guest";
  const identityType = user?.id ? "user" : "guest";
  const identityId = user?.id || guestSession;
  const tier = await getPlanTier(user);
  const limit =
    POZI_LIMITS[tier]?.buildr || POZI_LIMITS.guest.buildr;
  const usageDate = todayKey();
  let counter = await getCounter(
    identityType,
    identityId,
    usageDate
  );
  if (!counter) {
    counter = {
      identity_type: identityType,
      identity_id: identityId,
      usage_date: usageDate,
      tier,
      buildr_count: 0
    };
  }
  const used = counter.buildr_count || 0;
  if (used >= limit) {
    return {
      allowed: false,
      response: jsonResponse(402, {
        ok: false,
        error: "Daily BUILDr limit reached.",
        tier,
        limit,
        used,
        upgrade_message:
          tier === "guest"
            ? "Guest session used. Create a free account to continue."
            : tier === "free"
            ? "Free BUILDr limit reached. Upgrade to Consumer."
            : tier === "consumer"
            ? "Consumer limit reached. Upgrade to Pro."
            : "Daily Pro limit reached."
      })
    };
  }
  return {
    allowed: true,
    tier,
    limit,
    counter,
    identityType,
    identityId,
    usageDate
  };
}
async function incrementUsage(usage) {
  const updated = {
    ...usage.counter,
    tier: usage.tier,
    buildr_count: (usage.counter.buildr_count || 0) + 1
  };
  return await saveCounter(updated);
}
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }
  try {
    const body = JSON.parse(event.body || "{}");
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return jsonResponse(400, {
        ok: false,
        error: "Missing prompt."
      });
    }
    const usage = await enforceUsage(event, body);
    if (!usage.allowed) {
      return usage.response;
    }
    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 900,
          system:
            "You are BUILDr — POZi's AI project planning assistant.",
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        })
      }
    );
    const data = await response.json();
    if (!response.ok) {
      return jsonResponse(500, {
        ok: false,
        error: "Anthropic request failed.",
        details: data
      });
    }
    const reply =
      data?.content?.find((x) => x.type === "text")?.text ||
      "No response.";
    const updatedCounter = await incrementUsage(usage);
    return jsonResponse(200, {
      ok: true,
      reply,
      tier: usage.tier,
      used_buildr: updatedCounter.buildr_count,
      limit_buildr: usage.limit,
      remaining_buildr:
        usage.limit - updatedCounter.buildr_count
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error.message || "Server error."
    });
  }
};
