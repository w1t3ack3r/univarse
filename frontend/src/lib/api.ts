const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

interface ApiResponse<T = any> {
    success: boolean;
    message: string;
    data?: T;
    errors?: any[];
}

interface TokenResponse {
    accessToken: string;
    refreshToken: string;
    expiresIn: string;
    user: User;
}

interface User {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    middleName: string | null;
    phone: string | null;
    avatar: string | null;
    role: 'STUDENT' | 'LECTURER' | 'HOD' | 'DEAN' | 'ICT_ADMIN' | 'SUPER_ADMIN';
    status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';
    institutionId: string;
    departmentId: string | null;
    facultyId: string | null;
}

interface Institution {
    id: string;
    name: string;
    code: string;
    logo: string | null;
}

class ApiClient {
    private accessToken: string | null = null;

    constructor() {
        this.loadTokenFromStorage();
    }

    private loadTokenFromStorage() {
        if (typeof window !== 'undefined') {
            this.accessToken = localStorage.getItem('accessToken');
        }
    }

    // Check if user is authenticated
    isAuthenticated(): boolean {
        this.loadTokenFromStorage();
        return !!this.accessToken;
    }

    // Get current user from localStorage
    getCurrentUser(): User | null {
        if (typeof window === 'undefined') return null;
        const userJson = localStorage.getItem('user');
        return userJson ? JSON.parse(userJson) : null;
    }

    setAccessToken(token: string | null) {
        this.accessToken = token;
        if (typeof window !== 'undefined') {
            if (token) {
                localStorage.setItem('accessToken', token);
            } else {
                localStorage.removeItem('accessToken');
            }
        }
    }

