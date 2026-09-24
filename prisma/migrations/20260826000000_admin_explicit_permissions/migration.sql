-- Data-only migration, no schema change. Companion to the code change in
-- src/utils/permissions.ts: ADMIN accounts used to bypass every permission
-- check unconditionally (same as SUPER_ADMIN); now only SUPER_ADMIN does,
-- and ADMIN is checked against its `permissions` column like any other
-- role. Without this backfill, every existing ADMIN account would lose
-- access to everything the moment this code ships, since their
-- `permissions` column was never populated (it never needed to be).
--
-- This grants every CURRENT ADMIN the full permission catalog as of this
-- migration i.e. exactly the access they already had so nobody's
-- access silently changes today. A super-admin can go into
-- Abakoresha -> Hindura for any specific admin afterwards and narrow
-- their permissions down from there if desired; this migration only
-- preserves the status quo, it does not lock anything in.
UPDATE `User`
SET `permissions` = '["student.view","student.approve","student.block","leader.view","leader.create","leader.update","leader.block","users.edit_info","dars.view","dars.create","dars.update","dars.delete","dars.publish","ifaida.create","ifaida.update","ifaida.delete","ifaida.publish","book.view","book.create","book.update","book.delete","book.download","classroom.view","classroom.create","classroom.host","classroom.moderate","analytics.view","analytics.users","analytics.activity","activity.logs","analytics.media","notification.send","notification.manage","announcement.create","announcement.update","announcement.delete","announcement.publish","teacher.manage","exam.create","exam.update","exam.delete","exam.publish","exam.results"]'
WHERE `role` = 'ADMIN';
