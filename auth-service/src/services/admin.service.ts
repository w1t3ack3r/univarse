import { PrismaClient, Role, UserStatus, Prisma } from '@prisma/client';
import { hashPassword } from '../utils/auth';

const prisma = new PrismaClient();

interface CreateUserData {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    middleName?: string;
    phone?: string;
    role: Role;
    institutionId: string;
    departmentId?: string;
    facultyId?: string;
    // Student specific
    matricNumber?: string;
    level?: number;
    enrollmentYear?: number;
    // Lecturer specific
    staffId?: string;
    title?: string;
    rank?: string;
    specialization?: string;
}

interface UpdateUserData {
    firstName?: string;
    lastName?: string;
    middleName?: string;
    phone?: string;
    status?: UserStatus;
    departmentId?: string;
    facultyId?: string;
}

interface UserFilters {
    institutionId: string;
    role?: Role;
    status?: UserStatus;
    departmentId?: string;
    search?: string;
    page?: number;
    limit?: number;
}

interface FacultyData {
    name: string;
    code: string;
    description?: string;
    institutionId: string;
}

interface DepartmentData {
    name: string;
    code: string;
    description?: string;
    facultyId: string;
    institutionId: string;
}

interface CourseData {
    code: string;
    title: string;
    description?: string;
    creditUnits: number;
    level: number;
    departmentId: string;
    lecturerId?: string;
}

interface SessionData {
    name: string;
    startDate: Date;
    endDate: Date;
    institutionId: string;
}

export class AdminService {
    // ==================== USERS ====================

    async getUsers(filters: UserFilters) {
        const { institutionId, role, status, departmentId, search, page = 1, limit = 20 } = filters;

        const where: Prisma.UserWhereInput = {
            institutionId,
            ...(role && { role }),
            ...(status && { status }),
            ...(departmentId && { departmentId }),
            ...(search && {
                OR: [
                    { firstName: { contains: search, mode: 'insensitive' as Prisma.QueryMode } },
                    { lastName: { contains: search, mode: 'insensitive' as Prisma.QueryMode } },
                    { email: { contains: search, mode: 'insensitive' as Prisma.QueryMode } },
                ]
            }),
        };

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                include: {
                    department: { select: { id: true, name: true } },
                    faculty: { select: { id: true, name: true } },
                    studentProfile: true,
                    lecturerProfile: true,
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.user.count({ where }),
        ]);

