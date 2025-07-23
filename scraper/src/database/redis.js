// =============================================
// REDIS CONNECTION (redis.js)  - redis v4+
// =============================================
'use strict';

const { createClient } = require('redis');

let client = null;
let isReady = false;

/**
 * Conecta (o reutiliza) el cliente de Redis.
 */
async function connect() {
  if (client && isReady) return client;

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 10_000,
      reconnectStrategy: (retries) =>
        retries > 10 ? new Error('Too many retries') : Math.min(retries * 100, 3000),
    },
  });

  // Eventos
  client.on('error', (err) => {
    console.error('Redis Client Error:', err.message);
    isReady = false;
  });

  client.on('ready', () => {
    console.log('✅ Redis client is ready.');
    isReady = true;
  });

  client.on('end', () => {
    console.log('Redis connection closed.');
    isReady = false;
  });

  await client.connect();

  // -------- Polyfill para código legacy que usa client.setex() --------
  if (!client.setex) {
    client.setex = (key, seconds, value) => {
      if (typeof client.setEx === 'function') return client.setEx(key, seconds, value);
      return client.set(key, value, { EX: seconds });
    };
  }

  return client;
}

/**
 * Devuelve la instancia actual.
 */
function getClient() {
  return client;
}

/**
 * Cierra la conexión de forma segura.
 */
async function disconnect() {
  if (client) {
    await client.quit();
    client = null;
    isReady = false;
  }
}

/**
 * Helper seguro para SET con expiración (usa setEx / set / setex según exista).
 */
async function safeSet(key, seconds, value) {
  if (!isReady || !client) return;
  const payload = typeof value === 'object' ? JSON.stringify(value) : value;

  if (client.setEx) return client.setEx(key, seconds, payload);
  if (client.set)   return client.set(key, payload, { EX: seconds });
  if (client.setex) return client.setex(key, seconds, payload);
}

/**
 * GET simple.
 */
async function get(key) {
  if (!isReady || !client) return null;
  try {
    return await client.get(key);
  } catch (err) {
    console.error(`Redis GET error (${key}):`, err);
    return null;
  }
}

/**
 * SET simple (con o sin expiración).
 */
async function set(key, value, expirySeconds) {
  if (!isReady || !client) return false;
  try {
    const payload = typeof value === 'object' ? JSON.stringify(value) : value;
    if (expirySeconds) {
      await client.set(key, payload, { EX: expirySeconds });
    } else {
      await client.set(key, payload);
    }
    return true;
  } catch (err) {
    console.error(`Redis SET error (${key}):`, err);
    return false;
  }
}

/**
 * DEL.
 */
async function del(key) {
  if (!isReady || !client) return false;
  try {
    await client.del(key);
    return true;
  } catch (err) {
    console.error(`Redis DEL error (${key}):`, err);
    return false;
  }
}

/**
 * EXISTS.
 */
async function exists(key) {
  if (!isReady || !client) return false;
  try {
    return (await client.exists(key)) === 1;
  } catch (err) {
    console.error(`Redis EXISTS error (${key}):`, err);
    return false;
  }
}

/**
 * Compatibilidad: setex(key, seconds, value)
 */
async function setex(key, seconds, value) {
  return safeSet(key, seconds, value);
}

module.exports = {
  connect,
  disconnect,
  getClient,
  isReady: () => isReady,
  safeSet,
  setex, // compat
  get,
  set,
  del,
  exists,
};


