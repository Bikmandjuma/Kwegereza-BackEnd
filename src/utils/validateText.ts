/**
 * Soft cap for "how much can someone type into a bio/description/content
 * field" applies everywhere the frontend shows a live X/5000 countdown
 * (Teacher.bio, Book/Dars/Playlist/Exam.description, ifaida.description/
 * content, Announcement.body). The column itself is TEXT (no realistic
 * DB-level ceiling), so this is a product decision enforced in code, not
 * a storage limit checked here too because a client-side maxLength
 * attribute is trivially bypassed by anyone calling the API directly.
 */
export const MAX_LONG_TEXT = 5000;

/** Returns an error message if `value` exceeds the cap, or null if it's fine. */
export function longTextError(value: string | undefined | null, fieldLabel: string): string | null {
  if (value && value.length > MAX_LONG_TEXT) {
    return `${fieldLabel} ntishobora kurenza inyuguti ${MAX_LONG_TEXT} (ubu ifite ${value.length}).`;
  }
  return null;
}
