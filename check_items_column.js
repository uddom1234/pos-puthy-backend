const { initializeDatabase, getPool } = require('./db');

async function checkItemsColumn() {
  let conn;
  try {
    await initializeDatabase();
    const pool = getPool();
    conn = await pool.getConnection();
    console.log('Checking items column in orders table...');

    const [orders] = await conn.query('SELECT id, items FROM orders WHERE items IS NOT NULL LIMIT 5');

    for (const order of orders) {
      console.log(`Order ID: ${order.id}`);
      console.log(`Items column type: ${typeof order.items}`);
      console.log(`Items column content:`, order.items);
      try {
        JSON.parse(order.items);
        console.log('Successfully parsed items as JSON.');
      } catch (e) {
        console.error('Failed to parse items as JSON:', e.message);
      }
      console.log('---');
    }
  } catch (error) {
    console.error('Error checking items column:', error);
  } finally {
    if (conn) conn.release();
    if (getPool()) {
      getPool().end();
    }
  }
}

checkItemsColumn();
