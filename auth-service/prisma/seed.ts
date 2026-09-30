import { PrismaClient, Role, UserStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Starting database seed...\n');

    // Create sample institutions
    const unilag = await prisma.institution.upsert({
        where: { code: 'UNILAG' },
        update: {},
        create: {
            name: 'University of Lagos',
            code: 'UNILAG',
            email: 'info@unilag.edu.ng',
            website: 'https://unilag.edu.ng',
            address: 'Akoka, Yaba, Lagos',
            phone: '+234-1-280-2439',
            isActive: true,
        },
    });
    console.log('✅ Created institution:', unilag.name);

    const oau = await prisma.institution.upsert({
        where: { code: 'OAU' },
        update: {},
        create: {
            name: 'Obafemi Awolowo University',
            code: 'OAU',
            email: 'info@oau.edu.ng',
            website: 'https://oau.edu.ng',
            address: 'Ile-Ife, Osun State',
            phone: '+234-36-230-290',
            isActive: true,
        },
    });
    console.log('✅ Created institution:', oau.name);

    // Create faculties for UNILAG
    const scienceFaculty = await prisma.faculty.upsert({
        where: { code_institutionId: { code: 'SCI', institutionId: unilag.id } },
        update: {},
        create: {
            name: 'Faculty of Science',
            code: 'SCI',
            description: 'Faculty of Science at UNILAG',
            institutionId: unilag.id,
        },
    });
    console.log('✅ Created faculty:', scienceFaculty.name);

    const engineeringFaculty = await prisma.faculty.upsert({
        where: { code_institutionId: { code: 'ENG', institutionId: unilag.id } },
        update: {},
        create: {
            name: 'Faculty of Engineering',
            code: 'ENG',
            description: 'Faculty of Engineering at UNILAG',
            institutionId: unilag.id,
        },
    });
    console.log('✅ Created faculty:', engineeringFaculty.name);

    // Create departments
    const cscDept = await prisma.department.upsert({
        where: { code_institutionId: { code: 'CSC', institutionId: unilag.id } },
        update: {},
        create: {
            name: 'Computer Science',
            code: 'CSC',
            description: 'Department of Computer Science',
            facultyId: scienceFaculty.id,
            institutionId: unilag.id,
        },
    });
    console.log('✅ Created department:', cscDept.name);

    const eeDept = await prisma.department.upsert({
        where: { code_institutionId: { code: 'EEE', institutionId: unilag.id } },
        update: {},
        create: {
            name: 'Electrical and Electronics Engineering',
            code: 'EEE',
            description: 'Department of Electrical Engineering',
            facultyId: engineeringFaculty.id,
            institutionId: unilag.id,
        },
    });
    console.log('✅ Created department:', eeDept.name);

    // Create academic session
    const session = await prisma.academicSession.upsert({
        where: { id: 'session-2025-2026' },
        update: {},
        create: {
            id: 'session-2025-2026',
            name: '2025/2026',
            startDate: new Date('2025-09-01'),
            endDate: new Date('2026-07-31'),
            isCurrent: true,
            institutionId: unilag.id,
        },
    });
    console.log('✅ Created session:', session.name);

    // Create Platform Super Admin (no institution)
    const hashedPassword = await bcrypt.hash('SuperAdmin@123', 12);
    const superAdmin = await prisma.user.upsert({
        where: { id: 'super-admin-1' },
        update: {},
        create: {
            id: 'super-admin-1',
            email: 'admin@univarse.com',
            password: hashedPassword,
            firstName: 'Super',
            lastName: 'Admin',
            role: Role.SUPER_ADMIN,
            status: UserStatus.ACTIVE,
            emailVerified: true,
            institutionId: null, // Platform-level admin
        },
    });
    console.log('✅ Created Super Admin:', superAdmin.email);

    // Create ICT Admin for UNILAG
    const ictAdminPassword = await bcrypt.hash('IctAdmin@123', 12);
    const ictAdmin = await prisma.user.upsert({
        where: { id: 'ict-admin-unilag' },
        update: {},
        create: {
            id: 'ict-admin-unilag',
            email: 'ict@unilag.edu.ng',
            password: ictAdminPassword,
            firstName: 'ICT',
            lastName: 'Administrator',
            role: Role.ICT_ADMIN,
            status: UserStatus.ACTIVE,
            emailVerified: true,
            institutionId: unilag.id,
        },
    });
    console.log('✅ Created ICT Admin:', ictAdmin.email);

    // Create a sample lecturer
    const lecturerPassword = await bcrypt.hash('Lecturer@123', 12);
    const lecturer = await prisma.user.upsert({
        where: { id: 'lecturer-1' },
        update: {},
        create: {
            id: 'lecturer-1',
            email: 'dr.adewale@unilag.edu.ng',
            password: lecturerPassword,
            firstName: 'Oluwaseun',
            lastName: 'Adewale',
            role: Role.LECTURER,
            status: UserStatus.ACTIVE,
            emailVerified: true,
            institutionId: unilag.id,
            departmentId: cscDept.id,
            facultyId: scienceFaculty.id,
        },
    });

    await prisma.lecturerProfile.upsert({
        where: { userId: lecturer.id },
        update: {},
        create: {
            staffId: 'STF/CSC/001',
            title: 'Dr.',
            rank: 'Senior Lecturer',
            specialization: 'Artificial Intelligence',
            userId: lecturer.id,
        },
    });
    console.log('✅ Created Lecturer:', lecturer.email);

    // Create a sample student
    const studentPassword = await bcrypt.hash('Student@123', 12);
    const student = await prisma.user.upsert({
        where: { id: 'student-1' },
        update: {},
        create: {
            id: 'student-1',
            email: 'john.doe@student.unilag.edu.ng',
            password: studentPassword,
            firstName: 'John',
            lastName: 'Doe',
            role: Role.STUDENT,
            status: UserStatus.ACTIVE,
            emailVerified: true,
            institutionId: unilag.id,
            departmentId: cscDept.id,
            facultyId: scienceFaculty.id,
        },
    });

    await prisma.studentProfile.upsert({
        where: { userId: student.id },
        update: {},
        create: {
            matricNumber: '2020/CSC/001',
            level: 400,
            enrollmentYear: 2020,
            cgpa: 4.25,
            userId: student.id,
        },
    });
    console.log('✅ Created Student:', student.email);

    // Create a sample course
    const course = await prisma.course.upsert({
        where: { code_departmentId: { code: 'CSC401', departmentId: cscDept.id } },
        update: {},
        create: {
            code: 'CSC401',
            title: 'Artificial Intelligence',
            description: 'Introduction to AI concepts and machine learning',
            creditUnits: 3,
            level: 400,
            departmentId: cscDept.id,
            lecturerId: (await prisma.lecturerProfile.findUnique({ where: { userId: lecturer.id } }))?.id,
            isActive: true,
        },
    });
    console.log('✅ Created Course:', course.code, '-', course.title);

    console.log('\n🎉 Database seeding completed!\n');
    console.log('📋 Test Credentials:');
    console.log('─'.repeat(50));
    console.log('Super Admin:  admin@univarse.com / SuperAdmin@123');
    console.log('ICT Admin:    ict@unilag.edu.ng / IctAdmin@123');
    console.log('Lecturer:     dr.adewale@unilag.edu.ng / Lecturer@123');
    console.log('Student:      john.doe@student.unilag.edu.ng / Student@123');
    console.log('─'.repeat(50));
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
