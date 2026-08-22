/**
 * Analytics correctness test. This is the spec's "no fake numbers" rule made
 * concrete: every number this test checks was produced by a real action taken
 * moments earlier in this same run, and the assertions compare against those
 * exact actions rather than accepting "some positive number".
 *
 * Run with: npx tsx scripts/test-analytics.ts   (server must be running)
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

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function main() {
  console.log("=== 1. Register + approve a fresh student for a clean, isolated measurement ===");
  const host = await login("leader@kwegereza.rw", "Leader@12345");
  const studentEmail = `analytics.student.${Date.now()}@example.com`;
  await register("Zainab Testeur", studentEmail, "Zainab@123");
  const pendingList = await fetch(
    `${API}/api/students/pending?search=${encodeURIComponent(studentEmail)}`,
    { headers: authHeaders(host.token) }
  ).then((r) => r.json());
  const pendingId = pendingList.data[0]?.id;
  await fetch(`${API}/api/students/${pendingId}/approve`, {
    method: "POST",
    headers: authHeaders(host.token),
  });

  console.log("\n=== 2. Student logs in — this must start a real Session and a LOGIN event ===");
  const loginTime = Date.now();
  const student = await login(studentEmail, "Zainab@123");
  check("Student login succeeds", !!student.token);

  console.log("\n=== 3. Student fires two allowed client-tracked events ===");
  const pageViewRes = await fetch(`${API}/api/activity/track`, {
    method: "POST",
    headers: authHeaders(student.token),
    body: JSON.stringify({ type: "PAGE_VIEW", meta: { path: "/ibitabo" } }),
  }).then((r) => r.json());
  check("PAGE_VIEW tracked", pageViewRes.success === true);

  const bookDownloadRes = await fetch(`${API}/api/activity/track`, {
    method: "POST",
    headers: authHeaders(student.token),
    body: JSON.stringify({ type: "BOOK_DOWNLOAD", meta: { title: "Riyadh As-Salihiin" } }),
  }).then((r) => r.json());
  check("BOOK_DOWNLOAD tracked", bookDownloadRes.success === true);

  console.log("\n=== 4. An arbitrary/unlisted event type is rejected (no open pipe for fake events) ===");
  const bogusRes = await fetch(`${API}/api/activity/track`, {
    method: "POST",
    headers: authHeaders(student.token),
    body: JSON.stringify({ type: "MOUSE_MOVED_A_LOT", meta: {} }),
  });
  check("Unlisted event type rejected with 422", bogusRes.status === 422);

  console.log("\n=== 5. A real STUDENT (no analytics.view) cannot read the dashboard ===");
  const studentAnalyticsAttempt = await fetch(`${API}/api/analytics/overview?range=lifetime`, {
    headers: authHeaders(student.token),
  });
  check("Student is rejected with 403", studentAnalyticsAttempt.status === 403);

  console.log("\n=== 6. Heartbeat, wait ~2.5s, then logout — session duration must reflect real elapsed time ===");
  await fetch(`${API}/api/activity/heartbeat`, { method: "POST", headers: authHeaders(student.token) });
  await new Promise((r) => setTimeout(r, 2500));
  await fetch(`${API}/api/auth/logout`, { method: "POST", headers: authHeaders(student.token) });
  const elapsedRealSeconds = (Date.now() - loginTime) / 1000;

  console.log("\n=== 7. Leader (has analytics.view) reads the per-student detail ===");
  const detailRes = await fetch(`${API}/api/analytics/students/${student.user.id}`, {
    headers: authHeaders(host.token),
  }).then((r) => r.json());
  check("Detail request succeeds", detailRes.success === true);
  check(
    `Platform time is close to real elapsed time (~${elapsedRealSeconds.toFixed(1)}s, got ${detailRes.data.totalPlatformTimeSeconds}s)`,
    Math.abs(detailRes.data.totalPlatformTimeSeconds - elapsedRealSeconds) < 5
  );
  check("Event counts include exactly 1 LOGIN", detailRes.data.eventCounts.LOGIN === 1);
  check("Event counts include exactly 1 LOGOUT", detailRes.data.eventCounts.LOGOUT === 1);
  check("Event counts include exactly 1 PAGE_VIEW", detailRes.data.eventCounts.PAGE_VIEW === 1);
  check("Event counts include exactly 1 BOOK_DOWNLOAD", detailRes.data.eventCounts.BOOK_DOWNLOAD === 1);
  check("No fabricated MOUSE_MOVED_A_LOT entry made it through", detailRes.data.eventCounts.MOUSE_MOVED_A_LOT === undefined);

  console.log("\n=== 8. Leader reads the overview (lifetime range) — real aggregate counts ===");
  const overviewRes = await fetch(`${API}/api/analytics/overview?range=lifetime`, {
    headers: authHeaders(host.token),
  }).then((r) => r.json());
  check("Overview request succeeds", overviewRes.success === true);
  check("totalStudents is a real positive count", overviewRes.data.totalStudents >= 1);
  check("Overview's PAGE_VIEW count includes this run's event", overviewRes.data.eventCounts.PAGE_VIEW >= 1);
  check("Overview's platform time includes this run's session", overviewRes.data.platformTimeSeconds >= elapsedRealSeconds - 2);

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
