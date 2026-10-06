# 17 — Coding Standards

## 1. TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`. No `any` (use `unknown` + narrowing). `// @ts-expect-error` only with a reason.
- ESM throughout. Node 24 LTS. Target ES2024.
- Formatting: **Prettier** (2 spaces, single quotes, trailing commas, width 100). Linting: **ESLint** flat config at the repo root (`eslint.config.mjs`), run per package by `pnpm lint` and in CI: typescript-eslint strict-type-checked plus the §8 bans that are lint-enforceable (`console.*`, `Math.random`, `$queryRawUnsafe`/`$executeRawUnsafe` in production code). Tests relax non-null assertions and `no-unsafe-*` (untyped response bodies). Import order, unicorn subset, jsx-a11y and security rules are added when the web apps land. Suppress only per line, with a reason: `// eslint-disable-next-line <rule> -- <why>`.
- **Branded types** for IDs and money to prevent mix-ups: `type StudentId = Brand<string, 'StudentId'>`, `type Kobo = Brand<bigint, 'Kobo'>`.
- Prefer `readonly` data, pure functions, discriminated unions for states, and exhaustive `switch` with `assertNever`.
- Dates: never do arithmetic on raw `Date` for calendar logic. Use `date-fns`/`date-fns-tz` with explicit `Africa/Lagos`. Time comes from the injected `Clock`.
- Decimals: `decimal.js` for scores/GPA maths. `bigint` for kobo. **`number` is never used for money.**

## 2. Naming

| Thing | Convention | Example |
|-------|------------|---------|
| Files | kebab-case | `approve-score-sheet.use-case.ts` |
| Classes / types | PascalCase | `ScoreSheet`, `ApproveScoreSheetCommand` |
| Functions / vars | camelCase, verbs for functions | `computeSemesterResult` |
| Constants | SCREAMING_SNAKE for true constants | `MAX_IMPORT_ROWS` |
| Permissions | `module.resource.action` | `results.scoresheet.approve_hod` |
| Error codes | `module.snake_case` | `registration.max_units_exceeded` |
| Events | `module.past_tense` | `results.published` |
| DB | snake_case, singular tables | `course_offering.semester_id` |
| Domain terms | From [00-glossary.md](00-glossary.md) only | `carryover`, not `retake`/`backlog` |

## 3. NestJS module conventions

```
modules/<context>/
├── api/
│   ├── <resource>.controller.ts     # thin: auth decorators, parse → call use case → map response
│   └── dto/                         # re-exports zod contracts, response mappers
├── application/
│   ├── commands/<verb-noun>.use-case.ts
│   ├── queries/<noun>.query.ts
│   └── policies/                    # module-specific authorization helpers
├── domain/
│   ├── <aggregate>.ts               # state + invariants + transitions (no framework imports)
│   ├── <aggregate>.machine.ts       # state machine definition
│   └── events.ts
├── infrastructure/
│   ├── <aggregate>.repository.ts    # Prisma via TenantTx
│   ├── adapters/                    # gateways, providers (implement ports)
│   └── jobs/                        # BullMQ processors
├── <context>.module.ts
└── index.ts                         # PUBLIC surface: services, types, events. Nothing else
```

- **Controllers never touch Prisma.** Use cases never return Prisma objects to controllers.
- **Every route handler has `@Contract(<Module>Ops.<operation>)`** from `packages/contracts/src/api` ([spec 0011](specs/0011-openapi-and-api-client.md)), and parses its body with that operation's own `body`.
  - **Changing a route:** change its operation, then run `pnpm contracts:gen` and commit both generated files. Generation refuses a route without a contract and any schema that converts to `{}`.
  - **In the web app:** call the API only through `@univarse/api-client` (`client`, `serverGet`). `fetch`, `XMLHttpRequest` and `/api/v1` strings are a lint error, except in `lib/server-api.ts` (transport) and `lib/storage-upload.ts` (the presigned POST to storage).
- **One use case = one class with `execute()`**, one transaction boundary, explicit authorization, audit + outbox inside the transaction.
- Use case template:
```ts
@Injectable()
export class ApproveScoreSheetAtHod {
  constructor(private tx: TenantTxRunner, private sheets: ScoreSheetRepository,
              private policy: PolicyService, private audit: AuditWriter, private outbox: Outbox,
              private clock: Clock) {}

  async execute(actor: Actor, cmd: { sheetId: ScoreSheetId; expectedVersion: number; comment?: string }) {
    return this.tx.run(async (tx) => {
      const sheet = await this.sheets.getForUpdate(tx, cmd.sheetId);          // 404 if not visible
      this.policy.assert(actor, 'results.scoresheet.approve_hod', sheet.scope);
      sheet.assertVersion(cmd.expectedVersion);                               // 412
      const event = sheet.approveAtHod(actor.id, cmd.comment, this.clock.now()); // domain enforces SoD + state
      await this.sheets.save(tx, sheet);
      await this.audit.write(tx, actor, 'results.scoresheet.approve_hod', sheet.ref, { comment: cmd.comment });
      await this.outbox.add(tx, event);
      return ScoreSheetView.from(sheet);
    });
  }
}
```

## 4. Errors

- Domain errors are typed classes with stable `code`s (`DomainError('registration.max_units_exceeded', details)`). An exception filter maps them to Problem Details ([06 §4](06-api-guidelines.md)).
- Don't throw strings. Don't catch-and-ignore. When catching, rethrow with context or handle fully.
- Unexpected errors: logged with stack + requestId, reported to Sentry, 500 to the client with a generic message.
- External calls: wrap provider errors in `IntegrationError` with a provider code. Never leak provider responses to clients.

## 5. Dependencies between packages

```
apps/web ─┬─> packages/api-client ─> packages/contracts
          └─> packages/ui
apps/api ─┬─> packages/contracts
          ├─> packages/domain   (pure; depends on contracts types only)
          └─> packages/db
packages/domain ─X─> db, api, any IO   (forbidden)
```
Enforced with dependency-cruiser in CI.

## 6. Comments & documentation

- Code says *what*. Comments say *why* (a regulation reference, a trade-off, a provider quirk). Link rules: `// Rule: docs/04-business-rules.md §5 (carryovers first)`.
- Public functions of `packages/domain` get TSDoc with an example.
- No commented-out code. No TODO without an issue link (`// TODO(#123): …`).

## 7. Testing conventions

- Test files next to code: `*.spec.ts` (unit), `*.int.spec.ts` (integration), `e2e/*.e2e.ts` (Playwright).
- Arrange-Act-Assert. One behaviour per test. Descriptive names: `it('rejects submission when carryovers are not registered first')`.
- No sleeping in tests. Use fake timers/Clock and event waits.

## 8. Things that are banned (lint-enforced where possible)

- Importing the raw tenant `PrismaClient` outside `shared/db`
- `$queryRawUnsafe` / `$executeRawUnsafe`
- `console.*` in app code
- `localStorage` for auth or personal data
- `dangerouslySetInnerHTML` outside `<SafeHtml>`
- `Math.random()` for anything security-related (use `crypto.randomBytes` / `randomUUID`)
- `float`/`number` for money. `Date.now()` / `new Date()` in domain/use cases (use `Clock`)
- Tenant-specific `if` branches (`if (tenant.slug === 'x')`). Use settings/feature flags
- Mock data imported by production code
