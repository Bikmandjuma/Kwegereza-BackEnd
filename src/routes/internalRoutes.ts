import { Router } from "express";
import {
  closeAttendanceInternal,
  createAttendanceInternal,
  createLiveClassInternal,
  createRecordingInternal,
  deleteLiveClassInternal,
  getActiveUserEmailsExcept,
  getLiveClassInternal,
  getUserForAuth,
  listLiveClassesInternal,
  notifyAllActiveExcept,
  trackActivity,
  updateLiveClassInternal,
  updateRecordingInternal,
} from "../controllers/internalController.js";
import { requireInternalSecret } from "../middleware/auth.js";

const router = Router();

// Every route on this router requires the shared secret -- there is no
// end-user JWT involved anywhere here, see requireInternalSecret for why.
router.use(requireInternalSecret);

router.get("/users/:id", getUserForAuth);
router.get("/active-user-emails", getActiveUserEmailsExcept);
router.post("/notify-all-active-except", notifyAllActiveExcept);
router.post("/activity/track", trackActivity);

router.post("/live-classes", createLiveClassInternal);
router.get("/live-classes", listLiveClassesInternal);
router.get("/live-classes/:id", getLiveClassInternal);
router.patch("/live-classes/:id", updateLiveClassInternal);
router.delete("/live-classes/:id", deleteLiveClassInternal);

router.post("/live-class-attendance", createAttendanceInternal);
router.patch("/live-class-attendance/close", closeAttendanceInternal);

router.post("/live-class-recordings", createRecordingInternal);
router.patch("/live-class-recordings/:egressId", updateRecordingInternal);

export default router;
