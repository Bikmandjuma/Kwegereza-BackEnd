import type { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import { verifyToken } from "../utils/jwt.js";
import { prisma } from "../utils/prisma.js";
import { registerLiveClassHandlers } from "./liveClass.js";
import { setIo } from "./ioInstance.js";
import { notifyUser } from "../utils/notify.js";

// userId -> set of live socket ids for that user (supports multiple devices/tabs).
// This is the in-memory presence store. In production this becomes Redis so it
// survives across multiple server instances — the interface stays identical.
const onlineUsers = new Map<string, Set<string>>();

function publicMessage(m: any) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: m.sender?.fullName,
    body: m.deletedAt ? null : m.body,
    deleted: !!m.deletedAt,
    clientMessageId: m.clientMessageId,
    createdAt: m.createdAt,
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
      next();
    } catch {
      next(new Error("unauthenticated"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId: string = socket.data.userId;

    // ---- presence: mark online ----
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    const wasOffline = onlineUsers.get(userId)!.size === 0;
    onlineUsers.get(userId)!.add(socket.id);
    socket.join(`user:${userId}`);

    if (wasOffline) {
      io.emit("presence:update", { userId, online: true });
    }

    registerLiveClassHandlers(io, socket);

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
    socket.on("message:send", async ({ conversationId, clientMessageId, body }, ack) => {
      if (!conversationId || !clientMessageId || !body?.trim()) {
        ack?.({ ok: false, error: "Ubutumwa ntibwuzuye neza." });
        return;
      }

      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) {
        ack?.({ ok: false, error: "Ntabwo uri mu kiganiro." });
        return;
      }

      let created = true;
      let message;
      try {
        message = await prisma.message.create({
          data: { conversationId, senderId: userId, clientMessageId, body: body.trim() },
          include: { sender: true },
        });
      } catch (err: any) {
        // P2002 = unique constraint violation on (senderId, clientMessageId).
        // This is a resubmission (retry, double-click, StrictMode double-fire)
        // of a message we already stored — fetch and return the ORIGINAL row.
        // We do NOT create a second row, and we do NOT broadcast again below.
        if (err.code === "P2002") {
          created = false;
          message = await prisma.message.findUnique({
            where: { senderId_clientMessageId: { senderId: userId, clientMessageId } },
            include: { sender: true },
          });
        } else {
          ack?.({ ok: false, error: "Habaye ikibazo mu kohereza ubutumwa." });
          return;
        }
      }

      const payload = publicMessage(message);
      // Every caller (fresh send or replayed duplicate) gets the same ack.
      ack?.({ ok: true, message: payload, duplicate: !created });

      // The room broadcast happens EXACTLY ONCE per real message — only on
      // the branch that actually inserted a new row. A duplicate submission
      // never causes a second `message:new` event.
      if (created) {
        io.to(`conv:${conversationId}`).emit("message:new", payload);

        // Chat notification intelligence: only push to participants who are
        // NOT currently looking at this conversation (i.e. their socket
        // hasn't joined this room). Someone actively viewing the chat
        // already saw the message arrive in real time — pushing to them too
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
            type: "message",
            title: `Ubutumwa bushya bwa ${socket.data.fullName}`,
            body: body.trim().slice(0, 120),
            url: "/chat",
            eventKey: `message-${message!.id}-${p.userId}`, // one row per message per recipient
          }).catch((err) => console.error("[chat] notify failed:", err));
        }
      }
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
      // disconnect — no manual socket.off() needed here, but if we ever add
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
