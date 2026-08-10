// netlify/functions/share-project.js
// Serves a shared project to a client who has no POZi account.
//
// WHY THIS EXISTS: project photos live in a PRIVATE Supabase Storage bucket, reachable only
// through short-lived signed URLs minted with the service role key. A public share page
// cannot hold that key, so the page sends only an opaque share token and this function
// does the privileged work: validate the token, then mint signed URLs for that one project.
//
// The token is the entire security boundary, so it is treated carefully:
// - It is looked up, never trusted. Revoked or expired tokens return 404, not 403 — a
//   revoked link should look identical to a link that never existed.
// - Only the columns a client should see are selected. No user_id, no internal ids.
// - Signed URLs expire in an hour, so a scraped URL dies quickly even if the token lives on.
//
// REQUIRED NETLIFY ENV VARS:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// REQUIRED TABLE — run once in the Supabase SQL editor:
//   create table if not exists buildr_project_shares (
//     token        text primary key,
//     project_id   uuid not null references buildr_projects(id) on delete cascade,
//     user_id      uuid not null,
//     include_notes boolean not null default true,
//     expires_at   timestamptz,
//     revoked      boolean not null default false,
//     view_count   integer not null default 0,
//     created_at   timestamptz not null default now()
//   );
//   grant select, insert, update, delete on table buildr_project_shares to service_role;
//   grant select, insert, update, delete on table buildr_project_shares to authenticated;
//   alter table buildr_project_shares enable row level security;
//   create policy "own shares" on buildr_project_shares
//     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
//   notify pgrst, 'reload schema';

const PHOTO_BUCKET = "project-photos";
const SIGNED_URL_TTL_SECONDS = 3600;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function restHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

// A revoked, expired, or unknown token all return the same thing. Distinguishing them
// would tell someone probing tokens which guesses were once real.
function notFound() {
  return jsonResponse(404, { ok: false, error: "This share link is no longer available." });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse(500, { ok: false, error: "Share service is not configured." });
  }

  const token = String(
    (event.queryStringParameters && event.queryStringParameters.token) || ""
  ).trim();

  // Tokens are 32 hex chars. Reject anything else before touching the database.
  if (!/^[a-f0-9]{16,64}$/i.test(token)) return notFound();

  try {
    // 1. Resolve the token.
    const shareRes = await fetch(
      `${supabaseUrl}/rest/v1/buildr_project_shares` +
        `?token=eq.${encodeURIComponent(token)}` +
        `&select=project_id,include_notes,expires_at,revoked`,
      { headers: restHeaders(serviceKey) }
    );
    if (!shareRes.ok) return notFound();
    const shares = await shareRes.json().catch(() => []);
    const share = Array.isArray(shares) ? shares[0] : null;

    if (!share || share.revoked) return notFound();
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) return notFound();

    const projectId = share.project_id;

    // 2. Project name only — nothing about the owner.
    const projRes = await fetch(
      `${supabaseUrl}/rest/v1/buildr_projects?id=eq.${encodeURIComponent(projectId)}&select=name,created_at`,
      { headers: restHeaders(serviceKey) }
    );
    const projects = projRes.ok ? await projRes.json().catch(() => []) : [];
    const project = Array.isArray(projects) ? projects[0] : null;
    if (!project) return notFound();

    // 3. Photo rows for the project.
    const photoRes = await fetch(
      `${supabaseUrl}/rest/v1/buildr_project_photos` +
        `?project_id=eq.${encodeURIComponent(projectId)}` +
        `&select=storage_path,storage_bucket,caption,category,created_at&order=created_at.asc`,
      { headers: restHeaders(serviceKey) }
    );
    const rows = photoRes.ok ? await photoRes.json().catch(() => []) : [];
    // 4. Mint short-lived signed URLs, one batch per bucket. Rows carry their own
    //    storage_bucket, so we group rather than assuming every photo lives in the
    //    default bucket — a wrong bucket silently returns zero signed URLs.
    const byBucket = {};
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.storage_path) continue;
      const bucket = r.storage_bucket || PHOTO_BUCKET;
      (byBucket[bucket] = byBucket[bucket] || []).push(r.storage_path);
    }

    const signedByPath = {};
    for (const [bucket, paths] of Object.entries(byBucket)) {
      const signRes = await fetch(
        `${supabaseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}`,
        {
          method: "POST",
          headers: restHeaders(serviceKey),
          body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS, paths })
        }
      );
      if (!signRes.ok) {
        console.warn("signing failed for bucket", bucket, await signRes.text().catch(() => ""));
        continue;
      }
      const signed = await signRes.json().catch(() => []);
      for (const item of Array.isArray(signed) ? signed : []) {
        if (item?.path && item?.signedURL) {
          signedByPath[item.path] = `${supabaseUrl}/storage/v1${item.signedURL}`;
        }
      }
    }

    const photos = (Array.isArray(rows) ? rows : [])
      .map((r) => ({
        url: signedByPath[r.storage_path] || null,
        caption: r.caption || "",
        category: r.category || ""
      }))
      .filter((p) => p.url);

    // 5. Build Notes, only if the owner chose to include them.
    let notes = [];
    if (share.include_notes) {
      const notesRes = await fetch(
        `${supabaseUrl}/rest/v1/buildr_project_notes` +
          `?project_id=eq.${encodeURIComponent(projectId)}` +
          `&select=title,body,content,created_at&order=created_at.desc`,
        { headers: restHeaders(serviceKey) }
      );
      const noteRows = notesRes.ok ? await notesRes.json().catch(() => []) : [];
      // The app renders body||content, so mirror that exactly rather than guessing.
      notes = (Array.isArray(noteRows) ? noteRows : [])
        .map((n) => ({
          title: String(n.title || ""),
          body: String(n.body || n.content || "")
        }))
        .filter((n) => n.body);
    }

    // Fire-and-forget view counter. A failure here must never break the page.
    fetch(
      `${supabaseUrl}/rest/v1/rpc/increment_share_view`,
      {
        method: "POST",
        headers: restHeaders(serviceKey),
        body: JSON.stringify({ share_token: token })
      }
    ).catch(() => {});

    return jsonResponse(200, {
      ok: true,
      project: { name: project.name || "Project" },
      photos,
      notes
    });
  } catch (error) {
    console.error("Share project error:", error);
    return jsonResponse(500, { ok: false, error: "Could not load this project right now." });
  }
};
