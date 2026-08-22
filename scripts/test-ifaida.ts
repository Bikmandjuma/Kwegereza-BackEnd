/**
 * Ifaida lifecycle test — the spec's "IFAIDA TEST" section made real: create
 * a draft, edit it repeatedly (simulating autosave), verify it stays
 * invisible to the public while a draft, publish it, verify it becomes
 * publicly readable, unpublish it, verify it disappears again — with each
 * individual action (create/update/delete/publish) gated on its OWN specific
 * permission, not a single blanket "can write Ifaida" flag.
 *
 * Run with: npx tsx scripts/test-ifaida.ts   (server must be running)
 */
const API = "http://localhost:4000";

async function login(email: string, password: string) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`login failed for ${email}: ${json.message}`);
  return json.data as { token: string; user: { id: string; fullName: string } };
}

async function register(fullName: string, email: string, password: string) {
  return fetch(`${API}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName, email, password }),
  }).then((r) => r.json());
}

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  const admin = await login("admin@kwegereza.rw", "Admin@12345");
  const leader = await login("leader@kwegereza.rw", "Leader@12345");

  console.log("=== 1. A LEADER with zero ifaida permissions cannot even create a draft ===");
  const bareEmail = `ifaida.bare.${Date.now()}@example.com`;
  await register("Bare Leader", bareEmail, "Bare@12345");
  const pendingList = await fetch(`${API}/api/students/pending?search=${encodeURIComponent(bareEmail)}`, {
    headers: authHeaders(leader.token),
  }).then((r) => r.json());
  await fetch(`${API}/api/students/${pendingList.data[0].id}/approve`, {
    method: "POST",
    headers: authHeaders(leader.token),
  });
  await fetch(`${API}/api/admin/users/${pendingList.data[0].id}/role`, {
    method: "PATCH",
    headers: authHeaders(admin.token),
    body: JSON.stringify({ role: "LEADER" }),
  });
  const bareLeader = await login(bareEmail, "Bare@12345");
  const bareCreateAttempt = await fetch(`${API}/api/ifaida`, {
    method: "POST",
    headers: authHeaders(bareLeader.token),
    body: JSON.stringify({ title: "Ntabwo bikwiye" }),
  });
  check("Leader with no ifaida.create is rejected with 403", bareCreateAttempt.status === 403);

  console.log("\n=== 2. Real leader (has ifaida.create) creates a DRAFT ===");
  const createRes = await fetch(`${API}/api/ifaida`, {
    method: "POST",
    headers: authHeaders(leader.token),
    body: JSON.stringify({ title: "Ibanze ry'Ukwemera muri Islamu" }),
  }).then((r) => r.json());
  check("Draft creation succeeds", createRes.success === true);
  check("New post starts as DRAFT", createRes.data.status === "DRAFT");
  const postId = createRes.data.id;

  console.log("\n=== 3. Draft is invisible to the public reading list ===");
  const publicListBeforePublish = await fetch(`${API}/api/ifaida/published`).then((r) => r.json());
  check(
    "Draft does not appear in the public list",
    !publicListBeforePublish.data.some((p: any) => p.id === postId)
  );
  const publicDetailBeforePublish = await fetch(`${API}/api/ifaida/published/${postId}`);
  check("Draft's public detail URL returns 404 (not just hidden from the list)", publicDetailBeforePublish.status === 404);

  console.log("\n=== 4. Simulate autosave: several rapid edits, each a real PATCH (debouncing is a frontend concern) ===");
  const maliciousContent =
    '<p>Ubu ni Ifaida <b>nziza</b> kuri Kwegereza.</p><script>alert("xss")</script><img src=x onerror="alert(1)">';
  const editRes = await fetch(`${API}/api/ifaida/${postId}`, {
    method: "PATCH",
    headers: authHeaders(leader.token),
    body: JSON.stringify({
      description: "Isomo rigufi ku bibanze by'ukwemera.",
      content: maliciousContent,
      category: "Aqida",
    }),
  }).then((r) => r.json());
  check("Autosave-style update succeeds", editRes.success === true);
  check("Script tag was stripped from stored content (XSS protection)", !editRes.data.content.includes("<script>"));
  check("Inline event handler was stripped (onerror=)", !editRes.data.content.includes("onerror"));
  check("Legitimate formatting survived sanitization", editRes.data.content.includes("<b>nziza</b>"));

  console.log("\n=== 5. A non-author leader cannot edit someone else's draft ===");
  await fetch(`${API}/api/admin/users/${pendingList.data[0].id}/permissions`, {
    method: "PATCH",
    headers: authHeaders(admin.token),
    body: JSON.stringify({ permissions: ["ifaida.update"] }),
  });
  const otherLeaderEditAttempt = await fetch(`${API}/api/ifaida/${postId}`, {
    method: "PATCH",
    headers: authHeaders(bareLeader.token),
    body: JSON.stringify({ title: "Hijack attempt" }),
  });
  check("A different leader (even with ifaida.update) cannot edit someone else's post", otherLeaderEditAttempt.status === 403);

  console.log("\n=== 6. Publishing requires ifaida.publish specifically, separate from update ===");
  const publishWithoutPermission = await fetch(`${API}/api/ifaida/${postId}/publish`, {
    method: "POST",
    headers: authHeaders(bareLeader.token), // has ifaida.update now, but NOT ifaida.publish, and isn't the author anyway
  });
  check("Publish attempt without permission (and wrong author) is rejected", publishWithoutPermission.status === 403);

  const publishRes = await fetch(`${API}/api/ifaida/${postId}/publish`, {
    method: "POST",
    headers: authHeaders(leader.token),
  }).then((r) => r.json());
  check("Author with ifaida.publish successfully publishes", publishRes.success === true);
  check("Status is now PUBLISHED", publishRes.data.status === "PUBLISHED");
  check("publishedAt timestamp was set", !!publishRes.data.publishedAt);

  console.log("\n=== 7. Published post is now publicly visible, sanitized content and all ===");
  const publicListAfterPublish = await fetch(`${API}/api/ifaida/published`).then((r) => r.json());
  check("Published post now appears in the public list", publicListAfterPublish.data.some((p: any) => p.id === postId));
  const publicDetailAfterPublish = await fetch(`${API}/api/ifaida/published/${postId}`).then((r) => r.json());
  check("Public detail view succeeds", publicDetailAfterPublish.success === true);
  check("Public view never sees the stripped script tag either", !publicDetailAfterPublish.data.content.includes("<script>"));
  check("Reading time is a real computed positive number", publicDetailAfterPublish.data.readingMinutes >= 1);

  console.log("\n=== 8. Unpublish takes it back out of public view ===");
  const unpublishRes = await fetch(`${API}/api/ifaida/${postId}/unpublish`, {
    method: "POST",
    headers: authHeaders(leader.token),
  }).then((r) => r.json());
  check("Unpublish succeeds", unpublishRes.success === true);
  check("Status is back to DRAFT", unpublishRes.data.status === "DRAFT");
  const publicListAfterUnpublish = await fetch(`${API}/api/ifaida/published`).then((r) => r.json());
  check("Post no longer appears publicly after unpublish", !publicListAfterUnpublish.data.some((p: any) => p.id === postId));

  console.log("\n=== 9. Delete requires ifaida.delete specifically ===");
  const deleteWithoutPermission = await fetch(`${API}/api/ifaida/${postId}`, {
    method: "DELETE",
    headers: authHeaders(bareLeader.token),
  });
  check("Delete without ifaida.delete permission is rejected", deleteWithoutPermission.status === 403);

  const deleteRes = await fetch(`${API}/api/ifaida/${postId}`, {
    method: "DELETE",
    headers: authHeaders(leader.token),
  }).then((r) => r.json());
  check("Author with ifaida.delete successfully deletes", deleteRes.success === true);

  const getAfterDelete = await fetch(`${API}/api/ifaida/mine/${postId}`, { headers: authHeaders(leader.token) });
  check("Post is genuinely gone after delete", getAfterDelete.status === 404);

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
