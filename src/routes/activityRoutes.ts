import { Router } from "express";
import { getMyDashboard, heartbeat, listActivityLogs, recordTime, track } from "../controllers/activityController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);
router.post("/track", track);
router.post("/heartbeat", heartbeat);
router.post("/time", recordTime);
router.get("/logs", requirePermission("activity.logs"), listActivityLogs);
// Every logged-in user, any role their own stats, no permission gate.
router.get("/my-dashboard", getMyDashboard);

export default router;
