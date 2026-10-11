-- Spec 0012 OB10 (D4): the W3C trace context of the request that wrote the row, written in the same
-- transaction, so the worker's delivery (outbox) or scan (file_object) joins that request's trace.
-- Expand-only and nullable: rows written before this release have no context and process as before.
-- Not sensitive (trace and span ids only); tenant RLS already covers both tables. Bounded in length,
-- but not format-checked: the worker treats a malformed value as "no context" (and logs it once).

ALTER TABLE "outbox_event"
  ADD COLUMN "traceparent" TEXT,
  ADD CONSTRAINT "outbox_event_traceparent_len" CHECK ("traceparent" IS NULL OR length("traceparent") <= 128);

ALTER TABLE "file_object"
  ADD COLUMN "traceparent" TEXT,
  ADD CONSTRAINT "file_object_traceparent_len" CHECK ("traceparent" IS NULL OR length("traceparent") <= 128);
