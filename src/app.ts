import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/authRoutes.js";
import activityRoutes from "./routes/activityRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import announcementRoutes from "./routes/announcementRoutes.js";
import bookRoutes from "./routes/bookRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import darsRoutes from "./routes/darsRoutes.js";
import examRoutes from "./routes/examRoutes.js";
import ifaidaRoutes from "./routes/ifaidaRoutes.js";
import liveClassRoutes from "./routes/liveClassRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import publicStatsRoutes from "./routes/publicStatsRoutes.js";
import pushRoutes from "./routes/pushRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import studentRoutes from "./routes/studentRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import { sendError, sendResponse } from "./utils/apiResponse.js";
import { UPLOADS_DIR } from "./utils/storage.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? "https://kwegereza-web.up.railway.app",
      credentials: true,
    })
  );
  app.use(morgan("dev"));
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    sendResponse(res, 200, { status: "ok" }, "Kwegereza API is healthy");
  });

  // Uploaded book files / audio / images — dev-tier storage. See utils/storage.ts
  // for what changes when this moves to S3-compatible object storage in production.
  app.use("/uploads", express.static(UPLOADS_DIR));

  app.use("/api/auth", authRoutes);
  app.use("/api/activity", activityRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/students", studentRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/ifaida", ifaidaRoutes);
  app.use("/api/live-classes", liveClassRoutes);
  app.use("/api/push", pushRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/books", bookRoutes);
  app.use("/api/dars", darsRoutes);
  app.use("/api/exams", examRoutes);
  app.use("/api/announcements", announcementRoutes);
  app.use("/api/teachers", teacherRoutes);
  app.use("/api/search", searchRoutes);
  app.use("/api/public-stats", publicStatsRoutes);

  app.use(notFoundHandler);

  // Multer errors (bad file type, file too large) arrive here as regular
  // thrown errors — caught before the generic errorHandler so the person
  // gets a real 422 with a Kinyarwanda message instead of a raw 500.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof multer.MulterError || (err instanceof Error && err.message.includes("ntibwemewe"))) {
      sendError(res, 422, (err as Error).message || "Habaye ikibazo ku idosiye wohereje.");
      return;
    }
    next(err);
  });
  app.use(errorHandler);

  return app;
}
