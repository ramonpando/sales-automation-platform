// =============================================
// REDIS CONNECTION (redis.js)
// Usando la librería 'redis' v4+
// =============================================
const { createClient } = require('redis');

// La variable 'client' se inicializa como null y se asignará después de la conexión.
let client = null;
// 'isReady' es un flag para saber si podemos ejecutar comandos.
let isReady = false;

/**
 * Crea y conecta el cliente de Redis.
 * Configura listeners para manejar eventos de conexión, error y listo.
 */
async function connect() {
  // Si ya hay un cliente conectado, no hagas nada.
  if (client && isReady) {
    console.log('Redis client is already connected.');
    return client;
  }

  try {
    // Obtiene la URL de Redis de las variables de entorno, con un valor por defecto.
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    console.log('Connecting to Redis...');

    // Crea el cliente con la URL y una estrategia de reconexión.
    client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 10000, // Tiempo de espera para la conexión inicial.
        // Estrategia para intentar reconectar si se pierde la conexión.
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('❌ Too many Redis reconnection attempts. Giving up.');
            return new Error('Too many retries');
          }
          // Espera un poco más con cada intento, hasta un máximo de 3 segundos.
          return Math.min(retries * 100, 3000);
        }
      }
    });

    // =============================================
    // MANEJO DE EVENTOS DEL CLIENTE
    // =============================================
    client.on('error', (err) => {
      console.error('Redis Client Error:', err.message);
      isReady = false; // Si hay un error, no estamos listos para operar.
    });

    client.on('connect', () => {
      console.log('Redis client is connecting...');
    });

    client.on('ready', () => {
      console.log('✅ Redis client is ready to use.');
      isReady = true; // El cliente está listo para recibir comandos.
    });

    client.on('end', () => {
      console.log('Redis connection closed.');
      isReady = false; // La conexión ha terminado.
    });

    // Inicia la conexión.
    await client.connect();
    // --- Patch compatibilidad para código legacy que usa client.setex() ---
// --- Patch compatibilidad para código legacy que usa client.setex() ---
if (!client.setex) {
  client.setex = (key, seconds, value) => {
    if (typeof client.setEx === 'function') {
      return client.setEx(key, seconds, value);
    }
    return client.set(key, value, { EX: seconds });
  };
}


    return client;

  } catch (error) {
    console.error('❌ Redis connection failed:', error.message);
    isReady = false;
    // Propaga el error para que el resto de la aplicación sepa que falló.
    throw error;
  }
}

/**
 * Devuelve la instancia del cliente de Redis.
 * @returns {object | null} La instancia del cliente o null si no está conectado.
 */
function getClient() {
  return client;
}

/**
 * Desconecta el cliente de Redis de forma segura.
 */
async function disconnect() {
  if (client) {
    await client.quit(); // 'quit' espera a que los comandos pendientes terminen.
    client = null;
    isReady = false;
  }
}

// =============================================
// MÉTODOS HELPER PARA OPERACIONES COMUNES
// =============================================

/**
 * Obtiene un valor de Redis por su clave.
 * @param {string} key - La clave a buscar.
 * @returns {Promise<string | null>} El valor encontrado o null.
 */
async function get(key) {
  if (!isReady) {
    console.error('Cannot GET from Redis: client is not ready.');
    return null;
  }
  try {
    return await client.get(key);
  } catch (error) {
    console.error(`Redis GET error for key "${key}":`, error);
    return null;
  }
}

/**
 * Guarda un valor en Redis, con una expiración opcional.
 * @param {string} key - La clave.
 * @param {string | object} value - El valor a guardar. Los objetos se convierten a JSON.
 * @param {number} [expirySeconds] - Tiempo de expiración en segundos (opcional).
 * @returns {Promise<boolean>} True si la operación fue exitosa, false en caso contrario.
 */
async function set(key, value, expirySeconds) {
  if (!isReady) {
    console.error('Cannot SET to Redis: client is not ready.');
    return false;
  }
  try {
    const finalValue = typeof value === 'object' ? JSON.stringify(value) : value;
    
    if (expirySeconds) {
      // Usa la opción 'EX' para la expiración, que es el estándar en redis v4+.
      await client.set(key, finalValue, { EX: expirySeconds });
    } else {
      await client.set(key, finalValue);
    }
    return true;
  } catch (error) {
    console.error(`Redis SET error for key "${key}":`, error);
    return false;
  }
}

/**
 * Elimina una clave de Redis.
 * @param {string} key - La clave a eliminar.
 * @returns {Promise<boolean>} True si se eliminó, false si hubo un error.
 */
async function del(key) {
  if (!isReady) {
    console.error('Cannot DEL from Redis: client is not ready.');
    return false;
  }
  try {
    await client.del(key);
    return true;
  } catch (error) {
    console.error(`Redis DEL error for key "${key}":`, error);
    return false;
  }
}

/**
 * Comprueba si una clave existe en Redis.
 * @param {string} key - La clave a comprobar.
 * @returns {Promise<boolean>} True si la clave existe, false en caso contrario.
 */
async function exists(key) {
  if (!isReady) {
    console.error('Cannot check EXISTS in Redis: client is not ready.');
    return false;
  }
  try {
    const result = await client.exists(key);
    return result === 1;
  } catch (error) {
    console.error(`Redis EXISTS error for key "${key}":`, error);
    return false;
  }
}

/**
 * Función de compatibilidad para 'setex' (SET with EXpiry).
 * Internamente, llama a nuestra función 'set' con el parámetro de expiración.
 * @param {string} key - La clave.
 * @param {number} seconds - El tiempo de expiración en segundos.
 * @param {string | object} value - El valor a guardar.
 * @returns {Promise<boolean>} El resultado de la operación 'set'.
 */
// Redis v4: no existe setex(). Usamos setEx() o set() con EX.
async function setex(key, seconds, value) {
  const client = module.exports.getClient ? module.exports.getClient() : redisClient;
  if (typeof client.setEx === 'function') {
    return client.setEx(key, seconds, value);
  }
  // fallback genérico
  return client.set(key, value, { EX: seconds });
}


// Exporta todas las funciones para que puedan ser usadas en otras partes de la aplicación.
module.exports = {
  connect,
  disconnect,
  getClient,
  get,
  set,
  del,
  exists,
  setex, // <-- Exportando setex para que pueda ser llamado desde otros archivos.
  isReady: () => isReady
};

