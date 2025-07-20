// =============================================
// HEALTH SERVICE - SYSTEM HEALTH MONITORING
// =============================================

import logger from '../utils/logger.js';
import database from '../database/connection.js';
import redis from '../database/redis.js';

class HealthService {
  constructor() {
    this.healthChecks = new Map();
    this.healthHistory = [];
    this.isInitialized = false;
    this.healthCheckInterval = null;
    this.healthStatus = 'unknown';
    this.lastHealthCheck = null;
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    try {
      logger.info('🏥 Initializing Health Service...');

      // Register health checks
      this.registerHealthChecks();

      // Perform initial health check
      await this.performHealthCheck();

      // Start periodic health checks (every 30 seconds)
      this.startPeriodicHealthChecks();

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
  // HEALTH CHECK REGISTRATION
  // =============================================

  registerHealthChecks() {
    // Database health check
    this.healthChecks.set('database', {
      name: 'PostgreSQL Database',
      critical: true,
      timeout: 5000,
      check: async () => {
        const start = Date.now();
        try {
          const result = await database.query('SELECT NOW() as current_time, version() as version');
          const duration = Date.now() - start;
          
          return {
            status: 'healthy',
            responseTime: `${duration}ms`,
            details: {
              currentTime: result.rows[0].current_time,
              version: result.rows[0].version.split(' ')[0],
              poolStats: database.getPoolStats()
            }
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            error: error.message,
            responseTime: `${Date.now() - start}ms`
          };
        }
      }
    });

    // Redis health check
    this.healthChecks.set('redis', {
      name: 'Redis Cache',
      critical: false,
      timeout: 3000,
      check: async () => {
        const start = Date.now();
        try {
          if (!redis.isConnected) {
            return {
              status: 'disconnected',
              error: 'Redis client not connected'
            };
          }

          await redis.client.ping();
          const duration = Date.now() - start;
          
          const info = await redis.client.info('memory');
          const memoryMatch = info.match(/used_memory_human:(.+)/);
          const memoryUsed = memoryMatch ? memoryMatch[1].trim() : 'unknown';

          return {
            status: 'healthy',
            responseTime: `${duration}ms`,
            details: {
              connected: true,
              memoryUsed,
              database: redis.client.options.db || 0
            }
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            error: error.message,
            responseTime: `${Date.now() - start}ms`
          };
        }
      }
    });

    // System resources health check
    this.healthChecks.set('system', {
      name: 'System Resources',
      critical: true,
      timeout: 1000,
      check: async () => {
        try {
          const memoryUsage = process.memoryUsage();
          const memoryMB = memoryUsage.heapUsed / 1024 / 1024;
          const memoryTotalMB = memoryUsage.heapTotal / 1024 / 1024;
          
          // Memory health assessment
          let memoryStatus = 'healthy';
          if (memoryMB > 1024) memoryStatus = 'critical';
          else if (memoryMB > 512) memoryStatus = 'warning';

          // CPU usage (simplified)
          const cpuUsage = process.cpuUsage();
          
          // Overall system status
          const status = memoryStatus === 'critical' ? 'unhealthy' : 'healthy';

          return {
            status,
            details: {
              memory: {
                used: `${Math.round(memoryMB)}MB`,
                total: `${Math.round(memoryTotalMB)}MB`,
                percentage: Math.round((memoryMB / memoryTotalMB) * 100),
                status: memoryStatus
              },
              cpu: {
                user: cpuUsage.user,
                system: cpuUsage.system
              },
              uptime: `${Math.round(process.uptime())}s`,
              loadAverage: process.platform === 'linux' ? require('os').loadavg() : null,
              platform: process.platform,
              nodeVersion: process.version
            }
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            error: error.message
          };
        }
      }
    });

    // Disk space health check (if needed)
    this.healthChecks.set('disk', {
      name: 'Disk Space',
      critical: false,
      timeout: 2000,
      check: async () => {
        try {
          // Simplified disk check - in production you might want to use 'df' command
          const stats = {
            status: 'healthy',
            details: {
              // This would need actual disk space checking implementation
              available: 'unknown',
              used: 'unknown',
              message: 'Disk monitoring not implemented'
            }
          };
          
          return stats;
        } catch (error) {
          return {
            status: 'unhealthy',
            error: error.message
          };
        }
      }
    });

    logger.info('🏥 Health checks registered', {
      checks: Array.from(this.healthChecks.keys()),
      critical: Array.from(this.healthChecks.values()).filter(check => check.critical).length,
      total: this.healthChecks.size
    });
  }

  // =============================================
  // HEALTH CHECK EXECUTION
  // =============================================

  async performHealthCheck() {
    const healthCheckStart = Date.now();
    const results = new Map();
    let overallStatus = 'healthy';
    const errors = [];

    logger.debug('🔍 Performing health check...');

    // Run all health checks in parallel
    const checkPromises = Array.from(this.healthChecks.entries()).map(async ([name, config]) => {
      try {
        const checkStart = Date.now();
        
        // Create timeout promise
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Health check timeout (${config.timeout}ms)`)), config.timeout);
        });

        // Race between health check and timeout
        const result = await Promise.race([
          config.check(),
          timeoutPromise
        ]);

        const duration = Date.now() - checkStart;
        
        results.set(name, {
          ...result,
          name: config.name,
          critical: config.critical,
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
    try {
      if (redis.isConnected) {
        // Cache current health status
        await redis.set('scraper:health:current', healthReport, 60); // 1 minute TTL
        
        // Cache health history
        const recentHistory = this.healthHistory.slice(0, 10); // Last 10 checks
        await redis.set('scraper:health:history', recentHistory, 300); // 5 minutes TTL
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
    if (this.healthChecks.has(name)) {
      this.healthChecks.delete(name);
      logger.info(`🏥 Removed health check: ${name}`);
    }
  }

  // =============================================
  // CLEANUP
  // =============================================

  async stop() {
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
export default healthService;
