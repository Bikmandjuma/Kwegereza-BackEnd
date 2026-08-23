import { Router } from "express";
import {
  addQuestion,
  createExam,
  deleteExam,
  deleteQuestion,
  getAttemptResult,
  getExamForTaking,
  getExamWithQuestions,
  listAdmin,
  listAttempts,
  listPublished,
  reorderQuestions,
  setExamStatus,
  startAttempt,
  submitAttempt,
  updateExam,
  updateQuestion,
} from "../controllers/examController.js";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);

// Student: browse + take (any active account — exams are a learning feature,
// not gated behind a special permission, same as chat).
router.get("/published", listPublished);
router.get("/:id/take", getExamForTaking);
router.post("/:id/attempts", startAttempt);
router.post("/attempts/:attemptId/submit", submitAttempt);
router.get("/attempts/:attemptId/result", getAttemptResult);

// Admin/leader: CRUD + question builder + results
router.get("/", requireAnyPermission("exam.create", "exam.update", "exam.publish", "exam.results"), listAdmin);
router.post("/", requirePermission("exam.create"), createExam);
router.get("/:id", requireAnyPermission("exam.create", "exam.update", "exam.publish", "exam.results"), getExamWithQuestions);
router.patch("/:id", requirePermission("exam.update"), updateExam);
router.post("/:id/publish", requirePermission("exam.publish"), (req, res, next) => {
  req.params.action = "publish";
  next();
}, setExamStatus);
router.post("/:id/unpublish", requirePermission("exam.publish"), (req, res, next) => {
  req.params.action = "unpublish";
  next();
}, setExamStatus);
router.delete("/:id", requirePermission("exam.delete"), deleteExam);

router.post("/:id/questions", requirePermission("exam.update"), addQuestion);
router.patch("/:id/questions/:questionId", requirePermission("exam.update"), updateQuestion);
router.delete("/:id/questions/:questionId", requirePermission("exam.update"), deleteQuestion);
router.post("/:id/questions/reorder", requirePermission("exam.update"), reorderQuestions);

router.get("/:id/attempts", requirePermission("exam.results"), listAttempts);

export default router;
