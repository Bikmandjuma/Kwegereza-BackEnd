import { Router } from "express";
import {
  editMessage,
  getChatSettings,
  getConversationWallpaper,
  getMyGenderRoom,
  listConversationMembers,
  listConversations,
  listForwardTargets,
  getMessageContext,
  listMessages,
  markConversationRead,
  startConversation,
  updateChatSettings,
  updateConversationWallpaper,
  uploadChatAttachment,
  uploadChatWallpaper,
} from "../controllers/chatController.js";
import { authenticate } from "../middleware/auth.js";
import { makeMultiFieldUploader, makeUploader } from "../utils/storage.js";

const uploadAttachment = makeMultiFieldUploader({
  image: "images",
  document: "chatDocuments",
  video: "chatVideos",
  audio: "audio",
  voiceNote: "voiceNotes",
});
const uploadWallpaper = makeUploader("images").single("image");

const router = Router();

router.use(authenticate); // any ACTIVE account, not permission-gated chat is a baseline feature

router.get("/gender-room", getMyGenderRoom);
router.post("/start", startConversation);
router.get("/conversations", listConversations);
router.get("/conversations/:id/messages", listMessages);
router.get("/conversations/:id/messages/:messageId/context", getMessageContext);
router.get("/conversations/:id/members", listConversationMembers);
router.post("/conversations/:id/read", markConversationRead);
router.patch("/messages/:id", editMessage);
router.get("/forward-targets", listForwardTargets);
router.get("/settings", getChatSettings);
router.patch("/settings", updateChatSettings);
router.post("/attachments", uploadAttachment, uploadChatAttachment);
router.post("/wallpaper", uploadWallpaper, uploadChatWallpaper);
router.get("/conversations/:id/wallpaper", getConversationWallpaper);
router.patch("/conversations/:id/wallpaper", updateConversationWallpaper);

export default router;
