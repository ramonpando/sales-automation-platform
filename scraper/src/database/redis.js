// =============================================
// SCRAPER SERVICE - REDIS CONNECTION & CACHING
// =============================================

import Redis from 'ioredis';
import logger from '../utils/logger.js';

// =============================================
// REDIS CONFIGURATION
// =============================================

const config = {
  // Connection
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB) || 0,
  
  // Connection options
  connectTimeout: 10000,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
  maxLoadingTimeout: 5000,
  
  // Pool settings
  family: 4,
  keepAlive: true,
  
  // Reconnection
  retryDelayOnClusterDown: 300,
  enableOfflineQueue: false,
  
  // Key prefix for scraper
  keyPrefix: 'scraper:',
  
  // Custom options
  showFriendlyErrorStack: process.env.NODE_ENV === 'development'
};

// Parse Redis URL if provided
if (process.env.REDIS_URL) {
  const url = new URL(process.env.REDIS_URL);
  config.host = url.hostname;
  config.port = parseInt(url.port) || 6379;
  config.password = url.password || undefined;
  config.db = parseInt(url.pathname.slice(1)) || 0;
}

// =============================================
// REDIS CLIENT
// =============================================

let redis = null;
let isConnected = false;

// =============================================
// REDIS INITIALIZATION
// =============================================

async function initialize() {
  try {
    logger.info('🔴 Initializing Redis connection...');
    
    // Create Redis client
    redis = new Redis(config);

    // Event handlers
    redis.on('connect', () => {
      logger.info('🔗 Redis connecting...');
    });

    redis.on('ready', () => {
      isConnected = true;
      logger.info('✅ Redis connection ready', {
        host: config.host,
        port: config.port,
        db: config.db,
        keyPrefix: config.keyPrefix
      });
    });

    redis.on('error', (error) => {
      isConnected = false;
      logger.error('💥 Redis connection error', {
        error: error.message,
        stack: error.stack,
        host: config.host,
        port: config.port
      });
    });

    redis.on('close', () => {
      isConnected = false;
      logger.warn('🔌 Redis connection closed');
    });

    redis.on('reconnecting', (delay) => {
      logger.info('🔄 Redis reconnecting...', { delay });
    });

    redis.on('end', () => {
      isConnected = false;
      logger.info('🔚 Redis connection ended');
    });

    // Test connection
    await redis.ping();
    
    // Set client info
    await redis.client('SETNAME', 'sales-scraper');
    
    logger.info('✅ Redis initialized successfully');
    return redis;

  } catch (error) {
    logger.error('❌ Failed to initialize Redis connection', {
      error: error.message,
      stack: error.stack,
      config: {
        host: config.host,
        port: config.port,
        db: config.db
      }
    });
    
    // Continue without Redis if it's not critical
    logger.warn('⚠️ Continuing without Redis cache');
    return null;
  }
}

// =============================================
// CACHE OPERATIONS
// =============================================

// Cache keys
const KEYS = {
  SCRAPING_SESSION: (sessionId) => `session:${sessionId}`,
  SCRAPED_URL: (url) => `scraped:${Buffer.from(url).toString('base64')}`,
  DUPLICATE_CHECK: (company, phone) => `duplicate:${company}:${phone}`,
  RATE_LIMIT: (source) => `ratelimit:${source}`,
  STATS: (source, date) => `stats:${source}:${date}`,
  HEALTH: () => 'health',
  METRICS: (metric) => `metrics:${metric}`,
  QUEUE: (type) => `queue:${type}`,
  LOCK: (resource) => `lock:${resource}`
};

// =============================================
// CACHING FUNCTIONS
// =============================================

// Generic cache operations
async function get(key) {
  if (!redis || !isConnected) return null;
  
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    logger.error('Redis GET error', { key, error: error.message });
    return null;
  }
}

async function set(key, value, ttl = 3600) {
  if (!redis || !isConnected) return false;
  
  try {
    const serialized = JSON.stringify(value);
    if (ttl > 0) {
      await redis.setex(key, ttl, serialized);
    } else {
      await redis.set(key, serialized);
    }
    return true;
  } catch (error) {
    logger.error('Redis SET error', { key, ttl, error: error.message });
    return false;
  }
}

async function del(key) {
  if (!redis || !isConnected) return false;
  
  try {
    await redis.del(key);
    return true;
  } catch (error) {
    logger.error('Redis DEL error', { key, error: error.message });
    return false;
  }
}

async function exists(key) {
  if (!redis || !isConnected) return false;
  
  try {
    const result = await redis.exists(key);
    return result === 1;
  } catch (error) {
    logger.error('Redis EXISTS error', { key, error: error.message });
    return false;
  }
}

// =============================================
// SCRAPER-SPECIFIC CACHE FUNCTIONS
// =============================================

// Scraping session cache
async function cacheScrapingSession(sessionId, sessionData, ttl = 86400) {
  const key = KEYS.SCRAPING_SESSION(sessionId);
  return await set(key, sessionData, ttl);
}

async function getScrapingSession(sessionId) {
  const key = KEYS.SCRAPING_SESSION(sessionId);
  return await get(key);
}

// URL scraping cache (to avoid re-scraping same URLs)
async function markUrlAsScraped(url, metadata = {}, ttl = 604800) { // 1 week
  const key = KEYS.SCRAPED_URL(url);
  const data = {
    url,
    scrapedAt: new Date().toISOString(),
    metadata
  };
  return await set(key, data, ttl);
}

