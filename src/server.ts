import "dotenv/config";
import { createServer } from "http";
import { createApp } from "./app.js";
import { initSocket } from "./realtime/socket.js";
import { prisma } from "./utils/prisma.js";

const PORT = Number(process.env.PORT) || 4000;

const app = createApp();
const httpServer = createServer(app);
initSocket(httpServer);

const server = httpServer.listen(PORT, () => {
  console.log(`Kwegereza API listening on port ${PORT}`);
  console.log("Socket.IO realtime (chat, presence, typing) live on the same port");
});

async function shutdown(): Promise<void> {
  await prisma.$disconnect();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);