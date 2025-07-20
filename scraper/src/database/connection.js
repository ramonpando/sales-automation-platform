// =============================================
// SCRAPER SERVICE - DATABASE CONNECTION
// =============================================

import pg from 'pg';
import logger from '../utils/logger.js';

const { Pool } = pg;

// =============================================
// DATABASE CONFIGURATION
// =============================================

const config = {
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 5000,
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 30000,
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000,
  application_name: 'sales-scraper',
  
  // SSL configuration for production
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false
};

// =============================================
// CONNECTION POOL
// =============================================

let pool = null;

// =============================================
// DATABASE INITIALIZATION
// =============================================

async function initialize() {
  try {
    logger.info('🔗 Initializing PostgreSQL connection...');
    
    // Create connection pool
    pool = new Pool(config);

    // Handle pool events
    pool.on('connect', (client) => {
      logger.debug('📊 New database client connected', {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      });
    });

    pool.on('acquire', (client) => {
      logger.debug('📊 Database client acquired from pool', {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      });
    });

    pool.on('remove', (client) => {
      logger.debug('📊 Database client removed from pool', {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      });
    });

    pool.on('error', (error, client) => {
      logger.error('💥 Database pool error', {
        error: error.message,
        stack: error.stack
      });
    });

    // Test connection
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT NOW() as current_time, version() as version');
      logger.db.connect('PostgreSQL');
      logger.info('✅ Database connection successful', {
        currentTime: result.rows[0].current_time,
        version: result.rows[0].version.split(' ')[0],
        poolSize: config.max
      });
    } finally {
      client.release();
    }

    // Initialize database schema
    await initializeSchema();
    
    return pool;

  } catch (error) {
    logger.error('❌ Failed to initialize database connection', {
      error: error.message,
      stack: error.stack,
      config: {
        max: config.max,
        idleTimeoutMillis: config.idleTimeoutMillis,
        connectionTimeoutMillis: config.connectionTimeoutMillis
      }
    });
    throw error;
  }
}

// =============================================
// SCHEMA INITIALIZATION
// =============================================

