const { initializeDatabase, getPool } = require('./db');

async function migrateOrderItems() {
  let conn;
  try {
    await initializeDatabase();
    const pool = getPool();
    conn = await pool.getConnection();
    console.log('Starting order items migration...');

    // Get all orders with items
    const [orders] = await conn.query('SELECT id, items FROM orders WHERE items IS NOT NULL');

    for (const order of orders) {
      const items = order.items;

      if (Array.isArray(items)) {
        for (const item of items) {
          // Check if item has the required properties
          if (item.productId && item.productName && item.quantity && item.price) {
            await conn.query('INSERT INTO order_items (order_id, product_id, product_name, quantity, price, customizations) VALUES (?, ?, ?, ?, ?, ?)', [
              order.id,
              item.productId,
              item.productName,
              item.quantity,
              item.price,
              item.customizations ? JSON.stringify(item.customizations) : null
            ]);
          } else {
            console.warn(`Skipping item in order ${order.id} due to missing properties:`, item);
          }
        }
      }
    }

    console.log('Order items migration completed successfully.');
  } catch (error) {
    console.error('Error during order items migration:', error);
  } finally {
    if (conn) conn.release();
    if (getPool()) {
      getPool().end();
    }
  }
}

migrateOrderItems();
