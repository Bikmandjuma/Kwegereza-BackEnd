import { Router } from "express";
import {
  closeConversation,
  getConversation,
  guestGetMessages,
  guestSendMessage,
  listConversations,
  staffSendMessage,
  startConversation,
} from "../controllers/guestChatController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

const router = Router();

// Fully public no accounts involved at all. Identity for these three
// is the guestToken itself (see loadGuestConversationOrFail in the
// controller), not a session or JWT.
router.post("/start", startConversation);
router.get("/:id/messages", guestGetMessages);
router.post("/:id/messages", guestSendMessage);

router.use(authenticate);

router.get("/", requirePermission("guestchat.respond"), listConversations);
router.get("/:id/staff-view", requirePermission("guestchat.respond"), getConversation);
router.post("/:id/staff-reply", requirePermission("guestchat.respond"), staffSendMessage);
router.post("/:id/close", requirePermission("guestchat.respond"), closeConversation);

export default router;
