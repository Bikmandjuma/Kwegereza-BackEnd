import { Router } from "express";
import { getSubscriptionStatus, getVapidKey, subscribe, unsubscribe } from "../controllers/pushController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.get("/vapid-public-key", getVapidKey); // public needed before login isn't typical, but safe to expose
router.post("/subscribe", authenticate, subscribe);
router.post("/unsubscribe", authenticate, unsubscribe);
router.get("/status", authenticate, getSubscriptionStatus);

export default router;
