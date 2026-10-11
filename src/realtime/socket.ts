import type { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import { verifyToken } from "../utils/jwt.js";
import { prisma } from "../utils/prisma.js";
import { setIo } from "./ioInstance.js";
import { notifyUser } from "../utils/notify.js";
import { isCrossGenderBlocked } from "../utils/genderScope.js";
import { hasPermission, isAdminTier } from "../utils/permissions.js";

// userId -> set of live socket ids for that user (supports multiple devices/tabs).
// This is the in-memory presence store. In production this becomes Redis so it
// survives across multiple server instances the interface stays identical.
const onlineUsers = new Map<string, Set<string>>();

// EDIT_WINDOW_MS mirrors the frontend's own 10-minute edit cutoff, but is
// the one that actually matters: this is checked server-side on every
// edit attempt, not trusted from whatever the client's clock or UI state
// claims. Same constant used in chatController.ts's REST edit endpoint
// so the two paths can never silently disagree about the cutoff.
export const EDIT_WINDOW_MS = 10 * 60 * 1000;

function publicMessage(m: any) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: m.sender?.fullName,
    body: m.deletedAt ? null : m.body,
    deleted: !!m.deletedAt,
    edited: !!m.editedAt,
    isForwarded: !!m.isForwarded,
    clientMessageId: m.clientMessageId,
    createdAt: m.createdAt,
    attachmentUrl: m.attachmentUrl ?? null,
    attachmentType: m.attachmentType ?? null,
    attachmentName: m.attachmentName ?? null,
    attachmentSize: m.attachmentSize ?? null,
    isVoiceNote: Boolean(m.isVoiceNote),
    attachmentDuration: m.attachmentDuration ?? null,
    groupId: m.groupId ?? null,
    replyTo: m.replyTo
      ? {
          id: m.replyTo.id,
          senderId: m.replyTo.senderId,
          senderName: m.replyTo.sender?.fullName,
          body: m.replyTo.deletedAt ? null : m.replyTo.body,
          deleted: !!m.replyTo.deletedAt,
          attachmentType: m.replyTo.deletedAt ? null : m.replyTo.attachmentType ?? null,
        }
      : null,
  };
}

