// =============================================
// SCRAPER SERVICE - MAIN SCRAPING ENGINE
// =============================================

import axios from 'axios';
import * as cheerio from 'cheerio';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';

import logger from '../utils/logger.js';
import database from '../database/connection.js';
import redis from '../database/redis.js';
import metricsService from './metricsService.js';

// =============================================
// SCRAPER CONFIGURATION
// =============================================

const config = {
  // Rate limiting
  maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 5,
  rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY) || 200,
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT) || 15000,
  
  // Retry configuration
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  retryDelay: parseInt(process.env.RETRY_DELAY) || 1000,
  
  // Scraping schedule
  scraperInterval: process.env.SCRAPER_INTERVAL || '0 */2 * * *', // Every 2 hours
  autoStart: process.env.AUTO_START_SCRAPING === 'true',
  
  // User agents for rotation
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  ],
  
  // Target sources
  sources: {
    paginasAmarillas: {
      baseUrl: 'https://www.paginasamarillas.com.mx',
      searchUrl: 'https://www.paginasamarillas.com.mx/busqueda',
      enabled: true,
      rateLimit: 100, // requests per hour
      categories: ['restaurantes', 'servicios', 'comercio', 'construccion']
    },
    seccionAmarilla: {
      baseUrl: 'https://www.seccionamarilla.com.mx',
      searchUrl: 'https://www.seccionamarilla.com.mx/buscar',
      enabled: true,
      rateLimit: 100, // requests per hour
      categories: ['restaurantes', 'servicios', 'tiendas', 'profesionales']
    }
  }
};

// =============================================
// RATE LIMITER
// =============================================

const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.source || 'global',
  points: config.maxConcurrentRequests,
  duration: 1 // Per second
});

// =============================================
// SCRAPER SERVICE CLASS
// =============================================

