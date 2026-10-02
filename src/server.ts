import "dotenv/config";
import { createServer } from "http";
import { createApp } from "./app.js";
import { initSocket } from "./realtime/socket.js";
import { initGuestChatSocket } from "./realtime/guestChatSocket.js";
import { prisma } from "./utils/prisma.js";
import { startGenderRoomCleanupSchedule } from "./utils/genderRoomCleanup.js";
import { startClassReminderSchedule } from "./utils/classReminder.js";

const PORT = Number(process.env.PORT) || 4000;
const HOST = "0.0.0.0";

const app = createApp();

const httpServer = createServer(app);

initGuestChatSocket(initSocket(httpServer));

async function start() {
  const server = httpServer.listen(PORT, HOST, () => {
    console.log(`Kwegereza API listening on port ${PORT}`);
    console.log("Socket.IO realtime (chat, presence, typing) live on the same port");
  });

  startGenderRoomCleanupSchedule();
  startClassReminderSchedule();

  async function shutdown(): Promise<void> {
    await prisma.$disconnect();
    server.close(() => {
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});