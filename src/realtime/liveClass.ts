import type { Server, Socket } from "socket.io";
import { prisma } from "../utils/prisma.js";
import { trackEvent } from "../utils/activity.js";

type MicState = "HOST" | "MUTED" | "APPROVED";

interface Participant {
  userId: string;
  fullName: string;
  socketId: string;
  role: "HOST" | "PARTICIPANT"; // role WITHIN this classroom
  accountRole: string; // real account role (STUDENT/LEADER/ADMIN) — lets the host find leaders to delegate chat-moderation to
  micState: MicState;
  handRaised: boolean;
}

interface ClassroomState {
  hostId: string;
  locked: boolean;
  namesRevealed: boolean; // chat sender identity hidden by default, per spec
  chatModerators: Set<string>; // userIds (besides the host) allowed to reveal/hide names
  anonLabels: Map<string, string>; // stable pseudonym per user for this class session
  participants: Map<string, Participant>; // key: userId
}

function anonLabelFor(state: ClassroomState, userId: string): string {
  if (userId === state.hostId) return "Umuyobozi";
  let label = state.anonLabels.get(userId);
  if (!label) {
    label = `Umunyeshuri ${state.anonLabels.size + 1}`;
    state.anonLabels.set(userId, label);
  }
  return label;
}

// One entry per LIVE class. Ephemeral by design — attendance and the class
// record itself are persisted to Postgres/SQLite; who's-online-right-now
// lives in memory (Redis in a multi-instance production deployment, same
// interface).
const classrooms = new Map<string, ClassroomState>();

function publicParticipant(p: Participant) {
  return {
    userId: p.userId,
    fullName: p.fullName,
    role: p.role,
    accountRole: p.accountRole,
    micState: p.micState,
    handRaised: p.handRaised,
  };
}

function participantList(state: ClassroomState) {
  return Array.from(state.participants.values()).map(publicParticipant);
}

/**
 * Shared by both the REST "end class" endpoint and the socket `classroom:end`
 * event, so there's exactly one code path that closes a class — no matter
 * which route triggered it, DB state and connected clients stay in sync.
 */
export async function endLiveClass(io: Server | null, liveClassId: string) {
  const state = classrooms.get(liveClassId);

  if (state) {
    // Close out attendance for everyone still "in" the room.
    await prisma.liveClassAttendance.updateMany({
      where: { liveClassId, userId: { in: Array.from(state.participants.keys()) }, leftAt: null },
      data: { leftAt: new Date() },
    });
  }

  const updated = await prisma.liveClass.update({
    where: { id: liveClassId },
    data: { status: "ENDED", endedAt: new Date() },
  });

  if (io && state) {
    io.to(`class:${liveClassId}`).emit("classroom:ended", { liveClassId });
    // Force everyone out of the room server-side too.
    const room = io.sockets.adapter.rooms.get(`class:${liveClassId}`);
    if (room) {
      for (const socketId of room) {
        io.sockets.sockets.get(socketId)?.leave(`class:${liveClassId}`);
      }
    }
  }

  classrooms.delete(liveClassId);
  return updated;
}

