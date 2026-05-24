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
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function supabaseFetch(path) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase server env vars.");
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
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

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  try {
    const user = await getUserFromAuth(event.headers.authorization || event.headers.Authorization);
    const guestSession = event.headers["x-pozi-session-id"] || "guest_unknown";
    const identityType = user?.id ? "user" : "guest";
    const identityId = user?.id || guestSession;
    const tier = await getTier(user);
    const limit = LIMITS[tier] || LIMITS.guest;
    const usageDate = todayKey();

    const rows = await supabaseFetch(
      `pozi_usage_counters?identity_type=eq.${identityType}&identity_id=eq.${encodeURIComponent(identityId)}&usage_date=eq.${usageDate}&select=*`
    );
    const counter = rows && rows[0] ? rows[0] : { buildr_count: 0, photo_count: 0, search_count: 0 };

    return json(200, {
      tier,
      identity_type: identityType,
      buildr_limit: limit.buildr,
      photo_limit: limit.photos,
      used_buildr: counter.buildr_count || 0,
      used_photos: counter.photo_count || 0,
      remaining_buildr: Math.max(0, limit.buildr - (counter.buildr_count || 0)),
      remaining_photos: Math.max(0, limit.photos - (counter.photo_count || 0))
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
