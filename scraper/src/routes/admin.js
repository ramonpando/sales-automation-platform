// =============================================
// ADMIN ROUTES - MANAGEMENT ENDPOINTS
// =============================================

import express from 'express';
import database from '../database/connection.js';
import redis from '../database/redis.js';
import scraperService from '../services/scraperService.js';
import metricsService from '../services/metricsService.js';
import healthService from '../services/healthService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// =============================================
// BASIC AUTH MIDDLEWARE (Simple protection)
// =============================================

const adminAuth = (req, res, next) => {
  const adminKey = process.env.ADMIN_API_KEY || 'admin123';
  const providedKey = req.headers['x-admin-key'] || req.query.adminKey;
  
  if (providedKey !== adminKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized - Admin key required',
      code: 'ADMIN_AUTH_REQUIRED'
    });
  }
  
  next();
};

// Apply auth to all admin routes
router.use(adminAuth);

// =============================================
// SYSTEM INFORMATION
// =============================================

router.get('/info', async (req, res) => {
  try {
    const info = {
      service: 'sales-scraper',
      version: '2.0.0',
      environment: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
      
      // Service status
      scraper: await scraperService.getStatus(),
      health: healthService.getHealthStatus(),
      
      // Configuration
      config: {
        maxConcurrentRequests: process.env.MAX_CONCURRENT_REQUESTS || 5,
        rateLimitDelay: process.env.RATE_LIMIT_DELAY || 200,
        scraperInterval: process.env.SCRAPER_INTERVAL || '0 */2 * * *',
        autoStart: process.env.AUTO_START_SCRAPING === 'true',
        logLevel: process.env.LOG_LEVEL || 'info'
      }
    };

    res.json({
      success: true,
      data: info
    });

  } catch (error) {
    logger.error('Error getting system info', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// DATABASE MANAGEMENT
// =============================================

router.get('/database/stats', async (req, res) => {
  try {
    const stats = await database.query(`
      SELECT 
        schemaname,
        tablename,
        n_tup_ins as inserts,
        n_tup_upd as updates,
        n_tup_del as deletes,
        n_live_tup as live_tuples,
        n_dead_tup as dead_tuples,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
      FROM pg_stat_user_tables
      WHERE schemaname = 'scraper'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);

    const poolStats = database.getPoolStats();

    res.json({
      success: true,
      data: {
        tables: stats.rows,
        connectionPool: poolStats,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error getting database stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/database/vacuum', async (req, res) => {
  try {
    const { table } = req.body;
    
    if (table) {
      await database.query(`VACUUM ANALYZE scraper.${table}`);
      logger.info(`Database vacuum completed for table: ${table}`);
    } else {
      await database.query('VACUUM ANALYZE');
      logger.info('Full database vacuum completed');
    }

    res.json({
      success: true,
      message: `Vacuum completed ${table ? `for table ${table}` : 'for all tables'}`
    });

  } catch (error) {
    logger.error('Error running database vacuum', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// CACHE MANAGEMENT
// =============================================

router.get('/cache/stats', async (req, res) => {
  try {
    if (!redis.isConnected) {
      return res.status(503).json({
        success: false,
        error: 'Redis not connected'
      });
    }

    const info = await redis.client.info('all');
    const keyCount = await redis.client.dbsize();
    
    // Parse Redis info
    const stats = {};
    info.split('\r\n').forEach(line => {
      if (line.includes(':')) {
        const [key, value] = line.split(':');
        stats[key] = value;
      }
    });

    res.json({
      success: true,
      data: {
        connected: redis.isConnected,
        keyCount,
        memory: {
          used: stats.used_memory_human,
          peak: stats.used_memory_peak_human,
          rss: stats.used_memory_rss_human
        },
        stats: {
          connections: stats.connected_clients,
          commands: stats.total_commands_processed,
          hits: stats.keyspace_hits,
          misses: stats.keyspace_misses
        },
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error getting cache stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.delete('/cache/clear', async (req, res) => {
  try {
    const { pattern } = req.query;
    
    if (pattern) {
      // Clear specific pattern
      const keys = await redis.client.keys(`scraper:${pattern}*`);
      if (keys.length > 0) {
        await redis.client.del(...keys);
      }
      logger.info(`Cache cleared for pattern: ${pattern}`, { keysCleared: keys.length });
      
      res.json({
        success: true,
        message: `Cleared ${keys.length} keys matching pattern: ${pattern}`
      });
    } else {
      // Clear all scraper keys
      const keys = await redis.client.keys('scraper:*');
      if (keys.length > 0) {
        await redis.client.del(...keys);
      }
      logger.info('Cache cleared for all scraper keys', { keysCleared: keys.length });
      
      res.json({
        success: true,
        message: `Cleared ${keys.length} scraper cache keys`
      });
    }

  } catch (error) {
    logger.error('Error clearing cache', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// METRICS MANAGEMENT
// =============================================

router.get('/metrics/report', async (req, res) => {
  try {
    const { timeRange = '1h' } = req.query;
    const report = metricsService.generateReport(timeRange);

    res.json({
      success: true,
      data: report
    });

  } catch (error) {
    logger.error('Error generating metrics report', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/metrics/reset', async (req, res) => {
  try {
    metricsService.reset();
    logger.info('Metrics reset by admin');

    res.json({
      success: true,
      message: 'Metrics reset successfully'
    });

  } catch (error) {
    logger.error('Error resetting metrics', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// LOG MANAGEMENT
// =============================================

router.get('/logs', async (req, res) => {
  try {
    const { level = 'info', limit = 100 } = req.query;
    
    // This would need implementation based on your logging setup
    // For now, return recent log entries from metrics buffer
    const logEntries = metricsService.getBuffer('log', parseInt(limit));

    res.json({
      success: true,
      data: {
        logs: logEntries,
        level,
        limit: parseInt(limit),
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error getting logs', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/logs/level', async (req, res) => {
  try {
    const { level } = req.body;
    
    // Update log level (this would need Winston integration)
    process.env.LOG_LEVEL = level;
    logger.info(`Log level changed to: ${level}`);

    res.json({
      success: true,
      message: `Log level set to ${level}`
    });

  } catch (error) {
    logger.error('Error setting log level', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// SERVICE CONTROL
// =============================================

router.post('/service/restart', async (req, res) => {
  try {
    logger.warn('Service restart requested by admin');
    
    // Graceful restart (in real implementation)
    res.json({
      success: true,
      message: 'Service restart initiated'
    });

    // Give response time to send
    setTimeout(() => {
      process.exit(0); // PM2 or Docker will restart
    }, 1000);

  } catch (error) {
    logger.error('Error restarting service', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/scraper/force-stop', async (req, res) => {
  try {
    await scraperService.stop();
    logger.warn('Scraper force-stopped by admin');

    res.json({
      success: true,
      message: 'Scraper stopped successfully'
    });

  } catch (error) {
    logger.error('Error stopping scraper', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// DATA MANAGEMENT
// =============================================

router.delete('/data/cleanup', async (req, res) => {
  try {
    const { days = 30, dryRun = false } = req.query;
    
    const query = `
      SELECT COUNT(*) as count
      FROM scraper.leads 
      WHERE created_at < NOW() - INTERVAL '${parseInt(days)} days'
    `;
    
    const countResult = await database.query(query);
    const recordsToDelete = parseInt(countResult.rows[0].count);

    if (!dryRun && recordsToDelete > 0) {
      await database.query(`
        DELETE FROM scraper.leads 
        WHERE created_at < NOW() - INTERVAL '${parseInt(days)} days'
      `);
      
      logger.info(`Data cleanup completed`, { 
        recordsDeleted: recordsToDelete, 
        daysOld: days 
      });
    }

    res.json({
      success: true,
      message: dryRun ? 'Dry run completed' : 'Cleanup completed',
      data: {
        recordsFound: recordsToDelete,
        recordsDeleted: dryRun ? 0 : recordsToDelete,
        daysOld: parseInt(days),
        dryRun: !!dryRun
      }
    });

  } catch (error) {
    logger.error('Error in data cleanup', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// BACKUP MANAGEMENT
// =============================================

router.post('/backup/create', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `scraper_backup_${timestamp}`;
    
    // This would implement actual backup logic
    logger.info(`Backup initiated: ${backupName}`);

    res.json({
      success: true,
      message: 'Backup initiated',
      data: {
        backupName,
        timestamp: new Date().toISOString(),
        status: 'initiated'
      }
    });

  } catch (error) {
    logger.error('Error creating backup', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// HEALTH CHECK MANAGEMENT
// =============================================

router.post('/health/check', async (req, res) => {
  try {
    const healthReport = await healthService.performHealthCheck();

    res.json({
      success: true,
      data: healthReport
    });

  } catch (error) {
    logger.error('Error performing health check', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/health/reset', async (req, res) => {
  try {
    healthService.reset();
    logger.info('Health status reset by admin');

    res.json({
      success: true,
      message: 'Health status reset successfully'
    });

  } catch (error) {
    logger.error('Error resetting health status', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// ERROR HANDLING
// =============================================

router.use((error, req, res, next) => {
  logger.error('Admin API error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'ADMIN_ERROR'
  });
});

export default router;
