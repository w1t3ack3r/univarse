import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All admin routes require authentication and ICT_ADMIN role
// Note: These are institution-level admin features (not for SUPER_ADMIN)
router.use(authenticate);
router.use(authorize('ICT_ADMIN'));

// Dashboard
router.get('/dashboard/stats', adminController.getDashboardStats.bind(adminController));

// Users
router.get('/users', adminController.getUsers.bind(adminController));
router.get('/users/:id', adminController.getUserById.bind(adminController));
router.post('/users', adminController.createUser.bind(adminController));
router.put('/users/:id', adminController.updateUser.bind(adminController));
router.delete('/users/:id', adminController.deleteUser.bind(adminController));
router.put('/users/:id/status', adminController.updateUserStatus.bind(adminController));

// Faculties
router.get('/faculties', adminController.getFaculties.bind(adminController));
router.post('/faculties', adminController.createFaculty.bind(adminController));
router.put('/faculties/:id', adminController.updateFaculty.bind(adminController));
router.delete('/faculties/:id', adminController.deleteFaculty.bind(adminController));

// Departments
router.get('/departments', adminController.getDepartments.bind(adminController));
router.post('/departments', adminController.createDepartment.bind(adminController));
router.put('/departments/:id', adminController.updateDepartment.bind(adminController));
router.delete('/departments/:id', adminController.deleteDepartment.bind(adminController));

// Courses
router.get('/courses', adminController.getCourses.bind(adminController));
router.post('/courses', adminController.createCourse.bind(adminController));
router.put('/courses/:id', adminController.updateCourse.bind(adminController));
router.delete('/courses/:id', adminController.deleteCourse.bind(adminController));

// Academic Sessions
router.get('/sessions', adminController.getSessions.bind(adminController));
router.post('/sessions', adminController.createSession.bind(adminController));
router.put('/sessions/:id', adminController.updateSession.bind(adminController));
router.put('/sessions/:id/activate', adminController.setCurrentSession.bind(adminController));

export default router;