export function initSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
      credentials: true,
    },
  });

  // ---- authentication happens BEFORE the connection is accepted ----
  // Same rule as the HTTP middleware: re-check the DB (status + tokenVersion),
  // never trust the JWT signature alone. A blocked user cannot open a socket.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error("unauthenticated"));

      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });

      if (!user || user.tokenVersion !== payload.tokenVersion || user.status !== "ACTIVE") {
        return next(new Error("unauthenticated"));
      }

      socket.data.userId = user.id;
      socket.data.fullName = user.fullName;
      socket.data.accountRole = user.role;
      socket.data.gender = user.gender;
      next();
    } catch {
      next(new Error("unauthenticated"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId: string = socket.data.userId;
    const fullName: string = socket.data.fullName;
    const accountRole: string = socket.data.accountRole;

    // ---- presence: mark online ----
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    const wasOffline = onlineUsers.get(userId)!.size === 0;
    onlineUsers.get(userId)!.add(socket.id);
    socket.join(`user:${userId}`);

    // A GUEST-role connection is a temporary chat session, not a real
    // account signing in it gets its own "guest joined" announcement
    // (see publicStatsController.ts's recordVisit) rather than being
    // folded into this one, which is meant to read as "a real person on
    // the team just came online", not "someone opened the guest chat box".
    //
    // .except(`user:${userId}`) rather than io.emit(...) otherwise the
    // person who just logged in would see a toast telling THEMSELVES
    // they're online, and so would any of their OTHER already-open tabs
    // or devices (everyone sharing this same user:{id} room). This is
    // meant to announce someone else joining, not echo a login back to
    // the person who just performed it.
    if (wasOffline && accountRole !== "GUEST") {
      socket.broadcast.except(`user:${userId}`).emit("presence:update", { userId, fullName, online: true });
    }

    // Live-class socket handlers moved to their own service (see
    // Kwegereza-LiveClass/) alongside its mediasoup worker/room
    // management -- the frontend connects to that service's own socket
    // server for live-class media, separately from this connection.

    // ---- guest chat: staff-side room join ----
    // Guest conversations themselves live on a separate, unauthenticated
    // namespace (see initGuestChatSocket below) since a guest has no JWT
    // to pass this connection's own auth middleware. Staff, already
    // authenticated right here, just need to join a shared broadcast room
    // to receive "a guest sent something" pushes re-checked against the
    // database on every join attempt, never trusted from the token alone,
    // same discipline as everywhere else permissions are checked in this
    // app (a permission revoked mid-session takes effect immediately).
    socket.on("guestchat:join-staff", async (_payload, ack) => {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !hasPermission(user.role, user.permissions, "guestchat.respond")) {
        ack?.({ ok: false, error: "Ntushobora kubona ibi biganiro." });
        return;
      }
      // Gender-scoped exactly like every other guest-chat surface in this
      // file (isOutOfGenderScope, already enforced on the REST reads/
      // writes): admin-tier or a staff member with no gender recorded
      // joins BOTH gender rooms (same "sees everything" rule
      // isOutOfGenderScope already applies), everyone else joins only
      // their own. This is what the realtime push was missing -- the
      // REST endpoints already refuse a gender-scoped leader's attempt
      // to open or reply to an out-of-scope conversation, but this
      // single shared room still pushed every guest's name and message
      // content to every connected staff socket regardless of gender,
      // which is the actual leak this fixes.
      const joinsBoth = isAdminTier(user.role) || !user.gender;
      if (joinsBoth || user.gender === "MALE") socket.join("guest-chat-staff:MALE");
      if (joinsBoth || user.gender === "FEMALE") socket.join("guest-chat-staff:FEMALE");
      ack?.({ ok: true });
    });

    // Staff typing into a guest conversation pushed to the guest's
    // separate namespace room (see guestChatSocket.ts), not this one.
    socket.on("guestchat:typing", ({ conversationId }) => {
      if (conversationId) io.of("/guest-chat").to(`conv:${conversationId}`).emit("guestchat:typing", { conversationId, who: "STAFF" });
    });
    socket.on("guestchat:stopped-typing", ({ conversationId }) => {
      if (conversationId) io.of("/guest-chat").to(`conv:${conversationId}`).emit("guestchat:stopped-typing", { conversationId, who: "STAFF" });
    });

    // ---- conversation:join ----
    // Client must explicitly join a conversation room before it will receive
    // that conversation's events. Server re-verifies membership every time —
    // never trust the client to only ask to join conversations it belongs to.
    socket.on("conversation:join", async ({ conversationId }, ack) => {
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) {
        ack?.({ ok: false, error: "Ntabwo uri mu kiganiro." });
        return;
      }
      socket.join(`conv:${conversationId}`);
      ack?.({ ok: true });
    });

    // ---- message:send (the idempotent core) ----
    socket.on(
      "message:send",
      async (
        {
          conversationId,
          clientMessageId,
          body,
          replyToId,
          attachmentUrl,
          attachmentType,
          attachmentName,
          attachmentSize,
          groupId,
          isVoiceNote,
          attachmentDuration,
        },
        ack
      ) => {
      // A message needs EITHER real text OR an attachment -- never
      // neither. An attachment-only message (a photo with no caption)
      // sends body as "" from the client; that's valid here as long as
      // attachmentUrl is present, unlike a bare empty text message.
      if (!conversationId || !clientMessageId || (!body?.trim() && !attachmentUrl)) {
        ack?.({ ok: false, error: "Ubutumwa ntibwuzuye neza." });
        return;
      }

      // A reply target must be a real message in THIS SAME conversation --
      // never trusted from the client beyond that. Silently dropped
      // (rather than rejecting the whole send) if it doesn't check out,
      // since by the time this fires the user has already typed a real
      // message; losing the quote context is a much smaller problem than
      // losing the message itself.
      let validReplyToId: string | null = null;
      if (replyToId) {
        const original = await prisma.message.findUnique({ where: { id: replyToId }, select: { conversationId: true } });
        if (original?.conversationId === conversationId) validReplyToId = replyToId;
      }

      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) {
        ack?.({ ok: false, error: "Ntabwo uri mu kiganiro." });
        return;
      }

      // Defense in depth alongside startConversation's check (chatController.ts):
      // that one blocks a NEW cross-gender DM from being opened at all, but a
      // DM created before either side had a gender on file (or before this
      // rule existed) would otherwise stay open forever. Only applies to
      // 1:1 DMs gender rooms are already single-gender by construction.
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { kind: true, participants: { where: { userId: { not: userId } }, select: { user: true } } },
      });
      const otherUser = conversation?.participants[0]?.user;
      const senderIdentity = { role: accountRole, gender: socket.data.gender };
      if (conversation?.kind === "DM" && otherUser && isCrossGenderBlocked(senderIdentity, otherUser)) {
        ack?.({ ok: false, error: "Ntushobora kuganira n'umukoresha w'igitsina kitandukanye." });
        return;
      }

      const trimmedBody = (body ?? "").trim();
      let created = true;
      let message;
      try {
        message = await prisma.message.create({
          data: {
            conversationId,
            senderId: userId,
            clientMessageId,
            body: trimmedBody,
            replyToId: validReplyToId,
            attachmentUrl: attachmentUrl || null,
            attachmentType: attachmentType || null,
            attachmentName: attachmentName || null,
            attachmentSize: attachmentSize || null,
            groupId: groupId || null,
            isVoiceNote: Boolean(isVoiceNote),
            attachmentDuration: attachmentDuration != null ? Number(attachmentDuration) : null,
          },
          include: { sender: true, replyTo: { include: { sender: true } } },
        });
      } catch (err: any) {
        // P2002 = unique constraint violation on (senderId, clientMessageId).
        // This is a resubmission (retry, double-click, StrictMode double-fire)
        // of a message we already stored fetch and return the ORIGINAL row.
        // We do NOT create a second row, and we do NOT broadcast again below.
        if (err.code === "P2002") {
          created = false;
          message = await prisma.message.findUnique({
            where: { senderId_clientMessageId: { senderId: userId, clientMessageId } },
            include: { sender: true, replyTo: { include: { sender: true } } },
          });
        } else {
          ack?.({ ok: false, error: "Habaye ikibazo mu kohereza ubutumwa." });
          return;
        }
      }

      const payload = publicMessage(message);
      // Every caller (fresh send or replayed duplicate) gets the same ack.
      ack?.({ ok: true, message: payload, duplicate: !created });

      // The room broadcast happens EXACTLY ONCE per real message only on
      // the branch that actually inserted a new row. A duplicate submission
      // never causes a second `message:new` event.
      if (created) {
        io.to(`conv:${conversationId}`).emit("message:new", payload);

        // Chat notification intelligence: only push to participants who are
        // NOT currently looking at this conversation (i.e. their socket
        // hasn't joined this room). Someone actively viewing the chat
        // already saw the message arrive in real time pushing to them too
        // would just be spam.
        const participants = await prisma.conversationParticipant.findMany({
          where: { conversationId, userId: { not: userId } },
        });
        const roomSocketIds = io.sockets.adapter.rooms.get(`conv:${conversationId}`) ?? new Set();
        const viewingUserIds = new Set(
          Array.from(roomSocketIds)
            .map((sid) => io.sockets.sockets.get(sid)?.data.userId)
            .filter(Boolean)
        );

        for (const p of participants) {
          if (viewingUserIds.has(p.userId)) continue;
          notifyUser({
            userId: p.userId,
            // Was just "message" before, which never matched the "chat."
            // category prefix in notify.ts -- meaning this silently
            // bypassed the user's own CHAT notification preference and
            // always fired regardless of what they'd chosen. Fixed to
            // actually respect their setting, same as every other
            // category.
            type: "chat.message",
            title: `Ubutumwa bushya bwa ${socket.data.fullName}`,
            body: trimmedBody ? trimmedBody.slice(0, 120) : attachmentType === "IMAGE" ? "📷 Ifoto" : "📎 Inyandiko",
            url: "/chat",
            eventKey: `message-${message!.id}-${p.userId}`, // one row per message per recipient
          }).catch((err) => console.error("[chat] notify failed:", err));
        }
      }
      }
    );

    // ---- message:edit ----
    // Only the sender, and only within EDIT_WINDOW_MS of the ORIGINAL
    // send (createdAt, never editedAt -- re-editing an edit doesn't reset
    // the clock). Re-checked here against the database's own timestamp;
    // a stale client clock or a tampered request can't extend the window.
    socket.on("message:edit", async ({ conversationId, messageId, body }, ack) => {
      if (!conversationId || !messageId || !body?.trim()) {
        ack?.({ ok: false, error: "Ubutumwa ntibwuzuye neza." });
        return;
      }
      const existing = await prisma.message.findUnique({ where: { id: messageId } });
      if (!existing || existing.conversationId !== conversationId || existing.senderId !== userId) {
        ack?.({ ok: false, error: "Ntushobora guhindura ubu butumwa." });
        return;
      }
      if (existing.deletedAt) {
        ack?.({ ok: false, error: "Ubu butumwa bwasibwe." });
        return;
      }
      if (Date.now() - existing.createdAt.getTime() > EDIT_WINDOW_MS) {
        ack?.({ ok: false, error: "Igihe cyo guhindura ubu butumwa cyarangiye (iminota 10)." });
        return;
      }

      const updated = await prisma.message.update({
        where: { id: messageId },
        data: { body: body.trim(), editedAt: new Date() },
        include: { sender: true, replyTo: { include: { sender: true } } },
      });
      const payload = publicMessage(updated);
      ack?.({ ok: true, message: payload });
      io.to(`conv:${conversationId}`).emit("message:edited", payload);
    });

    // ---- message:delete ----
    // mode "EVERYONE": sender-only, sets the existing global deletedAt --
    // the exact same column message:send's publicMessage() already reads,
    // so an everyone-delete is indistinguishable from any other soft
    // delete to every reader of this conversation, present or future.
    // mode "ME": any participant, hides it only from their own device via
    // MessageDeletion -- no broadcast, since nobody else's view changes.
    socket.on("message:delete", async ({ conversationId, messageId, mode }, ack) => {
      if (!conversationId || !messageId || (mode !== "EVERYONE" && mode !== "ME")) {
        ack?.({ ok: false, error: "Ibisabwa ntibyuzuye." });
        return;
      }
      const existing = await prisma.message.findUnique({ where: { id: messageId } });
      if (!existing || existing.conversationId !== conversationId) {
        ack?.({ ok: false, error: "Ubu butumwa ntabwo buboneka." });
        return;
      }

      if (mode === "EVERYONE") {
        if (existing.senderId !== userId) {
          ack?.({ ok: false, error: "Ushobora gusiba ubutumwa bwawe bwonyine kuri bose." });
          return;
        }
        if (!existing.deletedAt) {
          await prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
        }
        ack?.({ ok: true });
        io.to(`conv:${conversationId}`).emit("message:deleted", { messageId, mode: "EVERYONE" });
        return;
      }

      // mode === "ME"
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) {
        ack?.({ ok: false, error: "Ntabwo uri mu kiganiro." });
        return;
      }
      await prisma.messageDeletion.upsert({
        where: { messageId_userId: { messageId, userId } },
        update: {},
        create: { messageId, userId },
      });
      ack?.({ ok: true });
      // Deliberately only acked to the caller's own socket, not broadcast --
      // the whole point of "delete for me" is that no one else's copy of
      // this conversation changes.
    });

    // ---- message:forward ----
    // Creates a genuinely new Message row in the TARGET conversation --
    // never moves or re-links the original. The original must not be
    // deleted and the caller must belong to BOTH conversations (source,
    // to prove they actually received this message, and target, to post
    // into it) -- gender-scope on the target conversation is already
    // enforced by conversation membership itself, since you can't be a
    // participant of a gender room or DM outside your own scope.
    socket.on(
      "message:forward",
      async ({ fromConversationId, toConversationId, messageId, clientMessageId }, ack) => {
        if (!fromConversationId || !toConversationId || !messageId || !clientMessageId) {
          ack?.({ ok: false, error: "Ibisabwa ntibyuzuye." });
          return;
        }
        const [sourceParticipant, targetParticipant, original] = await Promise.all([
          prisma.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId: fromConversationId, userId } },
          }),
          prisma.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId: toConversationId, userId } },
          }),
          prisma.message.findUnique({ where: { id: messageId } }),
        ]);
        if (!sourceParticipant || !targetParticipant) {
          ack?.({ ok: false, error: "Ntabwo uri mu kiganiro." });
          return;
        }
        if (!original || original.conversationId !== fromConversationId || original.deletedAt) {
          ack?.({ ok: false, error: "Ubu butumwa ntibukiboneka." });
          return;
        }

        let created = true;
        let message;
        try {
          message = await prisma.message.create({
            data: {
              conversationId: toConversationId,
              senderId: userId,
              clientMessageId,
              body: original.body,
              isForwarded: true,
              attachmentUrl: original.attachmentUrl,
              attachmentType: original.attachmentType,
              attachmentName: original.attachmentName,
              attachmentSize: original.attachmentSize,
              isVoiceNote: original.isVoiceNote,
              attachmentDuration: original.attachmentDuration,
            },
            include: { sender: true, replyTo: { include: { sender: true } } },
          });
        } catch (err: any) {
          if (err.code === "P2002") {
            created = false;
            message = await prisma.message.findUnique({
              where: { senderId_clientMessageId: { senderId: userId, clientMessageId } },
              include: { sender: true, replyTo: { include: { sender: true } } },
            });
          } else {
            ack?.({ ok: false, error: "Habaye ikibazo mu kohereza ubutumwa." });
            return;
          }
        }
        const payload = publicMessage(message);
        ack?.({ ok: true, message: payload, duplicate: !created });
        if (created) io.to(`conv:${toConversationId}`).emit("message:new", payload);
      }
    );

    // ---- conversation:mark-read (real-time counterpart of the REST
    // endpoint in chatController.ts) ----
    // Broadcasting this is what lets every OTHER open client in the room
    // flip that message's ticks to "read" immediately, instead of only
    // finding out the next time they happen to refetch.
    socket.on("conversation:mark-read", async ({ conversationId }, ack) => {
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) {
        ack?.({ ok: false, error: "Ntabwo uri mu kiganiro." });
        return;
      }
      const lastReadAt = new Date();
      await prisma.conversationParticipant.update({ where: { id: participant.id }, data: { lastReadAt } });
      ack?.({ ok: true });
      socket.to(`conv:${conversationId}`).emit("conversation:read-receipt", { conversationId, userId, lastReadAt });
    });

    // ---- typing indicators: ephemeral, never persisted ----
    socket.on("typing:start", ({ conversationId }) => {
      socket.to(`conv:${conversationId}`).emit("typing:update", {
        conversationId,
        userId,
        fullName: socket.data.fullName,
        typing: true,
      });
    });
    socket.on("typing:stop", ({ conversationId }) => {
      socket.to(`conv:${conversationId}`).emit("typing:update", {
        conversationId,
        userId,
        fullName: socket.data.fullName,
        typing: false,
      });
    });

    // ---- cleanup: every listener registered above is torn down here ----
    socket.on("disconnect", () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          io.emit("presence:update", { userId, online: false });
        }
      }
      // socket.io removes this socket's room memberships automatically on
      // disconnect no manual socket.off() needed here, but if we ever add
      // listeners on OTHER emitters (not `socket` itself) inside this handler,
      // those would need explicit teardown too.
    });
  });

  setIo(io);
  return io;
}

export function isUserOnline(userId: string): boolean {
  return (onlineUsers.get(userId)?.size ?? 0) > 0;
}

export function getOnlineUserCount(): number {
  return onlineUsers.size;
}
