import { Router } from "express";
import {
  createLiveClass,
  endLiveClassRoute,
  getLiveClass,
  listActiveLiveClasses,
  listUpcomingLiveClasses,
  startScheduledLiveClass,
} from "../controllers/liveClassController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.get("/active", listActiveLiveClasses); // any active user can see what's live
router.get("/upcoming", listUpcomingLiveClasses); // any active user can see what's scheduled
router.get("/:id", getLiveClass); // backs the shareable link — read-only, any active user
router.post("/", requirePermission("classroom.host"), createLiveClass);
router.post("/:id/start", requirePermission("classroom.host"), startScheduledLiveClass);
router.post("/:id/end", requirePermission("classroom.host"), endLiveClassRoute);

export default router;
