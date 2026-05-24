const LIMITS = {
  guest: { buildr: 1, photos: 1 },
  free: { buildr: 3, photos: 2 },
  consumer: { buildr: 50, photos: 20 },
  pro: { buildr: 200, photos: 80 }
};

function json(statusCode, body) {
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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function supabaseFetch(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase server env vars.");
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch(e) { data = text; }
  if (!res.ok) throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  return data;
}

async function getUserFromAuth(authHeader) {
  const token = (authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon, authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  return await res.json();
}

async function getTier(user) {
  if (!user || !user.id) return "guest";
  const rows = await supabaseFetch(`pozi_user_plans?user_id=eq.${encodeURIComponent(user.id)}&select=tier&limit=1`);
  return rows && rows[0] && rows[0].tier ? rows[0].tier : "free";
}

async function getCounter(identityType, identityId, usageDate) {
  const rows = await supabaseFetch(
    `pozi_usage_counters?identity_type=eq.${identityType}&identity_id=eq.${encodeURIComponent(identityId)}&usage_date=eq.${usageDate}&select=*`
  );
  return rows && rows[0] ? rows[0] : null;
}

async function upsertCounter(counter) {
  return await supabaseFetch("pozi_usage_counters?on_conflict=identity_type,identity_id,usage_date", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(counter)
  });
}

async function callAnthropic(prompt) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY.");
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Anthropic request failed.");
  return data.content?.[0]?.text || "";
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const body = JSON.parse(event.body || "{}");
    const prompt = body.prompt || body.message || "";
    if (!prompt) return json(400, { error: "Missing prompt." });

    const user = await getUserFromAuth(event.headers.authorization || event.headers.Authorization);
    const guestSession = event.headers["x-pozi-session-id"] || body.session_id || "guest_unknown";
    const identityType = user?.id ? "user" : "guest";
    const identityId = user?.id || guestSession;
    const tier = await getTier(user);
    const limit = (LIMITS[tier] || LIMITS.guest).buildr;
    const usageDate = todayKey();

    let counter = await getCounter(identityType, identityId, usageDate);
    if (!counter) {
      counter = { identity_type: identityType, identity_id: identityId, usage_date: usageDate, tier, buildr_count: 0, photo_count: 0, search_count: 0 };
    }

    if ((counter.buildr_count || 0) >= limit) {
      const next = tier === "guest" ? "Create an account to keep using BUILDr." :
                   tier === "free" ? "Upgrade to Consumer to unlock saved projects, full notes, materials, photos, and sourcing." :
                   tier === "consumer" ? "Upgrade to Pro for higher usage and larger project workflows." :
                   "Your Pro usage limit was reached for today.";
      return json(402, {
        error: "BUILDr daily limit reached.",
        tier,
        limit,
        used: counter.buildr_count || 0,
        upgrade_message: next
      });
    }

    const reply = await callAnthropic(prompt);

    counter.tier = tier;
    counter.buildr_count = (counter.buildr_count || 0) + 1;
    await upsertCounter(counter);

    return json(200, {
      reply,
      tier,
      remaining_buildr: Math.max(0, limit - counter.buildr_count),
      used_buildr: counter.buildr_count,
      limit_buildr: limit
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
