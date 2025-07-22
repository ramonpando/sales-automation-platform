// =============================================
// SCRAPER SERVICE - MAIN SCRAPING ENGINE
// =============================================

const axios = require('axios');
const cheerio = require('cheerio');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

// Lazy load Apify scraper
let ApifyScraperService;
try {
  ApifyScraperService = require('./scrapers/apifyScraperService');
} catch (error) {
  console.log('Apify scraper not available');
}

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
      lastRun: null
    };
    
    // Initialize Apify scraper if available
    this.apifyScraper = null;
    this.metricsService = null;
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    try {
      this.logger.info('🕷️ Initializing Scraper Service...');

      // Setup scheduled scraping if enabled
      if (config.autoStart) {
        this.scheduleAutomaticScraping();
      }

      // Load stats from database
      await this.loadStats();

      // Initialize metrics service
      try {
        this.metricsService = require('./metricsService');
      } catch (error) {
        this.logger.warn('Metrics service not available');
      }

      // Initialize Apify if enabled
      if (process.env.USE_APIFY === 'true' && ApifyScraperService) {
        try {
          this.apifyScraper = new ApifyScraperService(this.logger, this.metricsService);
          await this.apifyScraper.initialize();
          this.logger.info('✅ Apify scraper initialized');
        } catch (error) {
          this.logger.error('Failed to initialize Apify scraper', error);
        }
      }

      this.logger.info('✅ Scraper Service initialized successfully', {
        autoStart: config.autoStart,
        sources: Object.keys(config.sources).filter(s => config.sources[s].enabled),
        maxConcurrentRequests: config.maxConcurrentRequests,
        schedule: config.scraperInterval,
        apifyEnabled: !!this.apifyScraper
      });

    } catch (error) {
      this.logger.error('❌ Failed to initialize Scraper Service', {
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
    this.logger.info('⏰ Setting up automatic scraping schedule', {
      schedule: config.scraperInterval
    });

    const job = cron.schedule(config.scraperInterval, async () => {
      if (!this.isRunning) {
        this.logger.info('🤖 Starting automatic scraping session');
        await this.startFullScraping();
      } else {
        this.logger.warn('⚠️ Skipping automatic scraping - another session is running');
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
      this.logger.info('Starting full scraping', { sessionId, options });

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
          this.logger.info(`🎯 Starting scraping from ${sourceName}`);
          
          const sourceResults = await this.scrapeSource(sourceName, sourceConfig, sessionId);
          results.sources[sourceName] = sourceResults;
          results.totalLeads += sourceResults.totalLeads;
          results.newLeads += sourceResults.newLeads;
          results.duplicates += sourceResults.duplicates;
          results.errors += sourceResults.errors;

        } catch (error) {
          this.logger.error(`Error scraping source ${sourceName}`, error);
          results.errors++;
        }
      }

      // Update session with final results
      await this.updateScrapingSession(sessionId, 'completed', results);

      // Update stats
      this.stats.totalSessions++;
      this.stats.totalLeads += results.totalLeads;
      this.stats.lastRun = new Date();

      // Cache results if Redis is available
      if (this.redis && this.redis.getClient()) {
        await this.redis.getClient().setex(
          `session:${sessionId}`,
          86400,
          JSON.stringify(results)
        );
      }

      this.logger.info('Full scraping completed', results);
      return results;

    } catch (error) {
      await this.updateScrapingSession(sessionId, 'failed', { error: error.message });
      this.logger.error('Full scraping failed', error);
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

    // Scrape each category
    for (const category of sourceConfig.categories) {
      try {
        this.logger.info(`📂 Scraping category: ${category} from ${sourceName}`);
        
        const categoryResults = await this.scrapeCategory(sourceName, sourceConfig, category, sessionId);
        results.categories[category] = categoryResults;
        results.totalLeads += categoryResults.totalLeads;
        results.newLeads += categoryResults.newLeads;
        results.duplicates += categoryResults.duplicates;

        // Add delay between categories
        await this.delay(config.rateLimitDelay * 2);

      } catch (error) {
        this.logger.error(`❌ Error scraping category ${category} from ${sourceName}`, {
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
        this.logger.info(`📄 Scraping page ${page} of ${category} from ${sourceName}`);

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
            this.logger.error('Error saving lead', { lead, error: error.message });
          }
        }

        // Check if there are more pages
        hasMorePages = pageResults.hasNextPage;
        page++;

        // Add delay between pages
        await this.delay(config.rateLimitDelay);

      } catch (error) {
        this.logger.error(`❌ Error scraping page ${page} of ${category}`, {
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
    // Si Apify está habilitado y es Páginas Amarillas, intentar usar el scraper mejorado
    if (this.apifyScraper && sourceName === 'paginasAmarillas' && process.env.USE_APIFY === 'true') {
      try {
        this.logger.info('Using Apify enhanced scraper for Páginas Amarillas');
        const result = await this.apifyScraper.scrapePaginasAmarillasEnhanced(
          category,
          'Mexico', // o usar location del config
          50 // límite por página
        );
        
        return {
          leads: result.results,
          hasNextPage: result.results.length >= 50
        };
      } catch (error) {
        this.logger.warn('Apify scraping failed, falling back to basic scraper', error);
        // Continuar con el scraper básico
      }
    }
    
    const url = this.buildSearchUrl(sourceConfig, category, page);
    
    try {
      // Apply rate limiting
      await rateLimiter.consume({ source: sourceName });

      // Make HTTP request
      const response = await this.makeRequest(url, sourceName);
      
      // Parse leads from HTML
      const leads = this.parseLeads(response.data, sourceName, url);
      
      // Check for next page
      const hasNextPage = this.hasNextPage(response.data, sourceName);

      this.logger.info(`Page scraped`, {
        url,
        leadsFound: leads.length,
        hasNextPage,
        category,
        page
      });

      return { leads, hasNextPage };

    } catch (error) {
      this.logger.error('❌ Error scraping page', {
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
  // APIFY INTEGRATION
  // =============================================

  async scrapeWithApify(config) {
    if (!this.apifyScraper) {
      throw new Error('Apify scraper not initialized');
    }

    const results = {
      paginasAmarillas: [],
      googleMyBusiness: [],
      linkedin: []
    };

    try {
      // Scrape Páginas Amarillas
      if (config.sources.includes('paginasAmarillas')) {
        const paResults = await this.apifyScraper.scrapePaginasAmarillasEnhanced(
          config.category,
          config.location,
          config.limit
        );
        results.paginasAmarillas = paResults.results;
      }

      // Scrape Google My Business
      if (config.sources.includes('googleMyBusiness')) {
        const gmbResults = await this.apifyScraper.scrapeGoogleMyBusiness(
          config.category,
          config.location,
          config.limit
        );
        results.googleMyBusiness = gmbResults.results;
      }

      // Scrape LinkedIn (si está configurado)
      if (config.sources.includes('linkedin') && process.env.LINKEDIN_COOKIE) {
        const linkedinResults = await this.apifyScraper.scrapeLinkedInCompanies(
          config.category,
          config.location,
          Math.min(config.limit, 20) // LinkedIn es más restrictivo
        );
        results.linkedin = linkedinResults.results;
      }

      return {
        success: true,
        results,
        totalLeads: Object.values(results).flat().length
      };

    } catch (error) {
      this.logger.error('Apify scraping failed', error);
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
      
      return response;

    } catch (error) {
      if (retries < config.maxRetries) {
        this.logger.warn(`🔄 Retrying request (${retries + 1}/${config.maxRetries})`, {
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
          this.logger.warn('🤷 Unknown source for parsing', { source });
      }

      return leads;

    } catch (error) {
      this.logger.error('❌ Error parsing leads', {
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
          this.logger.debug('Lead found', lead);
        }

      } catch (error) {
        this.logger.error('Error parsing individual lead', { error: error.message });
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
          this.logger.debug('Lead found', lead);
        }

      } catch (error) {
        this.logger.error('Error parsing individual lead', { error: error.message });
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
        this.logger.debug('Duplicate lead found', leadData);
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
      if (this.database && this.database.pool) {
        const result = await this.database.query(`
          INSERT INTO scraping_results (
            job_id, source, business_name, phone, email, website, address, category, raw_data
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id
        `, [
          sessionId, source, lead.company_name, lead.phone, lead.email, 
          lead.website, lead.address, lead.category, JSON.stringify(lead)
        ]);

        this.logger.debug('💾 Lead saved to database', {
          id: result.rows[0].id,
          company: lead.company_name
        });

        return { isNew: true, id: result.rows[0].id };
      }

      return { isNew: true };

    } catch (error) {
      this.logger.error('❌ Error saving lead', {
        lead: leadData,
        error: error.message
      });
      throw error;
    }
  }

  async checkDuplicate(companyName, phone) {
    if (!this.database || !this.database.pool) return false;

    try {
      const result = await this.database.query(`
        SELECT id FROM scraping_results 
        WHERE business_name = $1 AND phone = $2
        LIMIT 1
      `, [companyName, phone]);

      return result.rows.length > 0;
    } catch (error) {
      this.logger.error('Error checking duplicate', error);
      return false;
    }
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
    if (!this.database || !this.database.pool) return { id: sessionId };

    try {
      // Create sessions table if not exists
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

      const result = await this.database.query(`
        INSERT INTO scraping_sessions (
          uuid, session_type, status, target_url
        ) VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [sessionId, type, 'running', JSON.stringify(options)]);

      return result.rows[0];
    } catch (error) {
      this.logger.error('Error creating session', error);
      return { id: sessionId };
    }
  }

  async updateScrapingSession(sessionId, status, stats = {}) {
    if (!this.database || !this.database.pool) return;

    try {
      await this.database.query(`
        UPDATE scraping_sessions 
        SET status = $1, final_stats = $2, completed_at = NOW(),
            duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))
        WHERE uuid = $3
      `, [status, JSON.stringify(stats), sessionId]);
    } catch (error) {
      this.logger.error('Error updating session', error);
    }
  }

  async loadStats() {
    if (!this.database || !this.database.pool) return;

    try {
      const result = await this.database.query(`
        SELECT 
          COUNT(*) as total_sessions,
          SUM(COALESCE((final_stats->>'totalLeads')::int, 0)) as total_leads,
          MAX(completed_at) as last_run
        FROM scraping_sessions
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
      this.logger.error('Error loading stats', { error: error.message });
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
        sources: Object.keys(config.sources).filter(s => config.sources[s].enabled),
        apifyEnabled: !!this.apifyScraper
      }
    };
  }

  async stop() {
    this.logger.info('🛑 Stopping Scraper Service...');
    
    // Stop cron jobs
    for (const [name, job] of this.cronJobs) {
      job.destroy();
      this.logger.info(`⏰ Stopped cron job: ${name}`);
    }
    
    this.cronJobs.clear();
    this.isRunning = false;
    
    // Cleanup Apify if needed
    if (this.apifyScraper && this.apifyScraper.cleanup) {
      await this.apifyScraper.cleanup();
    }
    
    this.logger.info('✅ Scraper Service stopped');
  }

  // Method from simplified version for compatibility
  async startScraping(config) {
    return this.startFullScraping(config);
  }

  getAvailableScrapers() {
    const scrapers = [];
    for (const [key, scraper] of Object.entries(config.sources)) {
      if (scraper.enabled) {
        scrapers.push({
          id: key,
          name: key === 'paginasAmarillas' ? 'Páginas Amarillas' : 'Sección Amarilla',
          enabled: scraper.enabled,
          hasEmail: key === 'paginasAmarillas'
        });
      }
    }
    
    // Add Apify scrapers if enabled
    if (this.apifyScraper) {
      scrapers.push({
        id: 'googleMyBusiness',
        name: 'Google My Business',
        enabled: true,
        hasEmail: true
      });
    }
    
    return scrapers;
  }

  async getJobStatus(jobId) {
    if (this.redis && this.redis.getClient()) {
      const data = await this.redis.getClient().get(`session:${jobId}`);
      return data ? JSON.parse(data) : null;
    }
    return null;
  }
}

// =============================================
// SINGLETON EXPORT
// =============================================

let instance = null;

module.exports = {
  initialize: (database, redis, logger) => {
    if (!instance) {
      instance = new ScraperService(database, redis, logger);
    }
    return instance;
  },
  getInstance: () => instance
};