async function isUrlScraped(url) {
  const key = KEYS.SCRAPED_URL(url);
  return await exists(key);
}

// Duplicate detection cache
async function checkDuplicate(company, phone, ttl = 86400) {
  const key = KEYS.DUPLICATE_CHECK(company, phone);
  return await exists(key);
}

async function markAsDuplicate(company, phone, ttl = 86400) {
  const key = KEYS.DUPLICATE_CHECK(company, phone);
  return await set(key, { company, phone, markedAt: new Date().toISOString() }, ttl);
}

// Rate limiting
async function checkRateLimit(source, maxRequests = 100, windowSeconds = 3600) {
  if (!redis || !isConnected) return { allowed: true, remaining: maxRequests };
  
  try {
    const key = KEYS.RATE_LIMIT(source);
    const current = await redis.incr(key);
    
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }
    
    const remaining = Math.max(0, maxRequests - current);
    const allowed = current <= maxRequests;
    
    return { allowed, remaining, current };
    
  } catch (error) {
    logger.error('Rate limit check error', { source, error: error.message });
    return { allowed: true, remaining: maxRequests };
  }
}

// Statistics cache
async function cacheStats(source, date, stats, ttl = 86400) {
  const key = KEYS.STATS(source, date);
  return await set(key, stats, ttl);
}

async function getStats(source, date) {
  const key = KEYS.STATS(source, date);
  return await get(key);
}

// =============================================
// QUEUE OPERATIONS
// =============================================

// Add to queue
async function enqueue(queueName, item, priority = 0) {
  if (!redis || !isConnected) return false;
  
  try {
    const key = KEYS.QUEUE(queueName);
    const data = JSON.stringify({ item, priority, addedAt: new Date().toISOString() });
    await redis.lpush(key, data);
    return true;
  } catch (error) {
    logger.error('Queue enqueue error', { queueName, error: error.message });
    return false;
  }
}

// Get from queue
async function dequeue(queueName, timeout = 0) {
  if (!redis || !isConnected) return null;
  
  try {
    const key = KEYS.QUEUE(queueName);
    const result = timeout > 0 
      ? await redis.brpop(key, timeout)
      : await redis.rpop(key);
    
    if (!result) return null;
    
    const data = timeout > 0 ? result[1] : result;
    return JSON.parse(data);
    
  } catch (error) {
    logger.error('Queue dequeue error', { queueName, error: error.message });
    return null;
  }
}

// Queue length
async function queueLength(queueName) {
  if (!redis || !isConnected) return 0;
  
  try {
    const key = KEYS.QUEUE(queueName);
    return await redis.llen(key);
  } catch (error) {
    logger.error('Queue length error', { queueName, error: error.message });
    return 0;
  }
}

// =============================================
// DISTRIBUTED LOCKING
// =============================================

async function acquireLock(resource, ttl = 30, retries = 3) {
  if (!redis || !isConnected) return null;
  
  const key = KEYS.LOCK(resource);
  const value = `${Date.now()}-${Math.random()}`;
  
  for (let i = 0; i < retries; i++) {
    try {
      const result = await redis.set(key, value, 'PX', ttl * 1000, 'NX');
      if (result === 'OK') {
        return {
          key,
          value,
          release: async () => {
            const script = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            return await redis.eval(script, 1, key, value);
          }
        };
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
      
    } catch (error) {
      logger.error('Lock acquisition error', { resource, error: error.message });
    }
  }
  
  return null;
}

// =============================================
// HEALTH CHECK
// =============================================

async function healthCheck() {
  try {
    if (!redis || !isConnected) {
      return {
        status: 'disconnected',
        cache: 'redis',
        error: 'Redis client not connected'
      };
    }
    
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;
    
    const info = await redis.info('memory');
    const memoryMatch = info.match(/used_memory_human:(.+)/);
    const memoryUsed = memoryMatch ? memoryMatch[1].trim() : 'unknown';
    
    return {
      status: 'healthy',
      cache: 'redis',
      latency: `${latency}ms`,
      memoryUsed,
      database: config.db,
      keyPrefix: config.keyPrefix
    };
    
  } catch (error) {
    return {
      status: 'unhealthy',
      cache: 'redis',
      error: error.message
    };
  }
}

// =============================================
// CLEANUP AND SHUTDOWN
// =============================================

async function close() {
  if (redis) {
    logger.info('🔌 Closing Redis connection...');
    await redis.quit();
    redis = null;
    isConnected = false;
    logger.info('✅ Redis connection closed');
  }
}

// =============================================
// EXPORTS
// =============================================

export default {
  initialize,
  healthCheck,
  close,
  
  // Generic operations
  get,
  set,
  del,
  exists,
  
  // Scraper-specific operations
  cacheScrapingSession,
  getScrapingSession,
  markUrlAsScraped,
  isUrlScraped,
  checkDuplicate,
  markAsDuplicate,
  checkRateLimit,
  cacheStats,
  getStats,
  
  // Queue operations
  enqueue,
  dequeue,
  queueLength,
  
  // Locking
  acquireLock,
  
  // Direct client access
  get client() {
    return redis;
  },
  
  get isConnected() {
    return isConnected;
  }
};
