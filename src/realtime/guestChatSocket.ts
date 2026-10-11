import type { Server } from "socket.io";
import { prisma } from "../utils/prisma.js";

/**
 * A guest has no account and therefore no JWT, so this can't share the
 * main namespace's `io.use()` middleware (which requires one) without
 * weakening that middleware for every other, already-working connection.
 * A separate namespace keeps this completely isolated: the main chat's
 * authentication is untouched, and a bug here can't affect it either.
 *
 * This namespace is deliberately PUSH-ONLY plus typing indicators --
 * actually creating a message always goes through the REST endpoints
 * (guestChatController.ts's guestSendMessage/staffSendMessage), which
 * then push the result out here via notifyGuestSocket. Two different
 * paths that both create messages would mean two places that could drift
 * out of sync; one path for writes, one for realtime delivery, is safer.
 */
export function initGuestChatSocket(io: Server) {
  const nsp = io.of("/guest-chat");

  nsp.use(async (socket, next) => {
    try {
      const { conversationId, guestToken } = socket.handshake.auth ?? {};
      if (!conversationId || !guestToken) return next(new Error("unauthenticated"));

      const conversation = await prisma.guestConversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.guestToken !== guestToken) {
        return next(new Error("unauthenticated"));
      }
      socket.data.conversationId = conversationId;
      socket.data.guestGender = conversation.guestGender;
      next();
    } catch {
      next(new Error("unauthenticated"));
    }
  });

  nsp.on("connection", (socket) => {
    const conversationId: string = socket.data.conversationId;
    const staffRoom = `guest-chat-staff:${socket.data.guestGender}`; // same per-gender rooms as socket.ts's guestchat:join-staff
    socket.join(`conv:${conversationId}`);

    socket.on("typing:start", () => {
      socket.to(`conv:${conversationId}`).emit("guestchat:typing", { conversationId, who: "GUEST" });
      io.to(staffRoom).emit("guestchat:typing", { conversationId, who: "GUEST" });
    });
    socket.on("typing:stop", () => {
      socket.to(`conv:${conversationId}`).emit("guestchat:stopped-typing", { conversationId, who: "GUEST" });
      io.to(staffRoom).emit("guestchat:stopped-typing", { conversationId, who: "GUEST" });
    });
  });

  return nsp;
}
