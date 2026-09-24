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
import playlistRoutes from "./routes/playlistRoutes.js";
import examRoutes from "./routes/examRoutes.js";
import ifaidaRoutes from "./routes/ifaidaRoutes.js";
import photoInsightRoutes from "./routes/photoInsightRoutes.js";
import guestChatRoutes from "./routes/guestChatRoutes.js";
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

  app.use(
    helmet({
      // Default is "same-origin", which silently blocks the browser from
      // actually rendering any <img>/<audio>/<video>/PDF loaded from this
      // API when the frontend runs on a different origin (e.g. dev server
      // on :5173 vs API on :4000, or separate subdomains in production).
      // This is a DIFFERENT mechanism from CORS CORS governs whether
      // fetch() can read a cross-origin response (so JSON API calls work
      // fine), CORP governs whether the browser will actually use a
      // cross-origin *resource* at all, regardless of CORS. Every book
      // cover, PDF, Dars audio/video file, and teacher photo is public
      // content meant to be freely embedded, not sensitive per-user data,
      // so "cross-origin" is the correct policy here, not a workaround.
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? "https://kwegereza.org", //add frontend url
      credentials: true,
      // Needed specifically for pdf.js's cross-origin Range-request
      // negotiation (see mozilla/pdf.js#4530 and mozilla/pdf.js#10159):
      // - allowedHeaders must explicitly include "Range", since Range is
      //   a non-"simple" request header without this, the browser's
      //   CORS preflight for any ranged request fails outright and pdf.js
      //   can't fetch the file at all.
      // - exposedHeaders must include the three response headers pdf.js
      //   reads to decide whether it can stream the PDF page-by-page —
      //   without these being explicitly exposed, the browser hides them
      //   from JS even though the request itself succeeded, and pdf.js
      //   silently falls back to (much slower) whole-file downloads, or
      //   in some browser/version combinations fails outright.
      allowedHeaders: ["Content-Type", "Authorization", "Range"],
      exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"],
    })
  );
  app.use(morgan("dev"));
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    sendResponse(res, 200, { status: "ok" }, "Kwegereza API is healthy");
  });

  // Uploaded book files / audio / images dev-tier storage. See utils/storage.ts
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
  app.use("/api/photo-insights", photoInsightRoutes);
  app.use("/api/guest-chat", guestChatRoutes);
  app.use("/api/live-classes", liveClassRoutes);
  app.use("/api/push", pushRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/books", bookRoutes);
  app.use("/api/dars", darsRoutes);
  app.use("/api/playlists", playlistRoutes);
  app.use("/api/exams", examRoutes);
  app.use("/api/announcements", announcementRoutes);
  app.use("/api/teachers", teacherRoutes);
  app.use("/api/search", searchRoutes);
  app.use("/api/public-stats", publicStatsRoutes);

  app.use(notFoundHandler);

  // Multer errors (bad file type, file too large) arrive here as regular
  // thrown errors caught before the generic errorHandler so the person
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
