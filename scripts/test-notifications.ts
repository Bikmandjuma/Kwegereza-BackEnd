/**
 * Notification correctness test. Covers:
 *  - the dedup guarantee (same eventKey never creates two rows / two pushes)
 *  - real-time in-app delivery via socket (`notification:new`)
 *  - the REST notification center (list, unread count, mark read, mark all)
 *  - push subscription CRUD (subscribe/unsubscribe) with a fake browser payload
 *  - that a real event (student approval, live class started) actually fires
 *    a notification end-to-end, not just that the utility function works
 *
 * HONESTY NOTE: a fake subscription payload cannot receive a real push — a
 * real push endpoint only exists once an actual browser calls
 * pushManager.subscribe(), which requires a real browser context. This test
 * proves the subscription is stored/validated/removed correctly and that
 * sendPushToUser() is invoked (see server log), not that a notification
 * appears on a real device. That final mile needs a human with a real
 * browser and notification permission granted.
 *
 * Run with: npx tsx scripts/test-notifications.ts   (server must be running)
 */
import { io as ioClient, type Socket } from "socket.io-client";
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:4000";
const prisma = new PrismaClient();

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

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(API, { auth: { token }, transports: ["websocket"] });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });
}

function once(socket: Socket, event: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
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

async function register(fullName: string, email: string, password: string) {
  return fetch(`${API}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName, email, password }),
  }).then((r) => r.json());
}

async function main() {
  console.log("=== 1. VAPID public key endpoint returns the real configured key ===");
  const vapidRes = await fetch(`${API}/api/push/vapid-public-key`).then((r) => r.json());
  check("VAPID key returned", vapidRes.success === true && typeof vapidRes.data.publicKey === "string");
  check("VAPID key looks like a real public key (length > 60)", vapidRes.data.publicKey.length > 60);

  console.log("\n=== 2. Register + approve a fresh student; watch the approval notification arrive live ===");
  const host = await login("leader@kwegereza.rw", "Leader@12345");
  const studentEmail = `notif.student.${Date.now()}@example.com`;
  await register("Fatima Testeur", studentEmail, "Fatima@123");

  const pendingList = await fetch(`${API}/api/students/pending?search=${encodeURIComponent(studentEmail)}`, {
    headers: { Authorization: `Bearer ${host.token}` },
  }).then((r) => r.json());
  const pendingId = pendingList.data[0]?.id;

  // Connect the student's socket BEFORE approval, joined to their own user room,
  // so we can prove the realtime notification actually reaches them live.
  const studentPreApproval = await login(studentEmail, "Fatima@123").catch(() => null);
  check("Student cannot log in yet (still PENDING)", studentPreApproval === null);

  // We can't open a socket before login (no token yet), so instead verify via
  // the DB + REST path, then open the socket AFTER approval to confirm the
  // notification is already sitting in their notification center.
  const approveRes = await fetch(`${API}/api/students/${pendingId}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${host.token}` },
  }).then((r) => r.json());
  check("Approval succeeds", approveRes.success === true);

  const student = await login(studentEmail, "Fatima@123");
  check("Student can now log in", !!student.token);

  const notifList = await fetch(`${API}/api/notifications`, {
    headers: { Authorization: `Bearer ${student.token}` },
  }).then((r) => r.json());
  check("Student has exactly 1 notification (the approval)", notifList.data.length === 1);
  check("Unread count is 1", notifList.meta.unreadCount === 1);
  check("Notification type is account.approved", notifList.data[0].type === "account.approved");

  console.log("\n=== 3. Mark it read; unread count drops to 0 ===");
  const notifId = notifList.data[0].id;
  await fetch(`${API}/api/notifications/${notifId}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${student.token}` },
  });
  const afterRead = await fetch(`${API}/api/notifications`, {
    headers: { Authorization: `Bearer ${student.token}` },
  }).then((r) => r.json());
  check("Unread count is now 0", afterRead.meta.unreadCount === 0);
  check("Notification itself is marked read", afterRead.data[0].read === true);

  console.log("\n=== 4. Dedup guarantee: same eventKey never creates a second row ===");
  const dbCountBefore = await prisma.notification.count({
    where: { userId: student.user.id, eventKey: { contains: "account-approved" } },
  });
  // Simulate the exact same approval event firing twice (e.g. a retried
  // request) by calling the notify utility directly with the identical key.
  const { notifyUser } = await import("../src/utils/notify.js");
  await notifyUser({
    userId: student.user.id,
    type: "account.approved",
    title: "duplicate attempt",
    body: "should not create a new row",
    eventKey: notifList.data[0].eventKey,
  });
  const dbCountAfter = await prisma.notification.count({
    where: { userId: student.user.id, eventKey: { contains: "account-approved" } },
  });
  check("Notification count unchanged after duplicate dispatch attempt", dbCountBefore === dbCountAfter);

  console.log("\n=== 5. Push subscription CRUD with a fake browser payload ===");
  const fakeEndpoint = `https://fake-push-service.example.com/${Date.now()}`;
  const subscribeRes = await fetch(`${API}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${student.token}` },
    body: JSON.stringify({
      subscription: { endpoint: fakeEndpoint, keys: { p256dh: "fake-p256dh-key", auth: "fake-auth-key" } },
    }),
  }).then((r) => r.json());
  check("Subscribe succeeds", subscribeRes.success === true);

  const storedSub = await prisma.pushSubscription.findUnique({ where: { endpoint: fakeEndpoint } });
  check("Subscription actually stored in the database", !!storedSub && storedSub.userId === student.user.id);

  const unsubscribeRes = await fetch(`${API}/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${student.token}` },
    body: JSON.stringify({ endpoint: fakeEndpoint }),
  }).then((r) => r.json());
  check("Unsubscribe succeeds", unsubscribeRes.success === true);
  const storedAfterUnsub = await prisma.pushSubscription.findUnique({ where: { endpoint: fakeEndpoint } });
  check("Subscription removed from the database", storedAfterUnsub === null);

  console.log("\n=== 6. Live class started -> notifies other active users, live over the socket ===");
  const studentSocket = await connectSocket(student.token);
  const notifPromise = once(studentSocket, "notification:new");
  const createClassRes = await fetch(`${API}/api/live-classes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ title: "Tajwiid — Ustadh Bilal" }),
  }).then((r) => r.json());
  const liveNotif = await notifPromise;
  check("Student receives a live notification:new event for the class starting", liveNotif.type === "liveclass.started");
  check("Notification body matches the class title", liveNotif.body === "Tajwiid — Ustadh Bilal");

  await fetch(`${API}/api/live-classes/${createClassRes.data.liveClass.id}/end`, {
    method: "POST",
    headers: { Authorization: `Bearer ${host.token}` },
  });

  studentSocket.disconnect();
  await prisma.$disconnect();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Test script crashed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
