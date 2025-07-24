// src/server.js
// =============================================
// SALES SCRAPER SERVICE - MAIN SERVER
// =============================================

console.log('=== STARTING SALES SCRAPER SERVICE ===');
console.log('Node version:', process.version);
console.log('Environment:', process.env.NODE_ENV);

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');

//
// === SAFE MODULE LOADING ===
//
let logger, database, redis, scraperService;
let healthRoutes, scraperRoutes, metricsRoutes, adminRoutes;

// 1) Logger
try {
  logger = require('./utils/logger');
  logger.info('✅ Logger loaded successfully');
} catch (err) {
  console.error('⚠️ Logger failed to load:', err.message);
  logger = console;
}

// 2) Database
try {
  database = require('./database/connection');
  logger.info('✅ Database module loaded');
} catch (err) {
  logger.error('⚠️ Database module failed:', err.message);
  database = null;
}

// 3) Redis
try {
  redis = require('./database/redis');
  logger.info('✅ Redis module loaded');
} catch (err) {
  logger.error('⚠️ Redis module failed:', err.message);
  redis = null;
}

// 4) Routes (only require, not mount yet)
try {
  healthRoutes = require('./routes/health');
  logger.info('✅ Health routes loaded');
} catch (err) {
  logger.error('⚠️ Health routes failed:', err.message);
}

try {
  scraperRoutes = require('./routes/scraper');
  logger.info('✅ Scraper routes loaded');
} catch (err) {
  logger.error('⚠️ Scraper routes failed:', err.message);
}

try {
  metricsRoutes = require('./routes/metrics');
  logger.info('✅ Metrics routes loaded');
} catch (err) {
  logger.error('⚠️ Metrics routes failed:', err.message);
}

try {
  adminRoutes = require('./routes/admin');
  logger.info('✅ Admin routes loaded');
} catch (err) {
  logger.error('⚠️ Admin routes failed:', err.message);
}

//
// === INITIALIZE SCRAPER SERVICE ===
//
(async () => {
  try {
    // Importa e instancia tu scraper
    const { initialize: initScraperService } = require('./services/scraperService');
    scraperService = initScraperService(database, redis, logger);

    console.log('🔍 initialize() ha sido invocado');
    await scraperService.initialize();
    logger.info('✅ Scraper Service initialized successfully');
  } catch (err) {
    console.error('❌ Scraper Service failed to initialize:', err);
    process.exit(1);
  }

  //
  // === EXPRESS SETUP ===
  //
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Montar rutas
  if (healthRoutes)   app.use('/api/health',  healthRoutes);
  if (scraperRoutes)  app.use('/api/scraper', scraperRoutes);
  if (metricsRoutes)  app.use('/api/metrics', metricsRoutes);
  if (adminRoutes)    app.use('/api/admin',   adminRoutes);

  // Arrancar servidor
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
})();
