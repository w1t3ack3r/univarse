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
