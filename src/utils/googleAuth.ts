import { OAuth2Client } from "google-auth-library";

// A placeholder Client ID is intentionally the default here — the backend
// still starts and every other feature keeps working, but any call to
// verifyGoogleIdToken() will fail loudly (not silently accept anything)
// until a real GOOGLE_CLIENT_ID from Google Cloud Console is set in .env.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID";
const IS_PLACEHOLDER = GOOGLE_CLIENT_ID === "REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID";

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

export interface GoogleProfile {
  googleId: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  emailVerified: boolean;
}

export function isGoogleConfigured(): boolean {
  return !IS_PLACEHOLDER;
}

/** Verifies the ID token's signature, audience, and expiry with Google's own
 * public keys — this is real verification, not just decoding the JWT payload. */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  if (IS_PLACEHOLDER) {
    throw new Error(
      "GOOGLE_CLIENT_ID ntiyashyizweho. Injiza Client ID nyayo muri .env kugira ngo Google Sign-In ikore."
    );
  }

  const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google ntiyatanze amakuru ahagije kuri iyi konti.");
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    fullName: payload.name ?? payload.email.split("@")[0],
    avatarUrl: payload.picture ?? null,
    emailVerified: payload.email_verified ?? false,
  };
}
