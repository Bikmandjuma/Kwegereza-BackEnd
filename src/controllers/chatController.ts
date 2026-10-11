import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { isCrossGenderBlocked, genderScopeWhere } from "../utils/genderScope.js";
import { publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";
import { isUserOnline } from "../realtime/socket.js";

function publicMessage(m: any) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: m.sender?.fullName,
    senderRole: m.sender?.role,
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

/** How many messages in this conversation arrived after the caller last
 * read it, and weren't sent by the caller themselves (never count your own
 * messages as "unread"). Used to badge the conversation list. */
async function countUnread(conversationId: string, lastReadAt: Date | null, myUserId: string): Promise<number> {
  return prisma.message.count({
    where: {
      conversationId,
      senderId: { not: myUserId },
      createdAt: { gt: lastReadAt ?? new Date(0) },
    },
  });
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
 * participant if they aren't one yet (lazy, self-healing membership a
 * user becomes a member the first time they open chat, not via any batch
 * backfill job that has to be kept in sync with registrations/approvals/
 * gender changes). A user with no gender set has no gender room at all.
 */
export const getMyGenderRoom = asyncHandler(async (req: Request, res: Response) => {
  const gender = req.user!.gender;
  if (!gender || !VALID_GENDERS.has(gender)) {
    sendError(res, 422, "Nta gitsina cyagenwe kuri konti yawe saba ubuyobozi kukibashyiraho.");
    return;
  }

  let room = await prisma.conversation.findUnique({
    where: { kind_genderScope: { kind: "GENDER_ROOM", genderScope: gender } },
  });
  if (!room) {
    // Two people of the same gender opening chat for the very first time,
    // at the exact same moment, could both reach this branch the unique
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
    // Shown by the frontend as a pinned banner/first entry in the group
    // chat -- not a real Message row (a system notice, not something
    // anyone sent), and it always reflects the CURRENT viewer's gender,
    // which for a gender room is always the room's own genderScope since
    // membership itself is gender-locked.
    description:
      gender === "FEMALE"
        ? "Iyi ni kwegereza group chat y'igitsina gore gusa"
        : "Iyi ni kwegereza group chat y'igitsina gabo gusa",
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

  // Same rule as student management (see genderScope.ts): a non-admin-tier
  // user can't open a 1:1 chat with someone of the other gender. Whole-
  // gender broadcast rooms (getMyGenderRoom above) were already scoped
  // this way from the start; a direct 1:1 DM was the one path that had no
  // gender awareness at all this closes that gap rather than leaving it
  // as a side door around the group-chat segregation.
  if (isCrossGenderBlocked(req.user!, other)) {
    sendError(res, 403, "Ntushobora kuganira n'umukoresha w'igitsina kitandukanye.");
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
  // there are exactly two never for the gender room, which could have
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
    genderRoomDescription?: string;
    participantCount: number | undefined;
    otherUser: { id: string; fullName: string; role: string } | null;
    lastMessage: ReturnType<typeof publicMessage> | null;
    unreadCount: number;
  }> = await Promise.all(
    dmConversations.map(async (conv) => {
      const other = conv.participants.find((x) => x.userId !== req.user!.id)?.user;
      const last = conv.messages[0];
      const mine = myParticipations.find((p) => p.conversationId === conv.id);
      return {
        id: conv.id,
        isGenderRoom: false,
        genderRoomLabel: null,
        participantCount: undefined,
        otherUser: other ? { id: other.id, fullName: other.fullName, role: other.role } : null,
        lastMessage: last ? publicMessage(last) : null,
        unreadCount: await countUnread(conv.id, mine?.lastReadAt ?? null, req.user!.id),
      };
    })
  );

  if (genderRoom) {
    const [participantCount, lastMessage, unreadCount] = await Promise.all([
      prisma.conversationParticipant.count({ where: { conversationId: genderRoom.conversationId } }),
      prisma.message.findFirst({
        where: { conversationId: genderRoom.conversationId },
        orderBy: { createdAt: "desc" },
        include: { sender: true },
      }),
      countUnread(genderRoom.conversationId, genderRoom.lastReadAt, req.user!.id),
    ]);
    const isFemaleRoom = genderRoom.conversation.genderScope === "FEMALE";
    result.unshift({
      id: genderRoom.conversationId,
      isGenderRoom: true,
      genderRoomLabel: isFemaleRoom ? "Icyumba cy'Abagore" : "Icyumba cy'Abagabo",
      genderRoomDescription: isFemaleRoom
        ? "Iyi ni kwegereza group chat y'igitsina gore gusa"
        : "Iyi ni kwegereza group chat y'igitsina gabo gusa",
      participantCount,
      otherUser: null,
      lastMessage: lastMessage ? publicMessage(lastMessage) : null,
      unreadCount,
    });
  }

  // The gender room is pinned to the top (already unshifted above) a
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
  // `before` (a message id already seen by the caller) pages backward
  // in time from there -- scrolling up for older history. Omitted, this
  // is the initial load, which must anchor on the MOST RECENT messages:
  // orderBy asc + take alone (the previous implementation) takes the
  // FIRST `limit` rows of an ascending-by-time result set, which are
  // the OLDEST messages in the conversation, not the newest. For any
  // conversation with more than `limit` messages ever sent, that meant
  // the newest messages -- the ones anyone opening a chat actually
  // wants to see -- were never returned at all, permanently, since
  // nothing paginated forward from there either. Fetching by `desc` +
  // take and reversing afterward is what actually anchors on "most
  // recent", while still handing the frontend messages in the
  // oldest-to-newest order it already expects to render.
  const beforeId = typeof req.query.before === "string" ? req.query.before : null;
  let beforeCreatedAt: Date | null = null;
  if (beforeId) {
    const beforeMessage = await prisma.message.findUnique({ where: { id: beforeId }, select: { createdAt: true, conversationId: true } });
    if (beforeMessage && beforeMessage.conversationId === id) beforeCreatedAt = beforeMessage.createdAt;
  }

  const [messagesDesc, myDeletions] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId: id, ...(beforeCreatedAt ? { createdAt: { lt: beforeCreatedAt } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { sender: true, replyTo: { include: { sender: true } } },
    }),
    prisma.messageDeletion.findMany({ where: { userId: req.user!.id, message: { conversationId: id } }, select: { messageId: true } }),
  ]);
  const messages = messagesDesc.reverse(); // back to oldest-first for display
  // Whether there's STILL older history beyond what was just fetched --
  // lets the frontend show/hide a "load older messages" control instead
  // of guessing from the page being full-sized (which a delete-for-me
  // filter could otherwise make misleading).
  const hasMore = messages.length === limit;

  // "Delete for me" rows are filtered out here, server-side, rather than
  // just hidden client-side -- the whole point is that THIS user's own
  // history of the conversation no longer includes it at all, not merely
  // that it's visually collapsed in one particular client.
  const hiddenIds = new Set(myDeletions.map((d) => d.messageId));
  sendResponse(
    res,
    200,
    messages.filter((m) => !hiddenIds.has(m.id)).map(publicMessage),
    null,
    { hasMore }
  );
});

