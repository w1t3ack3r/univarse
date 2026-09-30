/** A business-rule violation with a stable, namespaced code (docs/06-api-guidelines.md §4). */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
