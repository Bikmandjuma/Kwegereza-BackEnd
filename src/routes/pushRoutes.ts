import { Router } from "express";
import {
  getSubscriptionStatus,
  getVapidKey,
  registerExpoToken,
  subscribe,
  unregisterExpoToken,
  unsubscribe,
} from "../controllers/pushController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.get("/vapid-public-key", getVapidKey); // public needed before login isn't typical, but safe to expose
router.post("/subscribe", authenticate, subscribe);
router.post("/unsubscribe", authenticate, unsubscribe);
router.get("/status", authenticate, getSubscriptionStatus);
// Mobile app's equivalent of subscribe/unsubscribe above -- see
// registerExpoToken's own comment in pushController.ts.
router.post("/expo-register", authenticate, registerExpoToken);
router.post("/expo-unregister", authenticate, unregisterExpoToken);

export default router;