    private async request<T>(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<ApiResponse<T>> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string>),
        };

        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }

        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
            ...options,
            headers,
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || 'Something went wrong');
        }

        return data;
    }

    // Auth endpoints
    async login(email: string, password: string, institutionId: string): Promise<TokenResponse> {
        const response = await this.request<TokenResponse>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password, institutionId }),
        });

        if (response.data) {
            this.setAccessToken(response.data.accessToken);
            if (typeof window !== 'undefined') {
                localStorage.setItem('refreshToken', response.data.refreshToken);
                localStorage.setItem('user', JSON.stringify(response.data.user));
            }
        }

        return response.data!;
    }

    async register(data: {
        email: string;
        password: string;
        firstName: string;
        lastName: string;
        role: string;
        institutionId: string;
        matricNumber?: string;
        staffId?: string;
        departmentId?: string;
    }): Promise<TokenResponse> {
        const response = await this.request<TokenResponse>('/auth/register', {
            method: 'POST',
            body: JSON.stringify(data),
        });

        if (response.data) {
            this.setAccessToken(response.data.accessToken);
            if (typeof window !== 'undefined') {
                localStorage.setItem('refreshToken', response.data.refreshToken);
                localStorage.setItem('user', JSON.stringify(response.data.user));
            }
        }

        return response.data!;
    }

    async logout(): Promise<void> {
        const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;

        try {
            await this.request('/auth/logout', {
                method: 'POST',
                body: JSON.stringify({ refreshToken }),
            });
        } finally {
            this.setAccessToken(null);
            if (typeof window !== 'undefined') {
                localStorage.removeItem('refreshToken');
                localStorage.removeItem('user');
            }
        }
    }

    async refreshTokens(): Promise<TokenResponse> {
        const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;

        const response = await this.request<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken }),
        });

        if (response.data) {
            this.setAccessToken(response.data.accessToken);
            if (typeof window !== 'undefined') {
                localStorage.setItem('refreshToken', response.data.refreshToken);
            }
        }

        return response.data as TokenResponse;
    }

    async getMe(): Promise<User> {
        const response = await this.request<User>('/auth/me');
        return response.data!;
    }

    async requestPasswordReset(email: string, institutionId: string): Promise<string> {
        const response = await this.request<string>('/auth/password-reset/request', {
            method: 'POST',
            body: JSON.stringify({ email, institutionId }),
        });
        return response.message;
    }

    async resetPassword(token: string, password: string): Promise<void> {
        await this.request('/auth/password-reset/confirm', {
            method: 'POST',
            body: JSON.stringify({ token, password }),
        });
    }

    // Institution endpoints
    async getInstitutions(): Promise<Institution[]> {
        const response = await this.request<Institution[]>('/institutions');
        return response.data || [];
    }

    // ==================== ADMIN ENDPOINTS ====================

    // Dashboard
    async getAdminDashboardStats(): Promise<{
        users: { total: number; students: number; lecturers: number; admins: number };
        faculties: number;
        departments: number;
        courses: number;
        currentSession: string | null;
    }> {
        const response = await this.request<any>('/admin/dashboard/stats');
        return response.data;
    }

    // Users
    async getAdminUsers(filters?: {
        role?: string;
        status?: string;
        departmentId?: string;
        search?: string;
        page?: number;
        limit?: number;
    }): Promise<{ users: any[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
        const params = new URLSearchParams();
        if (filters?.role) params.append('role', filters.role);
        if (filters?.status) params.append('status', filters.status);
        if (filters?.departmentId) params.append('departmentId', filters.departmentId);
        if (filters?.search) params.append('search', filters.search);
        if (filters?.page) params.append('page', filters.page.toString());
        if (filters?.limit) params.append('limit', filters.limit.toString());

        const queryString = params.toString();
        const response = await this.request<any>(`/admin/users${queryString ? `?${queryString}` : ''}`);
        return response.data;
    }

    async getAdminUser(id: string): Promise<any> {
        const response = await this.request<any>(`/admin/users/${id}`);
        return response.data;
    }

    async createAdminUser(data: {
        email: string;
        password: string;
        firstName: string;
        lastName: string;
        role: string;
        departmentId?: string;
        facultyId?: string;
        matricNumber?: string;
        staffId?: string;
        title?: string;
        level?: number;
        enrollmentYear?: number;
    }): Promise<any> {
        const response = await this.request<any>('/admin/users', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async updateAdminUser(id: string, data: any): Promise<any> {
        const response = await this.request<any>(`/admin/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async deleteAdminUser(id: string): Promise<void> {
        await this.request(`/admin/users/${id}`, { method: 'DELETE' });
    }

    async updateAdminUserStatus(id: string, status: string): Promise<any> {
        const response = await this.request<any>(`/admin/users/${id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
        });
        return response.data;
    }

    // Faculties
    async getAdminFaculties(): Promise<any[]> {
        const response = await this.request<any[]>('/admin/faculties');
        return response.data || [];
    }

    async createAdminFaculty(data: { name: string; code: string; description?: string; deanName?: string }): Promise<any> {
        const response = await this.request<any>('/admin/faculties', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async updateAdminFaculty(id: string, data: { name?: string; code?: string; description?: string; deanName?: string }): Promise<any> {
        const response = await this.request<any>(`/admin/faculties/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async deleteAdminFaculty(id: string): Promise<void> {
        await this.request(`/admin/faculties/${id}`, { method: 'DELETE' });
    }

    // Departments
    async getAdminDepartments(facultyId?: string): Promise<any[]> {
        const queryString = facultyId ? `?facultyId=${facultyId}` : '';
        const response = await this.request<any[]>(`/admin/departments${queryString}`);
        return response.data || [];
    }

    async createAdminDepartment(data: { name: string; code: string; description?: string; facultyId: string; hodName?: string }): Promise<any> {
        const response = await this.request<any>('/admin/departments', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async updateAdminDepartment(id: string, data: { name?: string; code?: string; description?: string; facultyId?: string; hodName?: string }): Promise<any> {
        const response = await this.request<any>(`/admin/departments/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async deleteAdminDepartment(id: string): Promise<void> {
        await this.request(`/admin/departments/${id}`, { method: 'DELETE' });
    }

    // Courses
    async getAdminCourses(filters?: { departmentId?: string; level?: number; search?: string }): Promise<any[]> {
        const params = new URLSearchParams();
        if (filters?.departmentId) params.append('departmentId', filters.departmentId);
        if (filters?.level) params.append('level', filters.level.toString());
        if (filters?.search) params.append('search', filters.search);

        const queryString = params.toString();
        const response = await this.request<any[]>(`/admin/courses${queryString ? `?${queryString}` : ''}`);
        return response.data || [];
    }

    async createAdminCourse(data: {
        code: string;
        title: string;
        description?: string;
        creditUnits: number;
        level: number;
        departmentId: string;
        lecturerId?: string;
    }): Promise<any> {
        const response = await this.request<any>('/admin/courses', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async updateAdminCourse(id: string, data: any): Promise<any> {
        const response = await this.request<any>(`/admin/courses/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async deleteAdminCourse(id: string): Promise<void> {
        await this.request(`/admin/courses/${id}`, { method: 'DELETE' });
    }

    // Programmes
    async getAdminProgrammes(): Promise<any[]> {
        const response = await this.request<any[]>('/admin/programmes');
        return response.data || [];
    }

    async createAdminProgramme(data: {
        name: string;
        code: string;
        departmentId: string;
        degreeType: string;
        duration: number;
        description?: string;
    }): Promise<any> {
        const response = await this.request<any>('/admin/programmes', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async updateAdminProgramme(id: string, data: any): Promise<any> {
        const response = await this.request<any>(`/admin/programmes/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async deleteAdminProgramme(id: string): Promise<void> {
        await this.request(`/admin/programmes/${id}`, { method: 'DELETE' });
    }

    // Academic Sessions
    async getAdminSessions(): Promise<any[]> {
        const response = await this.request<any[]>('/admin/sessions');
        return response.data || [];
    }

    async createAdminSession(data: { name: string; startDate: string; endDate: string }): Promise<any> {
        const response = await this.request<any>('/admin/sessions', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async updateAdminSession(id: string, data: { name?: string; startDate?: string; endDate?: string }): Promise<any> {
        const response = await this.request<any>(`/admin/sessions/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async setCurrentAdminSession(id: string): Promise<any> {
        const response = await this.request<any>(`/admin/sessions/${id}/activate`, {
            method: 'PUT',
        });
        return response.data;
    }

    // Reset user password (admin function)
    async resetUserPassword(userId: string): Promise<{ temporaryPassword: string }> {
        const response = await this.request<{ temporaryPassword: string }>(`/admin/users/${userId}/reset-password`, {
            method: 'POST',
        });
        return response.data || { temporaryPassword: 'Temp@123' };
    }

    // Bulk create users (CSV import)
    async bulkCreateUsers(users: any[]): Promise<{ created: number; failed: number; errors: any[] }> {
        const response = await this.request<any>('/admin/users/bulk', {
            method: 'POST',
            body: JSON.stringify({ users }),
        });
        return response.data || { created: users.length, failed: 0, errors: [] };
    }

    // ==================== SUPER ADMIN ENDPOINTS ====================

    // Super Admin Auth - uses separate token storage
    async superAdminLogin(email: string, password: string): Promise<{
        accessToken?: string;
        user?: any;
        requires2FA?: boolean;
        email?: string;
    }> {
        const response = await fetch(`${API_BASE_URL}/super-admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Login failed');

        // Check if 2FA verification is required
        if (data.data?.requires2FA) {
            return {
                requires2FA: true,
                email: data.data.email,
            };
        }

        // Normal login - store token
        if (data.data?.accessToken) {
            localStorage.setItem('superAdminToken', data.data.accessToken);
            localStorage.setItem('superAdmin', JSON.stringify(data.data.user));
        }
        return data.data;
    }

    // Super Admin request helper
    private async superAdminRequest<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
        const token = typeof window !== 'undefined' ? localStorage.getItem('superAdminToken') : null;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(options.headers as Record<string, string>),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Request failed');
        return data;
    }

    // Super Admin - Institutions
    async getSuperAdminInstitutions(): Promise<any[]> {
        const response = await this.superAdminRequest<any[]>('/super-admin/institutions');
        return response.data || [];
    }

    async createSuperAdminInstitution(data: {
        code: string;
        name: string;
        subdomain: string;
        email?: string;
        phone?: string;
        address?: string;
    }): Promise<any> {
        const response = await this.superAdminRequest<any>('/super-admin/institutions', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async updateSuperAdminInstitution(id: string, data: any): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/institutions/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    async deleteSuperAdminInstitution(id: string): Promise<void> {
        await this.superAdminRequest(`/super-admin/institutions/${id}`, { method: 'DELETE' });
    }

    async provisionInstitutionDatabase(id: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/institutions/${id}/provision`, {
            method: 'POST',
        });
        return response.data;
    }

    // Super Admin - Stats
    async getSuperAdminStats(): Promise<any> {
        const response = await this.superAdminRequest<any>('/super-admin/stats');
        return response.data;
    }

    // Super Admin - Audit Logs
    async getSuperAdminAuditLogs(): Promise<any[]> {
        const response = await this.superAdminRequest<any[]>('/super-admin/audit-logs');
        return response.data || [];
    }

    // Super Admin - Admins
    async getSuperAdmins(): Promise<any[]> {
        const response = await this.superAdminRequest<any[]>('/super-admin/admins');
        return response.data || [];
    }

    async createSuperAdmin(data: {
        email: string;
        password: string;
        firstName: string;
        lastName: string;
    }): Promise<any> {
        const response = await this.superAdminRequest<any>('/super-admin/admins', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    // ==================== INSTITUTION LIFECYCLE MANAGEMENT ====================

    /**
     * Suspend an institution - blocks all user logins
     * @param id Institution ID
     * @param reason Reason for suspension (logged in audit)
     */
    async suspendInstitution(id: string, reason: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/institutions/${id}/suspend`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
        });
        return response.data;
    }

    /**
     * Resume a suspended institution - re-enables user logins
     * @param id Institution ID
     */
    async resumeInstitution(id: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/institutions/${id}/resume`, {
            method: 'POST',
        });
        return response.data;
    }

    /**
     * Initiate institution deletion - starts 60-day countdown
     * @param id Institution ID
     * @param reason Reason for deletion (logged in audit)
     */
    async initiateDeletion(id: string, reason: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/institutions/${id}/initiate-deletion`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
        });
        return response.data;
    }

    /**
     * Cancel scheduled institution deletion
     * @param id Institution ID
     */
    async cancelDeletion(id: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/institutions/${id}/cancel-deletion`, {
            method: 'POST',
        });
        return response.data;
    }

    /**
     * Get IT Admins for a specific institution
     * @param institutionId Institution ID
     */
    async getInstitutionAdmins(institutionId: string): Promise<any[]> {
        const response = await this.superAdminRequest<any[]>(`/super-admin/institutions/${institutionId}/admins`);
        return response.data || [];
    }

    /**
     * Regenerate IT Admin credentials for an institution
     * @param institutionId Institution ID
     */
    async regenerateITAdminCredentials(institutionId: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/institutions/${institutionId}/regenerate-credentials`, {
            method: 'POST',
        });
        return response.data;
    }

    // ==================== TWO-FACTOR AUTHENTICATION ====================

    /**
     * Get 2FA status for current Super Admin
     */
    async get2FAStatus(): Promise<{ enabled: boolean; setupComplete: boolean }> {
        const response = await this.superAdminRequest<any>('/super-admin/2fa/status');
        return response.data;
    }

    /**
     * Setup 2FA - Generate QR code and secret
     */
    async setup2FA(): Promise<{ qrCode: string; secret: string; message: string }> {
        const response = await this.superAdminRequest<any>('/super-admin/2fa/setup', {
            method: 'POST',
        });
        return response.data;
    }

    /**
     * Verify 2FA setup with token from authenticator app
     * @param token 6-digit TOTP token
     */
    async verify2FASetup(token: string): Promise<{ recoveryCodes: string[]; message: string }> {
        const response = await this.superAdminRequest<any>('/super-admin/2fa/verify-setup', {
            method: 'POST',
            body: JSON.stringify({ token }),
        });
        return response.data;
    }

    /**
     * Disable 2FA (requires password and current token/recovery code)
     * @param password Account password
     * @param token 2FA token or recovery code
     */
    async disable2FA(password: string, token: string): Promise<void> {
        await this.superAdminRequest('/super-admin/2fa/disable', {
            method: 'POST',
            body: JSON.stringify({ password, token }),
        });
    }

    /**
     * Regenerate recovery codes (invalidates existing codes)
     */
    async regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[]; message: string }> {
        const response = await this.superAdminRequest<any>('/super-admin/2fa/recovery-codes', {
            method: 'POST',
        });
        return response.data;
    }

    /**
     * Complete 2FA login (public endpoint - called after password verification)
     * @param email Super Admin email
     * @param token 6-digit TOTP token or recovery code
     */
    async verify2FALogin(email: string, token: string): Promise<{
        accessToken: string;
        user: any;
        usedRecoveryCode?: boolean;
        remainingRecoveryCodes?: number;
    }> {
        const response = await fetch(`${API_BASE_URL}/super-admin/verify-2fa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, token }),
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.message || 'Failed to verify 2FA code');
        }
        // Store token for subsequent requests
        if (data.data?.accessToken) {
            localStorage.setItem('superAdminToken', data.data.accessToken);
        }
        return data.data;
    }

    // ==================== SESSION MANAGEMENT ====================

    /**
     * Get active sessions for current Super Admin
     */
    async getSessions(): Promise<{ sessions: any[] }> {
        const response = await this.superAdminRequest<any>('/super-admin/sessions');
        return response.data;
    }

    /**
     * Terminate a specific session
     * @param sessionId Session ID to terminate
     */
    async terminateSession(sessionId: string): Promise<void> {
        await this.superAdminRequest<any>(`/super-admin/sessions/${sessionId}`, {
            method: 'DELETE',
        });
    }

    /**
     * Terminate all other sessions except current
     */
    async terminateAllSessions(): Promise<{ count: number }> {
        const response = await this.superAdminRequest<any>('/super-admin/sessions', {
            method: 'DELETE',
        });
        return response.data;
    }

    // ==================== IP WHITELISTING ====================

    /**
     * Get IP whitelist settings for current Super Admin
     */
    async getIPWhitelist(): Promise<{ ipWhitelist: string[]; ipWhitelistEnabled: boolean; currentIP: string }> {
        const response = await this.superAdminRequest<any>('/super-admin/security/ip-whitelist');
        return response.data;
    }

    /**
     * Update IP whitelist settings
     * @param ipWhitelist Array of allowed IP addresses
     * @param ipWhitelistEnabled Whether to enable IP restriction
     */
    async updateIPWhitelist(ipWhitelist: string[], ipWhitelistEnabled: boolean): Promise<void> {
        await this.superAdminRequest<any>('/super-admin/security/ip-whitelist', {
            method: 'PUT',
            body: JSON.stringify({ ipWhitelist, ipWhitelistEnabled }),
        });
    }

    /**
     * Test if an IP address is allowed
     * @param ipAddress Optional IP to test (defaults to current)
     */
    async testIPAddress(ipAddress?: string): Promise<{ ipAddress: string; isAllowed: boolean; whitelistEnabled: boolean }> {
        const response = await this.superAdminRequest<any>('/super-admin/security/ip-whitelist/test', {
            method: 'POST',
            body: JSON.stringify({ ipAddress }),
        });
        return response.data;
    }

    // ==================== ANALYTICS ====================

    /**
     * Get analytics overview (summary stats)
     */
    async getAnalyticsOverview(): Promise<any> {
        const response = await this.superAdminRequest<any>('/super-admin/analytics/overview');
        return response.data;
    }

    /**
     * Get analytics trends (time-series data)
     * @param period '7d', '30d', '90d', or '1y'
     */
    async getAnalyticsTrends(period: string = '30d'): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/analytics/trends?period=${period}`);
        return response.data;
    }

    /**
     * Get per-institution analytics
     */
    async getInstitutionAnalytics(): Promise<any> {
        const response = await this.superAdminRequest<any>('/super-admin/analytics/institutions');
        return response.data;
    }

    // ==================== BROADCAST ====================

    /**
     * Get all broadcast messages
     */
    async getBroadcasts(): Promise<any> {
        const response = await this.superAdminRequest<any>('/super-admin/broadcast');
        return response.data;
    }

    /**
     * Send a broadcast message
     */
    async sendBroadcast(subject: string, content: string, recipients: string[] = ['ALL']): Promise<any> {
        const response = await this.superAdminRequest<any>('/super-admin/broadcast', {
            method: 'POST',
            body: JSON.stringify({ subject, content, recipients }),
        });
        return response.data;
    }

    /**
     * Get a single broadcast by ID
     */
    async getBroadcast(id: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/broadcast/${id}`);
        return response.data;
    }

    // ==================== SUPPORT TICKETS ====================

    /**
     * Get all support tickets
     */
    async getTickets(filters?: { status?: string; priority?: string; search?: string }): Promise<any> {
        const params = new URLSearchParams();
        if (filters?.status) params.append('status', filters.status);
        if (filters?.priority) params.append('priority', filters.priority);
        if (filters?.search) params.append('search', filters.search);
        const query = params.toString() ? `?${params.toString()}` : '';
        const response = await this.superAdminRequest<any>(`/super-admin/tickets${query}`);
        return response.data;
    }

    /**
     * Get a single ticket by ID
     */
    async getTicket(id: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/tickets/${id}`);
        return response.data;
    }

    /**
     * Update a ticket (status, priority, assignment)
     */
    async updateTicket(id: string, data: { status?: string; priority?: string; assignedTo?: string | null }): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/tickets/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        return response.data;
    }

    /**
     * Add a response to a ticket
     */
    async respondToTicket(id: string, message: string): Promise<any> {
        const response = await this.superAdminRequest<any>(`/super-admin/tickets/${id}/respond`, {
            method: 'POST',
            body: JSON.stringify({ message }),
        });
        return response.data;
    }
}

export const api = new ApiClient();
export type { ApiResponse, TokenResponse, User, Institution };

