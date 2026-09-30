import { Request, Response } from 'express';
import { adminService } from '../services/admin.service';
import { Role, UserStatus } from '@prisma/client';

interface AuthRequest extends Request<{ id?: string }> {
    user?: {
        id: string;
        role: Role;
        institutionId: string;
    };
}

export class AdminController {
    // ==================== USERS ====================

    async getUsers(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { role, status, departmentId, search, page, limit } = req.query;

            const result = await adminService.getUsers({
                institutionId,
                role: role as Role | undefined,
                status: status as UserStatus | undefined,
                departmentId: departmentId as string | undefined,
                search: search as string | undefined,
                page: page ? parseInt(page as string) : undefined,
                limit: limit ? parseInt(limit as string) : undefined,
            });

            res.json({ success: true, data: result });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async getUserById(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { id } = req.params;

            const user = await adminService.getUserById(id!, institutionId);
            res.json({ success: true, data: user });
        } catch (error: any) {
            res.status(404).json({ success: false, message: error.message });
        }
    }

    async createUser(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const userData = { ...req.body, institutionId };

            const user = await adminService.createUser(userData);
            res.status(201).json({ success: true, data: user, message: 'User created successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async updateUser(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { id } = req.params;

            const user = await adminService.updateUser(id!, institutionId, req.body);
            res.json({ success: true, data: user, message: 'User updated successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async deleteUser(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { id } = req.params;

            await adminService.deleteUser(id!, institutionId);
            res.json({ success: true, message: 'User deleted successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async updateUserStatus(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { id } = req.params;
            const { status } = req.body;

            const user = await adminService.updateUserStatus(id!, institutionId, status);
            res.json({ success: true, data: user, message: 'User status updated successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    // ==================== FACULTIES ====================

    async getFaculties(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const faculties = await adminService.getFaculties(institutionId);
            res.json({ success: true, data: faculties });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async createFaculty(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const faculty = await adminService.createFaculty({ ...req.body, institutionId });
            res.status(201).json({ success: true, data: faculty, message: 'Faculty created successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async updateFaculty(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            const faculty = await adminService.updateFaculty(id!, req.body);
            res.json({ success: true, data: faculty, message: 'Faculty updated successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async deleteFaculty(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            await adminService.deleteFaculty(id!);
            res.json({ success: true, message: 'Faculty deleted successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    // ==================== DEPARTMENTS ====================

    async getDepartments(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { facultyId } = req.query;

            const departments = await adminService.getDepartments(institutionId, facultyId as string | undefined);
            res.json({ success: true, data: departments });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async createDepartment(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const department = await adminService.createDepartment({ ...req.body, institutionId });
            res.status(201).json({ success: true, data: department, message: 'Department created successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async updateDepartment(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            const department = await adminService.updateDepartment(id!, req.body);
            res.json({ success: true, data: department, message: 'Department updated successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async deleteDepartment(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            await adminService.deleteDepartment(id!);
            res.json({ success: true, message: 'Department deleted successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    // ==================== COURSES ====================

    async getCourses(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { departmentId, level, search } = req.query;

            const courses = await adminService.getCourses(institutionId, {
                departmentId: departmentId as string | undefined,
                level: level ? parseInt(level as string) : undefined,
                search: search as string | undefined,
            });
            res.json({ success: true, data: courses });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async createCourse(req: AuthRequest, res: Response) {
        try {
            const course = await adminService.createCourse(req.body);
            res.status(201).json({ success: true, data: course, message: 'Course created successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async updateCourse(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            const course = await adminService.updateCourse(id!, req.body);
            res.json({ success: true, data: course, message: 'Course updated successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async deleteCourse(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            await adminService.deleteCourse(id!);
            res.json({ success: true, message: 'Course deleted successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    // ==================== ACADEMIC SESSIONS ====================

    async getSessions(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const sessions = await adminService.getSessions(institutionId);
            res.json({ success: true, data: sessions });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async createSession(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const session = await adminService.createSession({ ...req.body, institutionId });
            res.status(201).json({ success: true, data: session, message: 'Session created successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async updateSession(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            const session = await adminService.updateSession(id!, req.body);
            res.json({ success: true, data: session, message: 'Session updated successfully' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    async setCurrentSession(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const { id } = req.params;

            const session = await adminService.setCurrentSession(id!, institutionId);
            res.json({ success: true, data: session, message: 'Session set as current' });
        } catch (error: any) {
            res.status(400).json({ success: false, message: error.message });
        }
    }

    // ==================== DASHBOARD ====================

    async getDashboardStats(req: AuthRequest, res: Response) {
        try {
            const institutionId = req.user!.institutionId;
            const stats = await adminService.getDashboardStats(institutionId);
            res.json({ success: true, data: stats });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
}

export const adminController = new AdminController();
