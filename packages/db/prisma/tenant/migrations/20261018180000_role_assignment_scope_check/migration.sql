-- Spec 0018 D4: a role assignment names a resource exactly when its scope isn't the institution. The policy already
-- treats a malformed grant as inert; this stops the data going wrong. Added NOT VALID, then validated: if a bad row
-- exists, validation fails and so does the migration, loudly, rather than skipping it.
ALTER TABLE role_assignment
  ADD CONSTRAINT role_assignment_scope_id_matches_type
  CHECK ((scope_type = 'INSTITUTION') = (scope_id IS NULL)) NOT VALID;
ALTER TABLE role_assignment VALIDATE CONSTRAINT role_assignment_scope_id_matches_type;
