import { Router } from "express";
import { searchUsers } from "../controllers/userController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);
router.get("/search", searchUsers);

export default router;
