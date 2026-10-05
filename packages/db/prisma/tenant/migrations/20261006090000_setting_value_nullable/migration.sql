-- Spec 0007 ST7: "reset to default" keeps the row (value NULL) and bumps its version, so an ETag is
-- never reused for different content (a delete would restart versions at 1). Expand-only.
ALTER TABLE "setting" ALTER COLUMN "value" DROP NOT NULL;