/**
 * Backs "jump to the original message" when a reply-quote points at a
 * message that isn't in whatever window listMessages/its `before`
 * pagination has loaded on the client right now -- which is routine in
 * any conversation with real history (the replied-to message could be
 * from months earlier). Returns that one message plus `limit` messages
 * immediately before and after it, so the frontend can splice in a
 * whole navigable window around the target rather than just the
 * single message with nothing to scroll through alongside it.
 * Deliberately a distinct endpoint from listMessages's own `before`
 * cursor: that one always pages backward from the client's current
 * oldest-loaded message, which has no way to jump to an arbitrary point
 * in history the client doesn't already have a foothold near.
 */
export const getMessageContext = asyncHandler(async (req: Request, res: Response) => {
  const { id, messageId } = req.params;
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: req.user!.id } },
  });
  if (!participant) {
    sendError(res, 403, "Ntabwo uri mu kiganiro.");
    return;
  }

  const target = await prisma.message.findUnique({ where: { id: messageId } });
  const deletion = await prisma.messageDeletion.findUnique({
    where: { messageId_userId: { messageId, userId: req.user!.id } },
  });
  if (!target || target.conversationId !== id || deletion) {
    sendError(res, 404, "Ubu butumwa ntibukiboneka (bushobora kuba bwarasibwe).");
    return;
  }

  const limit = Math.min(50, Number(req.query.limit) || 20);
  const [before, after, myDeletions] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId: id, createdAt: { lt: target.createdAt } },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { sender: true, replyTo: { include: { sender: true } } },
    }),
    prisma.message.findMany({
      where: { conversationId: id, createdAt: { gt: target.createdAt } },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: { sender: true, replyTo: { include: { sender: true } } },
    }),
    prisma.messageDeletion.findMany({ where: { userId: req.user!.id, message: { conversationId: id } }, select: { messageId: true } }),
  ]);
  const targetFull = await prisma.message.findUnique({
    where: { id: messageId },
    include: { sender: true, replyTo: { include: { sender: true } } },
  });
  if (!targetFull) {
    // Already confirmed to exist just above -- this would only happen
    // via an impossible race (deleted between the two queries), but
    // failing clearly here beats a null slipping into the window below.
    sendError(res, 404, "Ubu butumwa ntibukiboneka (bushobora kuba bwarasibwe).");
    return;
  }
  const hiddenIds = new Set(myDeletions.map((d) => d.messageId));
  const window = [...before.reverse(), targetFull, ...after].filter((m) => !hiddenIds.has(m.id));

  sendResponse(res, 200, {
    messages: window.map(publicMessage),
    hasMoreBefore: before.length === limit,
    hasMoreAfter: after.length === limit,
  });
});

