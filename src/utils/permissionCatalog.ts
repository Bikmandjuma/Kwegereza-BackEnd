// The canonical, authoritative list of every assignable permission in the
// system taken directly from the spec. Nothing outside this list can ever
// be assigned to a leader (validated in userManagementController), and
// nothing in this list is decorative: every key here is actually checked
// somewhere via requirePermission().

export interface PermissionDef {
  key: string;
  category: string;
  label: string;
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  { key: "student.view", category: "Abanyeshuri", label: "Kureba abanyeshuri" },
  { key: "student.approve", category: "Abanyeshuri", label: "Kwemeza abanyeshuri" },
  { key: "student.block", category: "Abanyeshuri", label: "Guhagarika abanyeshuri" },
  { key: "student.delete", category: "Abanyeshuri", label: "Gusiba konti y'umunyeshuri burundu" },

  { key: "leader.view", category: "Abayobozi", label: "Kureba abayobozi" },
  { key: "leader.create", category: "Abayobozi", label: "Kongeramo umuyobozi" },
  { key: "leader.update", category: "Abayobozi", label: "Guhindura umuyobozi" },
  { key: "leader.block", category: "Abayobozi", label: "Guhagarika umuyobozi" },

  { key: "users.edit_info", category: "Abakoresha", label: "Guhindura amakuru y'umukoresha (amazina, imeli, telefone)" },

  { key: "dars.view", category: "Dars", label: "Kureba Dars" },
  { key: "dars.create", category: "Dars", label: "Kwandika Dars" },
  { key: "dars.update", category: "Dars", label: "Guhindura Dars" },
  { key: "dars.delete", category: "Dars", label: "Gusiba Dars" },
  { key: "dars.publish", category: "Dars", label: "Gutangaza Dars" },

  { key: "ifaida.create", category: "Inyungu mu Nyandiko", label: "Kwandika Inyungu mu Nyandiko" },
  { key: "ifaida.update", category: "Inyungu mu Nyandiko", label: "Guhindura Inyungu mu Nyandiko" },
  { key: "ifaida.delete", category: "Inyungu mu Nyandiko", label: "Gusiba Inyungu mu Nyandiko" },
  { key: "ifaida.publish", category: "Inyungu mu Nyandiko", label: "Gutangaza Inyungu mu Nyandiko" },

  { key: "photoinsight.view", category: "Inyungu mu Mafoto", label: "Kureba Inyungu mu Mafoto" },
  { key: "photoinsight.create", category: "Inyungu mu Mafoto", label: "Kongeramo Inyungu mu Mafoto" },
  { key: "photoinsight.update", category: "Inyungu mu Mafoto", label: "Guhindura Inyungu mu Mafoto" },
  { key: "photoinsight.delete", category: "Inyungu mu Mafoto", label: "Gusiba Inyungu mu Mafoto" },
  { key: "photoinsight.publish", category: "Inyungu mu Mafoto", label: "Gutangaza Inyungu mu Mafoto" },

  { key: "guestchat.respond", category: "Ikiganiro n'Abasuye", label: "Gusubiza abasuye batinjiye" },

  { key: "book.view", category: "Ibitabo", label: "Kureba ibitabo" },
  { key: "book.create", category: "Ibitabo", label: "Kongeramo igitabo" },
  { key: "book.update", category: "Ibitabo", label: "Guhindura igitabo" },
  { key: "book.delete", category: "Ibitabo", label: "Gusiba igitabo" },
  { key: "book.download", category: "Ibitabo", label: "Gukuraho ibitabo" },

  { key: "classroom.view", category: "inyigisho ziri Live", label: "Kureba inyigisho ziri live" },
  { key: "classroom.create", category: "inyigisho ziri Live", label: "Gushyiraho isomo rya live" },
  { key: "classroom.host", category: "inyigisho ziri Live", label: "Gutangira no kuyobora isomo" },
  { key: "classroom.moderate", category: "inyigisho ziri Live", label: "Gucunga abari mu ishuri" },
  { key: "classroom.delete", category: "inyigisho ziri Live", label: "Gusiba isomo riteganyijwe" },

  { key: "analytics.view", category: "Isesengura", label: "Kureba isesengura rusange" },
  { key: "analytics.users", category: "Isesengura", label: "Isesengura ry'abakoresha" },
  { key: "analytics.activity", category: "Isesengura", label: "Isesengura ry'ibikorwa" },
  { key: "activity.logs", category: "Isesengura", label: "Kureba raporo y'ibikorwa byose (Activity Logs)" },
  { key: "analytics.media", category: "Isesengura", label: "Isesengura rya media" },

  { key: "notification.send", category: "Ubutumwa", label: "Kohereza ubutumwa" },
  { key: "notification.manage", category: "Ubutumwa", label: "Gucunga ubutumwa" },

  { key: "announcement.create", category: "Amatangazo", label: "Kwandika itangazo" },
  { key: "announcement.update", category: "Amatangazo", label: "Guhindura itangazo" },
  { key: "announcement.delete", category: "Amatangazo", label: "Gusiba itangazo" },
  { key: "announcement.publish", category: "Amatangazo", label: "Gutangaza itangazo" },

  { key: "teacher.manage", category: "Abarimu", label: "Gucunga abarimu" },

  { key: "exam.create", category: "Ibizamini", label: "shyiraho ikizamini" },
  { key: "exam.update", category: "Ibizamini", label: "Guhindura ikizamini" },
  { key: "exam.delete", category: "Ibizamini", label: "Gusiba ikizamini" },
  { key: "exam.publish", category: "Ibizamini", label: "Gutangaza ikizamini" },
  { key: "exam.results", category: "Ibizamini", label: "Kureba amanota y'abanyeshuri" },
];

export const VALID_PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));

// The User.permissions column is a plain JSON-encoded string column, not a
// validated JSON type at the DB level nothing stops it from ever holding
// something that isn't valid JSON (a hand-edited row, a bug somewhere else
// that wrote a bad value, anything). userManagementController.ts and
// authController.ts both used to call JSON.parse(u.permissions || "[]")
// directly wherever they needed to hand permissions back to the client —
// including on every single login so one malformed row would have meant
// that user (or anyone whose role/permissions got touched near them)
// couldn't log in, or a role assignment would 500, with no way to tell
// from the outside what actually went wrong.
export function parsePermissionsSafely(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function sanitizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const unique = new Set(input.filter((p): p is string => typeof p === "string" && VALID_PERMISSION_KEYS.has(p)));
  return Array.from(unique);
}
