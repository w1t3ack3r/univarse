## Summary
<!-- What changes and why. Link the roadmap item or spec. -->

## Testing
<!-- What ran, and where: unit, integration, E2E; locally and/or in CI. Screenshots for UI. -->

## Checklists
<!-- docs/08 §13 (security) and docs/12 §8 (Definition of Done). -->

## Migration and rollback
<!-- Expand → migrate → contract (CLAUDE.md invariant 9). How to roll back. "None" if none. -->

<!--
Only if the api-contract check reports breaking changes (spec 0011 OA12). Name every broken operation as
METHOD /path, and say how browser tabs still running the previous web app cope. Example:

## API breaking changes
- `PUT /api/v1/settings/{key}`: If-Match is now documented as a required header. The API already enforced it (428 without it), so the documented contract changed, not the runtime behaviour.
Open tabs: the web app already sends If-Match on every settings write, so tabs opened before this release keep working.
-->