/** Mirrors socket.ts's EDIT_WINDOW_MS exactly -- see that file for why
 * this is enforced here against the database timestamp rather than
 * trusted from the client. Kept as a literal rather than importing from
 * realtime/socket.ts to avoid pulling socket.io's server setup into a
 * plain REST controller for the sake of one constant. */
const EDIT_WINDOW_MS = 10 * 60 * 1000;

export const editMessage = asyncHandler(async (req: Request, res: Response) => {
  const { id: messageId } = req.params;
  const { body } = req.body ?? {};
  if (!body?.trim()) {
    sendError(res, 422, "Uzuza ubutumwa.");
    return;
  }
  const existing = await prisma.message.findUnique({ where: { id: messageId } });
  if (!existing || existing.senderId !== req.user!.id) {
    sendError(res, 403, "Ntushobora guhindura ubu butumwa.");
    return;
  }
  if (existing.deletedAt) {
    sendError(res, 422, "Ubu butumwa bwasibwe.");
    return;
  }
  if (Date.now() - existing.createdAt.getTime() > EDIT_WINDOW_MS) {
    sendError(res, 422, "Igihe cyo guhindura ubu butumwa cyarangiye (iminota 10).");
    return;
  }
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { body: body.trim(), editedAt: new Date() },
    include: { sender: true, replyTo: { include: { sender: true } } },
  });
  sendResponse(res, 200, publicMessage(updated));
});

/**
 * Forward targets: the caller's own gender room plus their existing 1:1
 * DMs (both are genuinely open conversations, the common/likely case),
 * and separately a same-gender user search for starting a brand-new DM
 * on the fly -- gender-scoped the exact same way startConversation
 * already is, so forwarding can never become a side door around that
 * restriction.
 */
export const listForwardTargets = asyncHandler(async (req: Request, res: Response) => {
  const search = String(req.query.search ?? "").trim();

  const myParticipations = await prisma.conversationParticipant.findMany({
    where: { userId: req.user!.id },
    select: { conversationId: true, conversation: { select: { kind: true, genderScope: true } } },
  });
  const dmIds = myParticipations.filter((p) => p.conversation.kind !== "GENDER_ROOM").map((p) => p.conversationId);
  const genderRoomId = myParticipations.find((p) => p.conversation.kind === "GENDER_ROOM")?.conversationId ?? null;

  const dmConversations = dmIds.length
    ? await prisma.conversation.findMany({
        where: { id: { in: dmIds } },
        include: { participants: { include: { user: true } } },
      })
    : [];

  const conversations: Array<{ id: string; label: string; isGenderRoom: boolean }> = [];
  if (genderRoomId) {
    conversations.push({
      id: genderRoomId,
      label: req.user!.gender === "FEMALE" ? "Icyumba cy'Abagore" : "Icyumba cy'Abagabo",
      isGenderRoom: true,
    });
  }
  for (const conv of dmConversations) {
    const other = conv.participants.find((p) => p.userId !== req.user!.id)?.user;
    if (!other) continue;
    if (search && !other.fullName.toLowerCase().includes(search.toLowerCase())) continue;
    conversations.push({ id: conv.id, label: other.fullName, isGenderRoom: false });
  }

  // Same-gender users with no existing DM yet -- forwarding to one of
  // these starts a fresh conversation first (see forwardMessage's
  // frontend flow: it calls startConversation, then forwards into the
  // id that returns).
  const existingDmOtherUserIds = dmConversations
    .map((c) => c.participants.find((p) => p.userId !== req.user!.id)?.userId)
    .filter(Boolean) as string[];

  const users = search
    ? await prisma.user.findMany({
        where: {
          id: { notIn: [req.user!.id, ...existingDmOtherUserIds] },
          status: "ACTIVE",
          fullName: { contains: search },
          ...genderScopeWhere(req.user!),
        },
        select: { id: true, fullName: true, role: true },
        take: 20,
      })
    : [];

  sendResponse(res, 200, { conversations, users });
});

