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

const VALID_GENDERS = new Set(["MALE", "FEMALE"]);

/**
 * Returns the caller's own-gender room, creating it the very first time
 * anyone of that gender ever asks for it, and adding the caller as a
 * participant if they aren't one yet (lazy, self-healing membership — a
 * user becomes a member the first time they open chat, not via any batch
 * backfill job that has to be kept in sync with registrations/approvals/
 * gender changes). A user with no gender set has no gender room at all.
 */
export const getMyGenderRoom = asyncHandler(async (req: Request, res: Response) => {
  const gender = req.user!.gender;
  if (!gender || !VALID_GENDERS.has(gender)) {
    sendError(res, 422, "Nta gitsina cyagenwe kuri konti yawe — saba ubuyobozi kukibashyiraho.");
    return;
  }

  let room = await prisma.conversation.findUnique({
    where: { kind_genderScope: { kind: "GENDER_ROOM", genderScope: gender } },
  });
  if (!room) {
    // Two people of the same gender opening chat for the very first time,
    // at the exact same moment, could both reach this branch — the unique
    // index on (kind, genderScope) is the real guarantee, not this check;
    // if we lose the race, we just fetch the winner's row instead of
    // crashing the request.
    try {
      room = await prisma.conversation.create({
        data: { isGroup: true, kind: "GENDER_ROOM", genderScope: gender },
      });
    } catch {
      room = await prisma.conversation.findUnique({
        where: { kind_genderScope: { kind: "GENDER_ROOM", genderScope: gender } },
      });
    }
  }
  if (!room) {
    sendError(res, 500, "Habaye ikibazo mu gushaka icyumba cyawe.");
    return;
  }

  await prisma.conversationParticipant.upsert({
    where: { conversationId_userId: { conversationId: room.id, userId: req.user!.id } },
    update: {},
    create: { conversationId: room.id, userId: req.user!.id },
  });

  sendResponse(res, 200, {
    id: room.id,
    gender,
    label: gender === "FEMALE" ? "Icyumba cy'Abagore" : "Icyumba cy'Abagabo",
  });
});

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
  const myParticipations = await prisma.conversationParticipant.findMany({
    where: { userId: req.user!.id },
    select: { conversationId: true, lastReadAt: true, conversation: { select: { kind: true, genderScope: true } } },
  });

  const dmIds = myParticipations.filter((p) => p.conversation.kind !== "GENDER_ROOM").map((p) => p.conversationId);
  const genderRoom = myParticipations.find((p) => p.conversation.kind === "GENDER_ROOM");

  // Full participant+user rows are only ever fetched for 1:1 DMs, where
  // there are exactly two — never for the gender room, which could have
  // hundreds of members and only needs a headcount here, not every name.
  const dmConversations = dmIds.length
    ? await prisma.conversation.findMany({
        where: { id: { in: dmIds } },
        include: {
          participants: { include: { user: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, include: { sender: true } },
        },
      })
    : [];

  const result: Array<{
    id: string;
    isGenderRoom: boolean;
    genderRoomLabel: string | null;
    participantCount: number | undefined;
    otherUser: { id: string; fullName: string; role: string } | null;
    lastMessage: ReturnType<typeof publicMessage> | null;
  }> = dmConversations.map((conv) => {
    const other = conv.participants.find((x) => x.userId !== req.user!.id)?.user;
    const last = conv.messages[0];
    return {
      id: conv.id,
      isGenderRoom: false,
      genderRoomLabel: null,
      participantCount: undefined,
      otherUser: other ? { id: other.id, fullName: other.fullName, role: other.role } : null,
      lastMessage: last ? publicMessage(last) : null,
    };
  });

  if (genderRoom) {
    const [participantCount, lastMessage] = await Promise.all([
      prisma.conversationParticipant.count({ where: { conversationId: genderRoom.conversationId } }),
      prisma.message.findFirst({
        where: { conversationId: genderRoom.conversationId },
        orderBy: { createdAt: "desc" },
        include: { sender: true },
      }),
    ]);
    result.unshift({
      id: genderRoom.conversationId,
      isGenderRoom: true,
      genderRoomLabel: genderRoom.conversation.genderScope === "FEMALE" ? "Icyumba cy'Abagore" : "Icyumba cy'Abagabo",
      participantCount,
      otherUser: null,
      lastMessage: lastMessage ? publicMessage(lastMessage) : null,
    });
  }

  // The gender room is pinned to the top (already unshifted above) — a
  // standing community space, not a conversation that should get buried
  // under whichever 1:1 DM happened to receive the most recent message.
  // Everything after it sorts by recency as before.
  const [pinned, rest] = [result[0]?.isGenderRoom ? [result[0]] : [], result[0]?.isGenderRoom ? result.slice(1) : result];
  rest.sort((a, b) => {
    const at = a.lastMessage?.createdAt ?? 0;
    const bt = b.lastMessage?.createdAt ?? 0;
    return new Date(bt).getTime() - new Date(at).getTime();
  });

  sendResponse(res, 200, [...pinned, ...rest]);
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
