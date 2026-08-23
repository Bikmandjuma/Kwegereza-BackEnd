// The canonical, authoritative list of every assignable permission in the
// system — taken directly from the spec. Nothing outside this list can ever
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

  { key: "leader.view", category: "Abayobozi", label: "Kureba abayobozi" },
  { key: "leader.create", category: "Abayobozi", label: "Kongeramo umuyobozi" },
  { key: "leader.update", category: "Abayobozi", label: "Guhindura umuyobozi" },
  { key: "leader.block", category: "Abayobozi", label: "Guhagarika umuyobozi" },

  { key: "dars.view", category: "Dars", label: "Kureba Dars" },
  { key: "dars.create", category: "Dars", label: "Kwandika Dars" },
  { key: "dars.update", category: "Dars", label: "Guhindura Dars" },
  { key: "dars.delete", category: "Dars", label: "Gusiba Dars" },
  { key: "dars.publish", category: "Dars", label: "Gutangaza Dars" },

  { key: "ifaida.create", category: "Ifaida", label: "Kwandika Ifaida" },
  { key: "ifaida.update", category: "Ifaida", label: "Guhindura Ifaida" },
  { key: "ifaida.delete", category: "Ifaida", label: "Gusiba Ifaida" },
  { key: "ifaida.publish", category: "Ifaida", label: "Gutangaza Ifaida" },

  { key: "book.view", category: "Ibitabo", label: "Kureba ibitabo" },
  { key: "book.create", category: "Ibitabo", label: "Kongeramo igitabo" },
  { key: "book.update", category: "Ibitabo", label: "Guhindura igitabo" },
  { key: "book.delete", category: "Ibitabo", label: "Gusiba igitabo" },
  { key: "book.download", category: "Ibitabo", label: "Gukuraho ibitabo" },

  { key: "classroom.view", category: "Amasomo ya Live", label: "Kureba amasomo ya live" },
  { key: "classroom.create", category: "Amasomo ya Live", label: "Gushyiraho isomo rya live" },
  { key: "classroom.host", category: "Amasomo ya Live", label: "Gutangira no kuyobora isomo" },
  { key: "classroom.moderate", category: "Amasomo ya Live", label: "Gucunga abari mu ishuri" },

  { key: "analytics.view", category: "Isesengura", label: "Kureba isesengura rusange" },
  { key: "analytics.users", category: "Isesengura", label: "Isesengura ry'abakoresha" },
  { key: "analytics.activity", category: "Isesengura", label: "Isesengura ry'ibikorwa" },
  { key: "analytics.media", category: "Isesengura", label: "Isesengura rya media" },

  { key: "notification.send", category: "Ubutumwa", label: "Kohereza ubutumwa" },
  { key: "notification.manage", category: "Ubutumwa", label: "Gucunga ubutumwa" },

  { key: "announcement.create", category: "Amatangazo", label: "Kwandika itangazo" },
  { key: "announcement.update", category: "Amatangazo", label: "Guhindura itangazo" },
  { key: "announcement.delete", category: "Amatangazo", label: "Gusiba itangazo" },
  { key: "announcement.publish", category: "Amatangazo", label: "Gutangaza itangazo" },

  { key: "teacher.manage", category: "Abarimu", label: "Gucunga abarimu" },

  { key: "exam.create", category: "Ibizamini", label: "Kurema ikizamini" },
  { key: "exam.update", category: "Ibizamini", label: "Guhindura ikizamini" },
  { key: "exam.delete", category: "Ibizamini", label: "Gusiba ikizamini" },
  { key: "exam.publish", category: "Ibizamini", label: "Gutangaza ikizamini" },
  { key: "exam.results", category: "Ibizamini", label: "Kureba amanota y'abanyeshuri" },
];

export const VALID_PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));

export function sanitizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const unique = new Set(input.filter((p): p is string => typeof p === "string" && VALID_PERMISSION_KEYS.has(p)));
  return Array.from(unique);
}
