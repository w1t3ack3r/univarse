-- Spec 0006 E13: a sweep that left unreadable values behind is partial, not done.
ALTER TABLE "key_reencryption" ADD COLUMN "unreadable_remaining" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "key_reencryption" ADD CONSTRAINT "key_reencryption_unreadable_nonnegative" CHECK ("unreadable_remaining" >= 0);
