import { prisma } from "./prisma.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Sends a real push notification to every mobile device this user has
 * registered an Expo push token from -- the mobile app's equivalent of
 * sendPushToUser (web push) in webPush.ts, called from the same single
 * place (notifyUser in notify.ts) so a feature never has to know or
 * care whether a given user reads notifications on the website, the
 * phone app, or both; both get fired for every user who has a
 * registration on file.
 *
 * Expo's push endpoint needs no authentication/API key for this basic
 * send call (confirmed directly against Expo's own current docs, not
 * assumed) -- the token itself is the only credential. An invalid or
 * uninstalled-app token comes back as a "DeviceNotRegistered" error
 * (Expo's equivalent of web push's 404/410), cleaned up the same way
 * sendPushToUser cleans up a dead browser subscription, so a token
 * that's gone stale doesn't keep silently failing forever.
 */
export async function sendExpoPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<{ sent: number; removed: number }> {
  const tokens = await prisma.expoPushToken.findMany({ where: { userId } });
  if (tokens.length === 0) return { sent: 0, removed: 0 };

  const messages = tokens.map((t) => ({
    to: t.token,
    title: payload.title,
    body: payload.body,
    data: payload.url ? { url: payload.url } : undefined,
    sound: "default",
    // Mirrors the "high"/TTL reasoning in webPush.ts: without this, a
    // phone in Doze mode or battery saver (exactly the state a
    // student's phone is in while they're not actively using this
    // app) is allowed to defer a "normal"-priority push indefinitely.
    priority: "high",
  }));

  let sent = 0;
  let removed = 0;

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Accept-Encoding": "gzip, deflate", "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
    const result: any = await res.json().catch(() => ({}));
    const tickets: any[] = Array.isArray(result?.data) ? result.data : [];
    // Expo's batch response is positional -- ticket i corresponds to
    // message i, with no token/id echoed back in the ticket itself to
    // confirm this independently. This is the standard, documented way
    // to use the batch endpoint (the same assumption expo-server-sdk's
    // own chunking relies on), but it's worth naming as an assumption
    // rather than something independently verified per-ticket.
    await Promise.all(
      tickets.map(async (ticket, i) => {
        if (ticket.status === "ok") {
          sent++;
          return;
        }
        if (ticket.details?.error === "DeviceNotRegistered") {
          await prisma.expoPushToken.delete({ where: { id: tokens[i].id } }).catch(() => {});
          removed++;
        } else {
          console.error("[expoPush] send failed:", ticket.message || ticket);
        }
      })
    );
  } catch (err) {
    console.error("[expoPush] request failed:", err);
  }

  return { sent, removed };
}
