// =============================================
// REDIS CONNECTION
// =============================================
const { createClient } = require('redis');

let client = null;
let isConnected = false;

// Create Redis client
async function connect() {
  try {
    // Parse REDIS_URL
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    // Create client with proper configuration
    client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('Too many Redis reconnection attempts');
            return new Error('Too many retries');
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    // Error handling
    client.on('error', (err) => {
      console.error('Redis Client Error:', err);
      isConnected = false;
    });

    client.on('connect', () => {
      console.log('Redis Client Connected');
      isConnected = true;
    });

    client.on('ready', () => {
      console.log('Redis Client Ready');
      isConnected = true;
    });

    // Connect
    await client.connect();
    
    // Test connection
    await client.ping();
    
    console.log('✅ Redis connected successfully');
    isConnected = true;
    
    return client;
  } catch (error) {
    console.error('❌ Redis connection failed:', error.message);
    isConnected = false;
    throw error;
  }
}

// Get client
function getClient() {
  return client;
}

// Disconnect
async function disconnect() {
  if (client) {
    await client.quit();
    isConnected = false;
    console.log('Redis disconnected');
  }
}

// Helper methods for common operations
async function get(key) {
  if (!client || !isConnected) return null;
  try {
    return await client.get(key);
  } catch (error) {
    console.error('Redis get error:', error);
    return null;
  }
}

async function set(key, value, expirySeconds) {
  if (!client || !isConnected) return false;
  try {
    if (expirySeconds) {
      // Use EX option for expiry in Redis v4
      await client.set(key, typeof value === 'object' ? JSON.stringify(value) : value, {
        EX: expirySeconds
      });
    } else {
      await client.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
    }
    return true;
  } catch (error) {
    console.error('Redis set error:', error);
    return false;
  }
}

async function del(key) {
  if (!client || !isConnected) return false;
  try {
    await client.del(key);
    return true;
  } catch (error) {
    console.error('Redis del error:', error);
    return false;
  }
}

async function exists(key) {
  if (!client || !isConnected) return false;
  try {
    const result = await client.exists(key);
    return result === 1;
  } catch (error) {
    console.error('Redis exists error:', error);
    return false;
  }
}

// Backward compatibility for setex
async function setex(key, seconds, value) {
  return set(key, value, seconds);
}

module.exports = {
  connect,
  disconnect,
  getClient,
  get,
  set,
  del,
  exists,
  setex,
  isConnected: () => isConnected
};
