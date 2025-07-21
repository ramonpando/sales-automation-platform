// =============================================
// HEALTH SERVICE - SYSTEM HEALTH MONITORING
// =============================================

class HealthService {
  constructor() {
    this.healthChecks = new Map();
    this.healthStatus = 'unknown';
    this.lastHealthCheck = null;
    this.healthHistory = [];
    this.healthCheckInterval = null;
    this.isInitialized = false;
    
    // Dependencies
    this.logger = null;
    this.database = null;
    this.redis = null;
  }

  // =============================================
  // LAZY LOADING OF DEPENDENCIES
  // =============================================

  getLogger() {
    if (!this.logger) {
      try {
        this.logger = require('../utils/logger');
      } catch {
        this.logger = {
          info: console.log,
          error: console.error,
          warn: console.warn,
          debug: console.debug
        };
      }
    }
    return this.logger;
  }

  getDatabase() {
    if (!this.database) {
      try {
        this.database = require('../database/connection');
      } catch {
        this.database = null;
      }
    }
    return this.database;
  }

  getRedis() {
    if (!this.redis) {
      try {
        this.redis = require('../database/redis');
      } catch {
        this.redis = null;
      }
    }
    return this.redis;
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    const logger = this.getLogger();
    
    try {
      logger.info('🏥 Initializing Health Service...');

      // Register default health checks
      this.registerDefaultHealthChecks();

      // Start periodic health checks
      this.startPeriodicHealthChecks();

      // Perform initial health check
      await this.performHealthCheck();

      this.isInitialized = true;
      logger.info('✅ Health Service initialized successfully');

    } catch (error) {
      logger.error('❌ Failed to initialize Health Service', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  // =============================================
  // DEFAULT HEALTH CHECKS
  // =============================================

  registerDefaultHealthChecks() {
    const logger = this.getLogger();

    // Database health check
    this.addHealthCheck('database', {
      name: 'PostgreSQL Database',
      critical: true,
      timeout: 5000,
      check: async () => {
        const database = this.getDatabase();
        
        if (!database || !database.pool) {
          return {
            status: 'unhealthy',
            message: 'Database not configured'
          };
        }

        try {
          const start = Date.now();
          const result = await database.query('SELECT NOW()');
          const responseTime = Date.now() - start;

          return {
            status: 'healthy',
            message: 'Database responding',
            details: {
              responseTime: `${responseTime}ms`,
              timestamp: result.rows[0].now
            }
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            message: 'Database query failed',
            error: error.message
          };
        }
      }
    });

    // Redis health check
    this.addHealthCheck('redis', {
      name: 'Redis Cache',
      critical: false,
      timeout: 3000,
      check: async () => {
        const redis = this.getRedis();
        const redisClient = redis && redis.getClient ? redis.getClient() : null;
        
        if (!redisClient) {
          return {
            status: 'unhealthy',
            message: 'Redis not configured'
          };
        }

        try {
          const start = Date.now();
          
          if (!redisClient.isOpen) {
            return {
              status: 'unhealthy',
              message: 'Redis not connected'
            };
          }
          
          await redisClient.ping();
          const responseTime = Date.now() - start;

          return {
            status: 'healthy',
            message: 'Redis responding',
            details: {
              responseTime: `${responseTime}ms`
            }
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            message: 'Redis ping failed',
            error: error.message
          };
        }
      }
    });

    // Memory health check
    this.addHealthCheck('memory', {
      name: 'Memory Usage',
      critical: false,
      timeout: 1000,
      check: async () => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
        const rssMB = Math.round(memoryUsage.rss / 1024 / 1024);
        
        const heapPercentage = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

        if (heapPercentage > 90) {
          return {
            status: 'unhealthy',
            message: 'Memory usage critical',
            details: {
              heapUsed: `${heapUsedMB}MB`,
              heapTotal: `${heapTotalMB}MB`,
              rss: `${rssMB}MB`,
              percentage: `${heapPercentage.toFixed(2)}%`
            }
          };
        } else if (heapPercentage > 75) {
          return {
            status: 'degraded',
            message: 'Memory usage high',
            details: {
              heapUsed: `${heapUsedMB}MB`,
              heapTotal: `${heapTotalMB}MB`,
              rss: `${rssMB}MB`,
              percentage: `${heapPercentage.toFixed(2)}%`
            }
          };
        }

        return {
          status: 'healthy',
          message: 'Memory usage normal',
          details: {
            heapUsed: `${heapUsedMB}MB`,
            heapTotal: `${heapTotalMB}MB`,
            rss: `${rssMB}MB`,
            percentage: `${heapPercentage.toFixed(2)}%`
          }
        };
      }
    });

    // Disk space health check (simplified)
    this.addHealthCheck('diskSpace', {
      name: 'Disk Space',
      critical: false,
      timeout: 3000,
      check: async () => {
        // This is a simplified check - in production you'd use proper disk space checking
        return {
          status: 'healthy',
          message: 'Disk space check not implemented',
          details: {}
        };
      }
    });

    logger.info('🏥 Registered default health checks', {
      checks: Array.from(this.healthChecks.keys())
    });
  }

  // =============================================
  // HEALTH CHECK EXECUTION
  // =============================================

  async performHealthCheck() {
    const logger = this.getLogger();
    const healthCheckStart = Date.now();
    const results = new Map();
    let overallStatus = 'healthy';
    const errors = [];

    logger.debug('🏥 Performing health check...');

    // Execute all health checks in parallel
    const checkPromises = Array.from(this.healthChecks.entries()).map(async ([name, config]) => {
      const checkStart = Date.now();
      
      try {
        // Execute health check with timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Health check timeout')), config.timeout);
        });

        const checkResult = await Promise.race([
          config.check(),
          timeoutPromise
        ]);

        const duration = Date.now() - checkStart;
        
        const result = {
          ...checkResult,
          name: config.name,
          critical: config.critical,
          duration: `${duration}ms`,
          timestamp: new Date().toISOString()
        };

        results.set(name, result);

        logger.debug(`Health check completed: ${name}`, {
          status: result.status,
          duration: `${duration}ms`,
          timestamp: new Date().toISOString()
        });

        // Update overall status
        if (result.status === 'unhealthy' && config.critical) {
          overallStatus = 'unhealthy';
          errors.push(`${config.name}: ${result.error || 'Unknown error'}`);
        } else if (result.status !== 'healthy' && overallStatus === 'healthy') {
          overallStatus = 'degraded';
        }

      } catch (error) {
        const duration = Date.now() - checkStart;
        
        results.set(name, {
          status: 'unhealthy',
          name: config.name,
          critical: config.critical,
          error: error.message,
          duration: `${duration}ms`,
          timestamp: new Date().toISOString()
        });

        if (config.critical) {
          overallStatus = 'unhealthy';
          errors.push(`${config.name}: ${error.message}`);
        }

        logger.error(`Health check failed: ${name}`, {
          error: error.message,
          duration: `${duration}ms`
        });
      }
    });

    await Promise.all(checkPromises);

    const totalDuration = Date.now() - healthCheckStart;
    
    const healthReport = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      duration: `${totalDuration}ms`,
      service: 'sales-scraper',
      version: '2.0.0',
      uptime: process.uptime(),
      checks: Object.fromEntries(results),
      summary: {
        total: this.healthChecks.size,
        healthy: Array.from(results.values()).filter(r => r.status === 'healthy').length,
        unhealthy: Array.from(results.values()).filter(r => r.status === 'unhealthy').length,
        critical_failures: errors.length
      }
    };

