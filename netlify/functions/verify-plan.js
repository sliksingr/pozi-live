// netlify/functions/verify-plan.js
// Checks a finished plan against the conversation that produced it.
//
// WHY THIS EXISTS: Foreman offered a 5 ft hand snake or a 25 ft drum auger, the user said
// the clog was 4 ft down, Foreman agreed on the hand snake — and then the plan produced a
// "25 ft hand snake" and sourced an auger. Every fact was in the transcript. Nothing was
// missing and nothing was misunderstood. The plan step simply failed to honor a choice that
// had already been settled.
//
// That distinction is the whole design. This is NOT a construction reviewer. It does not
// know what size stringer carries a load and it must never guess. It answers one question:
// does the deliverable contradict or recombine something the conversation explicitly
// settled? That is a text-matching task, which is the kind of thing a model is reliable at,
// rather than a judgment call, which is the kind of thing it is not.
//
// WHY A SEPARATE ENDPOINT: the plan streams so a long generation never hits Netlify's 10s
// ceiling. Verification cannot ride inside that stream without risking the very timeout
// streaming exists to avoid, and the user should not sit watching a finished plan with no
// explanation while a second call runs. The client streams the plan, shows it, then calls
// this and marks the result.
//
// FAILING OPEN IS DELIBERATE: if this endpoint errors, times out, or returns nonsense, the
// user still gets their plan with verified:false. A verification step that can block a
// deliverable is a worse failure than the bug it was built to catch.
//
// COST: one Sonnet call per plan, and a plan happens once per project. It does not consume
// a chat message and it logs under source_page "pozi.verify" so it stays out of the caps,
// exactly as the plan call does.

const VERIFIER_PROMPT = `You compare a construction plan against the conversation that produced it.

You are checking ONE thing: did the plan stay faithful to what the conversation actually settled?

You are NOT checking whether the construction advice is correct. You are NOT checking arithmetic.
You are NOT adding your own opinion about what the user should have chosen. If the conversation
settled on something you personally think is wrong, that is not a finding. Fidelity only.

Report a finding ONLY when one of these is true:

1. CONTRADICTION — the plan names a different product, material, method, or dimension than the
   one the conversation confirmed.
   Example: conversation confirmed a hand snake, plan sources a drum auger.

2. RECOMBINATION — the conversation offered options, one was chosen, and the plan attached a
   number or attribute belonging to the option that was NOT chosen.
   Example: options were a 5 ft hand snake or a 25 ft auger, the user chose the hand snake,
   and the plan says "25 ft hand snake".

3. INTERNAL MISMATCH — the Build Notes and the item list name different products for the same
   job, so the user would buy something other than what the notes describe.

Do NOT report:
- Detail the plan added that the conversation never covered. Filling gaps is the plan's job.
- Quantities, waste factors, or arithmetic.
- Stated assumptions where a dimension was missing.
- Wording differences that mean the same thing. "Pressure treated 2x12" and "PT 2x12 board"
  are the same product. "Hand snake" and "handheld drum snake" are the same tool.
- Anything you are unsure about. A false alarm trains the user to ignore this check, which is
  worse than missing one. When genuinely uncertain, stay silent.

Respond with JSON and nothing else. No preamble, no markdown fences.

{"ok": true, "findings": []}

or

{"ok": false, "findings": [
  {"confirmed": "what the conversation settled on, quoted or closely paraphrased",
   "produced": "what the plan actually says",
   "where": "notes" or "item list" or "both",
   "type": "contradiction" or "recombination" or "internal mismatch"}
]}

Keep each field under 20 words. Report at most 4 findings — the clearest ones.`;

const ANTHROPIC_VERIFY_MODEL = String(
  process.env.ANTHROPIC_VERIFY_MODEL || process.env.ANTHROPIC_PLAN_MODEL || "claude-sonnet-4-6"
).trim();

const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_PLAN_CHARS = 16000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
    body: JSON.stringify(body)
  };
}

// Every early return that isn't a real finding says verified:false, ok:true — the plan is
// shown normally and simply carries no check mark.
function unverified(reason) {
  return jsonResponse(200, { ok: true, verified: false, findings: [], reason });
}

