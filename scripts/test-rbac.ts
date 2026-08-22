/**
 * Role & permission assignment correctness test. This is the spec's "RBAC —
 * CRITICAL" section made real: a permission an admin hasn't granted must be
 * unusable by the API regardless of role, and only ADMIN can assign roles
 * and permissions in the first place — not even a fully-permissioned leader.
 *
 * Run with: npx tsx scripts/test-rbac.ts   (server must be running)
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

  console.log("=== 1. Permission catalog is real and admin-only ===");
  const catalogAsAdmin = await fetch(`${API}/api/admin/permissions-catalog`, {
    headers: authHeaders(admin.token),
  }).then((r) => r.json());
  check("Admin can read the permission catalog", catalogAsAdmin.success === true);
  check("Catalog has the full 34 permissions from the spec", catalogAsAdmin.data.length === 34);

  const catalogAsLeader = await fetch(`${API}/api/admin/permissions-catalog`, {
    headers: authHeaders(leader.token),
  });
  check("A LEADER (even a highly-permissioned one) cannot read the catalog — admin-only", catalogAsLeader.status === 403);

  console.log("\n=== 2. Register a fresh student, approve them, promote to LEADER ===");
  const email = `rbac.test.${Date.now()}@example.com`;
  await register("Khalid Testeur", email, "Khalid@123");
  const pendingList = await fetch(`${API}/api/students/pending?search=${encodeURIComponent(email)}`, {
    headers: authHeaders(leader.token),
  }).then((r) => r.json());
  const pendingId = pendingList.data[0]?.id;
  await fetch(`${API}/api/students/${pendingId}/approve`, { method: "POST", headers: authHeaders(leader.token) });
  const student = await login(email, "Khalid@123");

  console.log("\n=== 3. A LEADER (not admin) cannot promote anyone — even with every student permission ===");
  const leaderPromoteAttempt = await fetch(`${API}/api/admin/users/${student.user.id}/role`, {
    method: "PATCH",
    headers: authHeaders(leader.token),
    body: JSON.stringify({ role: "LEADER" }),
  });
  check("Leader's promotion attempt is rejected with 403", leaderPromoteAttempt.status === 403);

  console.log("\n=== 4. Admin promotes the student to LEADER with zero permissions ===");
  const promoteRes = await fetch(`${API}/api/admin/users/${student.user.id}/role`, {
    method: "PATCH",
    headers: authHeaders(admin.token),
    body: JSON.stringify({ role: "LEADER" }),
  }).then((r) => r.json());
  check("Admin promotion succeeds", promoteRes.success === true);
  check("New leader starts with zero permissions", promoteRes.data.user.permissions.length === 0);

  console.log("\n=== 5. Freshly-promoted leader (zero permissions) cannot approve students ===");
  const newLeaderLogin = await login(email, "Khalid@123");
  const blindApproveAttempt = await fetch(`${API}/api/students/pending`, {
    headers: authHeaders(newLeaderLogin.token),
  });
  check("New leader with no permissions is rejected from student.approve-gated route (403)", blindApproveAttempt.status === 403);

  console.log("\n=== 6. Admin grants ONLY classroom.host — not student.approve ===");
  const grantRes = await fetch(`${API}/api/admin/users/${student.user.id}/permissions`, {
    method: "PATCH",
    headers: authHeaders(admin.token),
    body: JSON.stringify({ permissions: ["classroom.host", "not.a.real.permission"] }),
  }).then((r) => r.json());
  check("Permission grant succeeds", grantRes.success === true);
  check("Invalid/unknown permission string was silently dropped, not stored", !grantRes.data.user.permissions.includes("not.a.real.permission"));
  check("Only the real granted permission is present", grantRes.data.user.permissions.length === 1 && grantRes.data.user.permissions[0] === "classroom.host");

  console.log("\n=== 7. Live enforcement WITHOUT re-login: DB is re-read on every request ===");
  // Deliberately reuse newLeaderLogin's token from BEFORE the grant above —
  // proves permission changes take effect immediately, no fresh token needed.
  const canHostNow = await fetch(`${API}/api/live-classes`, {
    method: "POST",
    headers: authHeaders(newLeaderLogin.token),
    body: JSON.stringify({ title: "Test class from newly-granted leader" }),
  });
  check("Same old token can now host a class (classroom.host was just granted)", canHostNow.status === 201);

  const stillCannotApprove = await fetch(`${API}/api/students/pending`, {
    headers: authHeaders(newLeaderLogin.token),
  });
  check("Same leader STILL cannot approve students (student.approve was never granted)", stillCannotApprove.status === 403);

  console.log("\n=== 8. Admin demotes the leader back to student — permissions wiped ===");
  const demoteRes = await fetch(`${API}/api/admin/users/${student.user.id}/role`, {
    method: "PATCH",
    headers: authHeaders(admin.token),
    body: JSON.stringify({ role: "STUDENT" }),
  }).then((r) => r.json());
  check("Demotion succeeds", demoteRes.success === true);
  check("Permissions wiped on demotion", demoteRes.data.user.permissions.length === 0);

  const cannotHostAfterDemotion = await fetch(`${API}/api/live-classes`, {
    method: "POST",
    headers: authHeaders(newLeaderLogin.token),
    body: JSON.stringify({ title: "Should fail" }),
  });
  check("Demoted user can no longer host a class", cannotHostAfterDemotion.status === 403);

  console.log("\n=== 9. Admin accounts cannot be role-changed or blocked through this API ===");
  const cannotDemoteAdmin = await fetch(`${API}/api/admin/users/${admin.user.id}/role`, {
    method: "PATCH",
    headers: authHeaders(admin.token),
    body: JSON.stringify({ role: "STUDENT" }),
  });
  check("Admin cannot change their own role", cannotDemoteAdmin.status === 422);

  const leaderIdForAdminBlockTest = (
    await fetch(`${API}/api/admin/users?role=ADMIN`, { headers: authHeaders(admin.token) }).then((r) => r.json())
  ).data[0]?.id;
  const cannotBlockAdmin = await fetch(`${API}/api/admin/users/${leaderIdForAdminBlockTest}/block`, {
    method: "POST",
    headers: authHeaders(admin.token),
  });
  check("No admin account can be blocked through this endpoint", cannotBlockAdmin.status === 403);

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
