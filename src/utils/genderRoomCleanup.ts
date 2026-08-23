import { prisma } from "./prisma.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Permanently deletes messages older than 30 days from gender rooms only —
 * not from any 1:1 DM, which is unaffected. A whole-gender broadcast room
 * accumulates messages fast (every active student+leader of that gender
 * shares one room), so this is a real deletion, not a soft one — the spec
 * says "deleted after a month", and letting a members-only community room
 * grow forever is also just bad for storage/privacy.
 */
export async function cleanupExpiredGenderRoomMessages(): Promise<number> {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const rooms = await prisma.conversation.findMany({
    where: { kind: "GENDER_ROOM" },
    select: { id: true },
  });
  if (rooms.length === 0) return 0;

  const result = await prisma.message.deleteMany({
    where: { conversationId: { in: rooms.map((r) => r.id) }, createdAt: { lt: cutoff } },
  });
  return result.count;
}

/** Runs the cleanup once immediately (so a fresh deploy doesn't wait a full
 * day before the first pass) and then on a recurring interval. Deliberately
 * a plain setInterval rather than pulling in a cron dependency — one daily
 * task doesn't need a scheduling library, and this keeps the "no unused
 * dependencies" discipline the rest of the backend already follows. */
export function startGenderRoomCleanupSchedule(): void {
  const RUN_EVERY_MS = 6 * 60 * 60 * 1000; // every 6h — cheap query, keeps expiry reasonably tight without needing exact-to-the-day precision

  const run = () => {
    cleanupExpiredGenderRoomMessages()
      .then((count) => {
        if (count > 0) console.log(`[gender-room-cleanup] deleted ${count} message(s) older than 30 days`);
      })
      .catch((err) => console.error("[gender-room-cleanup] failed:", err));
  };

  run();
  setInterval(run, RUN_EVERY_MS);
}
