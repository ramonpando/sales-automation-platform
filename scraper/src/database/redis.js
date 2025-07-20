// =============================================
// REDIS CONNECTION
// =============================================
const redis = require('redis');

let client;

// Create Redis client
async function connect() {
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    client = redis.createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('Too many Redis reconnection attempts');
            return new Error('Too many retries');
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    client.on('connect', () => {
      console.log('Redis Client Connected');
    });

    await client.connect();
    console.log('✅ Redis connected successfully');
    
    return client;
  } catch (error) {
    console.error('❌ Redis connection failed:', error.message);
    return null;
  }
}

// Disconnect from Redis
async function disconnect() {
  if (client && client.isOpen) {
    await client.quit();
    console.log('Redis connection closed');
  }
}

// Get client instance
function getClient() {
  return client;
}

module.exports = {
  connect,
  disconnect,
  getClient,
  client
};
