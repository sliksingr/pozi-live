// netlify/functions/buildr-chat-stream.mjs
// Streaming POZi Foreman endpoint.
//
// This is now the ONLY Foreman endpoint. buildr-chat.js has been retired: it never carried
// FOREMAN_PLAN_PROMPT, so a fallback during a plan call answered with the conversation
// prompt — which is explicitly told not to write Build Notes or an item list. The user got
// chat where they expected a cut list, silently. A visible error and a retry is better than
// a confidently wrong deliverable, and one prompt cannot drift from itself.
//
// IMPORTANT: every tier and limit check happens BEFORE the stream opens. Once bytes are
// flowing you can no longer return a clean 429, so all gating must complete up front.
// The limit constants below must stay identical to usage-status.js.

const FOREMAN_SYSTEM_PROMPT = `You are POZi Foreman — POZi's AI project planning and sourcing assistant.

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
- identify categories
- prepare clean searchable item-list entries
- explain common construction logic before the user buys materials

You may provide practical guidance about:
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

You should answer normal construction questions such as:
- common spacing for screws, clips, joists, studs, hangers, posts, or fasteners
- whether gravel, sand, compacted base, drainage fabric, or bedding material is commonly used
- common trench, post, conduit, pipe, or footing depths
- installation order
- materials and tools usually needed
- mistakes to avoid before purchasing supplies

You should:
- give concise practical guidance
- explain common building practices
- avoid overexplaining
- tie advice directly to the active project
- distinguish common practice from local code
- ask one smart follow-up question only when the answer materially affects safety, sizing, quantities, or sourcing
- use plain language a homeowner, builder, or contractor can act on

You are not:
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

Communication rules:
- short sentences
- practical wording
- no fluff
- no giant tutorials
- one smart question at a time only when critical information is missing

CONVERSATION ONLY

You do not write Build Notes and you do not write an item list. A separate step produces
those from this conversation when the user asks for them.

Talk like a foreman walking someone through a job. Explain what the work actually involves,
what to watch for, and why a detail matters — the practical guidance in the sections above
belongs here, in conversation. Answer real construction questions when asked.

What stays out of chat: final quantities, cut lengths, material counts, and the arithmetic
behind them. When those come up, say you'll work them out in the plan and keep moving.

Preferences are fair game and worth asking about, because they change what the plan buys:
- stock lengths the user wants to work with, 8 ft versus 16 ft
- whether they would rather have fewer seams or less waste
- a material or finish they already own or prefer
- access limits, truck size, or how they are hauling it
Ask these as plain preference questions. Do not compute totals around the answer — note it
and move on.

Gather what the plan step will need: dimensions, heights, spans, materials, conditions,
finishes. One smart question at a time, and only when the answer changes the materials.

For anything structural, get the real measurement rather than working from a guess. Stair
height, span, and post height all change the material size. Ask for the number.

When you offer the user a choice between two tools, materials, or methods, keep each option's
specs attached to that option. Say what distinguishes them and what condition picks one over
the other. Once the user tells you which situation they are in, confirm the single option that
fits and stop describing the other — the plan step reads this conversation, and options left
half-open are where a deliverable goes wrong.

When you have enough to plan the project, say exactly:

Ready when you are — tap Build the Plan.

Do not add anything after that line. Do not preview the materials. Do not list quantities.

LEARNING LOOP
Treat unusual, repeated, or high-value construction questions as future knowledge candidates.
Answer carefully with current best practical guidance.
Do not claim the system permanently learned anything.
Keep the response safe, code-aware, and useful for later review.
Do not mention internal logging or review unless the user asks.

FORMATTING

Output is plain text. Markdown is not rendered.
Never use asterisks for bold or italics. Never use # headings.

Your goal:
Understand the project well enough that the plan step can produce accurate quantities.`;

