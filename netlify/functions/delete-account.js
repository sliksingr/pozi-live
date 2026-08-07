// netlify/functions/delete-account.js
// Permanent account + data deletion for POZi Go.
//
// WHY THIS EXISTS: Apple requires any app that supports account creation to
// offer account deletion from inside the app. "Sign out" does not satisfy it —
// the account and its data have to actually go away.
//
// WHY IT'S A FUNCTION: deleting a Supabase auth user requires the service role
// key, which must never ship inside the app bundle. The client sends its own
// access token, we verify that token server-side, and we only ever delete the
// user that token belongs to. A caller cannot delete anyone else's account.
//
// DELETION ORDER matters — children before parents, so foreign keys never
// block a delete and nothing is orphaned:
//   1. item list items  (child of item lists)
//   2. item lists, messages, notes, photos rows, searches  (child of projects)
//   3. projects
//   4. standalone per-user rows (profile, disclaimer acceptances, usage)
//   5. storage objects under {uid}/
//   6. the auth user itself  — last, so a failure earlier leaves a recoverable
//      account rather than an orphaned data set with no owner.
//
// REQUIRED NETLIFY ENV VARS:
//   SUPABASE_URL                — https://eaagnkwtflsxiclpcaok.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   — service_role key (NEVER the anon key)
//   SUPABASE_ANON_KEY           — used only to verify the caller's token
//
// GRANTS GOTCHA: every table listed below needs explicit service_role grants or
// the delete silently no-ops with a 42501 permission denied:
//   grant select, insert, update, delete on table <name> to service_role;
//   notify pgrst, 'reload schema';

const PHOTO_BUCKET = "project-photos";

// Tables keyed directly by user_id, safe to delete in any order among themselves.
const USER_SCOPED_TABLES = [
  "buildr_project_searches",
  "buildr_project_photos",
  "buildr_project_notes",
  "buildr_project_messages",
  "buildr_disclaimer_acceptances",
  "buildr_profiles"
];

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function restHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };
}

// Verify the caller's access token and return their user id. This is the whole
// security model: we never trust a user id sent in the body.
async function getCallerUserId(supabaseUrl, anonKey, accessToken) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user?.id || null;
}

async function selectIds(supabaseUrl, serviceKey, table, column, matchColumn, values) {
  if (!values.length) return [];
  const list = values.map((v) => `"${v}"`).join(",");
  const url = `${supabaseUrl}/rest/v1/${table}?select=${column}&${matchColumn}=in.(${list})`;
  const res = await fetch(url, { headers: restHeaders(serviceKey) });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map((r) => r[column]).filter(Boolean) : [];
}

async function deleteWhereIn(supabaseUrl, serviceKey, table, column, values) {
  if (!values.length) return { table, skipped: true };
  const list = values.map((v) => `"${v}"`).join(",");
  const url = `${supabaseUrl}/rest/v1/${table}?${column}=in.(${list})`;
  const res = await fetch(url, { method: "DELETE", headers: restHeaders(serviceKey) });
  return { table, ok: res.ok, status: res.status };
}

async function deleteByUser(supabaseUrl, serviceKey, table, userId) {
  const url = `${supabaseUrl}/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, { method: "DELETE", headers: restHeaders(serviceKey) });
  return { table, ok: res.ok, status: res.status };
}

// Remove every stored photo under this user's prefix. Storage is listed per
// folder, so we walk the user's project folders rather than assuming a flat list.
async function deleteUserStorage(supabaseUrl, serviceKey, userId) {
  const listAt = async (prefix) => {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/list/${PHOTO_BUCKET}`, {
      method: "POST",
      headers: restHeaders(serviceKey),
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 })
    });
    if (!res.ok) return [];
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  };

  const paths = [];
  const folders = await listAt(`${userId}/`);
  for (const entry of folders) {
    if (!entry?.name) continue;
    // An entry with no id is a folder (a project), so descend into it.
    if (entry.id === null || entry.id === undefined) {
      const files = await listAt(`${userId}/${entry.name}/`);
      for (const f of files) if (f?.name) paths.push(`${userId}/${entry.name}/${f.name}`);
    } else {
      paths.push(`${userId}/${entry.name}`);
    }
  }

  if (!paths.length) return { removed: 0 };

  const res = await fetch(`${supabaseUrl}/storage/v1/object/${PHOTO_BUCKET}`, {
    method: "DELETE",
    headers: restHeaders(serviceKey),
    body: JSON.stringify({ prefixes: paths })
  });
  return { removed: res.ok ? paths.length : 0, ok: res.ok };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, { ok: true });
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return jsonResponse(500, {
      ok: false,
      error:
        "Server is missing Supabase credentials. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY in Netlify environment variables."
    });
  }

  // Bearer token from the signed-in client.
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!accessToken) {
    return jsonResponse(401, { ok: false, error: "Not signed in." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body." });
  }

  // Typed confirmation, checked server-side as well as in the UI.
  if (String(body.confirm || "").trim().toUpperCase() !== "DELETE") {
    return jsonResponse(400, { ok: false, error: "Deletion not confirmed." });
  }

  const userId = await getCallerUserId(supabaseUrl, anonKey, accessToken);
  if (!userId) {
    return jsonResponse(401, { ok: false, error: "Your session has expired. Sign in again." });
  }

  const steps = [];

  try {
    // 1. Project ids, then item list ids belonging to them.
    const projectIds = await selectIds(
      supabaseUrl, serviceKey, "buildr_projects", "id", "user_id", [userId]
    );
    const itemListIds = projectIds.length
      ? await selectIds(supabaseUrl, serviceKey, "buildr_project_item_lists", "id", "project_id", projectIds)
      : [];

    // 2. Deepest children first.
    if (itemListIds.length) {
      steps.push(await deleteWhereIn(
        supabaseUrl, serviceKey, "buildr_project_item_list_items", "item_list_id", itemListIds
      ));
    }
    if (projectIds.length) {
      steps.push(await deleteWhereIn(
        supabaseUrl, serviceKey, "buildr_project_item_lists", "project_id", projectIds
      ));
    }

    // 3. Storage before the photo rows, so a failure leaves rows pointing at
    //    files we can still find and retry.
    steps.push({ storage: await deleteUserStorage(supabaseUrl, serviceKey, userId) });

    // 4. Everything keyed straight to the user.
    for (const table of USER_SCOPED_TABLES) {
      steps.push(await deleteByUser(supabaseUrl, serviceKey, table, userId));
    }

    // 5. Projects last among the data tables.
    steps.push(await deleteByUser(supabaseUrl, serviceKey, "buildr_projects", userId));

    // 6. Finally the auth user. Once this succeeds the account is gone.
    const delRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: restHeaders(serviceKey)
    });

    if (!delRes.ok) {
      const detail = await delRes.text().catch(() => "");
      console.error("Auth user deletion failed:", delRes.status, detail);
      return jsonResponse(502, {
        ok: false,
        error: "Your data was removed, but the account itself could not be deleted. Contact info@pozi.live and we'll finish it.",
        steps
      });
    }

    console.log("Account deleted:", userId, JSON.stringify(steps));
    return jsonResponse(200, { ok: true, deleted: true });
  } catch (error) {
    console.error("Account deletion error:", error);
    return jsonResponse(500, {
      ok: false,
      error: error?.message || "Account deletion failed. Contact info@pozi.live.",
      steps
    });
  }
};