/**
 * Upload only -- this does NOT create a Message row. The frontend
 * uploads first, gets a URL back, then sends that URL through the
 * ordinary message:send socket event (now accepting attachmentUrl/
 * attachmentType/attachmentName alongside body, see socket.ts) so an
 * attachment message goes through the exact same idempotent-send,
 * broadcast, and notification path as any other message rather than a
 * second parallel one.
 */
export const uploadChatAttachment = asyncHandler(async (req: Request, res: Response) => {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const imageFile = files?.image?.[0];
  const documentFile = files?.document?.[0];
  const videoFile = files?.video?.[0];
  const audioFile = files?.audio?.[0];
  const voiceNoteFile = files?.voiceNote?.[0];
  const file = imageFile ?? documentFile ?? videoFile ?? audioFile ?? voiceNoteFile;
  if (!file) {
    sendError(res, 422, "Nta dosiye yoherejwe.");
    return;
  }
  const category = imageFile
    ? "images"
    : documentFile
      ? "chatDocuments"
      : videoFile
        ? "chatVideos"
        : audioFile
          ? "audio"
          : "voiceNotes";
  // Both audioFile and voiceNoteFile report "AUDIO" here -- the
  // distinction that actually matters (compact waveform card vs. plain
  // file player) lives on the Message itself via isVoiceNote, set when
  // the message is sent, not on the upload response.
  const attachmentType = imageFile ? "IMAGE" : documentFile ? "DOCUMENT" : videoFile ? "VIDEO" : "AUDIO";
  try {
    verifySignatureOrThrow(category, file.path);
  } catch (err: any) {
    sendError(res, 422, err.message ?? "Idosiye ntiyemewe.");
    return;
  }
  sendResponse(res, 201, {
    url: publicUrlFor(category, file.filename),
    type: attachmentType,
    name: file.originalname,
    size: file.size,
  });
});

// themeId ONLY now -- a deliberately global, per-user preference. See
// ConversationWallpaper below for the per-conversation background,
// which used to live on this same table (the direct cause of one
// conversation's wallpaper changing another's, since there was only
// ever one row per user).
export const getChatSettings = asyncHandler(async (req: Request, res: Response) => {
  const settings = await prisma.chatSettings.findUnique({ where: { userId: req.user!.id } });
  sendResponse(res, 200, { themeId: settings?.themeId ?? "default" });
});

export const updateChatSettings = asyncHandler(async (req: Request, res: Response) => {
  const { themeId } = req.body ?? {};
  if (themeId === undefined) {
    sendError(res, 422, "themeId irakenewe.");
    return;
  }
  const settings = await prisma.chatSettings.upsert({
    where: { userId: req.user!.id },
    update: { themeId },
    create: { userId: req.user!.id, themeId },
  });
  sendResponse(res, 200, { themeId: settings.themeId });
});

/** Upload-only, same pattern as uploadChatAttachment -- returns a URL,
 * does not itself touch any wallpaper row. The frontend uploads here
 * first (showing the full image in the pinch-zoom-pan cropper), then
 * calls updateConversationWallpaper with the resulting url plus
 * whatever scale/offsetX/offsetY the user settled on, for the specific
 * conversation they had open. */
export const uploadChatWallpaper = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    sendError(res, 422, "Nta ifoto yoherejwe.");
    return;
  }
  try {
    verifySignatureOrThrow("images", file.path);
  } catch (err: any) {
    sendError(res, 422, err.message ?? "Ifoto ntiyemewe.");
    return;
  }
  sendResponse(res, 201, { url: publicUrlFor("images", file.filename) });
});

function publicConversationWallpaper(w: any) {
  return {
    wallpaper: w?.wallpaper ?? null,
    wallpaperImageUrl: w?.wallpaperImageUrl ?? null,
    wallpaperScale: w?.wallpaperScale ?? null,
    wallpaperOffsetX: w?.wallpaperOffsetX ?? null,
    wallpaperOffsetY: w?.wallpaperOffsetY ?? null,
    wallpaperNaturalWidth: w?.wallpaperNaturalWidth ?? null,
    wallpaperNaturalHeight: w?.wallpaperNaturalHeight ?? null,
  };
}

/** Membership is checked explicitly here (not just implied by the
 * conversation route prefix) -- a wallpaper choice is private per-user
 * data tied to a conversation, so anyone requesting it needs to
 * actually belong to that conversation, the same authorization
 * standard every other per-conversation endpoint in this file holds
 * to. */
async function requireConversationMembership(conversationId: string, userId: string) {
  return prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
}

