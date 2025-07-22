// =============================================
// SALES SCRAPER SERVICE - MAIN SERVER
// =============================================
console.log('=== STARTING SALES SCRAPER SERVICE ===');
console.log('Node version:', process.version);
console.log('Environment:', process.env.NODE_ENV);

// Import required modules
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize variables for modules that might fail
let logger, database, redis, scraperService, metricsService, healthService;
let healthRoutes, scraperRoutes, metricsRoutes, adminRoutes;

// =============================================
// SAFE MODULE LOADING
// =============================================

// Load logger
try {
  logger = require('./utils/logger.js');
  console.log('✅ Logger loaded successfully');
} catch (error) {
  console.error('⚠️ Logger failed to load:', error.message);
  // Create fallback logger
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    debug: (...args) => console.log('[DEBUG]', ...args)
  };
}

// Load database connection
try {
  database = require('./database/connection.js');
  logger.info('✅ Database module loaded');
} catch (error) {
  logger.error('⚠️ Database module failed:', error.message);
  database = null;
}

// Load Redis
try {
  redis = require('./database/redis.js');
  logger.info('✅ Redis module loaded');
} catch (error) {
  logger.error('⚠️ Redis module failed:', error.message);
  redis = null;
}

// Load services
try {
  scraperService = require('./services/scraperService.js');
  logger.info('✅ Scraper service loaded');
} catch (error) {
  logger.error('⚠️ Scraper service failed:', error.message);
}

try {
  metricsService = require('./services/metricsService.js');
  logger.info('✅ Metrics service loaded');
} catch (error) {
  logger.error('⚠️ Metrics service failed:', error.message);
}

try {
  healthService = require('./services/healthService.js');
  logger.info('✅ Health service loaded');
} catch (error) {
  logger.error('⚠️ Health service failed:', error.message);
}

// Load routes
try {
  healthRoutes = require('./routes/health.js');
  logger.info('✅ Health routes loaded');
} catch (error) {
  logger.error('⚠️ Health routes failed:', error.message);
}

try {
  scraperRoutes = require('./routes/scraper.js');
  logger.info('✅ Scraper routes loaded');
} catch (error) {
  logger.error('⚠️ Scraper routes failed:', error.message);
}

try {
  metricsRoutes = require('./routes/metrics.js');
  logger.info('✅ Metrics routes loaded');
} catch (error) {
  logger.error('⚠️ Metrics routes failed:', error.message);
}

try {
  adminRoutes = require('./routes/admin.js');
  logger.info('✅ Admin routes loaded');
} catch (error) {
  logger.error('⚠️ Admin routes failed:', error.message);
}

// =============================================
// EXPRESS SETUP
// =============================================
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// =============================================
// ROUTES
// =============================================

// Basic health check (always available)
app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      version: '1.0.0',
      services: {
        database: database ? 'loaded' : 'not loaded',
        redis: redis ? 'loaded' : 'not loaded',
        scraper: scraperService ? 'loaded' : 'not loaded'
      }
    };

    // If healthService is available, use it for more detailed info
    if (healthService && typeof healthService.getHealth === 'function') {
      try {
        const detailedHealth = await healthService.getHealth();
        Object.assign(health, detailedHealth);
      } catch (error) {
        health.healthServiceError = error.message;
      }
    }

    res.json(health);
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Sales Scraper API',
    version: '1.0.0',
    endpoints: [
      '/health',
      '/api/scraper',
      '/api/metrics',
      '/api/admin'
    ],
    documentation: '/api/docs'
  });
});

// Mount routes if they loaded successfully
if (healthRoutes) {
  app.use('/api/health', healthRoutes);
  logger.info('Health routes mounted at /api/health');
}

if (scraperRoutes) {
  app.use('/api/scraper', scraperRoutes);
  logger.info('Scraper routes mounted at /api/scraper');
}

if (metricsRoutes) {
  app.use('/api/metrics', metricsRoutes);
  logger.info('Metrics routes mounted at /api/metrics');
}

if (adminRoutes) {
  app.use('/api/admin', adminRoutes);
  logger.info('Admin routes mounted at /api/admin');
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    availableEndpoints: ['/health', '/api/scraper', '/api/metrics', '/api/admin']
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// =============================================
// SERVER INITIALIZATION
// =============================================
async function startServer() {
  try {
    // Initialize database if available
    if (database && typeof database.initialize === 'function') {
      try {
        await database.initialize();
        logger.info('✅ Database initialized');
      } catch (error) {
        logger.error('❌ Database initialization failed:', error.message);
        // Continue anyway - the app can work without DB
      }
    }

    // Initialize Redis if available
    if (redis && typeof redis.connect === 'function') {
      try {
        await redis.connect();
        logger.info('✅ Redis connected');
      } catch (error) {
        logger.error('❌ Redis connection failed:', error.message);
        // Continue anyway - the app can work without Redis
      }
    }

    // Initialize Scraper Service if available
    if (scraperService) {
      try {
        // El scraperService necesita ser inicializado con database, redis y logger
        const scraperInstance = scraperService.initialize(database, redis, logger);
        
        if (scraperInstance && typeof scraperInstance.initialize === 'function') {
          await scraperInstance.initialize();
          logger.info('✅ Scraper Service initialized');
        }
      } catch (error) {
        logger.error('❌ Scraper Service initialization failed:', error.message);
        // Continue anyway - the app can work but scraping won't be available
      }
    }

    // Initialize Metrics Service if available
    if (metricsService && typeof metricsService.initialize === 'function') {
      try {
        await metricsService.initialize();
        logger.info('✅ Metrics Service initialized');
      } catch (error) {
        logger.error('❌ Metrics Service initialization failed:', error.message);
      }
    }

    // Initialize Health Service if available
    if (healthService && typeof healthService.initialize === 'function') {
      try {
        await healthService.initialize();
        logger.info('✅ Health Service initialized');
      } catch (error) {
        logger.error('❌ Health Service initialization failed:', error.message);
      }
    }

    // Start Express server
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`✅ Server running on port ${PORT}`);
      logger.info(`Health check: http://localhost:${PORT}/health`);
      logger.info('=== SERVER IS READY ===');
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop services
      if (scraperService) {
        const instance = scraperService.getInstance();
        if (instance && typeof instance.stop === 'function') {
          await instance.stop();
        }
      }

      if (metricsService && typeof metricsService.stop === 'function') {
        await metricsService.stop();
      }

      if (healthService && typeof healthService.stop === 'function') {
        await healthService.stop();
      }

      // Close database connections
      if (database && typeof database.close === 'function') {
        await database.close();
      }
      if (redis && typeof redis.disconnect === 'function') {
        await redis.disconnect();
      }

      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit - try to keep running
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled Rejection:', error);
  // Don't exit - try to keep running
});

// Start the server
startServer().catch(error => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});

// Keep-alive logging (every 30 seconds in production)
if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    logger.info(`Server alive - Uptime: ${Math.floor(process.uptime())}s`);
  }, 30000);
}
