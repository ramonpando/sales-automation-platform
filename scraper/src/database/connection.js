// =============================================
// DATABASE CONNECTION
// =============================================
const { Pool } = require('pg');

// Parse DATABASE_URL or use individual env vars
const connectionString = process.env.DATABASE_URL;
let pool;

if (connectionString) {
  // Parse the connection string properly
  let sslConfig = false;
  
  // In production, use SSL
  if (process.env.NODE_ENV === 'production') {
    sslConfig = {
      rejectUnauthorized: false
    };
  }
  
  // Check if SSL is disabled in the connection string
  if (connectionString.includes('sslmode=disable')) {
    sslConfig = false;
  }
  
  pool = new Pool({
    connectionString: connectionString,
    ssl: sslConfig,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
} else {
  console.error('DATABASE_URL not configured');
  pool = null;
}

// Test connection
async function initialize() {
  if (!pool) {
    console.error('Database pool not initialized');
    return false;
  }
  
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('✅ Database connected successfully');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

// Query helper
async function query(text, params) {
  if (!pool) {
    throw new Error('Database not connected');
  }
  
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error:', error.message);
    throw error;
  }
}

// Get pool stats
function getPoolStats() {
  if (!pool) return null;
  
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  };
}

// Close connection
async function close() {
  if (pool) {
    await pool.end();
    console.log('Database connection closed');
  }
}

module.exports = {
  initialize,
  query,
  close,
  pool,
  getPoolStats
};