    // Update internal state
    this.healthStatus = overallStatus;
    this.lastHealthCheck = healthReport;

    // Add to history (keep last 50 checks)
    this.healthHistory.unshift(healthReport);
    if (this.healthHistory.length > 50) {
      this.healthHistory = this.healthHistory.slice(0, 50);
    }

    // Log health status changes
    if (overallStatus !== 'healthy') {
      logger.warn(`🚨 Health check completed with status: ${overallStatus}`, {
        status: overallStatus,
        errors: errors,
        duration: `${totalDuration}ms`
      });
    } else {
      logger.debug('✅ Health check completed successfully', {
        status: overallStatus,
        duration: `${totalDuration}ms`
      });
    }

    // Cache health status in Redis
    await this.cacheHealthStatus(healthReport);

    return healthReport;
  }

  // =============================================
  // PERIODIC HEALTH CHECKS
  // =============================================

  startPeriodicHealthChecks() {
    const logger = this.getLogger();
    
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        logger.error('Error in periodic health check', {
          error: error.message,
          stack: error.stack
        });
      }
    }, 30000); // Every 30 seconds

    logger.info('⏰ Periodic health checks started (30s interval)');
  }

  // =============================================
  // CACHING AND STORAGE
  // =============================================

  async cacheHealthStatus(healthReport) {
    const logger = this.getLogger();
    const redis = this.getRedis();
    
    try {
      const redisClient = redis && redis.getClient ? redis.getClient() : null;
      
      if (redisClient && redisClient.isOpen) {
        // Cache current health status
        await redisClient.setex(
          'scraper:health:current',
          60, // 1 minute TTL
          JSON.stringify(healthReport)
        );
        
        // Cache health history
        const recentHistory = this.healthHistory.slice(0, 10); // Last 10 checks
        await redisClient.setex(
          'scraper:health:history',
          300, // 5 minutes TTL
          JSON.stringify(recentHistory)
        );
      }
    } catch (error) {
      logger.error('Error caching health status', { error: error.message });
    }
  }

  // =============================================
  // PUBLIC API METHODS
  // =============================================

  getHealthStatus() {
    return {
      current: this.lastHealthCheck,
      status: this.healthStatus,
      lastCheck: this.lastHealthCheck?.timestamp,
      uptime: process.uptime(),
      initialized: this.isInitialized
    };
  }

  getHealthHistory(limit = 10) {
    return this.healthHistory.slice(0, limit);
  }

  async getDetailedHealth() {
    // Return cached health or perform new check if cache is stale
    const now = Date.now();
    const lastCheckTime = this.lastHealthCheck ? new Date(this.lastHealthCheck.timestamp).getTime() : 0;
    const cacheAge = now - lastCheckTime;

    // If cache is older than 1 minute, perform new check
    if (cacheAge > 60000) {
      return await this.performHealthCheck();
    }

    return this.lastHealthCheck;
  }

  isHealthy() {
    return this.healthStatus === 'healthy';
  }

  isReady() {
    // Service is ready if initialized and not unhealthy
    return this.isInitialized && this.healthStatus !== 'unhealthy';
  }

  // =============================================
  // HEALTH CHECK MANAGEMENT
  // =============================================

  addHealthCheck(name, config) {
    const logger = this.getLogger();
    
    this.healthChecks.set(name, {
      name: config.name || name,
      critical: config.critical || false,
      timeout: config.timeout || 5000,
      check: config.check
    });

    logger.info(`🏥 Added health check: ${name}`, {
      critical: config.critical,
      timeout: config.timeout
    });
  }

  removeHealthCheck(name) {
    const logger = this.getLogger();
    
    if (this.healthChecks.has(name)) {
      this.healthChecks.delete(name);
      logger.info(`🏥 Removed health check: ${name}`);
    }
  }

  // =============================================
  // CLEANUP
  // =============================================

  async stop() {
    const logger = this.getLogger();
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Perform final health check
    try {
      await this.performHealthCheck();
    } catch (error) {
      logger.error('Error in final health check', { error: error.message });
    }

    logger.info('🏥 Health Service stopped');
  }

  reset() {
    const logger = this.getLogger();
    
    this.healthHistory = [];
    this.healthStatus = 'unknown';
    this.lastHealthCheck = null;
    logger.info('🏥 Health status reset');
  }
}

// =============================================
// SINGLETON EXPORT
// =============================================

const healthService = new HealthService();
module.exports = healthService;
