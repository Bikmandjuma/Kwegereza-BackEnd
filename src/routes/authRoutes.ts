import { Router } from "express";
import { changeMyPassword, googleAuth, login, logout, me, register, updateMyProfile } from "../controllers/authController.js";
import { authenticate } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const uploadAvatar = makeMultiFieldUploader({ avatar: "images" });

router.post("/register", register);
router.post("/login", login);
router.post("/google", googleAuth);
router.post("/logout", logout);
router.get("/me", authenticate, me);
router.patch("/me", authenticate, uploadAvatar, updateMyProfile);
router.post("/me/change-password", authenticate, changeMyPassword);

export default router;
