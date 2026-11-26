// Spec 0041 Q10 (ADR-039): logic never branches on the institution's type. Institution differences are profile data,
// configurable policies and stable identifiers; a comparison or a `switch` case on a type literal is refused. Only
// the places that legitimately read the type may: the profile definitions and provisioning's selection of a profile
// (packages/domain/src/platform), tests, and explicit migration tooling (packages/db-ops). Each is named here, so a
// new exception is a reviewed change to this file.

const TYPES = '/^(UNIVERSITY|POLYTECHNIC|COLLEGE_OF_EDUCATION)$/';
const MESSAGE =
  "Don't branch on the institution's type (ADR-039, spec 0041 Q10): read the institution's profile data or a setting, or choose by a stable identifier such as a qualification's family.";

/** The `no-restricted-syntax` entries. Spread into every block that sets that rule, as flat config replaces it. */
export const TYPE_BRANCHING_RESTRICTIONS = [
  { selector: `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=${TYPES}]`, message: MESSAGE },
  { selector: `SwitchCase > Literal.test[value=${TYPES}]`, message: MESSAGE },
];

/** Where reading the type is the job. */
export const TYPE_BRANCHING_PERMITTED = ['packages/domain/src/platform/**', 'packages/db-ops/**'];
