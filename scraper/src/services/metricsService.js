// =============================================
// METRICS SERVICE - CENTRALIZED METRICS COLLECTION
// =============================================

import logger from '../utils/logger.js';
import redis from '../database/redis.js';

class MetricsService {
  constructor() {
    this.metrics = new Map();
    this.isInitialized = false;
    this.flushInterval = null;
    this.metricsBuffer = [];
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    try {
      logger.info('📈 Initializing Metrics Service...');

      // Initialize metrics storage
      this.initializeMetrics();

      // Start metrics flush interval (every 30 seconds)
      this.startMetricsFlush();

      this.isInitialized = true;
      logger.info('✅ Metrics Service initialized successfully');

    } catch (error) {
      logger.error('❌ Failed to initialize Metrics Service', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  initializeMetrics() {
    // HTTP Request metrics
    this.metrics.set('http_requests_total', 0);
    this.metrics.set('http_requests_success', 0);
    this.metrics.set('http_requests_error', 0);
    this.metrics.set('http_response_time_avg', 0);

    // Scraping metrics
    this.metrics.set('scraping_sessions_total', 0);
    this.metrics.set('scraping_sessions_success', 0);
    this.metrics.set('scraping_sessions_failed', 0);
    this.metrics.set('scraping_pages_processed', 0);
    this.metrics.set('scraping_leads_found', 0);
    this.metrics.set('scraping_leads_saved', 0);
    this.metrics.set('scraping_duplicates_skipped', 0);

    // Performance metrics
    this.metrics.set('memory_usage_mb', 0);
    this.metrics.set('cpu_usage_percent', 0);
    this.metrics.set('active_connections', 0);

    // Business metrics
    this.metrics.set('leads_total', 0);
    this.metrics.set('leads_new', 0);
    this.metrics.set('leads_processed', 0);
    this.metrics.set('leads_enriched', 0);
  }

  // =============================================
  // HTTP METRICS
  // =============================================

  recordRequest(type, source, status, duration = null) {
    try {
      // Increment total requests
      this.increment('http_requests_total');

      // Increment by status
      if (status === 'success' || (typeof status === 'number' && status < 400)) {
        this.increment('http_requests_success');
      } else {
        this.increment('http_requests_error');
      }

      // Record response time
      if (duration) {
        this.recordResponseTime(duration);
      }

      // Add to buffer for detailed tracking
      this.addToBuffer({
        type: 'http_request',
        source,
        status,
        duration,
        timestamp: Date.now()
      });

      logger.debug('📊 HTTP request metric recorded', {
        type, source, status, duration
      });

    } catch (error) {
      logger.error('Error recording HTTP request metric', { error: error.message });
    }
  }

  recordResponseTime(duration) {
    try {
      const currentAvg = this.get('http_response_time_avg') || 0;
      const totalRequests = this.get('http_requests_total') || 1;
      
      // Calculate new average
      const newAvg = ((currentAvg * (totalRequests - 1)) + duration) / totalRequests;
      this.set('http_response_time_avg', Math.round(newAvg));

    } catch (error) {
      logger.error('Error recording response time', { error: error.message });
    }
  }

  // =============================================
  // SCRAPING METRICS
  // =============================================

  recordScrapingSession(source, status, stats = {}) {
    try {
      this.increment('scraping_sessions_total');

      if (status === 'success' || status === 'completed') {
        this.increment('scraping_sessions_success');
      } else if (status === 'failed' || status === 'error') {
        this.increment('scraping_sessions_failed');
      }

      // Record session stats
      if (stats.pagesProcessed) {
        this.add('scraping_pages_processed', stats.pagesProcessed);
      }
      if (stats.leadsFound) {
        this.add('scraping_leads_found', stats.leadsFound);
      }
      if (stats.leadsSaved) {
        this.add('scraping_leads_saved', stats.leadsSaved);
      }
      if (stats.duplicatesSkipped) {
        this.add('scraping_duplicates_skipped', stats.duplicatesSkipped);
      }

      this.addToBuffer({
        type: 'scraping_session',
        source,
        status,
        stats,
        timestamp: Date.now()
      });

      logger.debug('📊 Scraping session metric recorded', {
        source, status, stats
      });

    } catch (error) {
      logger.error('Error recording scraping session metric', { error: error.message });
    }
  }

  recordLeadProcessed(source, action, success = true) {
    try {
      switch (action) {
        case 'found':
          this.increment('scraping_leads_found');
          break;
        case 'saved':
          if (success) {
            this.increment('scraping_leads_saved');
            this.increment('leads_new');
          }
          break;
        case 'duplicate':
          this.increment('scraping_duplicates_skipped');
          break;
        case 'enriched':
          if (success) {
            this.increment('leads_enriched');
          }
          break;
        case 'processed':
          if (success) {
            this.increment('leads_processed');
          }
          break;
      }

      this.addToBuffer({
        type: 'lead_processed',
        source,
        action,
        success,
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Error recording lead processed metric', { error: error.message });
    }
  }

  // =============================================
  // SYSTEM METRICS
  // =============================================

  recordSystemMetrics() {
    try {
      const memoryUsage = process.memoryUsage();
      const memoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
      this.set('memory_usage_mb', memoryMB);

      // CPU usage would require additional package, keeping simple for now
      this.addToBuffer({
        type: 'system_metrics',
        memory: memoryUsage,
        uptime: process.uptime(),
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Error recording system metrics', { error: error.message });
    }
  }

  // =============================================
  // PERFORMANCE TRACKING
  // =============================================

  startTimer(name) {
    return {
      name,
      startTime: Date.now(),
      end: () => {
        const duration = Date.now() - this.startTime;
        this.recordDuration(name, duration);
        return duration;
      }
    };
  }

  recordDuration(operation, duration) {
    try {
      this.addToBuffer({
        type: 'duration',
        operation,
        duration,
        timestamp: Date.now()
      });

      logger.performance.metric(operation, duration, 'ms');

    } catch (error) {
      logger.error('Error recording duration', { error: error.message });
    }
  }

  // =============================================
  // BASIC OPERATIONS
  // =============================================

  increment(key, value = 1) {
    const current = this.metrics.get(key) || 0;
    this.metrics.set(key, current + value);
  }

  add(key, value) {
    const current = this.metrics.get(key) || 0;
    this.metrics.set(key, current + value);
  }

  set(key, value) {
    this.metrics.set(key, value);
  }

  get(key) {
    return this.metrics.get(key) || 0;
  }

  getAll() {
    const metrics = {};
    for (const [key, value] of this.metrics.entries()) {
      metrics[key] = value;
    }
    return {
      ...metrics,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };
  }

  // =============================================
  // BUFFER MANAGEMENT
  // =============================================

  addToBuffer(metric) {
    this.metricsBuffer.push(metric);
    
    // Keep buffer size manageable
    if (this.metricsBuffer.length > 1000) {
      this.metricsBuffer = this.metricsBuffer.slice(-500);
    }
  }

  getBuffer(type = null, limit = 100) {
    let buffer = this.metricsBuffer;
    
    if (type) {
      buffer = buffer.filter(metric => metric.type === type);
    }
    
    return buffer.slice(-limit).reverse(); // Most recent first
  }

  clearBuffer() {
    this.metricsBuffer = [];
  }

  // =============================================
  // PERIODIC OPERATIONS
  // =============================================

  startMetricsFlush() {
    this.flushInterval = setInterval(async () => {
      try {
        await this.flushMetrics();
        this.recordSystemMetrics();
      } catch (error) {
        logger.error('Error in metrics flush interval', { error: error.message });
      }
    }, 30000); // Every 30 seconds
  }

  async flushMetrics() {
    try {
      if (!redis.isConnected) {
        logger.debug('Skipping metrics flush - Redis not connected');
        return;
      }

      // Cache current metrics
      const currentMetrics = this.getAll();
      await redis.set('scraper:metrics:current', currentMetrics, 300); // 5 minutes TTL

      // Cache recent buffer
      const recentMetrics = this.getBuffer(null, 50);
      await redis.set('scraper:metrics:recent', recentMetrics, 300);

      logger.debug('📊 Metrics flushed to Redis', {
        metricsCount: Object.keys(currentMetrics).length,
        bufferSize: recentMetrics.length
      });

    } catch (error) {
      logger.error('Error flushing metrics to Redis', { error: error.message });
    }
  }

  // =============================================
  // REPORTING
  // =============================================

  generateReport(timeRange = '1h') {
    try {
      const metrics = this.getAll();
      const buffer = this.getBuffer();

      // Calculate rates based on timeRange
      const now = Date.now();
      let cutoffTime;
      
      switch (timeRange) {
        case '5m':
          cutoffTime = now - (5 * 60 * 1000);
          break;
        case '1h':
          cutoffTime = now - (60 * 60 * 1000);
          break;
        case '24h':
          cutoffTime = now - (24 * 60 * 60 * 1000);
          break;
        default:
          cutoffTime = now - (60 * 60 * 1000); // 1 hour
      }

      const recentEvents = buffer.filter(event => event.timestamp >= cutoffTime);

      const report = {
        timeRange,
        generatedAt: new Date().toISOString(),
        summary: {
          totalRequests: metrics.http_requests_total,
          successRate: metrics.http_requests_total > 0 
            ? Math.round((metrics.http_requests_success / metrics.http_requests_total) * 100) 
            : 0,
          avgResponseTime: metrics.http_response_time_avg,
          scrapingSessions: metrics.scraping_sessions_total,
          leadsFound: metrics.scraping_leads_found,
          leadsSaved: metrics.scraping_leads_saved,
          duplicatesSkipped: metrics.scraping_duplicates_skipped,
          memoryUsage: metrics.memory_usage_mb
        },
        recent: {
          eventCount: recentEvents.length,
          events: recentEvents.slice(0, 20) // Latest 20 events
        },
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          version: process.version,
          platform: process.platform
        }
      };

      return report;

    } catch (error) {
      logger.error('Error generating metrics report', { error: error.message });
      return {
        error: error.message,
        generatedAt: new Date().toISOString()
      };
    }
  }

  // =============================================
  // CLEANUP
  // =============================================

  async stop() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush
    await this.flushMetrics();
    
    logger.info('📊 Metrics Service stopped');
  }

  reset() {
    this.metrics.clear();
    this.metricsBuffer = [];
    this.initializeMetrics();
    logger.info('📊 Metrics reset');
  }
}

// =============================================
// SINGLETON EXPORT
// =============================================

const metricsService = new MetricsService();
export default metricsService;
