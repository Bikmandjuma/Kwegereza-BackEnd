import { Router } from "express";
import { heartbeat, recordTime, track } from "../controllers/activityController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);
router.post("/track", track);
router.post("/heartbeat", heartbeat);
router.post("/time", recordTime);

export default router;
