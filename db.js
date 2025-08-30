const mysql = require('mysql2/promise');

const DB_HOST = '167.172.84.179';
const DB_USER = 'root';
const DB_PASSWORD = 'jkiller8';
const DB_NAME = 'saas_pos';

let pool;

async function initializeDatabase() {
  // Create pool for the database (assumes DB and schema already exist)
  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
    decimalNumbers: true,
    multipleStatements: true,
  });
  // Simple connectivity check
  const conn = await pool.getConnection();
  await conn.query('SELECT 1');
  conn.release();
  return pool;
}

module.exports = {
  initializeDatabase,
  getPool: () => pool,
};


