// Spec 0033: what staff read instead of the registry's machine names. A name that isn't here shows as it is.
export const STATUS: Readonly<Record<string, { label: string; tone: string }>> = {
  REQUESTED: { label: 'Requested', tone: 'pc-status--wait' },
  PROVISIONING: { label: 'Provisioning', tone: 'pc-status--wait' },
  ONBOARDING: { label: 'Onboarding', tone: 'pc-status--wait' },
  ACTIVE: { label: 'Active', tone: 'pc-status--on' },
  SUSPENDED: { label: 'Suspended', tone: 'pc-status--bad' },
  OFFBOARDING: { label: 'Offboarding', tone: 'pc-status--wait' },
  ARCHIVED: { label: 'Archived', tone: 'pc-status--off' },
  PURGED: { label: 'Purged', tone: 'pc-status--off' },
};

/** Spec 0037 Q6: the fixed reasons, as staff read them. */
export const SUSPENSION_REASON: Readonly<Record<'SECURITY_INCIDENT' | 'REGULATOR_ORDER' | 'CONTRACT_ENDED' | 'INSTITUTION_ASKED' | 'OTHER', string>> = {
  SECURITY_INCIDENT: 'A security incident',
  REGULATOR_ORDER: 'A regulator’s order',
  CONTRACT_ENDED: 'The contract ended',
  INSTITUTION_ASKED: 'The institution asked',
  OTHER: 'Other',
};

export const TYPE: Readonly<Record<string, string>> = {
  UNIVERSITY: 'University',
  POLYTECHNIC: 'Polytechnic',
  COLLEGE_OF_EDUCATION: 'College of education',
};

export const OWNERSHIP: Readonly<Record<string, string>> = { FEDERAL: 'Federal', STATE: 'State', PRIVATE: 'Private' };

export const OPERATING_STATUS: Readonly<Record<string, string>> = {
  UNKNOWN: 'Not recorded',
  APPROVED: 'Approved',
  PROVISIONAL_LICENCE: 'Provisional licence',
  SUSPENDED_BY_REGULATOR: 'Suspended by the regulator',
};

export const PRODUCT: Readonly<Record<string, { name: string; about: string }>> = {
  core: { name: 'Core', about: 'Accounts, sign-in, roles and settings.' },
  admissions: { name: 'Admissions', about: 'Applications, screening, offers and acceptance.' },
  bursary: { name: 'Bursary', about: 'Fees, invoices, payments and receipts.' },
  academics: { name: 'Academics', about: 'Courses, registration, score sheets and results.' },
  teaching: { name: 'Teaching & Learning', about: 'Course pages, materials, assignments and live engagement.' },
  assessment: { name: 'Assessment', about: 'CA tests by computer, question banks and marking.' },
  student_affairs: { name: 'Student Affairs', about: 'Hostels, clearance and student records.' },
  helpdesk: { name: 'Helpdesk', about: 'Announcements and support between users and the ICT unit.' },
  reporting: { name: 'Reporting', about: 'Dashboards and reports for management.' },
};

/** Spec 0034 Q5: provisioning's eight steps, as staff read them while one runs. */
export const STEP: Readonly<Record<string, { label: string; about: string }>> = {
  place: { label: 'Place', about: 'Check its database answers, then mark it as being provisioned.' },
  key: { label: 'Data key', about: 'Create the key that protects its data, in Vault.' },
  seed: { label: 'Roles', about: 'Set up its organisation root and the system roles.' },
  template: { label: 'Template', about: 'Apply the settings its template defines.' },
  host: { label: 'Address', about: 'Give it its own web address.' },
  products: { label: 'Products', about: 'Grant the products chosen; switch Core on.' },
  invite: { label: 'Invitation', about: 'Create the first administrator’s account and email them.' },
  done: { label: 'Onboarding', about: 'Hand it over: the administrator can now activate.' },
};

/** Spec 0034 Q4: a failed step's fixed code, and what to do about it. */
export const PROVISIONING_ERROR: Readonly<Record<string, string>> = {
  no_shard: 'No database is available for new institutions. Add or reactivate a shard, then resume.',
  shard_unavailable: 'Its database didn’t answer. Check the database is running, then resume.',
  key_unavailable: 'Vault didn’t answer, or refused the key. Check Vault is unsealed, then resume.',
  invite_unreadable: 'The administrator’s details couldn’t be opened. Check the worker has the provisioning key, then resume.',
  state_conflict: 'The institution changed while it was being provisioned (its status, or its address is taken). Look at the audit log before resuming.',
  database: 'The database refused a change, even after retrying. Check its health, then resume.',
  unexpected: 'Something unexpected stopped this step. Check the worker’s log for this institution, then resume.',
};

/** Spec 0034 Q6. */
export const TEMPLATE: Readonly<Record<string, { label: string; about: string }>> = {
  university: { label: 'University (NUC)', about: 'NUC’s structure: units per semester for now; grading and sessions arrive with Academics.' },
  polytechnic: { label: 'Polytechnic (NBTE)', about: 'NBTE’s structure: units per semester for now; ND and HND grading arrive with Academics.' },
  'college-of-education': { label: 'College of education (NCCE)', about: 'NCCE’s structure: units per semester for now; grading arrives with Academics.' },
};

/** Spec 0034 Q9: the go-live checklist's items. */
export const GO_LIVE: Readonly<Record<string, { label: string; todo: string; done: string }>> = {
  admin_ready: { label: 'The administrator is ready', todo: 'Waiting for them to activate their account and set up an authenticator. Checked every minute.', done: 'Activated, with an authenticator.' },
  products: { label: 'A product beyond Core', todo: 'Grant at least one product in', done: 'Granted.' },
  branding: { label: 'Its colour', todo: 'Set it (a logo is optional) in', done: 'Set.' },
  regulatory: { label: 'Regulatory details', todo: 'Record its state and operating status in', done: 'Recorded.' },
  dpa: { label: 'Data processing agreement', todo: 'Record the signed agreement:', done: 'Recorded.' },
};
