import { Router } from "express";
import { heartbeat, track } from "../controllers/activityController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);
router.post("/track", track);
router.post("/heartbeat", heartbeat);

export default router;
