// Database Provisioning Service
// Creates and configures tenant databases

import { Pool } from 'pg';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

interface ProvisionConfig {
    dbName: string;
    dbUser: string;
    dbPassword: string;
}

interface ProvisionResult {
    success: boolean;
    message: string;
    details?: {
        database: string;
        user: string;
        migrated: boolean;
    };
}

class DatabaseProvisioningService {
    private adminPool: Pool;

    constructor() {
        // Connect to tenant-db as admin to create new databases
        this.adminPool = new Pool({
            host: process.env.TENANT_DB_HOST || 'localhost',
            port: parseInt(process.env.TENANT_DB_PORT || '5434'),
            database: 'postgres', // Connect to default database for admin operations
            user: process.env.TENANT_DB_ADMIN_USER || 'univarse_tenant',
            password: process.env.TENANT_DB_ADMIN_PASSWORD || 'tenantsecret',
        });
    }

    /**
     * Provision a new database for an institution
     */
    async provisionDatabase(config: ProvisionConfig): Promise<ProvisionResult> {
        const client = await this.adminPool.connect();

        try {
            // 1. Check if database already exists
            const dbExists = await client.query(
                `SELECT 1 FROM pg_database WHERE datname = $1`,
                [config.dbName]
            );

            if (dbExists.rows.length > 0) {
                return {
                    success: false,
                    message: `Database ${config.dbName} already exists`,
                };
            }

            // 2. Create the database
            // Note: DB names can't be parameterized, so we validate first
            if (!/^[a-z0-9_]+$/.test(config.dbName)) {
                return {
                    success: false,
                    message: 'Invalid database name. Use only lowercase letters, numbers, and underscores.',
                };
            }

            await client.query(`CREATE DATABASE ${config.dbName}`);
            console.log(`[Provisioning] Created database: ${config.dbName}`);

            // 3. Check if user exists, if not create
            const userExists = await client.query(
                `SELECT 1 FROM pg_roles WHERE rolname = $1`,
                [config.dbUser]
            );

            if (userExists.rows.length === 0) {
                // Validate user name
                if (!/^[a-z0-9_]+$/.test(config.dbUser)) {
                    return {
                        success: false,
                        message: 'Invalid user name. Use only lowercase letters, numbers, and underscores.',
                    };
                }

                // Create user with password
                await client.query(
                    `CREATE USER ${config.dbUser} WITH PASSWORD '${config.dbPassword}'`
                );
                console.log(`[Provisioning] Created user: ${config.dbUser}`);
            }

            // 4. Grant privileges on database
            await client.query(
                `GRANT ALL PRIVILEGES ON DATABASE ${config.dbName} TO ${config.dbUser}`
            );
            console.log(`[Provisioning] Granted privileges to ${config.dbUser} on ${config.dbName}`);

            // 5. Connect to the new database to grant schema privileges
            client.release(); // Release the postgres connection

            const newDbPool = new Pool({
                host: process.env.TENANT_DB_HOST || 'localhost',
                port: parseInt(process.env.TENANT_DB_PORT || '5434'),
                database: config.dbName,
                user: process.env.TENANT_DB_ADMIN_USER || 'univarse_tenant',
                password: process.env.TENANT_DB_ADMIN_PASSWORD || 'tenantsecret',
            });

            const newDbClient = await newDbPool.connect();
            try {
                // Grant schema permissions
                await newDbClient.query(`GRANT ALL ON SCHEMA public TO ${config.dbUser}`);
                await newDbClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${config.dbUser}`);
                await newDbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${config.dbUser}`);
                console.log(`[Provisioning] Granted schema privileges to ${config.dbUser}`);
            } finally {
                newDbClient.release();
                await newDbPool.end();
            }

            // 6. Run Prisma migrations on the new database
            const migrateResult = await this.runMigrations(config);

            return {
                success: true,
                message: 'Database provisioned successfully',
                details: {
                    database: config.dbName,
                    user: config.dbUser,
                    migrated: migrateResult,
                },
            };
        } catch (error: any) {
            console.error('[Provisioning] Error:', error.message);
            return {
                success: false,
                message: error.message || 'Failed to provision database',
            };
        }
        // Note: client was released after granting DB privileges
    }

    /**
     * Run Prisma migrations on a tenant database
     */
    private async runMigrations(config: ProvisionConfig): Promise<boolean> {
        try {
            // URL encode password to handle special characters
            const encodedPassword = encodeURIComponent(config.dbPassword);
            const dbUrl = `postgresql://${config.dbUser}:${encodedPassword}@${process.env.TENANT_DB_HOST || 'localhost'}:${process.env.TENANT_DB_PORT || '5434'}/${config.dbName}?schema=public`;

            // Point to the tenant prisma schema
            const prismaSchemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');

            // Run Prisma migrate deploy
            const { stdout, stderr } = await execAsync(
                `npx prisma migrate deploy --schema="${prismaSchemaPath}"`,
                {
                    env: {
                        ...process.env,
                        DATABASE_URL: dbUrl,
                    },
                }
            );

            console.log(`[Provisioning] Migrations output:`, stdout);
            if (stderr) console.log(`[Provisioning] Migrations stderr:`, stderr);

            return true;
        } catch (error: any) {
            console.error('[Provisioning] Migration error:', error.message);
            // Don't fail the whole provisioning if migrations fail
            // The database is still created and can be migrated later
            return false;
        }
    }

    /**
     * Drop a tenant database (use with caution!)
     */
    async dropDatabase(dbName: string, dbUser?: string): Promise<boolean> {
        const client = await this.adminPool.connect();

        try {
            // Terminate active connections
            await client.query(`
                SELECT pg_terminate_backend(pg_stat_activity.pid)
                FROM pg_stat_activity
                WHERE pg_stat_activity.datname = $1
                AND pid <> pg_backend_pid()
            `, [dbName]);

            // Drop the database
            await client.query(`DROP DATABASE IF EXISTS ${dbName}`);
            console.log(`[Provisioning] Dropped database: ${dbName}`);

            // Drop the user if specified
            if (dbUser) {
                await client.query(`DROP USER IF EXISTS ${dbUser}`);
                console.log(`[Provisioning] Dropped user: ${dbUser}`);
            }

            return true;
        } catch (error: any) {
            console.error('[Provisioning] Drop error:', error.message);
            return false;
        } finally {
            client.release();
        }
    }

    /**
     * Check if a database exists
     */
    async databaseExists(dbName: string): Promise<boolean> {
        const client = await this.adminPool.connect();
        try {
            const result = await client.query(
                `SELECT 1 FROM pg_database WHERE datname = $1`,
                [dbName]
            );
            return result.rows.length > 0;
        } finally {
            client.release();
        }
    }

    /**
     * Close the admin connection pool
     */
    async close(): Promise<void> {
        await this.adminPool.end();
    }
}

export const dbProvisioningService = new DatabaseProvisioningService();
