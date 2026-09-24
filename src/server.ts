import "dotenv/config";
import { createServer } from "http";
import { createApp } from "./app.js";
import { initSocket } from "./realtime/socket.js";
import { initGuestChatSocket } from "./realtime/guestChatSocket.js";
import { initMediasoupWorkers } from "./realtime/mediasoup/workers.js";
import { prisma } from "./utils/prisma.js";
import { startGenderRoomCleanupSchedule } from "./utils/genderRoomCleanup.js";

const PORT = Number(process.env.PORT) || 4000;
const HOST = "0.0.0.0";

const app = createApp();

const httpServer = createServer(app);

initGuestChatSocket(initSocket(httpServer));

async function start() {
  // Mediasoup workers must exist before any "classroom:join"/"media:*"
  // socket event can be handled do this before accepting traffic.
  await initMediasoupWorkers();

  const server = httpServer.listen(PORT, HOST, () => {
    console.log(`Kwegereza API listening on port ${PORT}`);
    console.log("Socket.IO realtime (chat, presence, typing, live-class media) live on the same port");
  });

  startGenderRoomCleanupSchedule();

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