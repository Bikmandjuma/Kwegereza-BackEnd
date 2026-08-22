import { Router } from "express";
import { getPublicStats, recordVisit } from "../controllers/publicStatsController.js";

const router = Router();
router.get("/", getPublicStats);
router.post("/visit", recordVisit);

export default router;
