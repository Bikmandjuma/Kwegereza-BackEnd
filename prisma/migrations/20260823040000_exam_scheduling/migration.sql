-- Backs scheduled exams: a share link opened before this time shows a
-- countdown instead of a Start button — enforced both client-side (UX) and
-- server-side in startAttempt (the real guarantee, since a client-side lock
-- alone can always be bypassed by calling the API directly).
ALTER TABLE `Exam` ADD COLUMN `scheduledFor` DATETIME(3) NULL;
