// Minimal server for debugging
console.log('=== STARTING SALES SCRAPER SERVICE ===');
console.log('Node version:', process.version);
console.log('Current directory:', __dirname);
console.log('Environment:', process.env.NODE_ENV);

// Test basic imports
try {
  const express = require('express');
  console.log('✅ Express loaded');
} catch (error) {
  console.error('❌ Error loading express:', error.message);
  process.exit(1);
}

// Create basic server
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

console.log('Port configured:', PORT);

// Basic middleware
app.use(express.json());

// Health endpoint
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
      REDIS_URL: process.env.REDIS_URL ? 'SET' : 'NOT SET'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  console.log('Root endpoint requested');
  res.json({
    message: 'Sales Scraper API - Debug Mode',
    version: '1.0.0',
    status: 'running'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: err.message });
});

// Start server with explicit error handling
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server successfully started on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('=== SERVER IS RUNNING ===');
});

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

// Keep process alive
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // Don't exit, just log
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
  // Don't exit, just log
});

// Log every 10 seconds to show we're alive
setInterval(() => {
  console.log(`[${new Date().toISOString()}] Server is alive - Uptime: ${Math.floor(process.uptime())}s`);
}, 10000);

console.log('=== SERVER SETUP COMPLETE ===');
