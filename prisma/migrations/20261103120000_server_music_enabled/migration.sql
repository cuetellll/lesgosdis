-- Mahyar Music: per-server music toggle (default open, admin can turn it off)
ALTER TABLE "Server" ADD COLUMN "musicEnabled" BOOLEAN NOT NULL DEFAULT true;
