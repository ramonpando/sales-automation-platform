// =============================================
// SCRAPER ROUTES - API ENDPOINTS
// =============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const router = express.Router();
// --- Helper para responder errores de forma consistente ---
function sendError(res, error, code = 500) {
  console.error('Scrape error:', error);
  return res.status(code).json({
    success: false,
    error: error?.message || String(error),
    details: error?.stack || error
  });
}

// Lazy loading of dependencies
function getLogger() {
  try {
    return require('../utils/logger');
  } catch {
    return console;
  }
}

function getDatabase() {
  return require('../database/connection');
}

function getRedis() {
  return require('../database/redis');
}

function getScraperService() {
  const scraperModule = require('../services/scraperService');
  return scraperModule.getInstance ? scraperModule.getInstance() : null;
}

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false,
      errors: errors.array() 
    });
  }
  next();
};

// =============================================
// SCRAPING ENDPOINTS
// =============================================

// Start full scraping session
router.post('/start', async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();
  
  try {
    const { sources, categories, options = {} } = req.body;
    
    if (logger.api) {
      logger.api.request(req.method, req.url, null, null, req.ip);
    }
    
    if (!scraperService) {
      return res.status(503).json({
        success: false,
        error: 'Scraper service not initialized',
        code: 'SERVICE_UNAVAILABLE'
      });
    }
    
    const result = await scraperService.startFullScraping({
      sources,
      categories,
      ...options,
      triggeredBy: 'api',
      clientIp: req.ip
    });

    res.json({
      success: true,
      message: 'Scraping session started successfully',
      sessionId: result.sessionId,
      data: result
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(400).json({
      success: false,
      error: error.message,
      code: 'SCRAPING_START_FAILED'
    });
  }
});

// Start scraping specific source
router.post('/start/:source', async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();
  
  try {
    const { source } = req.params;
    const { categories, options = {} } = req.body;
    
    if (logger.api) {
      logger.api.request(req.method, req.url, null, null, req.ip);
    }
    
    if (!scraperService) {
      return res.status(503).json({
        success: false,
        error: 'Scraper service not initialized',
        code: 'SERVICE_UNAVAILABLE'
      });
    }
    
    // For now, use the general scraping method
    const result = await scraperService.startFullScraping({
      sources: [source],
      categories,
      ...options,
      triggeredBy: 'api',
      clientIp: req.ip
    });

    res.json({
      success: true,
      message: `Scraping started for ${source}`,
      sessionId: result.sessionId,
      data: result
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(400).json({
      success: false,
      error: error.message,
      code: 'SOURCE_SCRAPING_FAILED'
    });
  }
});

// POST /api/scraper/apify - Scraping con Apify múltiples fuentes
router.post('/apify', [
  body('category').notEmpty().withMessage('Category is required'),
  body('location').notEmpty().withMessage('Location is required'),
  body('state').optional().isString().withMessage('State must be a string'),
  body('sources').isArray().withMessage('Sources must be an array'),
  body('limit').optional().isInt({ min: 1, max: 500 })
], validateRequest, async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();
  const database = getDatabase();
  
  try {
    if (!scraperService) {
      return res.status(503).json({
        error: 'Scraper service not initialized'
      });
    }

    // Verificar si Apify está habilitado
    if (process.env.USE_APIFY !== 'true') {
      return res.status(400).json({
        error: 'Apify scraping is not enabled. Set USE_APIFY=true in environment variables.'
      });
    }

    const config = {
      category: req.body.category,
      location: req.body.location,
      state: req.body.state || 'ciudad-de-mexico',  // Default state para PYMES
      sources: req.body.sources || ['paginasAmarillas', 'googleMyBusiness'],
      limit: req.body.limit || 50
    };

    logger.info('Starting Apify scraping', config);

    // Ejecutar scraping con Apify
    const result = await scraperService.scrapeWithApify(config);

    // Guardar resultados en la base de datos
    let savedCount = 0;
    const sessionId = uuidv4();

    if (database && database.pool) {
      for (const [source, leads] of Object.entries(result.results)) {
        for (const lead of leads) {
          try {
            await database.query(`
              INSERT INTO scraping_results (
                job_id, source, business_name, phone, email, website, 
                address, category, raw_data, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            `, [
              sessionId,
              source,
              lead.businessName || lead.company_name,
              lead.phone,
              lead.email,
              lead.website,
              lead.address,
              config.category,
              JSON.stringify(lead)
            ]);
            savedCount++;
          } catch (error) {
            logger.error('Error saving lead', { error: error.message, lead });
          }
        }
      }
    }

    res.json({
      success: true,
      message: 'Apify scraping completed',
      sessionId,
      data: {
        totalFound: result.totalLeads,
        savedToDatabase: savedCount,
        bySource: {
          paginasAmarillas: result.results.paginasAmarillas?.length || 0,
          googleMyBusiness: result.results.googleMyBusiness?.length || 0,
          linkedin: result.results.linkedin?.length || 0,
          pymesOrgMx: result.results.pymesOrgMx?.length || 0
        }
      }
    });

  } catch (error) {
    logger.error('Apify scraping failed', { error: error.message });
    res.status(500).json({
      error: error.message,
      details: 'Apify scraping failed. Check logs for details.'
    });
  }
});

// GET /api/scraper/apify/status - Check Apify status
router.get('/apify/status', async (req, res) => {
  const scraperService = getScraperService();
  
  try {
    if (!scraperService) {
      return res.status(503).json({
        error: 'Scraper service not initialized'
      });
    }
    
    const status = await scraperService.getStatus();
    
    res.json({
      apifyEnabled: process.env.USE_APIFY === 'true',
      apifyInitialized: status.config.apifyEnabled,
      availableScrapers: scraperService.getAvailableScrapers(),
      environmentVariables: {
        USE_APIFY: !!process.env.USE_APIFY,
        APIFY_TOKEN: !!process.env.APIFY_TOKEN,
        GOOGLE_PLACES_API_KEY: !!process.env.GOOGLE_PLACES_API_KEY,
        LINKEDIN_COOKIE: !!process.env.LINKEDIN_COOKIE
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get scraping status
router.get('/status', async (req, res) => {
  const scraperService = getScraperService();
  
  try {
    if (!scraperService) {
      return res.status(503).json({
        success: false,
        error: 'Scraper service not initialized',
        code: 'SERVICE_UNAVAILABLE'
      });
    }
    
    const status = await scraperService.getStatus();
    
    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    const logger = getLogger();
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'STATUS_FETCH_FAILED'
    });
  }
});

// Get available scrapers
router.get('/scrapers', async (req, res) => {
  const scraperService = getScraperService();
  
  try {
    if (!scraperService) {
      return res.status(503).json({
        success: false,
        error: 'Scraper service not initialized'
      });
    }
    
    const scrapers = scraperService.getAvailableScrapers();
    
    res.json({
      success: true,
      data: scrapers
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test scraping endpoint
router.post('/test', [
  body('source').notEmpty().withMessage('Source is required'),
  body('category').notEmpty().withMessage('Category is required'),
  body('limit').optional().isInt({ min: 1, max: 100 })
], validateRequest, async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();
  
  try {
    if (!scraperService) {
      return res.status(503).json({
        error: 'Scraper service not initialized'
      });
    }
    
    const { source, category, limit = 5 } = req.body;
    
    logger.info('Test scraping started', { source, category, limit });
    
    // For test, just scrape one category from one source
    const result = await scraperService.startFullScraping({
      sources: [source],
      categories: [category],
      limit,
      test: true
    });
    
    res.json({
      success: true,
      message: 'Test scraping completed',
      data: result
    });
    
 } catch (error) {
  console.error('Scrape error:', error);
  return res.status(500).json({
    success: false,
    error: error?.message || String(error),
    details: error?.stack || error
  });
}


// Get session details
router.get('/session/:sessionId', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();
  const redis = getRedis();
  
  try {
    const { sessionId } = req.params;
    
    // Try Redis cache first
    let session = null;
    
    if (redis && redis.getClient) {
      const redisClient = redis.getClient();
      if (redisClient && redisClient.isOpen) {
        const sessionData = await redisClient.get(`session:${sessionId}`);
        if (sessionData) {
          session = JSON.parse(sessionData);
        }
      }
    }
    
    if (!session && database && database.pool) {
      // Fallback to database
      const result = await database.query(`
        SELECT * FROM scraping_sessions 
        WHERE uuid = $1
      `, [sessionId]);
      
      session = result.rows[0] || null;
    }

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      data: session
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'SESSION_FETCH_FAILED'
    });
  }
});

// Stop scraping
router.post('/stop', async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();
  
  try {
    if (!scraperService) {
      return res.status(503).json({
        success: false,
        error: 'Scraper service not initialized',
        code: 'SERVICE_UNAVAILABLE'
      });
    }
    
    await scraperService.stop();
    
    res.json({
      success: true,
      message: 'Scraping stopped successfully'
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'STOP_FAILED'
    });
  }
});

// =============================================
// LEADS ENDPOINTS
// =============================================

// Get leads with filtering and pagination
router.get('/leads', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();
  
  try {
    if (!database || !database.pool) {
      return res.status(503).json({
        success: false,
        error: 'Database not available',
        code: 'DATABASE_UNAVAILABLE'
      });
    }
    
    const {
      page = 1,
      limit = 50,
      source,
      status,
      category,
      search,
      sort = 'created_at',
      order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    // Build WHERE clause
    const conditions = [];
    const params = [];
    let paramCount = 0;

    if (source) {
      paramCount++;
      conditions.push(`source = $${paramCount}`);
      params.push(source);
    }

    if (status) {
      paramCount++;
      conditions.push(`status = $${paramCount}`);
      params.push(status);
    }

    if (category) {
      paramCount++;
      conditions.push(`category ILIKE $${paramCount}`);
      params.push(`%${category}%`);
    }

    if (search) {
      paramCount++;
      conditions.push(`(business_name ILIKE $${paramCount} OR phone ILIKE $${paramCount})`);
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Get total count
    const countResult = await database.query(`
      SELECT COUNT(*) as total FROM scraping_results ${whereClause}
    `, params);
    
    const total = parseInt(countResult.rows[0].total);

    // Get leads
    paramCount++;
    params.push(parseInt(limit));
    paramCount++;
    params.push(offset);

    const leadsResult = await database.query(`
      SELECT 
        id, job_id, source, business_name, phone, email, website, address, 
        category, created_at
      FROM scraping_results 
      ${whereClause}
      ORDER BY ${sort} ${order}
      LIMIT $${paramCount - 1} OFFSET $${paramCount}
    `, params);

    res.json({
      success: true,
      data: {
        leads: leadsResult.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'LEADS_FETCH_FAILED'
    });
  }
});

// Get lead by ID
router.get('/leads/:id', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();
  
  try {
    if (!database || !database.pool) {
      return res.status(503).json({
        success: false,
        error: 'Database not available',
        code: 'DATABASE_UNAVAILABLE'
      });
    }
    
    const { id } = req.params;
    
    const result = await database.query(`
      SELECT * FROM scraping_results WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
        code: 'LEAD_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'LEAD_FETCH_FAILED'
    });
  }
});

// =============================================
// STATISTICS ENDPOINTS
// =============================================

// Get daily statistics
router.get('/stats/daily', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();
  
  try {
    if (!database || !database.pool) {
      return res.status(503).json({
        success: false,
        error: 'Database not available',
        code: 'DATABASE_UNAVAILABLE'
      });
    }
    
    const { days = 7, source } = req.query;
    
    let whereClause = '';
    const params = [parseInt(days)];
    
    if (source) {
      whereClause = 'AND source = $2';
      params.push(source);
    }

    const result = await database.query(`
      SELECT 
        DATE(created_at) as date,
        source,
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE phone IS NOT NULL) as leads_with_phone,
        COUNT(*) FILTER (WHERE email IS NOT NULL) as leads_with_email
      FROM scraping_results
      WHERE created_at >= NOW() - INTERVAL '${days} days' ${whereClause}
      GROUP BY DATE(created_at), source
      ORDER BY date DESC, source
    `, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'STATS_FETCH_FAILED'
    });
  }
});

// Get source statistics
router.get('/stats/sources', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();
  
  try {
    if (!database || !database.pool) {
      return res.status(503).json({
        success: false,
        error: 'Database not available',
        code: 'DATABASE_UNAVAILABLE'
      });
    }
    
    const result = await database.query(`
      SELECT 
        source,
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as leads_today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as leads_week,
        MAX(created_at) as last_scrape
      FROM scraping_results
      GROUP BY source
      ORDER BY total_leads DESC
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    if (logger.api) {
      logger.api.error(req.method, req.url, error, req.ip);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'SOURCE_STATS_FAILED'
    });
  }
});

// =============================================
// ERROR HANDLING MIDDLEWARE
// =============================================

router.use((error, req, res, next) => {
  const logger = getLogger();
  
  logger.error('Scraper API error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    body: req.body
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
});

module.exports = router;
