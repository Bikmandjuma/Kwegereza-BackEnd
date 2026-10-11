-- Additive only: two ready-made custom roles, seeded directly so they
-- show up on /leader/uburenganzira immediately rather than requiring a
-- super-admin to click "Shyiraho Uruhare" and create them by hand first.
-- These are NOT special-cased anywhere in code they are ordinary
-- custom roles (isSystem = false), editable and deletable exactly like
-- any role a super-admin creates through the UI. The gender-scoping
-- behavior (a LEADER-tier user only seeing/managing students of their
-- own gender) comes from the PERSON's own gender field, not from the
-- role name these two roles exist so the role name itself makes that
-- intent explicit in the "Abakoresha" table and in this list, for anyone
-- who wants a female-specific or male-specific supervisor role to assign
-- rather than relying on the shared "Umuyobozi" (LEADER) role plus that
-- person's own gender.
INSERT INTO `Role` (`id`, `key`, `label`, `defaultPermissions`, `isSystem`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'LADY_LEADER', 'Lady-Leader', '["student.view","student.approve","student.block"]', false, NOW(3), NOW(3)),
  (UUID(), 'MEN_LEADER', 'Men-Leader', '["student.view","student.approve","student.block"]', false, NOW(3), NOW(3));
