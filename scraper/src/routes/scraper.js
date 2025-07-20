// =============================================
// SCRAPER ROUTES - API ENDPOINTS
// =============================================

import express from 'express';
import { v4 as uuidv4 } from 'uuid';

import logger from '../utils/logger.js';
import scraperService from '../services/scraperService.js';
import database from '../database/connection.js';
import redis from '../database/redis.js';

const router = express.Router();

// =============================================
// SCRAPING ENDPOINTS
// =============================================

// Start full scraping session
router.post('/start', async (req, res) => {
  try {
    const { sources, categories, options = {} } = req.body;
    
    logger.api.request(req.method, req.url, null, null, req.ip);
    
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
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(400).json({
      success: false,
      error: error.message,
      code: 'SCRAPING_START_FAILED'
    });
  }
});

// Start scraping specific source
router.post('/start/:source', async (req, res) => {
  try {
    const { source } = req.params;
    const { categories, options = {} } = req.body;
    
    logger.api.request(req.method, req.url, null, null, req.ip);
    
    const result = await scraperService.startSourceScraping(source, {
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
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(400).json({
      success: false,
      error: error.message,
      code: 'SOURCE_SCRAPING_FAILED'
    });
  }
});

// Get scraping status
router.get('/status', async (req, res) => {
  try {
    const status = await scraperService.getStatus();
    
    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'STATUS_FETCH_FAILED'
    });
  }
});

// Get session details
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Try Redis cache first
    let session = await redis.getScrapingSession(sessionId);
    
    if (!session) {
      // Fallback to database
      const result = await database.query(`
        SELECT * FROM scraper.scraping_sessions 
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
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'SESSION_FETCH_FAILED'
    });
  }
});

// Stop scraping
router.post('/stop', async (req, res) => {
  try {
    await scraperService.stop();
    
    res.json({
      success: true,
      message: 'Scraping stopped successfully'
    });

  } catch (error) {
    logger.api.error(req.method, req.url, error, req.ip);
    
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
  try {
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
      conditions.push(`(company_name ILIKE $${paramCount} OR phone ILIKE $${paramCount})`);
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Get total count
    const countResult = await database.query(`
      SELECT COUNT(*) as total FROM scraper.leads ${whereClause}
    `, params);
    
    const total = parseInt(countResult.rows[0].total);

    // Get leads
    paramCount++;
    params.push(parseInt(limit));
    paramCount++;
    params.push(offset);

    const leadsResult = await database.query(`
      SELECT 
        id, uuid, company_name, phone, email, website, address, 
        location, category, source, confidence_score, status,
        created_at, updated_at
      FROM scraper.leads 
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
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'LEADS_FETCH_FAILED'
    });
  }
});

// Get lead by ID or UUID
router.get('/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if it's UUID or numeric ID
    const isUuid = id.includes('-');
    const column = isUuid ? 'uuid' : 'id';
    
    const result = await database.query(`
      SELECT * FROM scraper.leads WHERE ${column} = $1
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
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'LEAD_FETCH_FAILED'
    });
  }
});

// Update lead status
router.patch('/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const isUuid = id.includes('-');
    const column = isUuid ? 'uuid' : 'id';
    
    const result = await database.query(`
      UPDATE scraper.leads 
      SET status = $1, notes = $2, updated_at = NOW()
      WHERE ${column} = $3
      RETURNING *
    `, [status, notes, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
        code: 'LEAD_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      message: 'Lead updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'LEAD_UPDATE_FAILED'
    });
  }
});

// =============================================
// STATISTICS ENDPOINTS
// =============================================

// Get daily statistics
router.get('/stats/daily', async (req, res) => {
  try {
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
        COUNT(*) FILTER (WHERE status = 'new') as new_leads,
        COUNT(*) FILTER (WHERE phone IS NOT NULL) as leads_with_phone,
        COUNT(*) FILTER (WHERE email IS NOT NULL) as leads_with_email,
        AVG(confidence_score) as avg_confidence
      FROM scraper.leads
      WHERE created_at >= NOW() - INTERVAL '$1 days' ${whereClause}
      GROUP BY DATE(created_at), source
      ORDER BY date DESC, source
    `, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'STATS_FETCH_FAILED'
    });
  }
});

// Get source statistics
router.get('/stats/sources', async (req, res) => {
  try {
    const result = await database.query(`
      SELECT 
        source,
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as leads_today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as leads_week,
        MAX(created_at) as last_scrape,
        AVG(confidence_score) as avg_confidence
      FROM scraper.leads
      GROUP BY source
      ORDER BY total_leads DESC
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'SOURCE_STATS_FAILED'
    });
  }
});

// =============================================
// CONFIGURATION ENDPOINTS
// =============================================

// Get scraper configuration
router.get('/config', async (req, res) => {
  try {
    const config = await scraperService.getConfiguration();
    
    res.json({
      success: true,
      data: config
    });

  } catch (error) {
    logger.api.error(req.method, req.url, error, req.ip);
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'CONFIG_FETCH_FAILED'
    });
  }
});

// =============================================
// ERROR HANDLING MIDDLEWARE
// =============================================

router.use((error, req, res, next) => {
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

export default router;
