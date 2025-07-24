// =============================================
// SCRAPER SERVICE - MAIN SCRAPING ENGINE
// =============================================

const axios = require('axios');
const cheerio = require('cheerio');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

// Importación de la clase ApifyScraperService
const ApifyScraperService = require('./scrapers/apifyScraperService');

// Importación de parsers específicos
const parsePaginasAmarillas = require('./parsers/paginasAmarillasParser');
const parseSeccionAmarilla = require('./parsers/seccionAmarillaParser');
const parsePymesOrgMx = require('./parsers/pymesOrgMxParser');

// =============================================
// SCRAPER CONFIGURATION
// =============================================

const config = require('../config');

// =============================================
// RATE LIMITER
// =============================================

const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.source || 'global',
  points: config.maxConcurrentRequests,
  duration: 1,
});

// =============================================
// SCRAPER SERVICE CLASS
// =============================================

class ScraperService {
  constructor(database, redis, logger) {
    this.database = database;
    this.redis = redis;
    this.logger = logger || console;
    this.isRunning = false;
    this.activeJobs = new Map();
    this.cronJobs = new Map();
    this.stats = {
      totalSessions: 0,
      totalLeads: 0,
      totalErrors: 0,
      lastRun: null,
    };

    this.apifyScraper = null;
    this.metricsService = null;
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    try {
      console.log('🔍 initialize() ha sido invocado');
      this.logger.info('🕷️ Initializing Scraper Service...');

      if (config.autoStart) {
        this.scheduleAutomaticScraping();
      }

      await this.loadStats();

      // Carga de métricas (opcional)
      try {
        this.metricsService = require('./metricsService');
      } catch (error) {
        this.logger.warn('Metrics service not available');
      }

      // --- INICIO PARCHE APIFY (AISLADO EN SU PROPIO TRY/CATCH) ---
      const useApify = String(process.env.USE_APIFY).toLowerCase() === 'true';
      console.log(`DEBUG: USE_APIFY='${process.env.USE_APIFY}' → useApify=${useApify}`);

      if (useApify) {
        try {
          // Creamos e inicializamos el scraper de Apify
          this.apifyScraper = new ApifyScraperService(config, this.logger);
          await this.apifyScraper.initialize();
          this.logger.info('✅ Apify scraper initialized');
        } catch (err) {
          // Mostramos el stack trace completo sin detener el init principal
          this.logger.error('❌ Failed to initialize ApifyScraperService', {
            message: err.message,
            stack: err.stack,
          });
          this.apifyScraper = null;
        }
      }
      // --- FIN PARCHE APIFY ---

      this.logger.info('✅ Scraper Service initialized successfully', {
        autoStart: config.autoStart,
        sources: Object.keys(config.sources).filter((s) => config.sources[s].enabled),
        maxConcurrentRequests: config.maxConcurrentRequests,
        schedule: config.scraperInterval,
        apifyEnabled: !!this.apifyScraper,
      });
    } catch (error) {
      this.logger.error('❌ Failed to initialize Scraper Service', {
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  // =============================================
  // SCHEDULED SCRAPING
  // =============================================

  scheduleAutomaticScraping() {
    this.logger.info('⏰ Setting up automatic scraping schedule', { schedule: config.scraperInterval });

    const job = cron.schedule(
      config.scraperInterval,
      async () => {
        if (!this.isRunning) {
          this.logger.info('🤖 Starting automatic scraping session');
          await this.startFullScraping();
        } else {
          this.logger.warn('⚠️ Skipping automatic scraping - another session is running');
        }
      },
      { scheduled: false, timezone: 'America/Mexico_City' }
    );

    this.cronJobs.set('automatic', job);
    job.start();
  }

  // =============================================
  // MAIN SCRAPING METHODS
  // =============================================

  async startFullScraping(options = {}) {
    if (this.isRunning) {
      throw new Error('Scraping session already in progress');
    }

    const sessionId = uuidv4();
    this.isRunning = true;

    try {
      this.logger.info('Starting full scraping', { sessionId, options });

      const session = await this.createScrapingSession(sessionId, 'automatic', options);
      const results = { sessionId, totalLeads: 0, newLeads: 0, duplicates: 0, errors: 0, sources: {} };

      for (const [sourceName, sourceConfig] of Object.entries(config.sources)) {
        if (!sourceConfig.enabled) continue;

        try {
          this.logger.info(`🎯 Starting scraping from ${sourceName}`);

          let srcResults;
          if (sourceName === 'pymesOrgMx' && this.apifyScraper) {
            srcResults = await this.scrapeWithApify({ ...options, sources: [sourceName] });
          } else {
            srcResults = await this.scrapeSource(sourceName, sourceConfig, sessionId, options);
          }

          results.sources[sourceName] = srcResults;
          results.totalLeads += srcResults.totalLeads;
          results.newLeads += srcResults.newLeads;
          results.duplicates += srcResults.duplicates;
          results.errors += srcResults.errors;
        } catch (error) {
          this.logger.error(`Error scraping source ${sourceName}`, { message: error.message });
          results.errors++;
        }
      }

      await this.updateScrapingSession(sessionId, 'completed', results);
      this.stats.totalSessions++;
      this.stats.totalLeads += results.totalLeads;
      this.stats.lastRun = new Date();

      try {
        const key = `session:${sessionId}`;
        const payload = JSON.stringify(results);
        if (this.redis?.setex) {
          await this.redis.setex(key, 86400, payload);
        } else if (this.redis?.getClient) {
          const rc = this.redis.getClient();
          await rc.setEx(key, 86400, payload);
        }
      } catch (e) {
        this.logger.warn('Failed to cache session in Redis', { message: e.message });
      }

      this.logger.info('Full scraping completed', results);
      return results;
    } catch (error) {
      await this.updateScrapingSession(sessionId, 'failed', { error: error.message });
      this.logger.error('Full scraping failed', { message: error.message });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async scrapeSource(sourceName, sourceConfig, sessionId, globalOptions = {}) {
    const results = {
      source: sourceName,
      totalLeads: 0,
      newLeads: 0,
      duplicates: 0,
      errors: 0,
      categories: {},
    };

    for (const category of sourceConfig.categories) {
      try {
        this.logger.info(`📂 Scraping category: ${category} from ${sourceName}`);
        const pageResults = await this.scrapeCategory(sourceName, sourceConfig, category, sessionId);
        results.categories[category] = pageResults;
        results.totalLeads += pageResults.totalLeads;
        results.newLeads += pageResults.newLeads;
        results.duplicates += pageResults.duplicates;
        await this.delay(config.rateLimitDelay * 2);
      } catch (error) {
        this.logger.error(`❌ Error scraping category ${category}`, {
          source: sourceName,
          category,
          message: error.message,
        });
        results.errors++;
      }
    }

    return results;
  }

  async scrapeCategory(sourceName, sourceConfig, category, sessionId) {
    const results = { category, totalLeads: 0, newLeads: 0, duplicates: 0, pages: 0 };
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      try {
        this.logger.info(`📄 Scraping page ${page} of ${category} from ${sourceName}`);
        const pageResults = await this.scrapePage(sourceName, sourceConfig, category, page, sessionId);
        results.totalLeads += pageResults.leads.length;
        results.pages++;
        for (const lead of pageResults.leads) {
          const saved = await this.saveLead(lead, sourceName, sessionId);
          if (saved.isNew) results.newLeads++;
          else results.duplicates++;
        }
        hasMore = pageResults.hasNextPage;
        page++;
        await this.delay(config.rateLimitDelay);
      } catch (error) {
        this.logger.error(`❌ Error scraping page ${page}`, { message: error.message });
        break;
      }
    }

    return results;
  }

  async scrapePage(sourceName, sourceConfig, category, page, sessionId) {
    // Fallback HTML parsing
    const url = this.buildSearchUrl(sourceName, sourceConfig, category, page);
    await rateLimiter.consume({ source: sourceName });
    const response = await this.makeRequest(url, sourceName);

    const parser = {
      paginasAmarillas: parsePaginasAmarillas,
      seccionAmarilla: parseSeccionAmarilla,
      pymesOrgMx: parsePymesOrgMx,
    }[sourceName];

    const leads = parser(response.data, url, category);
    const hasNextPage = this.hasNextPage(response.data, sourceName);

    this.logger.info('Page scraped', {
      url,
      leadsFound: leads.length,
      hasNextPage,
      category,
      page,
    });

    return { leads, hasNextPage };
  }

  // ===========================================
  // APIFY INTEGRATION (manual endpoint /apify)
  // ===========================================

  async scrapeWithApify(cfg) {
    if (!this.apifyScraper) throw new Error('Apify scraper not initialized');
    return this.apifyScraper.run(cfg);
  }

  // =============================================
  // HTTP REQUEST HANDLING
  // =============================================

  async makeRequest(url, source, retries = 0) {
    try {
      const userAgent = config.userAgents[Math.floor(Math.random() * config.userAgents.length)];
      return await axios.get(url, {
        timeout: config.requestTimeout,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          DNT: '1',
          Connection: 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
      });
    } catch (error) {
      if (retries < config.maxRetries) {
        this.logger.warn(`🔄 Retrying request (${retries + 1}/${config.maxRetries})`, {
          url,
          message: error.message,
        });
        await this.delay(config.retryDelay * (retries + 1));
        return this.makeRequest(url, source, retries + 1);
      }
      throw error;
    }
  }

  // =============================================
  // PARSING HELPERS & UTILITIES
  // =============================================

  buildSearchUrl(sourceName, sourceConfig, category, page) {
    switch (sourceName) {
      case 'paginasAmarillas': {
        return `${sourceConfig.searchUrl}/${category}/Mexico?page=${page}`;
      }
      case 'seccionAmarilla': {
        const params = new URLSearchParams({ what: category, where: 'Mexico', page });
        return `${sourceConfig.searchUrl}?${params}`;
      }
      case 'pymesOrgMx':
        return `${sourceConfig.baseUrl}/categoria/${encodeURIComponent(category)}.html?page=${page}`;
      default: {
        const params = new URLSearchParams({ q: category, page });
        return `${sourceConfig.searchUrl}?${params}`;
      }
    }
  }

  hasNextPage(html, sourceName) {
    const $ = cheerio.load(html);
    const selectors = ['.next-page', '.pagination .next', 'a[rel="next"]', '.page-nav .siguiente'];
    return selectors.some((sel) => $(sel).length > 0);
  }

  cleanText(text) {
    return text ? text.trim().replace(/\s+/g, ' ').replace(/\n/g, '') : '';
  }

  async delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // =============================================
  // DATABASE OPERATIONS & SESSION MANAGEMENT
  // =============================================

  async saveLead(leadData, source, sessionId) {
    try {
      const isDuplicate = await this.checkDuplicate(leadData.company_name, leadData.phone);
      if (isDuplicate) return { isNew: false };

      if (this.database && this.database.pool) {
        await this.database.query(`
          CREATE TABLE IF NOT EXISTS scraping_results (
            id SERIAL PRIMARY KEY,
            job_id VARCHAR(255),
            source VARCHAR(50),
            business_name TEXT,
            phone TEXT,
            email TEXT,
            website TEXT,
            address TEXT,
            category TEXT,
            raw_data JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        const { rows } = await this.database.query(
          `INSERT INTO scraping_results
            (job_id, source, business_name, phone, email, website, address, category, raw_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            sessionId,
            source,
            leadData.company_name,
            leadData.phone,
            leadData.email,
            leadData.website,
            leadData.address,
            leadData.category,
            JSON.stringify(leadData),
          ]
        );

        this.logger.debug('💾 Lead saved', { id: rows[0].id, company: leadData.company_name });
        return { isNew: true, id: rows[0].id };
      }

      return { isNew: true };
    } catch (error) {
      this.logger.error('❌ Error saving lead', { message: error.message });
      throw error;
    }
  }

  async checkDuplicate(companyName, phone) {
    if (!this.database || !this.database.pool) return false;
    try {
      const { rows } = await this.database.query(
        `SELECT id FROM scraping_results WHERE business_name=$1 AND phone=$2 LIMIT 1`,
        [companyName, phone]
      );
      return rows.length > 0;
    } catch (error) {
      this.logger.error('Error checking duplicate', { message: error.message });
      return false;
    }
  }

  async createScrapingSession(uuid, type, options) {
    if (!this.database || !this.database.pool) return { id: uuid };
    try {
      await this.database.query(`
        CREATE TABLE IF NOT EXISTS scraping_sessions (
          id SERIAL PRIMARY KEY,
          uuid VARCHAR(255) UNIQUE NOT NULL,
          session_type VARCHAR(50),
          status VARCHAR(50),
          target_url TEXT,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP,
          duration_seconds INTEGER,
          final_stats JSONB
        )
      `);
      const { rows } = await this.database.query(
        `INSERT INTO scraping_sessions (uuid, session_type, status, target_url)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [uuid, type, 'running', JSON.stringify(options)]
      );
      return rows[0];
    } catch (error) {
      this.logger.error('Error creating session', { message: error.message });
      return { id: uuid };
    }
  }

  async updateScrapingSession(uuid, status, stats = {}) {
    if (!this.database || !this.database.pool) return;
    try {
      await this.database.query(
        `UPDATE scraping_sessions
         SET status=$1, final_stats=$2, completed_at=NOW(),
             duration_seconds=EXTRACT(EPOCH FROM NOW()-started_at)
         WHERE uuid=$3`,
        [status, JSON.stringify(stats), uuid]
      );
    } catch (error) {
      this.logger.error('Error updating session', { message: error.message });
    }
  }

  async loadStats() {
    if (!this.database || !this.database.pool) return;
    try {
      const { rows } = await this.database.query(
        `SELECT COUNT(*) AS total_sessions,
                SUM((final_stats->>'totalLeads')::int) AS total_leads,
                MAX(completed_at) AS last_run
         FROM scraping_sessions WHERE status='completed'`
      );
      if (rows[0]) {
        this.stats.totalSessions = parseInt(rows[0].total_sessions) || 0;
        this.stats.totalLeads = parseInt(rows[0].total_leads) || 0;
        this.stats.lastRun = rows[0].last_run;
      }
    } catch (error) {
      this.logger.error('Error loading stats', { message: error.message });
    }
  }

  // =============================================
  // PUBLIC API / ROUTES METHODS
  // =============================================

  async getStatus() {
    return {
      isRunning: this.isRunning,
      stats: this.stats,
      config: {
        maxConcurrentRequests: config.maxConcurrentRequests,
        sources: Object.keys(config.sources).filter((s) => config.sources[s].enabled),
        apifyEnabled: !!this.apifyScraper,
      },
    };
  }

  async stop() {
    this.logger.info('🛑 Stopping Scraper Service...');
    for (const job of this.cronJobs.values()) {
      job.destroy();
    }
    this.cronJobs.clear();
    this.isRunning = false;
    if (this.apifyScraper?.cleanup) {
      await this.apifyScraper.cleanup();
    }
    this.logger.info('✅ Scraper Service stopped');
  }
}

// =============================================
// SINGLETON EXPORT
// =============================================

let instance = null;
module.exports = {
  initialize: (database, redis, logger) => {
    if (!instance) instance = new ScraperService(database, redis, logger);
    return instance;
  },
  getInstance: () => instance,
};

