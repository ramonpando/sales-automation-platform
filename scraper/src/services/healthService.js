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
    
    this.logger = null;
    this.database = null;
    this.redis = null;

    // =============================================
    // BINDING 'this' CONTEXT (LA SOLUCIÓN CLAVE)
    // =============================================
    // Esto asegura que 'this' siempre se refiera a la instancia de HealthService,
    // sin importar cómo se llamen los métodos.
    this.initialize = this.initialize.bind(this);
    this.performHealthCheck = this.performHealthCheck.bind(this);
    this.registerDefaultHealthChecks = this.registerDefaultHealthChecks.bind(this);
    this.startPeriodicHealthChecks = this.startPeriodicHealthChecks.bind(this);
    this.cacheHealthStatus = this.cacheHealthStatus.bind(this);
    this.stop = this.stop.bind(this);
  }

  // =============================================
  // LAZY LOADING OF DEPENDENCIES
  // =============================================

  getLogger() {
    if (!this.logger) {
      try {
        this.logger = require('../utils/logger');
      } catch {
        console.warn('Warning: Custom logger not found. Falling back to console.');
        this.logger = { info: console.log, error: console.error, warn: console.warn, debug: console.debug };
      }
    }
    return this.logger;
  }

  getDatabase() {
    if (!this.database) {
      try {
        this.database = require('../database/connection');
      } catch (e) {
        this.getLogger().error('Failed to load Database module.', { error: e.message });
        this.database = null;
      }
    }
    return this.database;
  }

  getRedis() {
    if (!this.redis) {
      try {
        this.redis = require('../database/redis');
      } catch (e) {
        this.getLogger().error('Failed to load Redis module.', { error: e.message });
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
      this.registerDefaultHealthChecks(); // Ahora 'this' es correcto.
      this.startPeriodicHealthChecks();
      await this.performHealthCheck();
      this.isInitialized = true;
      logger.info('✅ Health Service initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize Health Service', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  // =============================================
  // DEFAULT HEALTH CHECKS
  // =============================================

  registerDefaultHealthChecks() {
    const logger = this.getLogger();

    this.addHealthCheck('database', { /* ...código sin cambios... */ });
    this.addHealthCheck('redis', { /* ...código sin cambios... */ });
    this.addHealthCheck('memory', { /* ...código sin cambios... */ });
    this.addHealthCheck('diskSpace', { /* ...código sin cambios... */ });

    logger.info('🏥 Registered default health checks', { checks: Array.from(this.healthChecks.keys()) });
  }

  // =============================================
  // HEALTH CHECK EXECUTION
  // =============================================

  async performHealthCheck() {
    // ... (Tu código completo para performHealthCheck aquí, sin cambios)
  }

  // =============================================
  // PERIODIC HEALTH CHECKS
  // =============================================

  startPeriodicHealthChecks() {
    // ... (Tu código completo para startPeriodicHealthChecks aquí, sin cambios)
  }

  // =============================================
  // CACHING AND STORAGE (CON LA CORRECCIÓN DE REDIS)
  // =============================================

  async cacheHealthStatus(healthReport) {
    const logger = this.getLogger();
    const redis = this.getRedis();
    if (!redis || !redis.isReady()) {
      logger.debug('Skipping health status cache: Redis is not ready.');
      return;
    }
    try {
      // CORRECTO: Llama a la función `setex` exportada desde tu módulo de Redis.
      await redis.setex('scraper:health:current', 60, JSON.stringify(healthReport));
      const recentHistory = this.healthHistory.slice(0, 10);
      await redis.setex('scraper:health:history', 300, JSON.stringify(recentHistory));
    } catch (error) {
      logger.error('Error caching health status to Redis', { error: error.message });
    }
  }

  // =============================================
  // PUBLIC API METHODS
  // =============================================

  getHealthStatus() { /* ...código sin cambios... */ }
  getHealthHistory(limit = 10) { /* ...código sin cambios... */ }
  async getDetailedHealth() { /* ...código sin cambios... */ }
  isHealthy() { /* ...código sin cambios... */ }
  isReady() { /* ...código sin cambios... */ }

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
    logger.info(`🏥 Added health check: ${name}`, { critical: config.critical, timeout: config.timeout });
  }

  removeHealthCheck(name) { /* ...código sin cambios... */ }

  // =============================================
  // CLEANUP
  // =============================================

  async stop() { /* ...código sin cambios... */ }
  reset() { /* ...código sin cambios... */ }
}

// =============================================
// SINGLETON EXPORT
// =============================================
const healthService = new HealthService();
module.exports = healthService;



