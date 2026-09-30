import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { config } from './config';
import prisma from './config/database';
import authRoutes from './routes/auth.routes';
import institutionRoutes from './routes/institution.routes';
import adminRoutes from './routes/admin.routes';
import superAdminRoutes, { verify2FARoute } from './routes/super-admin.routes';
import { errorHandler } from './middleware/error.middleware';
import { monitoringSocket } from './socket/monitoring.socket';
import { deletionSchedulerService } from './services/deletion-scheduler.service';

const app = express();
const httpServer = createServer(app);

// Security middleware
app.use(helmet());
app.use(cors({
    origin: config.corsOrigin,
    credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    message: { success: false, message: 'Too many requests, please try again later' },
});
app.use(limiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging
if (config.nodeEnv !== 'test') {
    app.use(morgan('dev'));
}

// Health check
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'ok',
        service: 'univarse-auth-service',
        timestamp: new Date().toISOString(),
    });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/institutions', institutionRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/super-admin', superAdminRoutes);
app.use('/api/v1/super-admin', verify2FARoute); // Public 2FA verification route

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handler
app.use(errorHandler);

// Start server
const startServer = async () => {
    try {
        // Test database connection
        await prisma.$connect();
        console.log('✅ Database connected successfully');

        // Initialize Socket.io for real-time monitoring
        monitoringSocket.initialize(httpServer);
        console.log('🔌 WebSocket monitoring enabled');

        // Start deletion warning scheduler
        deletionSchedulerService.start();
        console.log('⏰ Deletion warning scheduler enabled');

        httpServer.listen(config.port, () => {
            console.log(`🚀 UniVarse Auth Service running on port ${config.port}`);
            console.log(`📍 Environment: ${config.nodeEnv}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    monitoringSocket.shutdown();
    await prisma.$disconnect();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    monitoringSocket.shutdown();
    await prisma.$disconnect();
    process.exit(0);
});

startServer();

export default app;
