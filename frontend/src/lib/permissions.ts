// IT Admin Role-Based Access Control (RBAC)
// This file defines the permissions for each IT Admin sub-role

export type ITAdminRole =
    | 'IT_ADMIN_CENTRAL'
    | 'IT_ADMIN_ACADEMIC'
    | 'IT_ADMIN_ADMISSIONS'
    | 'IT_ADMIN_BURSARY'
    | 'IT_ADMIN_EXAMS'
    | 'IT_ADMIN_STUDENT_AFFAIRS'
    | 'IT_ADMIN_HOSTEL';

// Routes that each role can access
export const ROLE_PERMISSIONS: Record<ITAdminRole, string[]> = {
    IT_ADMIN_CENTRAL: [
        '/it-admin',
        '/it-admin/users',
        '/it-admin/structure',
        '/it-admin/courses',
        '/it-admin/programmes',
        '/it-admin/sessions',
        '/it-admin/admissions',
        '/it-admin/fees',
        '/it-admin/examinations',
        '/it-admin/results',
        '/it-admin/clearance',
        '/it-admin/hostel',
        '/it-admin/notifications',
        '/it-admin/support',
        '/it-admin/settings',
    ],
    IT_ADMIN_ACADEMIC: [
        '/it-admin',
        '/it-admin/structure',
        '/it-admin/courses',
        '/it-admin/programmes',
        '/it-admin/sessions',
    ],
    IT_ADMIN_ADMISSIONS: [
        '/it-admin',
        '/it-admin/admissions',
    ],
    IT_ADMIN_BURSARY: [
        '/it-admin',
        '/it-admin/fees',
    ],
    IT_ADMIN_EXAMS: [
        '/it-admin',
        '/it-admin/examinations',
        '/it-admin/results',
        '/it-admin/clearance',
    ],
    IT_ADMIN_STUDENT_AFFAIRS: [
        '/it-admin',
        '/it-admin/notifications',
        '/it-admin/support',
    ],
    IT_ADMIN_HOSTEL: [
        '/it-admin',
        '/it-admin/hostel',
    ],
};

// Check if a role has access to a specific route
export function hasAccess(role: ITAdminRole | null | undefined, route: string): boolean {
    if (!role) return false;
    const allowed = ROLE_PERMISSIONS[role];
    if (!allowed) return false;

    // Check exact match or if route starts with an allowed path
    return allowed.some(path => route === path || route.startsWith(path + '/'));
}

// Get the display name for a role
export function getRoleDisplayName(role: ITAdminRole): string {
    const names: Record<ITAdminRole, string> = {
        IT_ADMIN_CENTRAL: 'Central IT Admin',
        IT_ADMIN_ACADEMIC: 'Academic Affairs',
        IT_ADMIN_ADMISSIONS: 'Admissions Unit',
        IT_ADMIN_BURSARY: 'Bursary/Finance',
        IT_ADMIN_EXAMS: 'Exams & Records',
        IT_ADMIN_STUDENT_AFFAIRS: 'Student Affairs',
        IT_ADMIN_HOSTEL: 'Hostel Management',
    };
    return names[role] || role;
}

// Navigation items with their required roles
export interface NavItem {
    name: string;
    href: string;
    icon: React.ComponentType<{ className?: string }>;
    allowedRoles: ITAdminRole[];
}

// Filter navigation items based on user's role
export function filterNavByRole<T extends { href: string }>(
    items: T[],
    role: ITAdminRole | null | undefined
): T[] {
    if (!role) return [];
    if (role === 'IT_ADMIN_CENTRAL') return items; // Central has full access

    const allowed = ROLE_PERMISSIONS[role] || [];
    return items.filter(item => allowed.includes(item.href));
}