export const getConversationWallpaper = asyncHandler(async (req: Request, res: Response) => {
  const { id: conversationId } = req.params;
  if (!(await requireConversationMembership(conversationId, req.user!.id))) {
    sendError(res, 403, "Ntabwo uri mu kiganiro.");
    return;
  }
  const wallpaper = await prisma.conversationWallpaper.findUnique({
    where: { userId_conversationId: { userId: req.user!.id, conversationId } },
  });
  sendResponse(res, 200, publicConversationWallpaper(wallpaper));
});

export const updateConversationWallpaper = asyncHandler(async (req: Request, res: Response) => {
  const { id: conversationId } = req.params;
  if (!(await requireConversationMembership(conversationId, req.user!.id))) {
    sendError(res, 403, "Ntabwo uri mu kiganiro.");
    return;
  }
  const { wallpaper, wallpaperImageUrl, wallpaperScale, wallpaperOffsetX, wallpaperOffsetY, wallpaperNaturalWidth, wallpaperNaturalHeight } =
    req.body ?? {};
  // Choosing a built-in preset and choosing a custom image are mutually
  // exclusive by nature (the background is one or the other), so
  // picking one explicitly clears the other's fields rather than
  // leaving a stale custom image lingering after switching back to a
  // preset, or vice versa.
  const data: any = {};
  if (wallpaper !== undefined) {
    data.wallpaper = wallpaper;
    data.wallpaperImageUrl = null;
    data.wallpaperScale = null;
    data.wallpaperOffsetX = null;
    data.wallpaperOffsetY = null;
    data.wallpaperNaturalWidth = null;
    data.wallpaperNaturalHeight = null;
  }
  if (wallpaperImageUrl !== undefined) {
    data.wallpaperImageUrl = wallpaperImageUrl;
    data.wallpaper = null;
    data.wallpaperScale = wallpaperScale ?? 1;
    data.wallpaperOffsetX = wallpaperOffsetX ?? 0;
    data.wallpaperOffsetY = wallpaperOffsetY ?? 0;
    data.wallpaperNaturalWidth = wallpaperNaturalWidth ?? null;
    data.wallpaperNaturalHeight = wallpaperNaturalHeight ?? null;
  }
  const row = await prisma.conversationWallpaper.upsert({
    where: { userId_conversationId: { userId: req.user!.id, conversationId } },
    update: data,
    create: { userId: req.user!.id, conversationId, ...data },
  });
  sendResponse(res, 200, publicConversationWallpaper(row));
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

/**
 * Member list for the sidebar's "who's in this room" panel real
 * participants of a real conversation the caller belongs to, not sample
 * data. Non-STUDENT accounts (LEADER, any custom role, ADMIN,
 * SUPER_ADMIN) are returned first and flagged `isLeader`, so the UI can
 * show them as a small pinned "leaders" section the same way the group
 * chat mockup does, with everyone else available on request rather than
 * dumping a full membership list (a gender room can have hundreds of
 * members; nobody needs all of them fetched on every open).
 */
export const listConversationMembers = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: req.user!.id } },
  });
  if (!participant) {
    sendError(res, 403, "Ntabwo uri mu kiganiro.");
    return;
  }

  const limit = Math.min(100, Number(req.query.limit) || 30);
  const rows = await prisma.conversationParticipant.findMany({
    where: { conversationId: id },
    include: { user: true },
    take: limit,
  });

  const members = rows
    .map((r) => ({
      id: r.user.id,
      fullName: r.user.fullName,
      role: r.user.role,
      isLeader: r.user.role !== "STUDENT",
      // Lets the frontend seed a correct initial read-tick (blue vs.
      // grey) the moment a conversation opens or the page reloads,
      // rather than only after a NEW live read-receipt event happens to
      // arrive post-open -- without this, refreshing the page would
      // show every already-read message as unread until the other side
      // reads something else.
      lastReadAt: r.lastReadAt,
      // Same reasoning as lastReadAt just above, for the exact same bug:
      // onlineIds on the frontend only ever grew from LIVE
      // "presence:update" events it heard after this socket connected,
      // with no way to learn who was ALREADY online at that moment.
      // Someone who'd been online the whole time this chat was closed
      // showed as offline until they happened to reconnect while this
      // tab was open -- which could be never, in one sitting. Seeding
      // from the real, current isUserOnline() here is what fixes that.
      online: isUserOnline(r.user.id),
    }))
    // Leaders first (matches the reference design's pinned leader rows),
    // then alphabetical within each group so the order is stable across
    // requests rather than shuffling on every reload.
    .sort((a, b) => (a.isLeader === b.isLeader ? a.fullName.localeCompare(b.fullName) : a.isLeader ? -1 : 1));

  sendResponse(res, 200, members);
});