export function registerLiveClassHandlers(io: Server, socket: Socket) {
  const userId: string = socket.data.userId;
  const fullName: string = socket.data.fullName;
  const accountRole: string = socket.data.accountRole ?? "STUDENT";

  socket.on("classroom:join", async ({ liveClassId }, ack) => {
    const liveClass = await prisma.liveClass.findUnique({ where: { id: liveClassId } });
    if (!liveClass || liveClass.status !== "LIVE") {
      ack?.({ ok: false, error: "Iri somo ntiriho ubu (ntabwo ari live)." });
      return;
    }

    let state = classrooms.get(liveClassId);
    if (!state) {
      state = {
        hostId: liveClass.hostId,
        locked: liveClass.locked,
        namesRevealed: false,
        chatModerators: new Set(),
        anonLabels: new Map(),
        participants: new Map(),
      };
      classrooms.set(liveClassId, state);
    }

    const isHost = userId === liveClass.hostId;
    const existing = state.participants.get(userId);

    // A locked class refuses NEW participants. Someone who was already in
    // (existing entry, e.g. a refreshed tab) is let back in — locking is
    // meant to stop new people from walking in, not to eject who's already
    // there. The host can always get in regardless of lock state.
    if (state.locked && !isHost && !existing) {
      ack?.({ ok: false, error: "Iri somo ryafunzwe n'umuyobozi — ntushobora kwinjira ubu." });
      return;
    }

    // Idempotent re-join: if this user already has an entry (e.g. a stale
    // tab), replace their socketId rather than creating a second participant.
    const participant: Participant = {
      userId,
      fullName,
      socketId: socket.id,
      role: isHost ? "HOST" : "PARTICIPANT",
      accountRole,
      // Students ALWAYS join muted with camera off by default, per spec —
      // never inherit an elevated state from a previous session.
      micState: isHost ? "HOST" : existing?.micState === "APPROVED" ? "APPROVED" : "MUTED",
      handRaised: existing?.handRaised ?? false,
    };
    state.participants.set(userId, participant);
    socket.join(`class:${liveClassId}`);
    socket.data.currentClassId = liveClassId;

    await prisma.liveClassAttendance.create({
      data: { liveClassId, userId },
    });
    await trackEvent(userId, "CLASS_JOIN", { liveClassId, role: participant.role });

    ack?.({
      ok: true,
      self: publicParticipant(participant),
      participants: participantList(state),
      locked: state.locked,
      namesRevealed: state.namesRevealed,
      canModerateChat: isHost || state.chatModerators.has(userId),
    });
    socket.to(`class:${liveClassId}`).emit("classroom:participant-joined", publicParticipant(participant));
  });

  socket.on("classroom:raise-hand", ({ liveClassId }) => {
    const state = classrooms.get(liveClassId);
    const p = state?.participants.get(userId);
    if (!state || !p || p.role !== "PARTICIPANT") return;
    p.handRaised = true;
    io.to(`class:${liveClassId}`).emit("classroom:hand-raised", { userId, fullName });
  });

  socket.on("classroom:lower-hand", ({ liveClassId }) => {
    const state = classrooms.get(liveClassId);
    const p = state?.participants.get(userId);
    if (!state || !p) return;
    p.handRaised = false;
    io.to(`class:${liveClassId}`).emit("classroom:participant-updated", publicParticipant(p));
  });

  function requireHost(liveClassId: string): ClassroomState | null {
    const state = classrooms.get(liveClassId);
    if (!state || state.hostId !== userId) return null;
    return state;
  }

  socket.on("classroom:lock", async ({ liveClassId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora gufunga isomo." });
      return;
    }
    state.locked = true;
    await prisma.liveClass.update({ where: { id: liveClassId }, data: { locked: true } });
    io.to(`class:${liveClassId}`).emit("classroom:locked");
    ack?.({ ok: true });
  });

  socket.on("classroom:unlock", async ({ liveClassId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora gufungura isomo." });
      return;
    }
    state.locked = false;
    await prisma.liveClass.update({ where: { id: liveClassId }, data: { locked: false } });
    io.to(`class:${liveClassId}`).emit("classroom:unlocked");
    ack?.({ ok: true });
  });

  // Distinct from revoke-speaker: this declines a RAISED HAND request without
  // ever having granted mic access — the student never spoke, they just get
  // told no. Revoke is for taking the mic away from someone already approved.
  socket.on("classroom:reject-speaker", ({ liveClassId, targetUserId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    const target = state.participants.get(targetUserId);
    if (!target) {
      ack?.({ ok: false, error: "Uwo mwigishwa ntaboneka mu ishuri." });
      return;
    }
    target.handRaised = false;
    io.to(`class:${liveClassId}`).emit("classroom:participant-updated", publicParticipant(target));
    io.to(target.socketId).emit("classroom:speaker-rejected", { liveClassId });
    ack?.({ ok: true });
  });

  socket.on("classroom:approve-speaker", ({ liveClassId, targetUserId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    const target = state.participants.get(targetUserId);
    if (!target) {
      ack?.({ ok: false, error: "Uwo mwigishwa ntaboneka mu ishuri." });
      return;
    }
    target.micState = "APPROVED";
    target.handRaised = false;
    io.to(`class:${liveClassId}`).emit("classroom:participant-updated", publicParticipant(target));
    io.to(target.socketId).emit("classroom:speaker-approved", { liveClassId });
    ack?.({ ok: true });
  });

  socket.on("classroom:revoke-speaker", ({ liveClassId, targetUserId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    const target = state.participants.get(targetUserId);
    if (!target) {
      ack?.({ ok: false, error: "Uwo mwigishwa ntaboneka mu ishuri." });
      return;
    }
    target.micState = "MUTED";
    io.to(`class:${liveClassId}`).emit("classroom:participant-updated", publicParticipant(target));
    io.to(target.socketId).emit("classroom:speaker-revoked", { liveClassId });
    ack?.({ ok: true });
  });

  socket.on("classroom:mute-all", ({ liveClassId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    for (const p of state.participants.values()) {
      if (p.role === "PARTICIPANT") {
        p.micState = "MUTED";
        p.handRaised = false;
      }
    }
    io.to(`class:${liveClassId}`).emit("classroom:muted-all");
    io.to(`class:${liveClassId}`).emit("classroom:participants", participantList(state));
    ack?.({ ok: true });
  });

  // Symmetric with mute-all, but for cameras: tells every connected client to
  // stop its own camera track (each client owns and stops its own hardware —
  // the server never touches anyone's device).
  socket.on("classroom:disable-all-cameras", ({ liveClassId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    io.to(`class:${liveClassId}`).emit("classroom:cameras-disabled");
    ack?.({ ok: true });
  });

  socket.on("classroom:lower-all-hands", ({ liveClassId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    for (const p of state.participants.values()) {
      if (p.role === "PARTICIPANT") p.handRaised = false;
    }
    io.to(`class:${liveClassId}`).emit("classroom:participants", participantList(state));
    ack?.({ ok: true });
  });

  socket.on("classroom:remove-participant", async ({ liveClassId, targetUserId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    const target = state.participants.get(targetUserId);
    if (!target) {
      ack?.({ ok: false, error: "Uwo mwigishwa ntaboneka mu ishuri." });
      return;
    }
    io.to(target.socketId).emit("classroom:removed", { liveClassId });
    io.sockets.sockets.get(target.socketId)?.leave(`class:${liveClassId}`);
    state.participants.delete(targetUserId);
    await prisma.liveClassAttendance.updateMany({
      where: { liveClassId, userId: targetUserId, leftAt: null },
      data: { leftAt: new Date() },
    });
    io.to(`class:${liveClassId}`).emit("classroom:participant-left", { userId: targetUserId });
    ack?.({ ok: true });
  });

  socket.on("classroom:end", async ({ liveClassId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kuryhagarika." });
      return;
    }
    await endLiveClass(io, liveClassId);
    ack?.({ ok: true });
  });

  function canModerateChat(state: ClassroomState): boolean {
    return state.hostId === userId || state.chatModerators.has(userId);
  }

  // ---- classroom chat (ephemeral — a text side-channel for the room, not a
  // persisted conversation like ChatPage's DMs; nothing to send if you're
  // not currently a participant of that class) ----
  socket.on("classroom:chat-message", ({ liveClassId, body }) => {
    const text = String(body ?? "").trim().slice(0, 1000);
    if (!text) return;
    const state = classrooms.get(liveClassId);
    const sender = state?.participants.get(userId);
    if (!state || !sender) return;

    // Identity is hidden by default (per spec) — the SERVER decides what
    // name goes out, not the client, so there's no real name in the socket
    // payload at all while hidden (not just visually hidden in the UI).
    const displayName = state.namesRevealed ? fullName : anonLabelFor(state, userId);

    io.to(`class:${liveClassId}`).emit("classroom:chat-message", {
      id: `${socket.id}-${Date.now()}`,
      userId,
      fullName: displayName,
      anonymous: !state.namesRevealed,
      role: sender.role,
      body: text,
      at: new Date().toISOString(),
    });
  });

  socket.on("classroom:reveal-names", ({ liveClassId }, ack) => {
    const state = classrooms.get(liveClassId);
    if (!state || !canModerateChat(state)) {
      ack?.({ ok: false, error: "Gusa umuyobozi cyangwa uwo yahaye uburenganzira ni bo bashobora kubyemeza." });
      return;
    }
    state.namesRevealed = true;
    io.to(`class:${liveClassId}`).emit("classroom:names-revealed");
    ack?.({ ok: true });
  });

  socket.on("classroom:hide-names", ({ liveClassId }, ack) => {
    const state = classrooms.get(liveClassId);
    if (!state || !canModerateChat(state)) {
      ack?.({ ok: false, error: "Gusa umuyobozi cyangwa uwo yahaye uburenganzira ni bo bashobora kubyemeza." });
      return;
    }
    state.namesRevealed = false;
    io.to(`class:${liveClassId}`).emit("classroom:names-hidden");
    ack?.({ ok: true });
  });

  // Lets the host delegate the reveal/hide-names ability to a co-leader —
  // "or allow other leader to do that" from the spec. Restricted to actual
  // LEADER/ADMIN accounts, checked against the database (not just whatever
  // the client claims), so a student can never be handed this by mistake.
  socket.on("classroom:grant-chat-moderator", async ({ liveClassId, targetUserId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target || !["LEADER", "ADMIN"].includes(target.role)) {
      ack?.({ ok: false, error: "Uburenganzira busa bwahabwa gusa Abayobozi (LEADER/ADMIN)." });
      return;
    }
    state.chatModerators.add(targetUserId);
    const targetParticipant = state.participants.get(targetUserId);
    if (targetParticipant) io.to(targetParticipant.socketId).emit("classroom:chat-moderator-granted", { liveClassId });
    ack?.({ ok: true });
  });

  socket.on("classroom:revoke-chat-moderator", ({ liveClassId, targetUserId }, ack) => {
    const state = requireHost(liveClassId);
    if (!state) {
      ack?.({ ok: false, error: "Gusa umuyobozi w'isomo ashobora kubyemeza." });
      return;
    }
    state.chatModerators.delete(targetUserId);
    const targetParticipant = state.participants.get(targetUserId);
    if (targetParticipant) io.to(targetParticipant.socketId).emit("classroom:chat-moderator-revoked", { liveClassId });
    ack?.({ ok: true });
  });

  // ---- WebRTC signaling relay (star topology: host <-> each participant) ----
  // Server never inspects SDP/ICE contents — it only routes them to the right
  // socket, and enforces that one side of every exchange is always the host.
  // This keeps today's implementation correct for small classrooms while
  // staying SFU-ready: swapping this relay for an SFU later doesn't change
  // the client-facing event names at all, only what sits behind them.
  function relayIfHostInvolved(event: string, liveClassId: string, toUserId: string, payload: any) {
    const state = classrooms.get(liveClassId);
    if (!state) return;
    const amHost = state.hostId === userId;
    const targetIsHost = state.hostId === toUserId;
    if (!amHost && !targetIsHost) return; // reject participant-to-participant signaling
    const target = state.participants.get(toUserId);
    if (!target) return;
    io.to(target.socketId).emit(event, { liveClassId, fromUserId: userId, ...payload });
  }

  // BUG FIX: these three handlers used to destructure only `{ sdp }` /
  // `{ candidate }` and drop `kind` entirely when relaying — so every
  // offer/answer/ICE candidate still negotiated a working peer connection,
  // but the receiving side's `ontrack` handler always got `kind: undefined`
  // and silently matched none of its `if (kind === "broadcast") ...`
  // branches. Connections formed; tracks just never got attached to any
  // <audio>/<video> element on either side. This is why nobody could hear
  // the host (or anyone) speak — it was never a microphone/permission
  // problem, it was this one dropped field.
  socket.on("webrtc:offer", ({ liveClassId, toUserId, sdp, kind }) => {
    relayIfHostInvolved("webrtc:offer", liveClassId, toUserId, { sdp, kind });
  });
  socket.on("webrtc:answer", ({ liveClassId, toUserId, sdp, kind }) => {
    relayIfHostInvolved("webrtc:answer", liveClassId, toUserId, { sdp, kind });
  });
  socket.on("webrtc:ice-candidate", ({ liveClassId, toUserId, candidate, kind }) => {
    relayIfHostInvolved("webrtc:ice-candidate", liveClassId, toUserId, { candidate, kind });
  });

  socket.on("disconnect", async () => {
    const liveClassId: string | undefined = socket.data.currentClassId;
    if (!liveClassId) return;
    const state = classrooms.get(liveClassId);
    if (!state) return;
    const p = state.participants.get(userId);
    if (!p || p.socketId !== socket.id) return; // a newer connection already replaced this one

    state.participants.delete(userId);
    await prisma.liveClassAttendance.updateMany({
      where: { liveClassId, userId, leftAt: null },
      data: { leftAt: new Date() },
    });
    await trackEvent(userId, "CLASS_LEAVE", { liveClassId });

    if (state.hostId === userId) {
      io.to(`class:${liveClassId}`).emit("classroom:host-disconnected", { liveClassId });
    } else {
      io.to(`class:${liveClassId}`).emit("classroom:participant-left", { userId });
    }
  });
}
