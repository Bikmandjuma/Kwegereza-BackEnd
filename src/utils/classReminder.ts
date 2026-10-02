import { prisma } from "./prisma.js";
import { notifyAllActiveUsersExcept } from "./notify.js";

const REMINDER_LEAD_MINUTES = 10;

/**
 * Finds every SCHEDULED class whose start time falls inside a window
 * roughly REMINDER_LEAD_MINUTES from now, and sends the "starting soon"
 * reminder for each. The window is a few minutes wide (not an exact
 * instant) because this runs on a tick, not a per-class timer — a class
 * scheduled for a time that doesn't land EXACTLY on a tick must still
 * be caught by one of the ticks that overlaps its window.
 *
 * Re-running this against the same class multiple times (which WILL
 * happen, by design -- several ticks overlap the same window) does not
 * re-notify anyone: notifyUser's own eventKey uniqueness
 * (`@@unique([userId, eventKey])`) is reused here directly rather than
 * tracking "already reminded" separately. Using the SAME eventKey
 * (`liveclass-reminder-<id>`) every time means the second and
 * subsequent attempts simply hit that constraint and are silently
 * treated as already-sent, exactly like any other duplicate
 * notification dispatch elsewhere in the app.
 */
export async function sendDueClassReminders(): Promise<number> {
  const now = Date.now();
  const windowStart = new Date(now + (REMINDER_LEAD_MINUTES - 1) * 60000);
  const windowEnd = new Date(now + (REMINDER_LEAD_MINUTES + 1) * 60000);

  const dueClasses = await prisma.liveClass.findMany({
    where: { status: "SCHEDULED", scheduledFor: { gte: windowStart, lte: windowEnd } },
  });

  let notified = 0;
  for (const liveClass of dueClasses) {
    const { createdCount } = await notifyAllActiveUsersExcept(liveClass.hostId, (userId) => ({
      userId,
      type: "liveclass.reminder",
      title: "Isomo rigiye gutangira",
      body: `${liveClass.title} ritangira mu minota ${REMINDER_LEAD_MINUTES}.`,
      url: `/live-class/${liveClass.id}`,
      eventKey: `liveclass-reminder-${liveClass.id}`,
    }));
    if (createdCount > 0) notified++;
  }
  return notified;
}

/** Same plain-setInterval pattern as startGenderRoomCleanupSchedule --
 * one daily-ish background task doesn't need a cron dependency, and a
 * reminder window needs a tick MUCH tighter than that cleanup's 6h
 * (every 1 minute, so a 2-minute-wide window is never skipped
 * entirely between ticks). */
export function startClassReminderSchedule(): void {
  const RUN_EVERY_MS = 60 * 1000;

  const run = () => {
    sendDueClassReminders()
      .then((count) => {
        if (count > 0) console.log(`[class-reminder] sent reminder(s) for ${count} class(es)`);
      })
      .catch((err) => console.error("[class-reminder] failed:", err));
  };

  run();
  setInterval(run, RUN_EVERY_MS);
}
