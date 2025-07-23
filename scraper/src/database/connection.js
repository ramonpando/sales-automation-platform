// =============================================
// DATABASE CONNECTION
// =============================================
const { Pool } = require('pg');

function buildConnStr() {
  // 1) Prioridad: DATABASE_URL completa
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // 2) Fallback: variables sueltas tipo PGHOST/POSTGRES_HOST, etc.
  const host = process.env.PGHOST || process.env.POSTGRES_HOST;
  const port = process.env.PGPORT || process.env.POSTGRES_PORT || 5432;
  const user = process.env.PGUSER || process.env.POSTGRES_USER;
  const pass = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;
  const db   = process.env.PGDATABASE || process.env.POSTGRES_DB;

  if (!user || !pass || !db || !host) return null;
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const connectionString = buildConnStr();
let pool = null;

try {
  if (!connectionString) throw new Error('No DB connection string (DATABASE_URL o vars PG*)');

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
} catch (e) {
  console.error('❌ PG pool init error:', e.message);
}

// Run a simple query to force connection (optional)
async function initialize() {
  if (!pool) throw new Error('Pool not initialized');
  await pool.query('SELECT 1');
  console.log('✅ Database connection OK');
}

async function query(text, params) {
  if (!pool) throw new Error('Pool not initialized');
  return pool.query(text, params);
}

function getPoolStats() {
  return pool ? {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  } : null;
}

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
  getPoolStats,
};

