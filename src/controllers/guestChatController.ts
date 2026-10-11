import crypto from "crypto";
import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { getIo } from "../realtime/ioInstance.js";
import { isOutOfGenderScope } from "../utils/genderScope.js";
import { isAdminTier } from "../utils/permissions.js";
import { isUserOnline } from "../realtime/socket.js";
import { findEligibleStaff, notifyUser } from "../utils/notify.js";

const VALID_GENDERS = new Set(["MALE", "FEMALE"]);

/**
 * A guest's message already reaches every connected staff socket
 * instantly (see notifyStaff below) -- this is for the OTHER case: a
 * male/female leader who's eligible to answer this specific
 * conversation (same gender scope that already gates staffSendMessage)
 * but isn't online at all right now, so that realtime push can't reach
 * them. Without this, a guest's message could sit unanswered with no
 * signal to anyone until a leader happens to open the app.
 *
 * Deliberately uncategorized (no "chat."/etc. prefix -- see
 * categoryForType in notify.ts): a support-coverage gap like this isn't
 * something a leader should be able to silence via notification
 * preferences, the same reasoning that keeps account/security
 * notifications always-on.
 */
async function alertOfflineEligibleStaff(conversation: { id: string; guestGender: string | null }, messageId: string) {
  const eligible = await findEligibleStaff("guestchat.respond", conversation.guestGender);
  if (eligible.length === 0) return;

  const anyoneOnline = eligible.some((u) => isUserOnline(u.id));
  if (anyoneOnline) return;

  await Promise.all(
    eligible.map((u) =>
      notifyUser({
        userId: u.id,
        type: "guestchat.unanswered",
        title: "Umusuye arategereza igisubizo",
        body: "Hari umusuye wohereje ubutumwa ariko nta muyobozi uri kuri interineti ubu.",
        url: "/leader/abasuye-chat",
        eventKey: `guestchat-unanswered-${messageId}-${u.id}`,
      })
    )
  );
}

function publicMessage(m: any) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    senderId: m.senderId,
    senderName: m.sender?.fullName ?? null,
    body: m.body,
    createdAt: m.createdAt,
  };
}

function publicConversation(c: any) {
  return {
    id: c.id,
    guestName: c.guestName,
    guestGender: c.guestGender,
    status: c.status,
    assignedToId: c.assignedToId,
    assignedToName: c.assignedTo?.fullName ?? null,
    lastMessage: c.messages?.[0]?.body ?? null,
    lastMessageAt: c.messages?.[0]?.createdAt ?? c.createdAt,
    createdAt: c.createdAt,
  };
}

// Notifies staff sockets on the MAIN authenticated namespace (see
// socket.ts's "guestchat:*" handlers) that something changed. Purely a
// server->staff push; the guest side has its own separate namespace
// (see realtime/guestChatSocket.ts) since a guest has no JWT to satisfy
// the main namespace's auth middleware.
// Scoped to the ONE gender room matching this guest (see socket.ts's
// guestchat:join-staff for who's actually in each room: a gender-scoped
// leader only their own, admin-tier or no-gender-recorded staff both).
// Previously this pushed to a single shared "guest-chat-staff" room
// every connected staff socket got every guest's name and message
// content in realtime regardless of gender, even though the REST
// endpoints already refused a gender-scoped leader's attempt to open
// or reply to an out-of-scope conversation. Targeting the matching room
// is what actually closes that gap, not just relying on the
// already-correct REST-level checks.
function notifyStaff(event: string, payload: any, guestGender: string | null) {
  if (guestGender !== "MALE" && guestGender !== "FEMALE") return; // malformed/legacy row -- nobody to safely target
  getIo()?.to(`guest-chat-staff:${guestGender}`).emit(event, payload);
}

function notifyGuestSocket(conversationId: string, event: string, payload: any) {
  getIo()?.of("/guest-chat").to(`conv:${conversationId}`).emit(event, payload);
}

/** Starts a brand new conversation for a visitor with no account. No auth
 * at all this is the entire point. Returns a `guestToken` the browser
 * must hold onto (localStorage) to read/post into this conversation again;
 * losing it means losing access to the thread, same as losing a session. */
export const startConversation = asyncHandler(async (req: Request, res: Response) => {
  const { guestName, guestGender } = req.body ?? {};
  if (!String(guestName ?? "").trim()) {
    sendError(res, 422, "Uzuza izina.");
    return;
  }
  if (!VALID_GENDERS.has(String(guestGender))) {
    sendError(res, 422, "Hitamo igitsina.");
    return;
  }

  const conversation = await prisma.guestConversation.create({
    data: {
      guestName: String(guestName).trim(),
      guestGender: String(guestGender),
      guestToken: crypto.randomBytes(24).toString("hex"),
    },
  });

  notifyStaff("guestchat:new-conversation", publicConversation(conversation), conversation.guestGender);
  sendResponse(res, 201, { conversationId: conversation.id, guestToken: conversation.guestToken });
});

async function loadGuestConversationOrFail(id: string, guestToken: string) {
  const conversation = await prisma.guestConversation.findUnique({ where: { id } });
  if (!conversation || conversation.guestToken !== guestToken) return null;
  return conversation;
}