const FOREMAN_PLAN_PROMPT = `You are POZi Foreman. You are given a full planning conversation.
Produce the deliverable for that project. Nothing else — no greeting, no commentary, no questions.

Output exactly two sections, in this order, with these exact labels:

Build Notes:

POZi Item List:

MATERIAL SIZING — NON-NEGOTIABLE
These are structural minimums. Never specify a smaller member than listed.
- Stair stringers: cut from 2x12 stock. Never 2x4, 2x6, or 2x8. A notched stringer loses
  most of its depth, so 2x12 is the minimum that leaves sound material behind the cut.
- Deck joists: 2x6 minimum, sized up by span. 2x8 past 8 ft, 2x10 past 10 ft.
- Beams and headers: 2x8 minimum, doubled or tripled by span.
- Posts carrying load: 4x4 minimum, 6x6 past 6 ft of height.
- Ground contact or within 6 in of soil: pressure treated, always.
If a span was never stated, assume the common residential case, size for it, and label the
assumption. Never size a structural member down to save material.

STAIRS — FOLLOW THIS ORDER EXACTLY
Stair math is the single most common place these plans go wrong. Work it in this order and
show each line of arithmetic:
1. Total rise in inches — the finished height being climbed.
2. Riser count = total rise divided by 7, rounded to the nearest whole number.
3. Actual riser height = total rise divided by riser count. This must be 7.75 in or less.
   If it is over, add one riser and divide again.
4. EVERY RISER IS THE SAME HEIGHT. A short or tall first or last step is a trip hazard and a
   code violation. If your arithmetic leaves a remainder, you divided wrong — redo step 3.
   Never write "remaining X inches lands on the deck."
5. Tread count = riser count minus 1 when the top riser lands on the existing surface.
6. Run per tread: 10 in minimum, 10.5 in typical.
7. Total run = tread count multiplied by run per tread.
8. Stringer length = square root of (total rise squared plus total run squared), then round
   up to the next stock length.

Worked example of the arithmetic style required:
- Total rise 48 in
- 48 / 7 = 6.86, round to 7 risers
- 48 / 7 = 6.857 in per riser, all equal, under 7.75 max
- 7 risers landing on deck = 6 treads
- 6 treads x 10.5 in = 63 in total run
- Stringer = sqrt(48² + 63²) = 79.2 in, use 8 ft 2x12 stock

ONE OPTION, CARRIED WHOLE
The conversation often narrows two or more options down to one — a tool size, a material, a
method. When it does, carry the chosen option forward COMPLETE and leave the rejected option
out entirely.

Never attach a number from the option that was not chosen. If the conversation compared a
5 ft hand snake for a shallow clog against a 25 ft drum auger for a deep one, and the user
said the clog is 4 ft down, the deliverable is the hand snake at its own length. It is not a
"25 ft hand snake". A spec belongs to the option it came from and does not travel.

Before writing an item, ask: does every number on this line come from the option I actually
chose? If a figure came from the alternative, delete it.

If the conversation genuinely did not settle on one option, pick the one that fits the stated
conditions, name it plainly in one short line under "How the quantities were figured", and use
only that one. Do not hedge across both.

QUANTITY METHOD — ALWAYS TWO STEPS
Never jump straight to a piece count. Work out how much material, then what to buy:
1. Total needed — linear feet, square feet, or a count.
2. Convert to purchasable stock — pieces = total divided by stock length, rounded up,
   then add waste.
Example: 84 linear ft of 2x6 / 8 ft stock = 10.5, round up to 11, +1 waste = 12 boards

If the conversation stated a preferred stock length, use it. Otherwise use the length that
wastes least and say why in one short line.

BUILD NOTES
Group under short plain labels with a blank line between groups. Use only what applies:

Dimensions
Cut list
How the quantities were figured
Fasteners and spacing
Installation order
Before you build

Under each label use short "- " bullets, one line each, no paragraphs.

Show the arithmetic for every quantity, one short line each:
- 50 linear ft / 8 ft boards = 6.25, round up to 7, +1 waste = 8 boards
- 30 ft / 16 in on center = 23 joists, +1 end = 24

Give real numbers, never placeholders: spacing in inches, lengths in feet, footing depth,
rise and run. State a waste allowance. Every quantity in the item list must have its math here.

If a dimension was never given, state a common default and label it an assumption. Do not stall.

Measurements are common practice, not code approval. Include a short "Before you build" group
reminding the user to verify local code, especially for structural, stair, and railing work.

CHECK YOUR NUMBERS BEFORE YOU OUTPUT
Re-read what you just wrote and confirm all of the following. Fix quietly, do not narrate:
- Every riser in a stair run is the same height, with no leftover inches anywhere.
- No structural member is smaller than the minimums above. Stringers are 2x12.
- Every division was actually carried out, not estimated.
- Every quantity in the item list has matching arithmetic in the notes.
- Cut lengths add up to the stock lengths purchased.
- Every spec belongs to the option actually chosen, with nothing borrowed from a rejected one.
- The Build Notes and the item list name the SAME product. If the notes say hand snake, the
  item list says hand snake — not auger.

POZI ITEM LIST
Short searchable supply items, one per line, starting with "- ".
Materials first, tools only when truly needed.

Each entry is sent to a live retailer product search exactly as written, so no quantities,
no parentheses, no explanations, no sizes-in-words. Keep entries the way a store lists them.

NAME THE THING THE USER SHOULD COME HOME WITH
An entry is wrong if a store search for it returns a different product than the one planned.
Two different tools are two different entries — never one blended entry that borrows a word
from one and a number from the other.

- Name the tool or material by the term a store actually uses.
- Include a size ONLY when it belongs to that exact item and a buyer must match it. When in
  doubt, leave the size off — a correct general entry beats a specific wrong one.
- Never carry a spec across from a product you did not choose.

Good entries:
- pressure treated 2x12 board
- galvanized joist hanger
- exterior deck screws
- 80lb concrete mix
- cedar deck board
- handheld drum drain snake
- 25 ft drain auger

Bad entries and why:
- 25 ft hand snake            (blends a hand snake with another tool's length)
- drain tool                  (too vague; returns nothing useful)
- snake or auger              (two products in one entry; search returns neither)
- 3 boxes of deck screws      (quantity belongs in the notes, not the entry)

FORMATTING
Plain text only. Markdown is not rendered. Never use asterisks or # headings.

End with exactly:
"Your item list is ready. Press Source My Items when you're finished reviewing the list."`;

