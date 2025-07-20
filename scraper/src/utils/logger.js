// =============================================
// SCRAPER SERVICE - LOGGING CONFIGURATION
// =============================================

import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================
// LOG CONFIGURATION
// =============================================

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';
const SERVICE_NAME = 'sales-scraper';

// Ensure logs directory exists
const logsDir = join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// =============================================
// CUSTOM FORMATS
// =============================================

// Custom format for console output (development)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    let metaStr = '';
    if (Object.keys(meta).length > 0) {
      metaStr = '\n' + JSON.stringify(meta, null, 2);
    }
    return `${timestamp} [${service || SERVICE_NAME}] ${level}: ${message}${metaStr}`;
  })
);

// Custom format for file output (production)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Custom format for structured logging
const structuredFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
  winston.format.json()
);

// =============================================
// TRANSPORT CONFIGURATION
// =============================================

const transports = [];

// Console transport (always enabled)
transports.push(
  new winston.transports.Console({
    level: LOG_LEVEL,
    format: NODE_ENV === 'production' ? structuredFormat : consoleFormat,
    handleExceptions: true,
    handleRejections: true
  })
);

// File transports (production and development)
if (NODE_ENV === 'production' || process.env.ENABLE_FILE_LOGGING === 'true') {
  // Combined log file
  transports.push(
    new winston.transports.File({
      filename: join(logsDir, 'combined.log'),
      level: 'info',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );

  // Error log file
  transports.push(
    new winston.transports.File({
      filename: join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );

  // Scraper-specific log file
  transports.push(
    new winston.transports.File({
      filename: join(logsDir, 'scraper.log'),
      level: 'debug',
      format: fileFormat,
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 3,
      tailable: true
    })
  );
}

// =============================================
// LOGGER INSTANCE
// =============================================

const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: {
    service: SERVICE_NAME,
    version: '2.0.0',
    environment: NODE_ENV,
    hostname: process.env.HOSTNAME || 'unknown',
    pid: process.pid
  },
  transports,
  exitOnError: false,
  
  // Handle uncaught exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({
      filename: join(logsDir, 'exceptions.log'),
      format: fileFormat
    })
  ],
  
  rejectionHandlers: [
    new winston.transports.File({
      filename: join(logsDir, 'rejections.log'),
      format: fileFormat
    })
  ]
});

// =============================================
// ENHANCED LOGGING METHODS
// =============================================

// Scraper-specific logging methods
logger.scraper = {
  start: (target, options = {}) => {
    logger.info('🕷️ Scraper started', {
      target,
      options,
      action: 'scraper_start',
      timestamp: new Date().toISOString()
    });
  },

  success: (target, stats = {}) => {
    logger.info('✅ Scraper completed successfully', {
      target,
      stats,
      action: 'scraper_success',
      timestamp: new Date().toISOString()
    });
  },

  error: (target, error, context = {}) => {
    logger.error('❌ Scraper failed', {
      target,
      error: error.message,
      stack: error.stack,
      context,
      action: 'scraper_error',
      timestamp: new Date().toISOString()
    });
  },

  page: (url, stats = {}) => {
    logger.debug('📄 Page processed', {
      url,
      stats,
      action: 'page_processed',
      timestamp: new Date().toISOString()
    });
  },

  lead: (lead, source) => {
    logger.debug('👤 Lead extracted', {
      lead: {
        company: lead.company_name,
        phone: lead.phone,
        location: lead.location
      },
      source,
      action: 'lead_extracted',
      timestamp: new Date().toISOString()
    });
  },

  duplicate: (lead, reason) => {
    logger.debug('🔄 Duplicate lead skipped', {
      lead: {
        company: lead.company_name,
        phone: lead.phone
      },
      reason,
      action: 'duplicate_skipped',
      timestamp: new Date().toISOString()
    });
  },

  rateLimit: (delay, reason) => {
    logger.warn('⏱️ Rate limit applied', {
      delay,
      reason,
      action: 'rate_limit',
      timestamp: new Date().toISOString()
    });
  }
};

// Database logging methods
logger.db = {
  connect: (database) => {
    logger.info('🔗 Database connected', {
      database,
      action: 'db_connect',
      timestamp: new Date().toISOString()
    });
  },

  disconnect: (database) => {
    logger.info('🔌 Database disconnected', {
      database,
      action: 'db_disconnect',
      timestamp: new Date().toISOString()
    });
  },

  query: (query, duration, rows) => {
    logger.debug('📊 Database query executed', {
      query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
      duration,
      rows,
      action: 'db_query',
      timestamp: new Date().toISOString()
    });
  },

  error: (error, query) => {
    logger.error('💥 Database error', {
      error: error.message,
      query: query?.substring(0, 100),
      action: 'db_error',
      timestamp: new Date().toISOString()
    });
  }
};

// API logging methods
logger.api = {
  request: (method, url, status, duration, ip) => {
    logger.info('🌐 API request', {
      method,
      url,
      status,
      duration,
      ip,
      action: 'api_request',
      timestamp: new Date().toISOString()
    });
  },

  error: (method, url, error, ip) => {
    logger.error('💥 API error', {
      method,
      url,
      error: error.message,
      ip,
      action: 'api_error',
      timestamp: new Date().toISOString()
    });
  }
};

// Performance logging
logger.performance = {
  metric: (name, value, unit = 'ms', tags = {}) => {
    logger.info('📈 Performance metric', {
      metric: name,
      value,
      unit,
      tags,
      action: 'performance_metric',
      timestamp: new Date().toISOString()
    });
  },

  timer: (name) => {
    const start = Date.now();
    return {
      end: (tags = {}) => {
        const duration = Date.now() - start;
        logger.performance.metric(name, duration, 'ms', tags);
        return duration;
      }
    };
  }
};

// =============================================
// UTILITY METHODS
// =============================================

// Create child logger with additional context
logger.child = (context) => {
  return logger.child(context);
};

// Log startup information
logger.startup = () => {
  logger.info('🚀 Sales Scraper Service starting up', {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    memory: process.memoryUsage(),
    environment: NODE_ENV,
    logLevel: LOG_LEVEL,
    action: 'service_startup',
    timestamp: new Date().toISOString()
  });
};

// Log shutdown information
logger.shutdown = () => {
  logger.info('🛑 Sales Scraper Service shutting down', {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    action: 'service_shutdown',
    timestamp: new Date().toISOString()
  });
};

// =============================================
// EXPORT LOGGER
// =============================================

export default logger;