class ScraperService {
  constructor() {
    this.isRunning = false;
    this.activeJobs = new Map();
    this.cronJobs = new Map();
    this.stats = {
      totalSessions: 0,
      totalLeads: 0,
      totalErrors: 0,
      lastRun: null
    };
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    try {
      logger.info('🕷️ Initializing Scraper Service...');

      // Setup scheduled scraping if enabled
      if (config.autoStart) {
        this.scheduleAutomaticScraping();
      }

      // Load stats from database
      await this.loadStats();

      logger.info('✅ Scraper Service initialized successfully', {
        autoStart: config.autoStart,
        sources: Object.keys(config.sources).filter(s => config.sources[s].enabled),
        maxConcurrentRequests: config.maxConcurrentRequests,
        schedule: config.scraperInterval
      });

    } catch (error) {
      logger.error('❌ Failed to initialize Scraper Service', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  // =============================================
  // SCHEDULED SCRAPING
  // =============================================

  scheduleAutomaticScraping() {
    logger.info('⏰ Setting up automatic scraping schedule', {
      schedule: config.scraperInterval
    });

    const job = cron.schedule(config.scraperInterval, async () => {
      if (!this.isRunning) {
        logger.info('🤖 Starting automatic scraping session');
        await this.startFullScraping();
      } else {
        logger.warn('⚠️ Skipping automatic scraping - another session is running');
      }
    }, {
      scheduled: false,
      timezone: "America/Mexico_City"
    });

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
      logger.scraper.start('full-scraping', { sessionId, options });

      // Create scraping session record
      const session = await this.createScrapingSession(sessionId, 'automatic', options);

      const results = {
        sessionId,
        totalLeads: 0,
        newLeads: 0,
        duplicates: 0,
        errors: 0,
        sources: {}
      };

      // Scrape from all enabled sources
      for (const [sourceName, sourceConfig] of Object.entries(config.sources)) {
        if (!sourceConfig.enabled) continue;

        try {
          logger.info(`🎯 Starting scraping from ${sourceName}`);
          
          const sourceResults = await this.scrapeSource(sourceName, sourceConfig, sessionId);
          results.sources[sourceName] = sourceResults;
          results.totalLeads += sourceResults.totalLeads;
          results.newLeads += sourceResults.newLeads;
          results.duplicates += sourceResults.duplicates;
          results.errors += sourceResults.errors;

        } catch (error) {
          logger.scraper.error(sourceName, error);
          results.errors++;
        }
      }

      // Update session with final results
      await this.updateScrapingSession(sessionId, 'completed', results);

      // Update stats
      this.stats.totalSessions++;
      this.stats.totalLeads += results.totalLeads;
      this.stats.lastRun = new Date();

      // Cache results
      await redis.cacheScrapingSession(sessionId, results, 86400);

      logger.scraper.success('full-scraping', results);
      return results;

    } catch (error) {
      await this.updateScrapingSession(sessionId, 'failed', { error: error.message });
      logger.scraper.error('full-scraping', error);
      throw error;

    } finally {
      this.isRunning = false;
    }
  }

  async scrapeSource(sourceName, sourceConfig, sessionId) {
    const results = {
      source: sourceName,
      totalLeads: 0,
      newLeads: 0,
      duplicates: 0,
      errors: 0,
      categories: {}
    };

    // Check rate limit
    const rateCheck = await redis.checkRateLimit(sourceName, sourceConfig.rateLimit, 3600);
    if (!rateCheck.allowed) {
      throw new Error(`Rate limit exceeded for ${sourceName}. Remaining: ${rateCheck.remaining}`);
    }

    // Scrape each category
    for (const category of sourceConfig.categories) {
      try {
        logger.info(`📂 Scraping category: ${category} from ${sourceName}`);
        
        const categoryResults = await this.scrapeCategory(sourceName, sourceConfig, category, sessionId);
        results.categories[category] = categoryResults;
        results.totalLeads += categoryResults.totalLeads;
        results.newLeads += categoryResults.newLeads;
        results.duplicates += categoryResults.duplicates;

        // Add delay between categories
        await this.delay(config.rateLimitDelay * 2);

      } catch (error) {
        logger.error(`❌ Error scraping category ${category} from ${sourceName}`, {
          error: error.message,
          category,
          source: sourceName
        });
        results.errors++;
      }
    }

    return results;
  }

  async scrapeCategory(sourceName, sourceConfig, category, sessionId) {
    const results = {
      category,
      totalLeads: 0,
      newLeads: 0,
      duplicates: 0,
      pages: 0
    };

    let page = 1;
    let hasMorePages = true;

    while (hasMorePages && page <= 10) { // Limit to 10 pages per category
      try {
        logger.info(`📄 Scraping page ${page} of ${category} from ${sourceName}`);

        const pageResults = await this.scrapePage(sourceName, sourceConfig, category, page, sessionId);
        
        results.totalLeads += pageResults.leads.length;
        results.pages++;

        // Process leads from this page
        for (const lead of pageResults.leads) {
          try {
            const saved = await this.saveLead(lead, sourceName, sessionId);
            if (saved.isNew) {
              results.newLeads++;
            } else {
              results.duplicates++;
            }
          } catch (error) {
            logger.error('Error saving lead', { lead, error: error.message });
          }
        }

        // Check if there are more pages
        hasMorePages = pageResults.hasNextPage;
        page++;

        // Add delay between pages
        await this.delay(config.rateLimitDelay);

      } catch (error) {
        logger.error(`❌ Error scraping page ${page} of ${category}`, {
          error: error.message,
          page,
          category,
          source: sourceName
        });
        break;
      }
    }

    return results;
  }

  async scrapePage(sourceName, sourceConfig, category, page, sessionId) {
    const url = this.buildSearchUrl(sourceConfig, category, page);
    
    try {
      // Check if URL was already scraped recently
      if (await redis.isUrlScraped(url)) {
        logger.debug('⏭️ Skipping already scraped URL', { url });
        return { leads: [], hasNextPage: false };
      }

      // Apply rate limiting
      await rateLimiter.consume({ source: sourceName });

      // Make HTTP request
      const response = await this.makeRequest(url, sourceName);
      
      // Parse leads from HTML
      const leads = this.parseLeads(response.data, sourceName, url);
      
      // Check for next page
      const hasNextPage = this.hasNextPage(response.data, sourceName);

      // Mark URL as scraped
      await redis.markUrlAsScraped(url, {
        leadsFound: leads.length,
        scrapedAt: new Date().toISOString(),
        sessionId
      });

      logger.scraper.page(url, {
        leadsFound: leads.length,
        hasNextPage,
        category,
        page
      });

      return { leads, hasNextPage };

    } catch (error) {
      logger.error('❌ Error scraping page', {
        url,
        error: error.message,
        source: sourceName,
        category,
        page
      });
      throw error;
    }
  }

  // =============================================
  // HTTP REQUEST HANDLING
  // =============================================

  async makeRequest(url, source, retries = 0) {
    try {
      const userAgent = config.userAgents[Math.floor(Math.random() * config.userAgents.length)];
      
      const response = await axios.get(url, {
        timeout: config.requestTimeout,
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      // Update metrics
      metricsService.recordRequest('scraper', source, 'success');
      
      return response;

    } catch (error) {
      // Update metrics
      metricsService.recordRequest('scraper', source, 'error');

      if (retries < config.maxRetries) {
        logger.warn(`🔄 Retrying request (${retries + 1}/${config.maxRetries})`, {
          url,
          error: error.message
        });
        
        await this.delay(config.retryDelay * (retries + 1));
        return this.makeRequest(url, source, retries + 1);
      }

      throw error;
    }
  }

  // =============================================
  // PARSING METHODS
  // =============================================

  parseLeads(html, source, url) {
    const $ = cheerio.load(html);
    const leads = [];

    try {
      // Different parsing logic for each source
      switch (source) {
        case 'paginasAmarillas':
          leads.push(...this.parsePaginasAmarillas($, url));
          break;
        case 'seccionAmarilla':
          leads.push(...this.parseSeccionAmarilla($, url));
          break;
        default:
          logger.warn('🤷 Unknown source for parsing', { source });
      }

      return leads;

    } catch (error) {
      logger.error('❌ Error parsing leads', {
        source,
        url,
        error: error.message
      });
      return [];
    }
  }

  parsePaginasAmarillas($, url) {
    const leads = [];
    
    $('.listing-item, .business-item, .result-item').each((i, element) => {
      try {
        const $el = $(element);
        
        const lead = {
          company_name: this.cleanText($el.find('.business-name, .company-name, h3').first().text()),
          phone: this.extractPhone($el.find('.phone, .telefono').text()),
          address: this.cleanText($el.find('.address, .direccion').text()),
          website: $el.find('a[href*="www"], a[href*="http"]').attr('href'),
          category: this.cleanText($el.find('.category, .categoria').text()),
          source_url: url
        };

        if (lead.company_name && (lead.phone || lead.address)) {
          leads.push(lead);
          logger.scraper.lead(lead, 'paginasAmarillas');
        }

      } catch (error) {
        logger.error('Error parsing individual lead', { error: error.message });
      }
    });

    return leads;
  }

  parseSeccionAmarilla($, url) {
    const leads = [];
    
    $('.empresa, .business, .listing').each((i, element) => {
      try {
        const $el = $(element);
        
        const lead = {
          company_name: this.cleanText($el.find('.nombre, .name, h2, h3').first().text()),
          phone: this.extractPhone($el.find('.tel, .telefono, .phone').text()),
          address: this.cleanText($el.find('.dir, .direccion, .address').text()),
          website: $el.find('a[href*="www"], a[href*="http"]').attr('href'),
          category: this.cleanText($el.find('.giro, .categoria, .category').text()),
          source_url: url
        };

        if (lead.company_name && (lead.phone || lead.address)) {
          leads.push(lead);
          logger.scraper.lead(lead, 'seccionAmarilla');
        }

      } catch (error) {
        logger.error('Error parsing individual lead', { error: error.message });
      }
    });

    return leads;
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  buildSearchUrl(sourceConfig, category, page) {
    const baseUrl = sourceConfig.searchUrl;
    
    // Build search URL with parameters
    const params = new URLSearchParams({
      q: category,
      page: page,
      location: 'Mexico'
    });

    return `${baseUrl}?${params.toString()}`;
  }

  hasNextPage(html, source) {
    const $ = cheerio.load(html);
    
    // Look for next page indicators
    const nextPageSelectors = [
      '.next-page',
      '.pagination .next',
      'a[rel="next"]',
      '.page-nav .siguiente'
    ];

    return nextPageSelectors.some(selector => $(selector).length > 0);
  }

  cleanText(text) {
    return text ? text.trim().replace(/\s+/g, ' ').replace(/\n/g, '') : '';
  }

  extractPhone(text) {
    if (!text) return null;
    
    // Mexican phone number patterns
    const phoneRegex = /(\+52\s?)?(\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4})/;
    const match = text.match(phoneRegex);
    
    return match ? match[0].replace(/[-\s]/g, '') : null;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // =============================================
  // DATABASE OPERATIONS
  // =============================================

  async saveLead(leadData, source, sessionId) {
    try {
      // Check for duplicates
      const isDuplicate = await this.checkDuplicate(leadData.company_name, leadData.phone);
      
      if (isDuplicate) {
        logger.scraper.duplicate(leadData, 'database');
        return { isNew: false, reason: 'database_duplicate' };
      }

      // Prepare lead for database
      const lead = {
        ...leadData,
        source,
        session_id: sessionId,
        confidence_score: this.calculateConfidenceScore(leadData),
        validation_status: 'pending',
        status: 'new'
      };

      // Insert into database
      const result = await database.query(`
        INSERT INTO scraper.leads (
          company_name, phone, email, website, address, location, 
          category, source, source_url, confidence_score, 
          validation_status, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, uuid
      `, [
        lead.company_name, lead.phone, lead.email, lead.website, 
        lead.address, lead.location, lead.category, lead.source, 
        lead.source_url, lead.confidence_score, lead.validation_status, lead.status
      ]);

      // Mark as processed to avoid duplicates
      await redis.markAsDuplicate(leadData.company_name, leadData.phone);

      logger.debug('💾 Lead saved to database', {
        id: result.rows[0].id,
        uuid: result.rows[0].uuid,
        company: lead.company_name
      });

      return { isNew: true, id: result.rows[0].id, uuid: result.rows[0].uuid };

    } catch (error) {
      logger.error('❌ Error saving lead', {
        lead: leadData,
        error: error.message
      });
      throw error;
    }
  }

  async checkDuplicate(companyName, phone) {
    // Check Redis cache first
    const cacheResult = await redis.checkDuplicate(companyName, phone);
    if (cacheResult) return true;

    // Check database
    const result = await database.query(`
      SELECT id FROM scraper.leads 
      WHERE company_name = $1 AND phone = $2
      LIMIT 1
    `, [companyName, phone]);

    return result.rows.length > 0;
  }

  calculateConfidenceScore(lead) {
    let score = 0.5; // Base score
    
    if (lead.phone) score += 0.3;
    if (lead.email) score += 0.2;
    if (lead.website) score += 0.15;
    if (lead.address) score += 0.1;
    if (lead.category) score += 0.05;
    
    return Math.min(score, 1.0);
  }

  // =============================================
  // SESSION MANAGEMENT
  // =============================================

  async createScrapingSession(sessionId, type, options) {
    const result = await database.query(`
      INSERT INTO scraper.scraping_sessions (
        uuid, session_type, status, target_url
      ) VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [sessionId, type, 'running', JSON.stringify(options)]);

    return result.rows[0];
  }

  async updateScrapingSession(sessionId, status, stats = {}) {
    await database.query(`
      UPDATE scraper.scraping_sessions 
      SET status = $1, final_stats = $2, completed_at = NOW(),
          duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))
      WHERE uuid = $3
    `, [status, JSON.stringify(stats), sessionId]);
  }

  async loadStats() {
    try {
      const result = await database.query(`
        SELECT 
          COUNT(*) as total_sessions,
          SUM(COALESCE((final_stats->>'totalLeads')::int, 0)) as total_leads,
          MAX(completed_at) as last_run
        FROM scraper.scraping_sessions
        WHERE status = 'completed'
      `);

      if (result.rows[0]) {
        this.stats = {
          totalSessions: parseInt(result.rows[0].total_sessions) || 0,
          totalLeads: parseInt(result.rows[0].total_leads) || 0,
          totalErrors: 0,
          lastRun: result.rows[0].last_run
        };
      }
    } catch (error) {
      logger.error('Error loading stats', { error: error.message });
    }
  }

  // =============================================
  // PUBLIC API METHODS
  // =============================================

  async getStatus() {
    return {
      isRunning: this.isRunning,
      activeJobs: this.activeJobs.size,
      stats: this.stats,
      config: {
        maxConcurrentRequests: config.maxConcurrentRequests,
        sources: Object.keys(config.sources).filter(s => config.sources[s].enabled)
      }
    };
  }

  async stop() {
    logger.info('🛑 Stopping Scraper Service...');
    
    // Stop cron jobs
    for (const [name, job] of this.cronJobs) {
      job.destroy();
      logger.info(`⏰ Stopped cron job: ${name}`);
    }
    
    this.cronJobs.clear();
    this.isRunning = false;
    
    logger.info('✅ Scraper Service stopped');
  }
}

// =============================================
// SINGLETON EXPORT
// =============================================

const scraperService = new ScraperService();
export default scraperService;