export const guestGetMessages = asyncHandler(async (req: Request, res: Response) => {
  const guestToken = String(req.query.guestToken ?? "");
  const conversation = await loadGuestConversationOrFail(req.params.id, guestToken);
  if (!conversation) {
    sendError(res, 404, "Ikiganiro ntikiboneka.");
    return;
  }
  const messages = await prisma.guestMessage.findMany({
    where: { conversationId: conversation.id },
    include: { sender: true },
    orderBy: { createdAt: "asc" },
  });
  sendResponse(res, 200, { conversation: publicConversation(conversation), messages: messages.map(publicMessage) });
});

export const guestSendMessage = asyncHandler(async (req: Request, res: Response) => {
  const { guestToken, body } = req.body ?? {};
  const conversation = await loadGuestConversationOrFail(req.params.id, String(guestToken ?? ""));
  if (!conversation) {
    sendError(res, 404, "Ikiganiro ntikiboneka.");
    return;
  }
  if (!String(body ?? "").trim()) {
    sendError(res, 422, "Andika ubutumwa.");
    return;
  }

  const message = await prisma.guestMessage.create({
    data: { conversationId: conversation.id, senderType: "GUEST", body: String(body).trim() },
  });
  await prisma.guestConversation.update({ where: { id: conversation.id }, data: { status: "OPEN" } });

  const publicMsg = publicMessage(message);
  notifyStaff("guestchat:new-message", { conversationId: conversation.id, message: publicMsg }, conversation.guestGender);
  // Best-effort: a slow/failed alert must never hold up the guest's own
  // message from being saved and shown back to them.
  alertOfflineEligibleStaff(conversation, message.id).catch((err) =>
    console.error("[guestChatController] alertOfflineEligibleStaff failed:", err)
  );
  sendResponse(res, 201, publicMsg);
});

// ---- staff side (authenticated) ----

/** Gender-scoped exactly like every other supervisor-facing list in this
 * app: ADMIN/SUPER_ADMIN see every open conversation; a gender-scoped
 * LEADER (or custom role) only sees guests of their own gender. */
export const listConversations = asyncHandler(async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "OPEN");
  const where: any = { status };
  if (!isAdminTier(req.user!.role) && req.user!.gender) {
    where.guestGender = req.user!.gender;
  }
  const conversations = await prisma.guestConversation.findMany({
    where,
    include: { assignedTo: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
  });
  sendResponse(res, 200, conversations.map(publicConversation));
});

export const getConversation = asyncHandler(async (req: Request, res: Response) => {
  const conversation = await prisma.guestConversation.findUnique({
    where: { id: req.params.id },
    include: { assignedTo: true },
  });
  if (!conversation) {
    sendError(res, 404, "Ikiganiro ntikiboneka.");
    return;
  }
  if (isOutOfGenderScope(req.user!, { gender: conversation.guestGender })) {
    sendError(res, 403, "Ntushobora kubona iki kiganiro.");
    return;
  }
  const messages = await prisma.guestMessage.findMany({
    where: { conversationId: conversation.id },
    include: { sender: true },
    orderBy: { createdAt: "asc" },
  });
  sendResponse(res, 200, { conversation: publicConversation(conversation), messages: messages.map(publicMessage) });
});

export const staffSendMessage = asyncHandler(async (req: Request, res: Response) => {
  const conversation = await prisma.guestConversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) {
    sendError(res, 404, "Ikiganiro ntikiboneka.");
    return;
  }
  if (isOutOfGenderScope(req.user!, { gender: conversation.guestGender })) {
    sendError(res, 403, "Ntushobora gusubiza iki kiganiro.");
    return;
  }
  const { body } = req.body ?? {};
  if (!String(body ?? "").trim()) {
    sendError(res, 422, "Andika ubutumwa.");
    return;
  }

  const message = await prisma.guestMessage.create({
    data: { conversationId: conversation.id, senderType: "STAFF", senderId: req.user!.id, body: String(body).trim() },
    include: { sender: true },
  });
  // First reply implicitly "claims" the conversation, same spirit as a
  // shared support inbox doesn't block anyone else from also replying.
  if (!conversation.assignedToId) {
    await prisma.guestConversation.update({ where: { id: conversation.id }, data: { assignedToId: req.user!.id } });
  }

  const publicMsg = publicMessage(message);
  notifyGuestSocket(conversation.id, "guestchat:new-message", publicMsg);
  notifyStaff("guestchat:new-message", { conversationId: conversation.id, message: publicMsg }, conversation.guestGender);
  sendResponse(res, 201, publicMsg);
});

export const closeConversation = asyncHandler(async (req: Request, res: Response) => {
  const conversation = await prisma.guestConversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) {
    sendError(res, 404, "Ikiganiro ntikiboneka.");
    return;
  }
  if (isOutOfGenderScope(req.user!, { gender: conversation.guestGender })) {
    sendError(res, 403, "Ntushobora gufunga iki kiganiro.");
    return;
  }
  await prisma.guestConversation.update({ where: { id: conversation.id }, data: { status: "CLOSED" } });
  notifyGuestSocket(conversation.id, "guestchat:closed", {});
  sendResponse(res, 200, null, "Ikiganiro cyafunzwe.");
});