async function initializeSchema() {
  const client = await pool.connect();
  
  try {
    logger.info('📋 Initializing database schema...');

    // Enable extensions
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS "pg_trgm";
    `);

    // Create scraper schema if not exists
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS scraper;
    `);

    // Create leads table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scraper.leads (
        id SERIAL PRIMARY KEY,
        uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
        
        -- Basic company information
        company_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        email VARCHAR(255),
        website VARCHAR(500),
        address TEXT,
        location VARCHAR(100),
        city VARCHAR(100),
        state VARCHAR(100),
        postal_code VARCHAR(20),
        country VARCHAR(50) DEFAULT 'México',
        
        -- Business information
        industry VARCHAR(100),
        category VARCHAR(100),
        subcategory VARCHAR(100),
        description TEXT,
        
        -- Scraping metadata
        source VARCHAR(100) NOT NULL,
        source_url TEXT,
        source_id VARCHAR(100),
        scrape_date TIMESTAMP DEFAULT NOW(),
        last_updated TIMESTAMP DEFAULT NOW(),
        
        -- Data quality
        confidence_score DECIMAL(3,2) DEFAULT 0.00,
        validation_status VARCHAR(20) DEFAULT 'pending',
        phone_validated BOOLEAN DEFAULT FALSE,
        email_validated BOOLEAN DEFAULT FALSE,
        website_validated BOOLEAN DEFAULT FALSE,
        
        -- Processing status
        status VARCHAR(20) DEFAULT 'new',
        enrichment_status VARCHAR(20) DEFAULT 'pending',
        export_status VARCHAR(20) DEFAULT 'pending',
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        
        -- Constraints
        UNIQUE(company_name, phone, source),
        CHECK (confidence_score >= 0.00 AND confidence_score <= 1.00)
      );
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_company_name ON scraper.leads USING gin(company_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_leads_phone ON scraper.leads(phone);
      CREATE INDEX IF NOT EXISTS idx_leads_location ON scraper.leads(location);
      CREATE INDEX IF NOT EXISTS idx_leads_source ON scraper.leads(source);
      CREATE INDEX IF NOT EXISTS idx_leads_scrape_date ON scraper.leads(scrape_date DESC);
      CREATE INDEX IF NOT EXISTS idx_leads_status ON scraper.leads(status);
      CREATE INDEX IF NOT EXISTS idx_leads_created_at ON scraper.leads(created_at DESC);
    `);

    // Create scraping sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scraper.scraping_sessions (
        id SERIAL PRIMARY KEY,
        uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
        
        -- Session information
        source VARCHAR(100) NOT NULL,
        target_url TEXT NOT NULL,
        session_type VARCHAR(50) DEFAULT 'manual',
        
        -- Session stats
        total_pages INTEGER DEFAULT 0,
        processed_pages INTEGER DEFAULT 0,
        total_leads INTEGER DEFAULT 0,
        new_leads INTEGER DEFAULT 0,
        duplicate_leads INTEGER DEFAULT 0,
        failed_leads INTEGER DEFAULT 0,
        
        -- Timing
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        duration_seconds INTEGER,
        
        -- Status and results
        status VARCHAR(20) DEFAULT 'running',
        error_message TEXT,
        final_stats JSONB,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create scraping errors table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scraper.scraping_errors (
        id SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES scraper.scraping_sessions(id),
        
        -- Error information
        error_type VARCHAR(100) NOT NULL,
        error_message TEXT NOT NULL,
        error_stack TEXT,
        url TEXT,
        page_number INTEGER,
        
        -- Context
        context JSONB,
        retry_count INTEGER DEFAULT 0,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create updated_at trigger function
    await client.query(`
      CREATE OR REPLACE FUNCTION scraper.update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    // Create triggers
    await client.query(`
      DROP TRIGGER IF EXISTS update_leads_updated_at ON scraper.leads;
      CREATE TRIGGER update_leads_updated_at 
        BEFORE UPDATE ON scraper.leads 
        FOR EACH ROW EXECUTE FUNCTION scraper.update_updated_at_column();
        
      DROP TRIGGER IF EXISTS update_sessions_updated_at ON scraper.scraping_sessions;
      CREATE TRIGGER update_sessions_updated_at 
        BEFORE UPDATE ON scraper.scraping_sessions 
        FOR EACH ROW EXECUTE FUNCTION scraper.update_updated_at_column();
    `);

    // Create views for reporting
    await client.query(`
      CREATE OR REPLACE VIEW scraper.daily_stats AS
      SELECT 
        DATE(created_at) as date,
        source,
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE status = 'new') as new_leads,
        COUNT(*) FILTER (WHERE phone IS NOT NULL) as leads_with_phone,
        COUNT(*) FILTER (WHERE email IS NOT NULL) as leads_with_email,
        COUNT(*) FILTER (WHERE website IS NOT NULL) as leads_with_website,
        AVG(confidence_score) as avg_confidence
      FROM scraper.leads
      GROUP BY DATE(created_at), source
      ORDER BY date DESC, source;
    `);

    logger.info('✅ Database schema initialized successfully');

  } catch (error) {
    logger.error('❌ Failed to initialize database schema', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    client.release();
  }
}

// =============================================
// DATABASE OPERATIONS
// =============================================

// Execute query with logging and metrics
async function query(text, params = []) {
  const start = Date.now();
  const client = await pool.connect();
  
  try {
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    
    logger.db.query(text, duration, result.rowCount);
    return result;
    
  } catch (error) {
    logger.db.error(error, text);
    throw error;
  } finally {
    client.release();
  }
}

// Execute transaction
async function transaction(callback) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Get pool statistics
function getPoolStats() {
  if (!pool) return null;
  
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxConnections: config.max
  };
}

// Health check
async function healthCheck() {
  try {
    const result = await query('SELECT NOW() as current_time');
    return {
      status: 'healthy',
      database: 'postgresql',
      currentTime: result.rows[0].current_time,
      poolStats: getPoolStats()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      database: 'postgresql',
      error: error.message
    };
  }
}

// =============================================
// CLEANUP AND SHUTDOWN
// =============================================

async function close() {
  if (pool) {
    logger.info('🔌 Closing database connections...');
    await pool.end();
    logger.db.disconnect('PostgreSQL');
    pool = null;
  }
}

// =============================================
// EXPORTS
// =============================================

export default {
  initialize,
  query,
  transaction,
  healthCheck,
  getPoolStats,
  close,
  
  // Direct pool access for advanced usage
  get pool() {
    return pool;
  }
};
