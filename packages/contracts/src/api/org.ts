// Spec 0042 (P2-S1): the org tree's contract. Bodies are strict; rules (codes, dates, placements) are the use case's,
// answered as 422 with a stable code, so a client never needs to repeat them to be safe.
import { z } from 'zod';
import { defineOperations, type PathParam } from './operation.js';

const Uuid = z.string().meta({ format: 'uuid' });
const Instant = z.string().meta({ format: 'date-time' });
/** A calendar day, `YYYY-MM-DD`. Whether it's a real day, and not in the future, is the use case's (422). */
// No `format: 'date'`: the response validator knows no such format; the pattern says it.
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).meta({ description: 'A calendar day, YYYY-MM-DD.' });
const Name = z.string().trim().min(1).max(120);
/** Empty clears it. */
const Description = z.string().trim().max(500);
/** As typed: trimmed and upper-cased by the use case; empty means "no code yet" (Q8). */
const CodeInput = z.string().max(40);
const Reason = z.string().trim().min(1).max(500);
const UnitState = z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']);
const TypeKind = z.enum(['ACADEMIC', 'ADMINISTRATIVE', 'RESEARCH']);
const TypeKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

// ─── Requests

export const OrgUnitsQuery = z
  .object({
    asAt: Day.optional().meta({ description: 'The tree as it was on this day (Q6). Today’s tree if left out.' }),
    includeArchived: z.enum(['true', 'false']).optional().meta({ description: 'Archived units too. Left out by default.' }),
    q: z.string().trim().min(1).max(100).optional().meta({ description: 'Units whose name or code contains this.' }),
  })
  .strict();

export const CreateOrgUnitBody = z
  .object({ parentId: Uuid, typeId: Uuid, name: Name, code: CodeInput.nullable().optional(), description: Description.nullable().optional(), effectiveFrom: Day.optional() })
  .strict();

