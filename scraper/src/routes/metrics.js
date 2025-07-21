// =============================================
// METRICS ROUTES - PROMETHEUS COMPATIBLE
// =============================================

const express = require('express');
const client = require('prom-client');

const router = express.Router();

// =============================================
// PROMETHEUS METRICS SETUP
// =============================================

// Create a Registry
const register = new client.Registry();

// Add default Node.js metrics
client.collectDefaultMetrics({
  register,
  prefix: 'scraper_nodejs_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// =============================================
// CUSTOM METRICS DEFINITIONS
// =============================================

// HTTP Request metrics
const httpRequestsTotal = new client.Counter({
  name: 'scraper_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const httpRequestDuration = new client.Histogram({
  name: 'scraper_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [register]
});

// Scraping metrics
const scrapingSessionsTotal = new client.Counter({
  name: 'scraper_sessions_total',
  help: 'Total number of scraping sessions',
  labelNames: ['source', 'status'],
  registers: [register]
});

const scrapingSessionDuration = new client.Histogram({
  name: 'scraper_session_duration_seconds',
  help: 'Duration of scraping sessions in seconds',
  labelNames: ['source', 'status'],
  buckets: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  registers: [register]
});

const leadsScrapedTotal = new client.Counter({
  name: 'scraper_leads_total',
  help: 'Total number of leads scraped',
  labelNames: ['source', 'status'],
  registers: [register]
});

const leadsCurrentTotal = new client.Gauge({
  name: 'scraper_leads_current_total',
  help: 'Current total number of leads in database',
  labelNames: ['source', 'status'],
  registers: [register]
});

// Database metrics
const databaseConnections = new client.Gauge({
  name: 'scraper_database_connections',
  help: 'Number of database connections',
  labelNames: ['type'],
  registers: [register]
});

const databaseQueryDuration = new client.Histogram({
  name: 'scraper_database_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
});

// Redis metrics
const redisOperationDuration = new client.Histogram({
  name: 'scraper_redis_operation_duration_seconds',
  help: 'Duration of Redis operations in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register]
});

const redisConnected = new client.Gauge({
  name: 'scraper_redis_connected',
  help: 'Redis connection status (1 = connected, 0 = disconnected)',
  registers: [register]
});

// System metrics
const systemInfo = new client.Gauge({
  name: 'scraper_system_info',
  help: 'System information',
  labelNames: ['version', 'platform', 'arch', 'node_version'],
  registers: [register]
});

// =============================================
// LAZY LOADING OF DEPENDENCIES
// =============================================

// Lazy load dependencies to avoid circular imports
function getDatabase() {
  return require('../database/connection');
}

function getRedis() {
  return require('../database/redis');
}

function getScraperService() {
  const scraperModule = require('../services/scraperService');
  return scraperModule.getInstance ? scraperModule.getInstance() : null;
}

// =============================================
// METRICS ENDPOINTS
// =============================================

// Prometheus metrics endpoint
router.get('/', async (req, res) => {
  try {
    // Update dynamic metrics before serving
    await updateDynamicMetrics();
    
    res.set('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.send(metrics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to collect metrics',
      message: error.message
    });
  }
});

// Health metrics in JSON format
router.get('/health', async (req, res) => {
  try {
    const metrics = await collectHealthMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to collect health metrics',
      message: error.message
    });
  }
});

// Scraper-specific metrics
router.get('/scraper', async (req, res) => {
  try {
    const metrics = await collectScraperMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to collect scraper metrics',
      message: error.message
    });
  }
});

// Database metrics
router.get('/database', async (req, res) => {
  try {
    const metrics = await collectDatabaseMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to collect database metrics',
      message: error.message
    });
  }
});

// =============================================
// METRICS COLLECTION FUNCTIONS
// =============================================

async function updateDynamicMetrics() {
  try {
    const database = getDatabase();
    const redis = getRedis();

    // Update database connection metrics
    if (database && database.pool) {
      const poolStats = database.pool;
      databaseConnections.set({ type: 'total' }, poolStats.totalCount || 0);
      databaseConnections.set({ type: 'idle' }, poolStats.idleCount || 0);
      databaseConnections.set({ type: 'waiting' }, poolStats.waitingCount || 0);
    }

    // Update Redis connection status
    const redisClient = redis && redis.getClient ? redis.getClient() : null;
    redisConnected.set(redisClient && redisClient.isOpen ? 1 : 0);

    // Update current leads count
    if (database && database.pool) {
      try {
        const leadsStats = await database.query(`
          SELECT 
            source,
            status,
            COUNT(*) as count
          FROM scraping_results
          GROUP BY source, status
        `);

        // Reset gauges and set new values
        leadsCurrentTotal.reset();
        for (const row of leadsStats.rows) {
          leadsCurrentTotal.set(
            { source: row.source || 'unknown', status: row.status || 'unknown' },
            parseInt(row.count)
          );
        }
      } catch (error) {
        console.error('Error updating leads metrics:', error);
      }
    }

    // Update system info
    systemInfo.set({
      version: '2.0.0',
      platform: process.platform,
      arch: process.arch,
      node_version: process.version
    }, 1);

  } catch (error) {
    console.error('Error updating dynamic metrics:', error);
  }
}

