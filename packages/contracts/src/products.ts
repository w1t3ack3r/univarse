// Product catalog — ADR-020, spec 0003. `core` is always on.

export const PRODUCTS = [
  'core',
  'admissions',
  'bursary',
  'academics',
  'teaching',
  'assessment',
  'student_affairs',
  'helpdesk',
  'reporting',
] as const;

export type ProductKey = (typeof PRODUCTS)[number];

export const isProduct = (p: string): p is ProductKey => (PRODUCTS as readonly string[]).includes(p);

export const ALWAYS_ON: readonly ProductKey[] = ['core'];
