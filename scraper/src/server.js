// =============================================
// SALES SCRAPER SERVICE - MAIN SERVER
// =============================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

// Internal imports
import logger from './utils/logger.js';
import database from './database/connection.js';
import redis from './database/redis.js';
import scraperService from './services/scraperService.js';
import metricsService from './services/metricsService.js';
import healthService from './services/healthService.js';

// Routes
import healthRoutes from './routes/health.js';
import scraperRoutes from './routes/scraper.js';
import metricsRoutes from './routes/metrics.js';
import adminRoutes from './routes/admin.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================
// SERVER CONFIGURATION
// =============================================

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// MIDDLEWARE SETUP
// =============================================

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// Compression
app.use(compression());

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request processed', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    // Update metrics
    metricsService.recordRequest(req.method, req.route?.path || req.url, res.statusCode, duration);
  });
  
  next();
});

// =============================================
// ROUTES SETUP
// =============================================

// Health check routes (no auth required)
app.use('/health', healthRoutes);
app.use('/metrics', metricsRoutes);

// Main scraper routes
app.use('/api/scraper', scraperRoutes);
app.use('/api/admin', adminRoutes);

// Serve static files (dashboard)
app.use('/dashboard', express.static(join(__dirname, '../public')));

// Default route
app.get('/', (req, res) => {
  res.json({
    service: 'Sales Scraper',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      metrics: '/metrics',
      scraper: '/api/scraper',
      admin: '/api/admin',
      dashboard: '/dashboard'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `${req.method} ${req.originalUrl} is not a valid endpoint`,
    availableEndpoints: ['/health', '/metrics', '/api/scraper', '/api/admin']
  });
});

// Global error handler
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    body: req.body
  });

  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(error.status || 500).json({
    error: 'Internal server error',
    message: isDevelopment ? error.message : 'Something went wrong',
    timestamp: new Date().toISOString(),
    ...(isDevelopment && { stack: error.stack })
  });
});

// =============================================
// SERVICE INITIALIZATION
// =============================================

async function initializeServices() {
  try {
    logger.info('🚀 Initializing Sales Scraper Service...');

    // Initialize database
    logger.info('📊 Connecting to PostgreSQL...');
    await database.initialize();
    logger.info('✅ PostgreSQL connected successfully');

    // Initialize Redis
    logger.info('🔴 Connecting to Redis...');
    await redis.initialize();
    logger.info('✅ Redis connected successfully');

    // Initialize metrics
    logger.info('📈 Initializing metrics...');
    await metricsService.initialize();
    logger.info('✅ Metrics initialized');

    // Initialize health service
    logger.info('🏥 Initializing health service...');
    await healthService.initialize();
    logger.info('✅ Health service initialized');

    // Initialize scraper service
    logger.info('🕷️ Initializing scraper service...');
    await scraperService.initialize();
    logger.info('✅ Scraper service initialized');

    logger.info('🎉 All services initialized successfully');
    return true;

  } catch (error) {
    logger.error('❌ Failed to initialize services:', error);
    throw error;
  }
}

// =============================================
// SERVER STARTUP
// =============================================

async function startServer() {
  try {
    // Initialize all services
    await initializeServices();

    // Start HTTP server
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Sales Scraper Server running on port ${PORT}`, {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
      });
    });

    // Graceful shutdown handlers
    const shutdown = async (signal) => {
      logger.info(`📪 Received ${signal}, starting graceful shutdown...`);
      
      // Stop accepting new requests
      server.close(async () => {
        logger.info('🔌 HTTP server closed');
        
        try {
          // Stop scraper service
          await scraperService.stop();
          logger.info('🕷️ Scraper service stopped');

          // Close database connections
          await database.close();
          logger.info('📊 Database connections closed');

          // Close Redis connection
          await redis.close();
          logger.info('🔴 Redis connection closed');

          logger.info('✅ Graceful shutdown completed');
          process.exit(0);
          
        } catch (error) {
          logger.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error('⏰ Force shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('💥 Uncaught Exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('💥 Unhandled Rejection at:', {
        promise,
        reason: reason?.message || reason
      });
      process.exit(1);
    });

    return server;

  } catch (error) {
    logger.error('💥 Failed to start server:', error);
    process.exit(1);
  }
}

// =============================================
// STARTUP
// =============================================

// Only start server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

// Export for testing
export default app;
