/**
 * Live chat correctness test — this is the "CHAT TEST" from the spec, run for
 * real against the running server: two independent socket connections
 * (simulating Browser A and Browser B), exactly one message sent, a deliberate
 * duplicate resubmission, a reconnect, and a fresh history fetch — verifying
 * at every step that the count is exactly 1, never 2.
 *
 * Run with: npx tsx scripts/test-chat.ts   (server must already be running)
 */
import { io as ioClient, type Socket } from "socket.io-client";

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

function emitAck(socket: Socket, event: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ack on ${event}`)), 3000);
    socket.emit(event, payload, (ack: any) => {
      clearTimeout(t);
      resolve(ack);
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

async function main() {
  console.log("=== 1. Login as Admin (Browser A) and Leader (Browser B) ===");
  const admin = await login("admin@kwegereza.rw", "Admin@12345");
  const leader = await login("leader@kwegereza.rw", "Leader@12345");
  console.log(`  Admin:  ${admin.user.fullName} (${admin.user.id})`);
  console.log(`  Leader: ${leader.user.fullName} (${leader.user.id})`);

  console.log("\n=== 2. Start (or reuse) a conversation between them ===");
  const startRes = await fetch(`${API}/api/chat/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ withUserId: leader.user.id }),
  }).then((r) => r.json());
  const conversationId = startRes.data.conversation.id;
  console.log(`  conversationId = ${conversationId}`);

  console.log("\n=== 3. Connect two independent sockets (Browser A = Admin, Browser B = Leader) ===");
  const socketA = await connectSocket(admin.token);
  const socketB = await connectSocket(leader.token);
  check("Socket A connected", socketA.connected);
  check("Socket B connected", socketB.connected);

  await emitAck(socketA, "conversation:join", { conversationId });
  await emitAck(socketB, "conversation:join", { conversationId });

  console.log("\n=== 4. Browser A sends EXACTLY ONE message ===");
  let bReceivedCount = 0;
  socketB.on("message:new", () => bReceivedCount++);

  const clientMessageId = "test-msg-" + Date.now();
  const bMessagePromise = once(socketB, "message:new");
  const sendAck1 = await emitAck(socketA, "message:send", {
    conversationId,
    clientMessageId,
    body: "Assalamu alaikum — this is the one and only message.",
  });
  const bMsg = await bMessagePromise;

  check("Send ack ok:true", sendAck1.ok === true);
  check("Send ack NOT flagged as duplicate (first send)", sendAck1.duplicate === false);
  check("Browser B received message:new exactly once so far", bReceivedCount === 1);
  check("Browser B's received message matches what A sent", bMsg.clientMessageId === clientMessageId);

  console.log("\n=== 5. Browser A's client RETRIES the same send (simulates network retry / double-click) ===");
  const sendAck2 = await emitAck(socketA, "message:send", {
    conversationId,
    clientMessageId, // <-- SAME id on purpose
    body: "Assalamu alaikum — this is the one and only message.",
  });
  // give the server a moment — if it were (incorrectly) going to double-broadcast, it would happen by now
  await new Promise((r) => setTimeout(r, 400));

  check("Retry ack ok:true (server still responds, doesn't error)", sendAck2.ok === true);
  check("Retry ack IS flagged as duplicate", sendAck2.duplicate === true);
  check("Retry returns the SAME message id as the original", sendAck2.message.id === bMsg.id);
  check("Browser B did NOT receive a second message:new event", bReceivedCount === 1);

  console.log("\n=== 6. Database check: exactly 1 row for this clientMessageId ===");
  const historyRes = await fetch(`${API}/api/chat/conversations/${conversationId}/messages`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  }).then((r) => r.json());
  const matching = historyRes.data.filter((m: any) => m.clientMessageId === clientMessageId);
  check("Exactly one database row for this clientMessageId", matching.length === 1);

  console.log("\n=== 7. Typing indicators ===");
  const typingPromise = once(socketB, "typing:update");
  socketA.emit("typing:start", { conversationId });
  const typingEvent = await typingPromise;
  check("Browser B received typing:update with typing:true", typingEvent.typing === true);

  const stopPromise = once(socketB, "typing:update");
  socketA.emit("typing:stop", { conversationId });
  const stopEvent = await stopPromise;
  check("Browser B received typing:update with typing:false", stopEvent.typing === false);

  console.log("\n=== 8. Reconnect: Browser B disconnects and reconnects, rejoins, re-fetches history ===");
  socketB.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const socketB2 = await connectSocket(leader.token);
  await emitAck(socketB2, "conversation:join", { conversationId });

  const historyAfterReconnect = await fetch(`${API}/api/chat/conversations/${conversationId}/messages`, {
    headers: { Authorization: `Bearer ${leader.token}` },
  }).then((r) => r.json());
  const matchingAfterReconnect = historyAfterReconnect.data.filter(
    (m: any) => m.clientMessageId === clientMessageId
  );
  check("After reconnect, history still shows exactly 1 copy of the message", matchingAfterReconnect.length === 1);

  console.log("\n=== 9. Mark conversation read ===");
  const readRes = await fetch(`${API}/api/chat/conversations/${conversationId}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${leader.token}` },
  }).then((r) => r.json());
  check("Mark-as-read succeeds", readRes.success === true);

  socketA.disconnect();
  socketB2.disconnect();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exit(1);
});