const FOREMAN_DAILY_LIMITS = Object.freeze({ guest: 1, free: 3, consumer: 5, pro: 7 });
const FOREMAN_MESSAGES_PER_SESSION = Object.freeze({ guest: 5, free: 5, consumer: 10, pro: 15 });
const FOREMAN_TEST_UNLIMITED_EMAILS = new Set(["info@pozi.live"]);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Chat is conversation, where Haiku is fast, cheap, and perfectly good.
// The plan is stair geometry, board yield, and waste factors — multi-step arithmetic where
// Haiku is the weakest link and where being wrong sends someone to the lumber yard for the
// wrong material. The plan runs ONCE per project against many chat turns, so upgrading only
// this call costs very little and protects the one output people actually build from.
const ANTHROPIC_MODEL = String(process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001").trim();
const ANTHROPIC_PLAN_MODEL = String(process.env.ANTHROPIC_PLAN_MODEL || "claude-sonnet-4-6").trim();
const ANTHROPIC_MAX_TOKENS = positiveInteger(process.env.ANTHROPIC_MAX_TOKENS, 900);
// The plan is one long deliverable, so it gets its own ceiling. Streaming means the long
// generation never hits a platform timeout the way a single buffered response would.
const ANTHROPIC_PLAN_MAX_TOKENS = positiveInteger(process.env.ANTHROPIC_PLAN_MAX_TOKENS, 2600);
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
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function cleanIdentity(v) {
  return String(v || "").trim().slice(0, 160).replace(/[^a-zA-Z0-9._:@-]/g, "_");
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function isUnlimitedTestUser(email) {
  return FOREMAN_TEST_UNLIMITED_EMAILS.has(normalizeEmail(email));
}

function getClientIp(req) {
  const h = req.headers;
  const raw = h.get("x-nf-client-connection-ip") || h.get("client-ip") || h.get("x-forwarded-for") || "";
  return String(raw).split(",")[0].trim();
}

function getBearerToken(req) {
  const m = String(req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function makeStableSessionId({ rawSessionId, userId, req }) {
  const user = cleanIdentity(userId);
  const rawSession = cleanIdentity(rawSessionId);
  const ip = cleanIdentity(getClientIp(req));
  if (user) return `user_${user}__${rawSession || "default_session"}`;
  const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
  return `${guestBase}__${rawSession || "default_session"}`;
}

async function getVerifiedIdentity(token) {
  if (!token) return null;
  const supabaseUrl = process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !apiKey) throw new Error("Missing SUPABASE_URL or a Supabase API key.");
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: apiKey, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const user = await r.json().catch(() => null);
    if (!user?.id) return null;
    return { user_id: String(user.id), user_email: normalizeEmail(user.email) };
  } catch (e) {
    console.warn("token verification failed:", e?.message || e);
    return null;
  }
}

async function getVerifiedTier(userId) {
  if (!userId) return "guest";
  const table = String(process.env.BUILDR_PROFILE_TABLE || "").trim();
  const planColumn = String(process.env.BUILDR_PLAN_COLUMN || "").trim();
  const idColumn = String(process.env.BUILDR_PROFILE_ID_COLUMN || "id").trim();
  if (!table || !planColumn) return "free";

  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) return "free";
  try {
    const url = `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}` +
      `?${encodeURIComponent(idColumn)}=eq.${encodeURIComponent(userId)}` +
      `&select=${encodeURIComponent(planColumn)}`;
    const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) return "free";
    const rows = await r.json().catch(() => []);
    const plan = Array.isArray(rows) && rows[0] ? rows[0][planColumn] : null;
    return normalizePlanTier(plan, true);
  } catch {
    return "free";
  }
}

