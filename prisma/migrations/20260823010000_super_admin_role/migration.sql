-- SUPER_ADMIN is a new value for the existing `role` string column — no
-- schema change needed, `role` was always a free-form VARCHAR. This
-- migration only *promotes data*: it upgrades the one specific, known
-- seeded admin account (admin@kwegereza.rw) to SUPER_ADMIN so the new
-- role has at least one real account able to use it immediately, without
-- guessing at or touching any other account in a live database.
--
-- If you're running this against a database where that seed email doesn't
-- exist (e.g. you changed it), promote whichever real admin account should
-- become your Super-Admin by hand:
--   UPDATE `User` SET `role` = 'SUPER_ADMIN' WHERE `email` = 'you@example.com';

UPDATE `User` SET `role` = 'SUPER_ADMIN' WHERE `email` = 'admin@kwegereza.rw' AND `role` = 'ADMIN';