        return {
            users: users.map(this.formatUser),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    async getUserById(id: string, institutionId: string) {
        const user = await prisma.user.findFirst({
            where: { id, institutionId },
            include: {
                department: true,
                faculty: true,
                studentProfile: true,
                lecturerProfile: true,
            },
        });

        if (!user) {
            throw new Error('User not found');
        }

        return this.formatUser(user);
    }

    async createUser(data: CreateUserData) {
        const hashedPassword = await hashPassword(data.password);

        const user = await prisma.user.create({
            data: {
                email: data.email,
                password: hashedPassword,
                firstName: data.firstName,
                lastName: data.lastName,
                middleName: data.middleName,
                phone: data.phone,
                role: data.role,
                status: 'ACTIVE',
                institutionId: data.institutionId,
                departmentId: data.departmentId,
                facultyId: data.facultyId,
                ...(data.role === 'STUDENT' && data.matricNumber && {
                    studentProfile: {
                        create: {
                            matricNumber: data.matricNumber,
                            level: data.level || 100,
                            enrollmentYear: data.enrollmentYear || new Date().getFullYear(),
                        },
                    },
                }),
                ...((['LECTURER', 'HOD'].includes(data.role)) && data.staffId && {
                    lecturerProfile: {
                        create: {
                            staffId: data.staffId,
                            title: data.title,
                            rank: data.rank,
                            specialization: data.specialization,
                        },
                    },
                }),
            },
            include: {
                department: true,
                faculty: true,
                studentProfile: true,
                lecturerProfile: true,
            },
        });

        return this.formatUser(user);
    }

    async updateUser(id: string, institutionId: string, data: UpdateUserData) {
        const user = await prisma.user.update({
            where: { id },
            data: {
                ...data,
                updatedAt: new Date(),
            },
            include: {
                department: true,
                faculty: true,
                studentProfile: true,
                lecturerProfile: true,
            },
        });

        return this.formatUser(user);
    }

    async deleteUser(id: string, institutionId: string) {
        await prisma.user.delete({
            where: { id },
        });
        return { success: true };
    }

    async updateUserStatus(id: string, institutionId: string, status: UserStatus) {
        const user = await prisma.user.update({
            where: { id },
            data: { status },
        });
        return this.formatUser(user);
    }

    // ==================== FACULTIES ====================

    async getFaculties(institutionId: string) {
        const faculties = await prisma.faculty.findMany({
            where: { institutionId },
            include: {
                _count: {
                    select: { departments: true, users: true },
                },
            },
            orderBy: { name: 'asc' },
        });

        return faculties.map(f => ({
            id: f.id,
            name: f.name,
            code: f.code,
            description: f.description,
            departmentCount: f._count.departments,
            userCount: f._count.users,
            createdAt: f.createdAt,
        }));
    }

    async createFaculty(data: FacultyData) {
        return prisma.faculty.create({
            data: {
                name: data.name,
                code: data.code,
                description: data.description,
                institutionId: data.institutionId,
            },
        });
    }

    async updateFaculty(id: string, data: Partial<FacultyData>) {
        return prisma.faculty.update({
            where: { id },
            data: {
                name: data.name,
                code: data.code,
                description: data.description,
            },
        });
    }

    async deleteFaculty(id: string) {
        await prisma.faculty.delete({ where: { id } });
        return { success: true };
    }

    // ==================== DEPARTMENTS ====================

    async getDepartments(institutionId: string, facultyId?: string) {
        const departments = await prisma.department.findMany({
            where: {
                institutionId,
                ...(facultyId && { facultyId }),
            },
            include: {
                faculty: { select: { id: true, name: true } },
                _count: {
                    select: { users: true, courses: true },
                },
            },
            orderBy: { name: 'asc' },
        });

        return departments.map(d => ({
            id: d.id,
            name: d.name,
            code: d.code,
            description: d.description,
            facultyId: d.facultyId,
            facultyName: d.faculty.name,
            userCount: d._count.users,
            courseCount: d._count.courses,
            createdAt: d.createdAt,
        }));
    }

    async createDepartment(data: DepartmentData) {
        return prisma.department.create({
            data: {
                name: data.name,
                code: data.code,
                description: data.description,
                facultyId: data.facultyId,
                institutionId: data.institutionId,
            },
        });
    }

    async updateDepartment(id: string, data: Partial<DepartmentData>) {
        return prisma.department.update({
            where: { id },
            data: {
                name: data.name,
                code: data.code,
                description: data.description,
                facultyId: data.facultyId,
            },
        });
    }

    async deleteDepartment(id: string) {
        await prisma.department.delete({ where: { id } });
        return { success: true };
    }

    // ==================== COURSES ====================

    async getCourses(institutionId: string, filters?: { departmentId?: string; level?: number; search?: string }) {
        const departments = await prisma.department.findMany({
            where: { institutionId },
            select: { id: true },
        });
        const departmentIds = departments.map(d => d.id);

        const courses = await prisma.course.findMany({
            where: {
                departmentId: { in: departmentIds },
                ...(filters?.departmentId && { departmentId: filters.departmentId }),
                ...(filters?.level && { level: filters.level }),
                ...(filters?.search && {
                    OR: [
                        { code: { contains: filters.search, mode: 'insensitive' as Prisma.QueryMode } },
                        { title: { contains: filters.search, mode: 'insensitive' as Prisma.QueryMode } },
                    ],
                }),
            },
            include: {
                department: { select: { id: true, name: true } },
                lecturer: { select: { id: true, title: true, user: { select: { firstName: true, lastName: true } } } },
            },
            orderBy: { code: 'asc' },
        });

        return courses.map(c => ({
            id: c.id,
            code: c.code,
            title: c.title,
            description: c.description,
            creditUnits: c.creditUnits,
            level: c.level,
            departmentId: c.departmentId,
            departmentName: c.department.name,
            lecturerId: c.lecturerId,
            lecturerName: c.lecturer ? `${c.lecturer.title || ''} ${c.lecturer.user.firstName} ${c.lecturer.user.lastName}`.trim() : null,
            isActive: c.isActive,
            createdAt: c.createdAt,
        }));
    }

    async createCourse(data: CourseData) {
        return prisma.course.create({
            data: {
                code: data.code,
                title: data.title,
                description: data.description,
                creditUnits: data.creditUnits,
                level: data.level,
                departmentId: data.departmentId,
                lecturerId: data.lecturerId,
            },
            include: {
                department: true,
            },
        });
    }

    async updateCourse(id: string, data: Partial<CourseData>) {
        return prisma.course.update({
            where: { id },
            data: {
                code: data.code,
                title: data.title,
                description: data.description,
                creditUnits: data.creditUnits,
                level: data.level,
                departmentId: data.departmentId,
                lecturerId: data.lecturerId,
            },
        });
    }

    async deleteCourse(id: string) {
        await prisma.course.delete({ where: { id } });
        return { success: true };
    }

    // ==================== ACADEMIC SESSIONS ====================

    async getSessions(institutionId: string) {
        return prisma.academicSession.findMany({
            where: { institutionId },
            include: {
                semesters: true,
            },
            orderBy: { startDate: 'desc' },
        });
    }

    async createSession(data: SessionData) {
        return prisma.academicSession.create({
            data: {
                name: data.name,
                startDate: data.startDate,
                endDate: data.endDate,
                institutionId: data.institutionId,
            },
        });
    }

    async updateSession(id: string, data: Partial<SessionData>) {
        return prisma.academicSession.update({
            where: { id },
            data: {
                name: data.name,
                startDate: data.startDate,
                endDate: data.endDate,
            },
        });
    }

    async setCurrentSession(id: string, institutionId: string) {
        // First, unset all current sessions for this institution
        await prisma.academicSession.updateMany({
            where: { institutionId, isCurrent: true },
            data: { isCurrent: false },
        });

        // Set the new current session
        return prisma.academicSession.update({
            where: { id },
            data: { isCurrent: true },
        });
    }

    // ==================== DASHBOARD STATS ====================

    async getDashboardStats(institutionId: string) {
        const [
            totalUsers,
            totalStudents,
            totalLecturers,
            totalFaculties,
            totalDepartments,
            totalCourses,
            activeSession,
        ] = await Promise.all([
            prisma.user.count({ where: { institutionId } }),
            prisma.user.count({ where: { institutionId, role: 'STUDENT' } }),
            prisma.user.count({ where: { institutionId, role: 'LECTURER' } }),
            prisma.faculty.count({ where: { institutionId } }),
            prisma.department.count({ where: { institutionId } }),
            prisma.course.count({
                where: {
                    department: { institutionId },
                },
            }),
            prisma.academicSession.findFirst({
                where: { institutionId, isCurrent: true },
            }),
        ]);

        return {
            users: {
                total: totalUsers,
                students: totalStudents,
                lecturers: totalLecturers,
                admins: totalUsers - totalStudents - totalLecturers,
            },
            faculties: totalFaculties,
            departments: totalDepartments,
            courses: totalCourses,
            currentSession: activeSession?.name || null,
        };
    }

    // ==================== HELPERS ====================

    private formatUser(user: any) {
        return {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            middleName: user.middleName,
            phone: user.phone,
            avatar: user.avatar,
            role: user.role,
            status: user.status,
            institutionId: user.institutionId,
            departmentId: user.departmentId,
            departmentName: user.department?.name || null,
            facultyId: user.facultyId,
            facultyName: user.faculty?.name || null,
            studentProfile: user.studentProfile,
            lecturerProfile: user.lecturerProfile,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
        };
    }
}

export const adminService = new AdminService();