async function getForemanSessionsToday({ sessionId, userId, req }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const currentSession = cleanIdentity(sessionId);
  const user = cleanIdentity(userId);
  const ip = cleanIdentity(getClientIp(req));
  const since = encodeURIComponent(todayStartISO());
  let url;
  if (user) {
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=session_id` +
      `&user_id=eq.${encodeURIComponent(user)}&source_page=eq.pozi.live&created_at=gte.${since}`;
  } else {
    const guestBase = ip ? `guest_ip_${ip}` : "guest_unknown_ip";
    url = `${supabaseUrl}/rest/v1/buildr_chats?select=session_id` +
      `&session_id=like.${encodeURIComponent(`${guestBase}__*`)}&source_page=eq.pozi.live&created_at=gte.${since}`;
  }
  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("Unable to count Foreman sessions.");
  const rows = await r.json().catch(() => []);
  const set = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = cleanIdentity(row?.session_id);
    if (id) set.add(id);
  }
  return {
    session_count: set.size,
    current_session_seen: currentSession ? set.has(currentSession) : false,
    current_session_id: currentSession
  };
}

async function checkForemanDailyLimit({ sessionId, userId, userEmail, accountType, req }) {
  if (isUnlimitedTestUser(userEmail)) {
    return { allowed: true, tier: "test_unlimited", limit: 999999, used: 0, remaining: 999999,
             session_based: true, current_session_seen: true, current_session_id: sessionId,
             unlimited_test_access: true };
  }
  const tier = normalizePlanTier(accountType, Boolean(userId));
  const limit = FOREMAN_DAILY_LIMITS[tier] ?? FOREMAN_DAILY_LIMITS.guest;
  const u = await getForemanSessionsToday({ sessionId, userId, req });
  const existing = Boolean(u.current_session_seen);
  const used = u.session_count;
  const wouldUse = existing ? used : used + 1;

  if (!existing && used >= limit) {
    return { allowed: false, tier, limit, used, remaining: 0, session_based: true,
             current_session_seen: false, current_session_id: u.current_session_id };
  }
  return { allowed: true, tier, limit, used: wouldUse, remaining: Math.max(limit - wouldUse, 0),
           session_based: true, current_session_seen: existing, current_session_id: u.current_session_id };
}

async function checkForemanMessageLimit({ sessionId, tier, userEmail }) {
  if (tier === "test_unlimited" || isUnlimitedTestUser(userEmail)) {
    return { allowed: true, limit: 999999, used: 0, remaining: 999999, message_based: true };
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const limit = FOREMAN_MESSAGES_PER_SESSION[tier] ?? FOREMAN_MESSAGES_PER_SESSION.guest;
  // source_page keeps Vision from burning chat messages; created_at resets the cap daily
  // so a contractor can return to a job tomorrow with its history intact.
  const url = `${supabaseUrl}/rest/v1/buildr_chats?select=id` +
    `&session_id=eq.${encodeURIComponent(sessionId)}` +
    `&source_page=eq.pozi.live` +
    `&created_at=gte.${encodeURIComponent(todayStartISO())}`;

  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("Unable to count Foreman session messages.");
  const rows = await r.json().catch(() => []);
  const used = Array.isArray(rows) ? rows.length : 0;
  return { allowed: used < limit, limit, used: used + 1,
           remaining: Math.max(limit - (used + 1), 0), message_based: true };
}

function foremanLimitMessage(tier) {
  if (tier === "guest") return "You've used your free guest Foreman session for today. Create a free account to keep planning.";
  if (tier === "free") return "You've used your free Foreman sessions for today. Upgrade to DIY or Contractor to keep building.";
  if (tier === "consumer") return "You've reached today's DIY Foreman session limit. Upgrade to Contractor for higher project usage.";
  return "You've reached today's Foreman usage limit.";
}

function foremanMessageLimitMessage(tier) {
  if (tier === "guest") return "You've reached the 5-message limit for this guest Foreman session. Create a free account to keep planning.";
  if (tier === "free") return "You've reached the 5-message limit for this free Foreman session. Start a new Foreman session if you have sessions remaining today.";
  if (tier === "consumer") return "You've reached the 10-message limit for this DIY Foreman session. Start a new Foreman session if you have sessions remaining today.";
  if (tier === "pro") return "You've reached the 15-message limit for this Contractor Foreman session. Start a new Foreman session if you have sessions remaining today.";
  return "You've reached the message limit for this Foreman session.";
}

function detectMode(prompt) {
  const t = String(prompt || "").toLowerCase();
  const pro = ["client","job","bid","quote","deadline","crew","install","materials","linear feet","square feet","sq ft","studs","joists","rafters","concrete","deck","framing","permit","takeoff","estimate"];
  const con = ["room","couch","sofa","tv","speaker","decor","lighting","apartment","bedroom","living room","kitchen","style","furniture","home theater"];
  if (pro.some(w => t.includes(w))) return "pro";
  if (con.some(w => t.includes(w))) return "consumer";
  return "general";
}

function detectProjectType(prompt) {
  const t = String(prompt || "").toLowerCase();
  if (["deck","stairs","stair","stringer","joist"].some(x => t.includes(x))) return "deck";
  if (["sink","plumbing","pipe","faucet","drain","water line"].some(x => t.includes(x))) return "plumbing";
  if (["electrical","outlet","light switch","breaker","conduit","wire","trench"].some(x => t.includes(x))) return "electrical";
  if (["roof","shingle"].some(x => t.includes(x))) return "roofing";
  if (["concrete","slab","footing"].some(x => t.includes(x))) return "concrete";
  if (["room","furniture","sofa","layout"].some(x => t.includes(x))) return "interior_design";
  if (["tv","speaker","smart home","home theater"].some(x => t.includes(x))) return "electronics";
  if (["fence","gate","post","wire clip","fence clip"].some(x => t.includes(x))) return "fencing";
  if (["paint","drywall","floor","flooring","screw spacing"].some(x => t.includes(x))) return "finishing";
  if (["irrigation","sprinkler","drip line"].some(x => t.includes(x))) return "irrigation";
  if (["drainage","french drain","gravel trench"].some(x => t.includes(x))) return "drainage";
  return "general";
}

async function logToSupabase({ prompt, reply, mode, projectType, sessionId, userId, sourcePage }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) return null;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/buildr_chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        prompt, reply, mode, project_type: projectType,
        session_id: sessionId || null, user_id: userId || null,
        source_page: sourcePage || "pozi.live", thumb_rating: null
      })
    });
    if (!r.ok) { console.warn("Supabase logging failed:", await r.text()); return null; }
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (e) {
    console.warn("Supabase logging error:", e?.message || e);
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-pozi-session-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS }
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: CORS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });

  try {
    let body;
    try { body = await req.json(); }
    catch { return jsonResponse(400, { ok: false, error: "Invalid JSON request body." }); }

    const prompt = String(body.prompt || "").trim();
    const rawSessionId = body.session_id ? String(body.session_id) : "";

    // Preferred shape: real turns. The older flat `prompt` is still accepted so an
    // app build that has not updated yet keeps working.
    const rawTurns = Array.isArray(body.messages) ? body.messages : null;
    const turns = rawTurns
      ? rawTurns
          .map((m) => ({
            role: String(m && m.role) === "assistant" ? "assistant" : "user",
            content: String((m && m.content) || "").trim()
          }))
          .filter((m) => m.content)
          .slice(-24)
      : null;

    // Anthropic requires the conversation to start with a user turn.
    while (turns && turns.length && turns[0].role !== "user") turns.shift();
    // "plan" produces the Build Notes + item list deliverable from the whole conversation.
    const isPlan = String(body.mode || "") === "plan";

    if (!prompt && !(turns && turns.length)) {
      return jsonResponse(400, { ok: false, error: "Missing prompt." });
    }
    const totalChars = (turns && turns.length)
      ? turns.reduce((n, m) => n + m.content.length, 0)
      : prompt.length;
    if (totalChars > MAX_PROMPT_CHARS) {
      return jsonResponse(413, { ok: false, error: `Prompt is too long. Maximum length is ${MAX_PROMPT_CHARS} characters.` });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return jsonResponse(500, { ok: false, error: "Missing ANTHROPIC_API_KEY environment variable." });
    }

    // ── ALL GATING HAPPENS HERE, BEFORE ANY BYTES ARE SENT ────────────────────
    const bearerToken = getBearerToken(req);
    const verified = bearerToken ? await getVerifiedIdentity(bearerToken) : null;
    if (bearerToken && !verified) {
      return jsonResponse(401, { ok: false, error: "Your session has expired or is invalid. Please sign in again." });
    }

    const userId = verified?.user_id || null;
    const userEmail = verified?.user_email || "";
    const accountType = userId ? await getVerifiedTier(userId) : "guest";
    const sessionId = makeStableSessionId({ rawSessionId, userId, req });
    // Classify and log against the newest user turn, not the whole transcript.
    const latestUserText = (turns && turns.length)
      ? (turns.filter((m) => m.role === "user").slice(-1)[0] || {}).content || ""
      : prompt;
    const mode = detectMode(latestUserText);
    const projectType = detectProjectType(latestUserText);

    const usage = await checkForemanDailyLimit({ sessionId, userId, userEmail, accountType, req });
    if (!usage.allowed) {
      return jsonResponse(429, { ok: false, error: foremanLimitMessage(usage.tier), usage });
    }

    // The plan is the payoff for the conversation the user already paid messages for, so it
    // does not consume one. It is still gated by the daily session check above, and it logs
    // under source_page "pozi.plan" so it never counts against the chat cap.
    const messageUsage = isPlan
      ? { allowed: true, limit: 0, used: 0, remaining: 0, message_based: false, plan_call: true }
      : await checkForemanMessageLimit({ sessionId, tier: usage.tier, userEmail });
    if (!messageUsage.allowed) {
      return jsonResponse(429, {
        ok: false,
        error: foremanMessageLimitMessage(usage.tier),
        usage: { ...usage, messages: messageUsage }
      });
    }
    // ── gating complete; from here on we stream ───────────────────────────────

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        // Plan calls get the stronger model — see the note on ANTHROPIC_PLAN_MODEL.
        model: isPlan ? ANTHROPIC_PLAN_MODEL : ANTHROPIC_MODEL,
        max_tokens: isPlan ? ANTHROPIC_PLAN_MAX_TOKENS : ANTHROPIC_MAX_TOKENS,
        system: isPlan ? FOREMAN_PLAN_PROMPT : FOREMAN_SYSTEM_PROMPT,
        stream: true,
        messages: (turns && turns.length) ? turns : [{ role: "user", content: prompt }]
      })
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      let msg = "Foreman could not start. Please try again.";
      try { msg = JSON.parse(detail)?.error?.message || msg; } catch {}
      return jsonResponse(upstream.status || 502, { ok: false, error: msg });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let full = "";

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const reader = upstream.body.getReader();
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            // Anthropic sends SSE; split on blank lines and read the data: payloads.
            const parts = buf.split("\n\n");
            buf = parts.pop() || "";
            for (const part of parts) {
              for (const line of part.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const raw = line.slice(5).trim();
                if (!raw || raw === "[DONE]") continue;
                let evt;
                try { evt = JSON.parse(raw); } catch { continue; }
                if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                  const t = evt.delta.text || "";
                  if (t) { full += t; send({ type: "text", v: t }); }
                } else if (evt.type === "error") {
                  send({ type: "error", error: evt.error?.message || "Foreman hit an error." });
                }
              }
            }
          }

          // Log the completed reply, then hand the client its usage numbers.
          const saved = await logToSupabase({
            prompt: latestUserText, reply: full, mode, projectType, sessionId, userId,
            sourcePage: isPlan ? "pozi.plan" : "pozi.live"
          });

          send({
            type: "done",
            chat_id: saved?.id || null,
            mode,
            project_type: projectType,
            authenticated: Boolean(userId),
            usage: { ...usage, messages: messageUsage }
          });
        } catch (e) {
          console.error("Foreman stream error:", e);
          send({ type: "error", error: "Foreman was interrupted. Please try again." });
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        ...CORS
      }
    });
  } catch (error) {
    console.error("Foreman stream function error:", error);
    return jsonResponse(500, { ok: false, error: error?.message || "Unknown server error." });
  }
};
