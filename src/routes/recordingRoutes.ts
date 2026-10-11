import { Router } from "express";
import {
  getRecordingDownloadUrl,
  listMyRecordings,
  listRecordingsForClass,
} from "../controllers/recordingController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.get("/mine", listMyRecordings);
router.get("/by-class/:liveClassId", listRecordingsForClass);
router.get("/:id/download-url", getRecordingDownloadUrl);

export default router;
