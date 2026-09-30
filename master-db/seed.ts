// Seed Script for Master Database
// Creates initial Super Admin and sample institution

import { PrismaClient } from './prisma/generated/client';
import bcrypt from 'bcryptjs';

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

    // Create Sample Institution
    const institution = await prisma.institution.upsert({
        where: { subdomain: 'demo' },
        update: {},
        create: {
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
    });

    console.log('✅ Sample Institution created:');
    console.log(`   Name: ${institution.name}`);
    console.log(`   Code: ${institution.code}`);
    console.log(`   Subdomain: ${institution.subdomain}.univarse.com`);
    console.log(`   ID: ${institution.id}\n`);

    // Create Audit Log
    await prisma.platformAuditLog.create({
        data: {
            action: 'SEED_DATABASE',
            description: 'Initial database seed - created Super Admin and sample institution',
            superAdminId: superAdmin.id,
            institutionId: institution.id,
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
