// =============================================
// HEALTH CHECK ROUTES
// =============================================

import express from 'express';
import database from '../database/connection.js';
import redis from '../database/redis.js';
import scraperService from '../services/scraperService.js';

const router = express.Router();

// =============================================
// BASIC HEALTH CHECK
// =============================================

router.get('/', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      service: 'sales-scraper',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development'
    };

    res.json(health);

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'sales-scraper',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================
// DETAILED HEALTH CHECK
// =============================================

router.get('/detailed', async (req, res) => {
  try {
    const checks = await Promise.allSettled([
      checkDatabase(),
      checkRedis(),
      checkScraperService(),
      checkSystemResources()
    ]);

    const [dbCheck, redisCheck, scraperCheck, systemCheck] = checks.map(
      result => result.status === 'fulfilled' ? result.value : { status: 'error', error: result.reason?.message }
    );

    const overallStatus = [dbCheck, redisCheck, scraperCheck, systemCheck]
      .every(check => check.status === 'healthy') ? 'healthy' : 'degraded';

    const health = {
      status: overallStatus,
      service: 'sales-scraper',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      checks: {
        database: dbCheck,
        cache: redisCheck,
        scraper: scraperCheck,
        system: systemCheck
      }
    };

    const statusCode = overallStatus === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'sales-scraper',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================
// INDIVIDUAL COMPONENT CHECKS
// =============================================

router.get('/database', async (req, res) => {
  try {
    const dbHealth = await checkDatabase();
    const statusCode = dbHealth.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(dbHealth);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      component: 'database',
      error: error.message
    });
  }
});

router.get('/cache', async (req, res) => {
  try {
    const cacheHealth = await checkRedis();
    const statusCode = cacheHealth.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(cacheHealth);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      component: 'cache',
      error: error.message
    });
  }
});

router.get('/scraper', async (req, res) => {
  try {
    const scraperHealth = await checkScraperService();
    const statusCode = scraperHealth.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(scraperHealth);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      component: 'scraper',
      error: error.message
    });
  }
});

// =============================================
// READINESS PROBE
// =============================================

router.get('/ready', async (req, res) => {
  try {
    // Check if all critical services are ready
    const [dbReady, scraperReady] = await Promise.all([
      checkDatabase(),
      checkScraperService()
    ]);

    const isReady = dbReady.status === 'healthy' && scraperReady.status === 'healthy';

    if (isReady) {
      res.json({
        status: 'ready',
        message: 'Service is ready to accept traffic',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({
        status: 'not-ready',
        message: 'Service is not ready to accept traffic',
        checks: { database: dbReady, scraper: scraperReady },
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    res.status(503).json({
      status: 'not-ready',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================
// LIVENESS PROBE
// =============================================

router.get('/live', async (req, res) => {
  try {
    // Basic liveness check - is the process running?
    res.json({
      status: 'alive',
      pid: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'dead',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================
// HEALTH CHECK FUNCTIONS
// =============================================

async function checkDatabase() {
  try {
    const dbHealth = await database.healthCheck();
    
    return {
      status: dbHealth.status === 'healthy' ? 'healthy' : 'unhealthy',
      component: 'database',
      responseTime: dbHealth.responseTime || 'unknown',
      details: {
        type: 'postgresql',
        poolStats: dbHealth.poolStats,
        lastCheck: new Date().toISOString()
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      component: 'database',
      error: error.message
    };
  }
}

async function checkRedis() {
  try {
    const redisHealth = await redis.healthCheck();
    
    return {
      status: redisHealth.status === 'healthy' ? 'healthy' : 'unhealthy',
      component: 'cache',
      responseTime: redisHealth.latency || 'unknown',
      details: {
        type: 'redis',
        connected: redis.isConnected,
        memoryUsed: redisHealth.memoryUsed,
        lastCheck: new Date().toISOString()
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      component: 'cache',
      error: error.message
    };
  }
}

async function checkScraperService() {
  try {
    const scraperStatus = await scraperService.getStatus();
    
    return {
      status: 'healthy',
      component: 'scraper',
      details: {
        isRunning: scraperStatus.isRunning,
        activeJobs: scraperStatus.activeJobs,
        totalSessions: scraperStatus.stats.totalSessions,
        totalLeads: scraperStatus.stats.totalLeads,
        lastRun: scraperStatus.stats.lastRun,
        lastCheck: new Date().toISOString()
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      component: 'scraper',
      error: error.message
    };
  }
}

async function checkSystemResources() {
  try {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // Memory health check (warn if over 500MB, critical if over 1GB)
    const memoryMB = memoryUsage.heapUsed / 1024 / 1024;
    let memoryStatus = 'healthy';
    if (memoryMB > 1024) memoryStatus = 'critical';
    else if (memoryMB > 500) memoryStatus = 'warning';

    return {
      status: memoryStatus === 'critical' ? 'unhealthy' : 'healthy',
      component: 'system',
      details: {
        memory: {
          heapUsed: `${Math.round(memoryMB)}MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`,
          status: memoryStatus
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system
        },
        uptime: `${Math.round(process.uptime())}s`,
        version: process.version,
        platform: process.platform,
        lastCheck: new Date().toISOString()
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      component: 'system',
      error: error.message
    };
  }
}

export default router;