export const UpdateOrgUnitBody = z
  .object({
    name: Name.optional(),
    description: Description.nullable().optional(),
    code: CodeInput.nullable().optional(),
    typeId: Uuid.optional(),
    effectiveFrom: Day.optional(),
    reason: Reason.optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.description !== undefined || b.code !== undefined || b.typeId !== undefined, { message: 'Change at least one thing.' });

export const MoveOrgUnitBody = z.object({ parentId: Uuid, effectiveFrom: Day.optional(), reason: Reason }).strict();
export const OrgUnitStateBody = z.object({ effectiveFrom: Day.optional(), reason: Reason.optional() }).strict();
export const ArchiveOrgUnitBody = z.object({ effectiveFrom: Day.optional(), reason: Reason }).strict();
export const ChangeOrgUnitCodeBody = z.object({ code: CodeInput, effectiveFrom: Day.optional(), reason: Reason }).strict();

export const SaveUnitTypeBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: TypeKind,
    mayContain: z.array(TypeKey).max(100),
    status: z.enum(['ACTIVE', 'ARCHIVED']),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

// ─── Responses (as serialized)

export const OrgUnitRow = z
  .object({
    id: Uuid,
    parentId: Uuid.nullable(),
    /** The root's is null: `ROOT` is internal, never shown (Q4). */
    code: z.string().nullable(),
    /** The root's is the institution's legal name (Q-A1). */
    name: z.string(),
    typeId: Uuid.nullable(),
    state: UnitState,
    /** False when the parent's type no longer may contain this unit's type (Q2: rules never restructure). */
    followsRules: z.boolean(),
  })
  .strict();

export const OrgUnitList = z.object({ data: z.array(OrgUnitRow), asAt: Day.nullable() }).strict();

const TypeRef = z.object({ id: Uuid, key: z.string(), name: z.string(), kind: TypeKind }).strict();

export const OrgUnitView = z
  .object({
    id: Uuid,
    parentId: Uuid.nullable(),
    code: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    type: TypeRef.nullable(),
    state: UnitState,
    codeLocked: z.boolean(),
    followsRules: z.boolean(),
    version: z.number().int(),
    /** From the root down to the parent. Only names and codes. */
    ancestors: z.array(z.object({ id: Uuid, name: z.string(), code: z.string().nullable() }).strict()),
    children: z.object({ open: z.number().int(), archived: z.number().int() }).strict(),
    /** The first and last effective dates in its history. */
    createdOn: Day,
    lastChangedOn: Day,
    /** What the caller may do here (each action is still decided when it's asked for). */
    can: z.object({ manage: z.boolean(), restructure: z.boolean() }).strict(),
  })
  .strict();

export const OrgUnitChangeRow = z
  .object({
    id: Uuid,
    kind: z.enum(['CREATED', 'RENAMED', 'DESCRIBED', 'RETYPED', 'MOVED', 'CODE_CHANGED', 'CODE_CORRECTED', 'DEACTIVATED', 'ARCHIVED', 'REACTIVATED']),
    effectiveFrom: Day,
    recordedAt: Instant,
    code: z.string().nullable(),
    name: z.string(),
    typeId: Uuid.nullable(),
    parentId: Uuid.nullable(),
    state: UnitState,
    reason: z.string().nullable(),
    actor: z.object({ id: Uuid, displayName: z.string() }).strict().nullable(),
  })
  .strict();

export const OrgUnitHistory = z.object({ data: z.array(OrgUnitChangeRow) }).strict();

export const UnitTypeRow = z
  .object({
    id: Uuid,
    key: z.string(),
    name: z.string(),
    kind: TypeKind,
    status: z.enum(['ACTIVE', 'ARCHIVED']),
    sortOrder: z.number().int(),
    /** The keys of the types it may contain. */
    mayContain: z.array(z.string()),
    /** Units of this type, archived ones included. */
    units: z.number().int(),
    version: z.number().int(),
  })
  .strict();

export const UnitTypeList = z.object({ data: z.array(UnitTypeRow), canManage: z.boolean() }).strict();

// ─── Operations

const unitId: PathParam = {
  schema: z.string().meta({ format: 'uuid' }),
  description: 'The unit’s id. A malformed id, an unknown one, or a unit outside your scope is 404.',
  invalid: { status: 404, code: 'resource.not_found' },
};
const typeKey: PathParam = {
  schema: TypeKey,
  description: 'The type’s key (lower-case `snake_case`). A key that isn’t one is 404.',
  invalid: { status: 404, code: 'resource.not_found' },
};

/** Q3, Q7, Q8, Q10: the rules a write can break, as 422 codes. */
const PLACEMENT = ['org.unit.parent_not_active', 'org.unit.type_archived', 'org.unit.type_not_allowed', 'org.unit.too_deep'] as const;
const DATES = ['org.unit.effective_date_invalid', 'org.unit.effective_date_future', 'org.unit.effective_date_out_of_order'] as const;
const CODES = ['org.unit.code_invalid'] as const;

export const OrgOps = defineOperations({
  listOrgUnits: {
    operationId: 'listOrgUnits',
    summary: 'The tree, whole, as one list (or as it was on a day); only the units in your scope',
    tag: 'org',
    query: OrgUnitsQuery,
    success: 200,
    response: OrgUnitList,
    errors: { 422: ['org.unit.effective_date_invalid', 'org.unit.effective_date_future'] },
  },
  getOrgUnit: {
    operationId: 'getOrgUnit',
    summary: 'One unit, with its ETag',
    tag: 'org',
    params: { id: unitId },
    success: 200,
    response: OrgUnitView,
    etag: true,
  },
  getOrgUnitHistory: {
    operationId: 'getOrgUnitHistory',
    summary: 'A unit’s changes, newest first',
    tag: 'org',
    params: { id: unitId },
    success: 200,
    response: OrgUnitHistory,
  },
  createOrgUnit: {
    operationId: 'createOrgUnit',
    summary: 'Add a unit under another (Idempotency-Key required; a replay answers with the same unit)',
    tag: 'org',
    body: CreateOrgUnitBody,
    success: 201,
    response: OrgUnitView,
    etag: true,
    errors: {
      404: ['org.unit.parent_not_found', 'org.unit.type_not_found'],
      409: ['org.unit.code_taken', 'org.unit.key_reused'],
      422: [...PLACEMENT, ...DATES, ...CODES, 'org.unit.limit_reached'],
    },
  },
  updateOrgUnit: {
    operationId: 'updateOrgUnit',
    summary: 'Rename, describe, correct an unlocked code, or retype a unit (If-Match required)',
    tag: 'org',
    params: { id: unitId },
    body: UpdateOrgUnitBody,
    success: 200,
    response: OrgUnitView,
    etag: true,
    ifMatch: true,
    errors: {
      404: ['org.unit.type_not_found'],
      409: ['org.unit.code_taken', 'org.unit.code_locked'],
      422: [...DATES, ...CODES, 'org.unit.root_fixed', 'org.unit.same_type', 'org.unit.type_archived', 'org.unit.kind_change', 'org.unit.type_not_allowed', 'org.unit.children_not_allowed'],
    },
  },
  moveOrgUnit: {
    operationId: 'moveOrgUnit',
    summary: 'Move a unit, with everything under it, to another parent (If-Match, a reason)',
    tag: 'org',
    params: { id: unitId },
    body: MoveOrgUnitBody,
    success: 200,
    response: OrgUnitView,
    etag: true,
    ifMatch: true,
    errors: { 404: ['org.unit.parent_not_found'], 422: [...PLACEMENT, ...DATES, 'org.unit.root_fixed', 'org.unit.archived', 'org.unit.cycle', 'org.unit.same_parent'] },
  },
  deactivateOrgUnit: {
    operationId: 'deactivateOrgUnit',
    summary: 'Deactivate a unit: it stays in the tree and takes no new unit (If-Match)',
    tag: 'org',
    params: { id: unitId },
    body: OrgUnitStateBody,
    success: 200,
    response: OrgUnitView,
    etag: true,
    ifMatch: true,
    errors: { 422: [...DATES, 'org.unit.root_fixed', 'org.unit.not_active'] },
  },
  archiveOrgUnit: {
    operationId: 'archiveOrgUnit',
    summary: 'Archive a unit whose units are all archived (If-Match, a reason)',
    tag: 'org',
    params: { id: unitId },
    body: ArchiveOrgUnitBody,
    success: 200,
    response: OrgUnitView,
    etag: true,
    ifMatch: true,
    errors: { 422: [...DATES, 'org.unit.root_fixed', 'org.unit.already_archived', 'org.unit.has_open_children'] },
  },
  reactivateOrgUnit: {
    operationId: 'reactivateOrgUnit',
    summary: 'Make an inactive or archived unit active again (If-Match)',
    tag: 'org',
    params: { id: unitId },
    body: OrgUnitStateBody,
    success: 200,
    response: OrgUnitView,
    etag: true,
    ifMatch: true,
    errors: { 422: [...DATES, 'org.unit.already_active', 'org.unit.parent_not_active'] },
  },
  changeOrgUnitCode: {
    operationId: 'changeOrgUnitCode',
    summary: 'Give a locked unit a new code; the old one stays reserved (If-Match, a reason)',
    tag: 'org',
    params: { id: unitId },
    body: ChangeOrgUnitCodeBody,
    success: 200,
    response: OrgUnitView,
    etag: true,
    ifMatch: true,
    errors: { 409: ['org.unit.code_taken', 'org.unit.code_not_locked'], 422: [...DATES, ...CODES, 'org.unit.root_fixed', 'org.unit.same_code'] },
  },
  listUnitTypes: {
    operationId: 'listUnitTypes',
    summary: 'The institution’s unit types, with what each may contain',
    tag: 'org',
    success: 200,
    response: UnitTypeList,
  },
  saveUnitType: {
    operationId: 'saveUnitType',
    summary: 'Create (If-Match "v0") or edit one unit type',
    tag: 'org',
    params: { key: typeKey },
    body: SaveUnitTypeBody,
    success: 200,
    response: UnitTypeRow,
    etag: true,
    ifMatch: true,
    errors: { 422: ['org.unit_type.kind_fixed', 'org.unit_type.unknown_child', 'org.unit_type.name_taken'] },
  },
});
