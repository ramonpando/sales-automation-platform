// =============================================
// SCRAPER ROUTES - API ENDPOINTS (FIXED)
// =============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// -----------------------------------------------------------------------------
// Helper para responder errores de forma consistente
// -----------------------------------------------------------------------------
function sendError(res, error, code = 500, extra = {}) {
  // Log al menos en consola; el logger real se usa en cada catch
  // para no perder contexto (req.method, req.url, etc.)
  console.error('Scrape error:', error);
  return res.status(code).json({
    success: false,
    error: error?.message || String(error),
    details: error?.stack || error,
    ...extra,
  });
}

// -----------------------------------------------------------------------------
// Lazy loading de dependencias (evita ciclos y carga innecesaria)
// -----------------------------------------------------------------------------
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
  const mod = require('../services/scraperService');
  return mod.getInstance ? mod.getInstance() : null;
}

// -----------------------------------------------------------------------------
// Middleware de validación
// -----------------------------------------------------------------------------
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

// =============================================
// SCRAPING ENDPOINTS
// =============================================

// POST /api/scraper/start  → inicia scraping completo
router.post('/start', async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();

  try {
    const { sources, categories, options = {} } = req.body || {};

    if (logger.api) {
      logger.api.request?.(req.method, req.url, null, null, req.ip);
    }

    if (!scraperService) {
      return sendError(res, new Error('Scraper service not initialized'), 503, {
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    const result = await scraperService.startFullScraping({
      sources,
      categories,
      ...options,
      triggeredBy: 'api',
      clientIp: req.ip,
    });

    return res.json({
      success: true,
      message: 'Scraping session started successfully',
      sessionId: result.sessionId,
      data: result,
    });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 400, { code: 'SCRAPING_START_FAILED' });
  }
});

// POST /api/scraper/start/:source  → inicia scraping para una fuente específica
router.post('/start/:source', async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();

  try {
    const { source } = req.params;
    const { categories, options = {} } = req.body || {};

    if (logger.api) {
      logger.api.request?.(req.method, req.url, null, null, req.ip);
    }

    if (!scraperService) {
      return sendError(res, new Error('Scraper service not initialized'), 503, {
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    const result = await scraperService.startFullScraping({
      sources: [source],
      categories,
      ...options,
      triggeredBy: 'api',
      clientIp: req.ip,
    });

    return res.json({
      success: true,
      message: `Scraping started for ${source}`,
      sessionId: result.sessionId,
      data: result,
    });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 400, { code: 'SOURCE_SCRAPING_FAILED' });
  }
});

// POST /api/scraper/apify  → Scraping usando Apify para múltiples fuentes
router.post(
  '/apify',
  [
    body('category').notEmpty().withMessage('Category is required'),
    body('location').notEmpty().withMessage('Location is required'),
    body('state').optional().isString().withMessage('State must be a string'),
    body('sources').isArray().withMessage('Sources must be an array'),
    body('limit').optional().isInt({ min: 1, max: 500 }),
  ],
  validateRequest,
  async (req, res) => {
    const logger = getLogger();
    const scraperService = getScraperService();
    const database = getDatabase();

    try {
      if (!scraperService) {
        return sendError(res, new Error('Scraper service not initialized'), 503);
      }

      if (process.env.USE_APIFY !== 'true') {
        return sendError(
          res,
          new Error('Apify scraping is not enabled. Set USE_APIFY=true in environment variables.'),
          400
        );
      }

      const config = {
        category: req.body.category,
        location: req.body.location,
        state: req.body.state || 'ciudad-de-mexico',
        sources: req.body.sources || ['paginasAmarillas', 'googleMyBusiness'],
        limit: req.body.limit || 50,
      };

      logger.info?.('Starting Apify scraping', config);

      const result = await scraperService.scrapeWithApify(config);

      // Guardar en DB
      let savedCount = 0;
      const sessionId = uuidv4();

      if (database && database.pool && result?.results) {
        for (const [src, leads] of Object.entries(result.results)) {
          for (const lead of leads) {
            try {
              await database.query(
                `INSERT INTO scraping_results (
                   job_id, source, business_name, phone, email, website,
                   address, category, raw_data, created_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
                [
                  sessionId,
                  src,
                  lead.businessName || lead.company_name,
                  lead.phone,
                  lead.email,
                  lead.website,
                  lead.address,
                  config.category,
                  JSON.stringify(lead),
                ]
              );
              savedCount++;
            } catch (e) {
              logger.error?.('Error saving lead', { error: e.message, lead });
            }
          }
        }
      }

      return res.json({
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
            pymesOrgMx: result.results.pymesOrgMx?.length || 0,
          },
        },
      });
    } catch (error) {
      logger.error?.('Apify scraping failed', { error: error.message });
      return sendError(res, error);
    }
  }
);

// GET /api/scraper/apify/status
router.get('/apify/status', async (req, res) => {
  const scraperService = getScraperService();

  try {
    if (!scraperService) {
      return sendError(res, new Error('Scraper service not initialized'), 503);
    }

    const status = await scraperService.getStatus();

    return res.json({
      apifyEnabled: process.env.USE_APIFY === 'true',
      apifyInitialized: status.config.apifyEnabled,
      availableScrapers: scraperService.getAvailableScrapers(),
      environmentVariables: {
        USE_APIFY: !!process.env.USE_APIFY,
        APIFY_TOKEN: !!process.env.APIFY_TOKEN,
        GOOGLE_PLACES_API_KEY: !!process.env.GOOGLE_PLACES_API_KEY,
        LINKEDIN_COOKIE: !!process.env.LINKEDIN_COOKIE,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// GET /api/scraper/status  → estado del servicio
router.get('/status', async (req, res) => {
  const scraperService = getScraperService();

  try {
    if (!scraperService) {
      return sendError(res, new Error('Scraper service not initialized'), 503, {
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    const status = await scraperService.getStatus();
    return res.json({ success: true, data: status });
  } catch (error) {
    const logger = getLogger();
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 500, { code: 'STATUS_FETCH_FAILED' });
  }
});

// GET /api/scraper/scrapers  → fuentes disponibles
router.get('/scrapers', async (req, res) => {
  const scraperService = getScraperService();

  try {
    if (!scraperService) {
      return sendError(res, new Error('Scraper service not initialized'), 503);
    }

    const scrapers = scraperService.getAvailableScrapers();
    return res.json({ success: true, data: scrapers });
  } catch (error) {
    return sendError(res, error);
  }
});

// POST /api/scraper/test  → prueba rápida de scraping
router.post(
  '/test',
  [
    body('source').notEmpty().withMessage('Source is required'),
    body('category').notEmpty().withMessage('Category is required'),
    body('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validateRequest,
  async (req, res) => {
    const logger = getLogger();
    const scraperService = getScraperService();

    try {
      if (!scraperService) {
        return sendError(res, new Error('Scraper service not initialized'), 503);
      }

      const { source, category, limit = 5 } = req.body;
      logger.info?.('Test scraping started', { source, category, limit });

      const result = await scraperService.startFullScraping({
        sources: [source],
        categories: [category],
        limit,
        test: true,
      });

      return res.json({ success: true, message: 'Test scraping completed', data: result });
    } catch (error) {
      if (logger.api) {
        logger.api.error?.(req.method, req.url, error, req.ip);
      }
      return sendError(res, error);
    }
  }
);

// GET /api/scraper/session/:sessionId
router.get('/session/:sessionId', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();
  const redis = getRedis();

  try {
    const { sessionId } = req.params;
    let session = null;

    // Redis primero
    if (redis && redis.getClient) {
      const rc = redis.getClient();
      if (rc && rc.isOpen) {
        const cached = await rc.get(`session:${sessionId}`);
        if (cached) session = JSON.parse(cached);
      }
    }

    // DB fallback
    if (!session && database && database.pool) {
      const r = await database.query(
        'SELECT * FROM scraping_sessions WHERE uuid = $1',
        [sessionId]
      );
      session = r.rows[0] || null;
    }

    if (!session) {
      return sendError(res, new Error('Session not found'), 404, {
        code: 'SESSION_NOT_FOUND',
      });
    }

    return res.json({ success: true, data: session });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 500, { code: 'SESSION_FETCH_FAILED' });
  }
});

// POST /api/scraper/stop
router.post('/stop', async (req, res) => {
  const logger = getLogger();
  const scraperService = getScraperService();

  try {
    if (!scraperService) {
      return sendError(res, new Error('Scraper service not initialized'), 503, {
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    await scraperService.stop();
    return res.json({ success: true, message: 'Scraping stopped successfully' });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 500, { code: 'STOP_FAILED' });
  }
});

// =============================================
// LEADS ENDPOINTS
// =============================================

// GET /api/scraper/leads
router.get('/leads', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();

  try {
    if (!database || !database.pool) {
      return sendError(res, new Error('Database not available'), 503, {
        code: 'DATABASE_UNAVAILABLE',
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
      order = 'DESC',
    } = req.query;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const conditions = [];
    const params = [];
    let i = 0;

    if (source) {
      params.push(source); i++; conditions.push(`source = $${i}`);
    }
    if (status) {
      params.push(status); i++; conditions.push(`status = $${i}`);
    }
    if (category) {
      params.push(`%${category}%`); i++; conditions.push(`category ILIKE $${i}`);
    }
    if (search) {
      params.push(`%${search}%`); i++; conditions.push(`(business_name ILIKE $${i} OR phone ILIKE $${i})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await database.query(`SELECT COUNT(*) AS total FROM scraping_results ${where}`, params);
    const total = parseInt(countRes.rows[0].total, 10);

    params.push(parseInt(limit, 10)); i++;
    params.push(offset); i++;

    const leadsRes = await database.query(
      `SELECT id, job_id, source, business_name, phone, email, website, address, category, created_at
       FROM scraping_results
       ${where}
       ORDER BY ${sort} ${order}
       LIMIT $${i - 1} OFFSET $${i}`,
      params
    );

    return res.json({
      success: true,
      data: {
        leads: leadsRes.rows,
        pagination: {
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
          total,
          pages: Math.ceil(total / parseInt(limit, 10)),
        },
      },
    });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 500, { code: 'LEADS_FETCH_FAILED' });
  }
});

// GET /api/scraper/leads/:id
router.get('/leads/:id', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();

  try {
    if (!database || !database.pool) {
      return sendError(res, new Error('Database not available'), 503, {
        code: 'DATABASE_UNAVAILABLE',
      });
    }

    const { id } = req.params;
    const result = await database.query('SELECT * FROM scraping_results WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return sendError(res, new Error('Lead not found'), 404, { code: 'LEAD_NOT_FOUND' });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 500, { code: 'LEAD_FETCH_FAILED' });
  }
});

// =============================================
// STATISTICS ENDPOINTS
// =============================================

// GET /api/scraper/stats/daily
router.get('/stats/daily', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();

  try {
    if (!database || !database.pool) {
      return sendError(res, new Error('Database not available'), 503, {
        code: 'DATABASE_UNAVAILABLE',
      });
    }

    const { days = 7, source } = req.query;
    const params = [parseInt(days, 10)];
    let whereExtra = '';

    if (source) {
      whereExtra = 'AND source = $2';
      params.push(source);
    }

    const result = await database.query(
      `SELECT 
         DATE(created_at) AS date,
         source,
         COUNT(*) AS total_leads,
         COUNT(*) FILTER (WHERE phone IS NOT NULL) AS leads_with_phone,
         COUNT(*) FILTER (WHERE email IS NOT NULL) AS leads_with_email
       FROM scraping_results
       WHERE created_at >= NOW() - INTERVAL '${days} days' ${whereExtra}
       GROUP BY DATE(created_at), source
       ORDER BY date DESC, source`,
      params
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 500, { code: 'STATS_FETCH_FAILED' });
  }
});

// GET /api/scraper/stats/sources
router.get('/stats/sources', async (req, res) => {
  const logger = getLogger();
  const database = getDatabase();

  try {
    if (!database || !database.pool) {
      return sendError(res, new Error('Database not available'), 503, {
        code: 'DATABASE_UNAVAILABLE',
      });
    }

    const result = await database.query(
      `SELECT 
         source,
         COUNT(*) AS total_leads,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS leads_today,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS leads_week,
         MAX(created_at) AS last_scrape
       FROM scraping_results
       GROUP BY source
       ORDER BY total_leads DESC`
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    if (logger.api) {
      logger.api.error?.(req.method, req.url, error, req.ip);
    }
    return sendError(res, error, 500, { code: 'SOURCE_STATS_FAILED' });
  }
});

// =============================================
// ERROR HANDLING MIDDLEWARE (fallback)
// =============================================
router.use((err, req, res, next) => {
  const logger = getLogger();
  logger.error?.('Scraper API error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body,
  });
  return sendError(res, err, 500, { code: 'INTERNAL_ERROR' });
});

module.exports = router;

