// Seed Script for Master Database
// Creates initial Super Admin and sample institution

const { PrismaClient } = require('./prisma/generated/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Seeding Master Database...\n');

    // Create Super Admin
    const hashedPassword = await bcrypt.hash('SuperAdmin@123', 12);

    const superAdmin = await prisma.superAdmin.upsert({
        where: { email: 'admin@univarse.com' },
        update: {},
        create: {
            email: 'admin@univarse.com',
            password: hashedPassword,
            firstName: 'Super',
            lastName: 'Admin',
            isActive: true,
        },
    });

    console.log('✅ Super Admin created:');
    console.log(`   Email: admin@univarse.com`);
    console.log(`   Password: SuperAdmin@123`);
    console.log(`   ID: ${superAdmin.id}\n`);

    // Create Sample Institutions
    const institutions = [
        {
            code: 'DEMO',
            name: 'Demo University',
            subdomain: 'demo',
            dbHost: 'localhost',
            dbPort: 5434,
            dbName: 'univarse_demo',
            dbUser: 'univarse_demo_user',
            dbPassword: 'demo_secret_password',
            isActive: true,
            isProvisioned: false,
        },
        {
            code: 'UNILAG',
            name: 'University of Lagos',
            subdomain: 'unilag',
            dbHost: 'localhost',
            dbPort: 5434,
            dbName: 'univarse_unilag',
            dbUser: 'univarse_unilag_user',
            dbPassword: 'unilag_secret',
            isActive: true,
            isProvisioned: false,
        },
        {
            code: 'OAU',
            name: 'Obafemi Awolowo University',
            subdomain: 'oau',
            dbHost: 'localhost',
            dbPort: 5434,
            dbName: 'univarse_oau',
            dbUser: 'univarse_oau_user',
            dbPassword: 'oau_secret',
            isActive: false,
            isProvisioned: false,
        },
    ];

    for (const inst of institutions) {
        const institution = await prisma.institution.upsert({
            where: { subdomain: inst.subdomain },
            update: {},
            create: inst,
        });
        console.log(`✅ Institution: ${institution.name} (${institution.code})`);
    }

    console.log('');

    // Create Audit Log
    await prisma.platformAuditLog.create({
        data: {
            action: 'SEED_DATABASE',
            description: 'Initial database seed - created Super Admin and sample institutions',
            superAdminId: superAdmin.id,
        },
    });

    console.log('✅ Audit log created\n');
    console.log('🎉 Seeding complete!\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Super Admin Login:');
    console.log('  Email:    admin@univarse.com');
    console.log('  Password: SuperAdmin@123');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
    .catch((e) => {
        console.error('❌ Seed error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
