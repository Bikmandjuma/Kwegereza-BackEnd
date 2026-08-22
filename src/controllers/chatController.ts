import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";

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

/**
 * Finds an existing 1:1 (non-group) conversation between the two users, or
 * creates one. Kept as a single reusable function so both the REST "start
 * chat" endpoint and any future group-chat logic go through the same path.
 */
async function findOrCreateDirectConversation(userAId: string, userBId: string) {
  const mine = await prisma.conversationParticipant.findMany({
    where: { userId: userAId, conversation: { isGroup: false } },
    select: { conversationId: true },
  });
  const mineIds = mine.map((c) => c.conversationId);

  if (mineIds.length > 0) {
    const shared = await prisma.conversationParticipant.findFirst({
      where: { userId: userBId, conversationId: { in: mineIds } },
    });
    if (shared) {
      return prisma.conversation.findUnique({ where: { id: shared.conversationId } });
    }
  }

  return prisma.conversation.create({
    data: {
      isGroup: false,
      participants: {
        create: [{ userId: userAId }, { userId: userBId }],
      },
    },
  });
}

export const startConversation = asyncHandler(async (req: Request, res: Response) => {
  const { withUserId } = req.body ?? {};
  if (!withUserId) {
    sendError(res, 422, "Uzuza uwo mushaka kuganira.");
    return;
  }
  if (withUserId === req.user!.id) {
    sendError(res, 422, "Ntushobora kwiyandikisha mu kiganiro na wewe ubwawe.");
    return;
  }

  const other = await prisma.user.findUnique({ where: { id: withUserId } });
  if (!other || other.status !== "ACTIVE") {
    sendError(res, 404, "Uyu mukoresha ntaboneka cyangwa ntagifite konti ikora.");
    return;
  }

  const conversation = await findOrCreateDirectConversation(req.user!.id, withUserId);
  sendResponse(res, 200, {
    conversation: {
      id: conversation!.id,
      otherUser: { id: other.id, fullName: other.fullName, role: other.role },
    },
  });
});

export const listConversations = asyncHandler(async (req: Request, res: Response) => {
  const participations = await prisma.conversationParticipant.findMany({
    where: { userId: req.user!.id },
    include: {
      conversation: {
        include: {
          participants: { include: { user: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, include: { sender: true } },
        },
      },
    },
  });

  const result = participations.map((p) => {
    const conv = p.conversation;
    const other = conv.participants.find((x) => x.userId !== req.user!.id)?.user;
    const last = conv.messages[0];
    return {
      id: conv.id,
      otherUser: other ? { id: other.id, fullName: other.fullName, role: other.role } : null,
      lastMessage: last ? publicMessage(last) : null,
      unread: p.lastReadAt ? undefined : undefined, // computed properly once we add counts in a later pass
    };
  });

  result.sort((a, b) => {
    const at = a.lastMessage?.createdAt ?? 0;
    const bt = b.lastMessage?.createdAt ?? 0;
    return new Date(bt).getTime() - new Date(at).getTime();
  });

  sendResponse(res, 200, result);
});

export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: req.user!.id } },
  });
  if (!participant) {
    sendError(res, 403, "Ntabwo uri mu kiganiro.");
    return;
  }

  const limit = Math.min(100, Number(req.query.limit) || 40);
  const messages = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { sender: true },
  });

  sendResponse(res, 200, messages.map(publicMessage));
});

export const markConversationRead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: req.user!.id } },
  });
  if (!participant) {
    sendError(res, 403, "Ntabwo uri mu kiganiro.");
    return;
  }
  await prisma.conversationParticipant.update({
    where: { id: participant.id },
    data: { lastReadAt: new Date() },
  });
  sendResponse(res, 200, null, "Byasomwe.");
});