async function collectHealthMetrics() {
  const metrics = {
    timestamp: new Date().toISOString(),
    service: 'sales-scraper',
    version: '2.0.0',
    uptime: process.uptime(),
    system: {
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      platform: process.platform,
      nodeVersion: process.version
    }
  };

  try {
    const database = getDatabase();
    const redis = getRedis();
    const scraperService = getScraperService();

    // Database health
    if (database && database.pool) {
      try {
        const result = await database.query('SELECT NOW()');
        metrics.database = {
          status: 'connected',
          timestamp: result.rows[0].now
        };
      } catch (error) {
        metrics.database = {
          status: 'error',
          error: error.message
        };
      }
    } else {
      metrics.database = { status: 'not configured' };
    }

    // Redis health
    const redisClient = redis && redis.getClient ? redis.getClient() : null;
    if (redisClient) {
      try {
        await redisClient.ping();
        metrics.cache = { status: 'connected' };
      } catch (error) {
        metrics.cache = {
          status: 'error',
          error: error.message
        };
      }
    } else {
      metrics.cache = { status: 'not configured' };
    }

    // Scraper status
    if (scraperService) {
      metrics.scraper = await scraperService.getStatus();
    } else {
      metrics.scraper = { status: 'not initialized' };
    }

  } catch (error) {
    metrics.error = error.message;
  }

  return metrics;
}

async function collectScraperMetrics() {
  try {
    const database = getDatabase();
    
    if (!database || !database.pool) {
      return {
        error: 'Database not available',
        timestamp: new Date().toISOString()
      };
    }

    const stats = await database.query(`
      SELECT 
        source,
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as leads_today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as leads_week,
        COUNT(*) FILTER (WHERE phone IS NOT NULL) as leads_with_phone,
        COUNT(*) FILTER (WHERE email IS NOT NULL) as leads_with_email,
        MAX(created_at) as last_scrape
      FROM scraping_results
      GROUP BY source
    `);

    const sessionStats = await database.query(`
      SELECT 
        status,
        COUNT(*) as count,
        AVG(duration_seconds) as avg_duration,
        MIN(started_at) as first_session,
        MAX(completed_at) as last_session
      FROM scraping_sessions
      WHERE uuid IS NOT NULL
      GROUP BY status
    `);

    return {
      timestamp: new Date().toISOString(),
      leads: {
        bySource: stats.rows,
        summary: {
          total: stats.rows.reduce((sum, row) => sum + parseInt(row.total_leads), 0),
          today: stats.rows.reduce((sum, row) => sum + parseInt(row.leads_today), 0),
          week: stats.rows.reduce((sum, row) => sum + parseInt(row.leads_week), 0)
        }
      },
      sessions: {
        byStatus: sessionStats.rows,
        summary: {
          total: sessionStats.rows.reduce((sum, row) => sum + parseInt(row.count), 0)
        }
      }
    };

  } catch (error) {
    return {
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

async function collectDatabaseMetrics() {
  try {
    const database = getDatabase();
    
    if (!database || !database.pool) {
      return {
        error: 'Database not available',
        timestamp: new Date().toISOString()
      };
    }

    const poolStats = {
      totalCount: database.pool.totalCount || 0,
      idleCount: database.pool.idleCount || 0,
      waitingCount: database.pool.waitingCount || 0
    };

    // Get table sizes
    const tableSizes = await database.query(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
        pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
      LIMIT 10
    `);

    return {
      timestamp: new Date().toISOString(),
      connection: {
        status: 'connected',
        pool: poolStats
      },
      tables: tableSizes.rows,
      performance: {
        responseTime: 'N/A'
      }
    };

  } catch (error) {
    return {
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// =============================================
// METRICS SERVICE EXPORTS
// =============================================

// Export functions for use in other modules
const metricsService = {
  // Record HTTP request
  recordRequest: (method, route, statusCode, duration) => {
    httpRequestsTotal.inc({ method, route, status_code: statusCode });
    if (duration) {
      httpRequestDuration.observe({ method, route, status_code: statusCode }, duration / 1000);
    }
  },

  // Record scraping session
  recordSession: (source, status, duration) => {
    scrapingSessionsTotal.inc({ source, status });
    if (duration) {
      scrapingSessionDuration.observe({ source, status }, duration);
    }
  },

  // Record scraped lead
  recordLead: (source, status) => {
    leadsScrapedTotal.inc({ source, status });
  },

  // Record database query
  recordDatabaseQuery: (operation, duration) => {
    if (duration) {
      databaseQueryDuration.observe({ operation }, duration / 1000);
    }
  },

  // Record Redis operation
  recordRedisOperation: (operation, duration) => {
    if (duration) {
      redisOperationDuration.observe({ operation }, duration / 1000);
    }
  },

  // Get current metrics
  getMetrics: () => register.metrics(),

  // Reset all metrics
  reset: () => register.clear()
};

// Export both router and service
module.exports = router;
module.exports.metricsService = metricsService;
