import { Router } from "express";
import {
  createifaida,
  deleteifaida,
  getMine,
  getPublished,
  listMine,
  listPublished,
  publishifaida,
  unpublishifaida,
  updateifaida,
} from "../controllers/ifaidaController.js";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/auth.js";

const router = Router();

router.get("/published", listPublished);
router.get("/published/:id", getPublished);

router.use(authenticate);

router.get("/mine", requireAnyPermission("ifaida.create", "ifaida.update"), listMine);
router.get("/mine/:id", requireAnyPermission("ifaida.create", "ifaida.update"), getMine);
router.post("/", requirePermission("ifaida.create"), createifaida);
router.patch("/:id", requirePermission("ifaida.update"), updateifaida);
router.delete("/:id", requirePermission("ifaida.delete"), deleteifaida);
router.post("/:id/publish", requirePermission("ifaida.publish"), publishifaida);
router.post("/:id/unpublish", requirePermission("ifaida.publish"), unpublishifaida);

export default router;
