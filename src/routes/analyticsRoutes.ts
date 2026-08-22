import { Router } from "express";
import { getOverview, getStudentDetail } from "../controllers/analyticsController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);
router.get("/overview", requirePermission("analytics.view"), getOverview);
router.get("/students/:id", requirePermission("analytics.view"), getStudentDetail);

export default router;
