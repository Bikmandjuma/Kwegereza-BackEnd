import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { prisma } from "../utils/prisma.js";
import { endOpenSessions, startSession, trackEvent } from "../utils/activity.js";
import { verifyGoogleIdToken } from "../utils/googleAuth.js";

const STATUS_MESSAGES: Record<string, string> = {
  PENDING: "Konti yawe iri gutegereza kwemezwa n'ubuyobozi.",
  INACTIVE: "Konti yawe ntikiri ingana. Hamagara ubuyobozi bwa Kwegereza niba ukeneye ubufasha.",
  SUSPENDED: "Konti yawe yahagaritswe by'agateganyo. Hamagara ubuyobozi bwa Kwegereza.",
  BLOCKED: "Konti yawe yahagaritswe. Hamagara ubuyobozi bwa Kwegereza niba ukeneye ubufasha.",
  REJECTED: "Ubusabe bwawe bwo kwiyandikisha ntibwemejwe. Hamagara ubuyobozi bwa Kwegereza.",
};

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function publicUser(user: {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  gender: string | null;
  kunia: string | null;
  passwordHash: string | null;
  avatarUrl: string | null;
  role: string;
  status: string;
  permissions: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    gender: user.gender,
    kunia: user.kunia,
    avatarUrl: user.avatarUrl,
    hasPassword: Boolean(user.passwordHash), // lets the frontend hide "change password" for Google-only accounts
    role: user.role,
    status: user.status,
    permissions: JSON.parse(user.permissions || "[]"),
    createdAt: user.createdAt,
  };
}

const VALID_GENDERS = new Set(["MALE", "FEMALE"]);

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { fullName, email, password, phone, gender, kunia } = req.body ?? {};

  if (!fullName || !email || !password) {
    sendError(res, 422, "Uzuza amazina, imeyili, n'ijambo ry'ibanga.");
    return;
  }
  if (String(password).length < 6) {
    sendError(res, 422, "Ijambo ry'ibanga rigomba kuba rifite byibura inyuguti 6.");
    return;
  }
  if (gender && !VALID_GENDERS.has(String(gender))) {
    sendError(res, 422, "Igitsina kigomba kuba MALE cyangwa FEMALE.");
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
  if (existing) {
    sendError(res, 422, "Iyi email isanzwe ifite konti kuri Kwegereza.");
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      fullName,
      email: String(email).toLowerCase(),
      phone: phone ?? null,
      gender: gender ?? null,
      kunia: kunia?.trim() ? String(kunia).trim() : null,
      passwordHash,
      role: "STUDENT",
      status: "PENDING",
    },
  });

  // Registration NEVER grants an active session — status is PENDING until a
  // leader/admin approves. The frontend routes PENDING users to a waiting screen.
  sendResponse(
    res,
    201,
    { user: publicUser(user) },
    "Kwiyandikisha byagenze neza. Konti yawe iri gutegereza kwemezwa n'ubuyobozi."
  );
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    sendError(res, 422, "Uzuza email n'ijambo ry'ibanga.");
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
  if (!user) {
    sendError(res, 401, "Email cyangwa ijambo ry'ibanga sibyo.");
    return;
  }

  if (!user.passwordHash) {
    sendError(res, 401, "Iyi konti yiyandikishije ukoresheje Google. Koresha 'Injira na Google'.");
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    sendError(res, 401, "Email cyangwa ijambo ry'ibanga sibyo.");
    return;
  }

  if (user.status !== "ACTIVE") {
    sendError(res, 403, STATUS_MESSAGES[user.status] ?? "Konti yawe ntiyemerewe kwinjira.");
    return;
  }

  const token = signToken({ sub: user.id, role: user.role, tokenVersion: user.tokenVersion });
  res.cookie("kiu_token", token, COOKIE_OPTIONS);

  await startSession(user.id);
  await trackEvent(user.id, "LOGIN");

  sendResponse(res, 200, { user: publicUser(user), token }, "Kwinjira byagenze neza.");
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  // authenticate middleware has already loaded + validated req.user
  sendResponse(res, 200, { user: publicUser(req.user!) }, null);
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  // Best-effort: logout should always succeed client-side (clear the cookie)
  // even if the token is already invalid/expired. But if we CAN identify the
  // user, close their session properly so platform-time stays accurate.
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const token = bearer ?? req.cookies?.kiu_token ?? null;
  if (token) {
    try {
      const payload = verifyToken(token);
      await endOpenSessions(payload.sub);
      await trackEvent(payload.sub, "LOGOUT");
    } catch {
      // Token invalid/expired — nothing to close, that's fine.
    }
  }

  res.clearCookie("kiu_token");
  sendResponse(res, 200, null, "Wasohotse neza.");
});

/**
 * One endpoint handles both "Iyandikishe ukoresheje Google" (register) and
 * "Injira na Google" (login) — Google gives us a verified email either way,
 * so the branch is: existing googleId -> log in; existing email without a
 * googleId -> link Google to that account; neither -> create a brand-new
 * PENDING account, identical approval flow to a normal registration. Google
 * sign-in is never a backdoor around leader/admin approval.
 */
export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
  const { idToken } = req.body ?? {};
  if (!idToken || typeof idToken !== "string") {
    sendError(res, 422, "Nta idToken ya Google yoherejwe.");
    return;
  }

  let profile;
  try {
    profile = await verifyGoogleIdToken(idToken);
  } catch (err: any) {
    sendError(res, 422, err.message || "Kwemeza Google byanze.");
    return;
  }

  let user = await prisma.user.findUnique({ where: { googleId: profile.googleId } });

  if (!user) {
    const existingByEmail = await prisma.user.findUnique({ where: { email: profile.email } });
    if (existingByEmail) {
      // Same person, previously registered with a password — link the accounts
      // rather than creating a confusing duplicate.
      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: { googleId: profile.googleId, avatarUrl: profile.avatarUrl },
      });
    } else {
      user = await prisma.user.create({
        data: {
          fullName: profile.fullName,
          email: profile.email,
          googleId: profile.googleId,
          avatarUrl: profile.avatarUrl,
          passwordHash: null,
          role: "STUDENT",
          status: "PENDING",
        },
      });
    }
  }

  if (user.status !== "ACTIVE") {
    // Same response shape as a fresh registration/blocked login — the
    // frontend already knows how to route PENDING/BLOCKED/etc. from this.
    sendResponse(
      res,
      user.status === "PENDING" ? 201 : 403,
      { user: publicUser(user) },
      STATUS_MESSAGES[user.status] ?? "Konti yawe iri gutegereza kwemezwa n'ubuyobozi."
    );
    return;
  }

  const token = signToken({ sub: user.id, role: user.role, tokenVersion: user.tokenVersion });
  res.cookie("kiu_token", token, COOKIE_OPTIONS);

  await startSession(user.id);
  await trackEvent(user.id, "LOGIN");

  sendResponse(res, 200, { user: publicUser(user), token }, "Kwinjira na Google byagenze neza.");
});
