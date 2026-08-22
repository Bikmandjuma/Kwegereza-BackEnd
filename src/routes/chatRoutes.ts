import { Router } from "express";
import {
  listConversations,
  listMessages,
  markConversationRead,
  startConversation,
} from "../controllers/chatController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.use(authenticate); // any ACTIVE account, not permission-gated — chat is a baseline feature

router.post("/start", startConversation);
router.get("/conversations", listConversations);
router.get("/conversations/:id/messages", listMessages);
router.post("/conversations/:id/read", markConversationRead);

export default router;