function flattenTranscript(turns) {
  return turns
    .map((t) => `${t.role === "assistant" ? "Foreman" : "User"}: ${t.content}`)
    .join("\n\n")
    .slice(-MAX_TRANSCRIPT_CHARS);
}

// The model is told to return bare JSON, but a stray fence or a sentence in front of it
// should degrade to "unverified", never to a crash or a false accusation.
function parseVerdict(text) {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    const findings = Array.isArray(parsed.findings) ? parsed.findings.slice(0, 4) : [];
    return {
      ok: parsed.ok !== false || findings.length === 0,
      findings: findings
        .filter((f) => f && (f.confirmed || f.produced))
        .map((f) => ({
          confirmed: String(f.confirmed || "").slice(0, 200),
          produced: String(f.produced || "").slice(0, 200),
          where: String(f.where || "").slice(0, 40),
          type: String(f.type || "").slice(0, 40)
        }))
    };
  } catch {
    return null;
  }
}

async function logVerification({ plan, verdict, sessionId, userId }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/buildr_chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        prompt: plan.slice(0, 4000),
        reply: JSON.stringify(verdict).slice(0, 4000),
        mode: verdict.findings.length ? "verify_failed" : "verify_passed",
        project_type: "verification",
        session_id: sessionId || null,
        user_id: userId || null,
        // Keeps verification out of every session and message counter, the same way
        // pozi.plan and pozi.vision do.
        source_page: "pozi.verify",
        thumb_rating: null
      })
    });
  } catch (e) {
    console.warn("verification logging failed:", e?.message || e);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });
  }
  if (!process.env.ANTHROPIC_API_KEY) return unverified("not configured");

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return unverified("bad request body");
  }

  const plan = String(body.plan || "").trim().slice(0, MAX_PLAN_CHARS);
  const rawTurns = Array.isArray(body.messages) ? body.messages : [];
  const turns = rawTurns
    .map((m) => ({
      role: String(m && m.role) === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").trim()
    }))
    .filter((m) => m.content)
    .slice(-24);

  // Nothing to compare against is not a failure — it just means no check ran.
  if (!plan || turns.length < 2) return unverified("not enough context to check");

  const sessionId = String(body.session_id || "").slice(0, 160);
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  let userId = null;
  if (accessToken && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` }
      });
      if (r.ok) {
        const u = await r.json().catch(() => null);
        userId = u?.id ? String(u.id) : null;
      }
    } catch { /* identity is only used for logging here */ }
  }

  // A verification that outlives the platform's patience is worth nothing, so it is capped
  // well short of it and simply reports "unverified" if it runs long.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);

  try {
    const userContent =
      `CONVERSATION:\n${flattenTranscript(turns)}\n\n` +
      `PLAN PRODUCED FROM IT:\n${plan}\n\n` +
      `Check the plan against the conversation. Respond with JSON only.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ANTHROPIC_VERIFY_MODEL,
        max_tokens: 700,
        system: VERIFIER_PROMPT,
        messages: [{ role: "user", content: userContent }]
      })
    });

    if (!res.ok) {
      console.warn("verifier upstream failed:", res.status);
      return unverified("check unavailable");
    }

    const data = await res.json().catch(() => null);
    const text = Array.isArray(data?.content)
      ? data.content.filter((b) => b?.type === "text").map((b) => b.text).join("")
      : "";

    const verdict = parseVerdict(text);
    if (!verdict) return unverified("check returned an unreadable result");

    await logVerification({ plan, verdict, sessionId, userId });

    if (verdict.findings.length) {
      console.log("Plan verification findings:", JSON.stringify(verdict.findings));
    }

    return jsonResponse(200, {
      ok: verdict.findings.length === 0,
      verified: true,
      findings: verdict.findings
    });
  } catch (e) {
    if (e?.name === "AbortError") return unverified("check timed out");
    console.error("verify-plan error:", e);
    return unverified("check failed");
  } finally {
    clearTimeout(timer);
  }
};
