// =============================================
// DATABASE CONNECTION
// =============================================
const { Pool } = require('pg');

// Parse DATABASE_URL or use individual env vars
const connectionString = process.env.DATABASE_URL;

let pool;

if (connectionString) {
  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
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
  pool
};
