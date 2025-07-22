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
    
    // Dependencies will be lazy-loaded to avoid circular dependencies
    // and improve startup performance.
    this.logger = null;
    this.database = null;
    this.redis = null;
  }

  // =============================================
  // LAZY LOADING OF DEPENDENCIES (IMPROVED)
  // =============================================

  getLogger() {
    if (!this.logger) {
      try {
        // Carga el logger solo una vez.
        this.logger = require('../utils/logger');
      } catch {
        // Si falla, usa un logger básico como fallback.
        console.warn('Warning: Custom logger not found. Falling back to console.');
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
        // Carga el módulo de Redis completo.
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
      this.registerDefaultHealthChecks();
      this.startPeriodicHealthChecks();
      await this.performHealthCheck(); // Realiza la primera comprobación al iniciar.
      this.isInitialized = true;
      logger.info('✅ Health Service initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize Health Service', {
        error: error.message,
        stack: error.stack
      });
      throw error; // Propaga el error para detener el inicio si es crítico.
    }
  }

  // =============================================
  // DEFAULT HEALTH CHECKS (REDIS CHECK IMPROVED)
  // =============================================

  registerDefaultHealthChecks() {
    // ... (el resto de tus health checks como 'database', 'memory', etc., están bien y no necesitan cambios)

    // Redis health check (MODIFICADO)
    this.addHealthCheck('redis', {
      name: 'Redis Cache',
      critical: false, // No es crítico si la caché falla.
      timeout: 3000,
      check: async () => {
        const redis = this.getRedis();
        
        // Comprueba si el módulo de Redis y la función isReady existen.
        if (!redis || typeof redis.isReady !== 'function') {
          return { status: 'unhealthy', message: 'Redis module not configured or loaded' };
        }

        // Usa la función isReady() que es más fiable.
        if (!redis.isReady()) {
          return { status: 'unhealthy', message: 'Redis client is not ready' };
        }

        try {
          const start = Date.now();
          // El PING es una excelente forma de verificar la conexión.
          await redis.getClient().ping();
          const responseTime = Date.now() - start;

          return {
            status: 'healthy',
            message: 'Redis responding',
            details: { responseTime: `${responseTime}ms` }
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

    // ... (Aquí irían tus otros health checks como 'memory' y 'diskSpace')
  }

  // =============================================
  // CACHING AND STORAGE (FIXED)
  // =============================================

  async cacheHealthStatus(healthReport) {
    const logger = this.getLogger();
    const redis = this.getRedis();
    
    // Comprueba si el módulo de Redis está disponible y listo para usarse.
    if (!redis || !redis.isReady()) {
      logger.debug('Skipping health status cache: Redis is not ready.');
      return;
    }
    
    try {
      // CORRECTO: Llama a la función `setex` exportada desde tu módulo de Redis.
      // No llames a `redis.getClient().setex` porque no existe.
      
      // Cachea el estado de salud actual por 60 segundos.
      await redis.setex(
        'scraper:health:current',
        60, // 1 minuto TTL
        JSON.stringify(healthReport)
      );
      
      // Cachea un historial reciente (últimos 10) por 5 minutos.
      const recentHistory = this.healthHistory.slice(0, 10);
      await redis.setex(
        'scraper:health:history',
        300, // 5 minutos TTL
        JSON.stringify(recentHistory)
      );

    } catch (error) {
      // Este error ya no debería ser "is not a function".
      logger.error('Error caching health status to Redis', { error: error.message });
    }
  }

  // =============================================
  // EL RESTO DE TU CÓDIGO
  // (No necesita cambios, puedes copiar y pegar el resto de tus funciones aquí)
  // =============================================
  
  // performHealthCheck()
  // startPeriodicHealthChecks()
  // getHealthStatus()
  // getHealthHistory()
  // getDetailedHealth()
  // isHealthy()
  // isReady()
  // addHealthCheck()
  // removeHealthCheck()
  // stop()
  // reset()
  
  // ... (Pega aquí el resto de las funciones de tu clase que no he modificado)
}

// =============================================
// SINGLETON EXPORT
// =============================================
const healthService = new HealthService();
module.exports = healthService;

