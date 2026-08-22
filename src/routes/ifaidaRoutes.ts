import { Router } from "express";
import {
  createIfaida,
  deleteIfaida,
  getMine,
  getPublished,
  listMine,
  listPublished,
  publishIfaida,
  unpublishIfaida,
  updateIfaida,
} from "../controllers/ifaidaController.js";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/auth.js";

const router = Router();

router.get("/published", listPublished);
router.get("/published/:id", getPublished);

router.use(authenticate);

router.get("/mine", requireAnyPermission("ifaida.create", "ifaida.update"), listMine);
router.get("/mine/:id", requireAnyPermission("ifaida.create", "ifaida.update"), getMine);
router.post("/", requirePermission("ifaida.create"), createIfaida);
router.patch("/:id", requirePermission("ifaida.update"), updateIfaida);
router.delete("/:id", requirePermission("ifaida.delete"), deleteIfaida);
router.post("/:id/publish", requirePermission("ifaida.publish"), publishIfaida);
router.post("/:id/unpublish", requirePermission("ifaida.publish"), unpublishIfaida);

export default router;
