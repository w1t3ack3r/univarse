# Spec 0022: Retiring CI10's static guard

**Status:** **Accepted (2026-10-23)** by the owner, R1–R6 as written. **Implemented** in one PR (below).
**Phase:** 0. A tracked gap in [18](../18-roadmap.md): retiring CI10 now that the database captures every writer.
**Builds on:**

- [spec 0015](0015-cache-isolation.md): CI9 (one path to key destruction) and CI10 (writers of the cache-relevant tables bound to a publisher, a type-aware static guard);
- [spec 0016](0016-platform-invalidation-outbox.md): the database capture that replaced CI10, and its **D3**: CI10 is retired in a separate PR, once the complete replacement has passed CI and merged (#73 and spec 0016's PR B did).

## Why

CI10 forced every write to `tenant`, `tenant_domain` and `tenant_product` into a function bound to a cache-invalidation publisher. It was a static check of about 1 000 lines over the TypeScript program. Since spec 0016, a trigger on each table records the invalidation in the writer's own transaction, for **any** writer: other roles, raw and dynamic SQL, stored functions. A relay publishes it. The guarantee now lives in the database. The static guard only duplicates it, and it makes legitimate code awkward to write.

## Decisions

| # | Decision | Why |
| - | -------- | --- |
| R1 | **Remove CI10:** the writer-binding analysis (`writerViolations`, `analyzeFile`, the relation graph, `sqlWrites`), its reviewed bindings, its fixtures and its tests. | Spec 0016 D3, as accepted. |
| R2 | **Keep what other guards use, in small named modules:**<br>• `apiProgram` and `productionFiles` (`testing/program.ts`), used by the writer-bound guard, CI9 and the policy guard;<br>• `lexSql` and `boundParameterOf` (`testing/sql-lexer.ts`), used by spec 0017's session-SQL guard, moved unchanged.<br>`productionFiles` now leaves out any guard's `__<name>_fixtures__` directory. | Removing CI10 must not weaken the guards that shared its code. |
| R3 | **Keep CI9,** in its own spec (`shared/crypto/key-destruction-path.spec.ts`). | D3: the trigger doesn't replace it. |
| R4 | **Keep the in-code publishes** (the fast path, spec 0016 D2) and their runtime tests. | They prove behaviour, not code shape. |
| R5 | **What proves the guarantee now,** all already in CI:<br>• the capture tests (IO1–IO6, IO14, IO16, IO17);<br>• **IO3:** changes made without the API code reach both instances within 2 s: the app role, the migrator, a stored function, dynamic SQL, a type that lies;<br>• **`pnpm rls:check`'s gate (IO15):** it fails if a trigger is disabled, not `ENABLE ALWAYS`, or dropped. It runs in CI and in every deploy's migrate job. | Nothing CI10 guarded is left unproven. A migration that removes or disables a trigger fails CI and the deploy. |
| R6 | **Mutation-checked:** what moved still bites, and what replaced CI10 already fails on its own mutations (IO15's test disables, downgrades and drops a trigger). | Proves the replacement catches what CI10 caught. |

## Implementation notes

- **Removed:** `apps/api/src/testing/cache-writer-guard.ts` and `apps/api/src/shared/infra/cache-writers.spec.ts`, with CI10's fixtures and bindings.
- **Moved:**
  - `testing/program.ts` (`API_DIR`, `SRC`, `apiProgram`, `productionFiles`);
  - `testing/sql-lexer.ts` (`lexSql`, `SqlToken`, `boundParameterOf`, unchanged).
- **The writer-bound guard's fixtures** move to `__writer_bound_fixtures__`, so `productionFiles` excludes them by the general rule.
- **The lexer gains direct tests** (`testing/sql-lexer.spec.ts`, 13), since some of its edge cases had been covered only through CI10's raw-SQL fixtures:
  - quoted-identifier boundaries;
  - a line comment ending at LF, CR or CRLF;
  - nested block comments;
  - every literal form decoded;
  - adjacent constants joined, with each piece kept too;
  - and the refused forms (`U&`, a backslash in a standard string, anything unterminated).
- **Mutations caught (3 of 3):**
  - the lexer with a line comment ending at LF only;
  - block comments not nesting;
  - `productionFiles` counting fixtures as production code.
- **Unit tests:** the API's 346 pass.
