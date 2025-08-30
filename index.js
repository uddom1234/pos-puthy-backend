const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  try {
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const { initializeDatabase, getPool } = require('./db');
const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'your-super-secret-jwt-key-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());

// All data now stored in MySQL via queries

// Ensure users table exists and default users are seeded
async function ensureUsersTableAndDefaults() {
  const pool = getPool();
  // Create users table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','staff') NOT NULL DEFAULT 'staff',
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Check which default users exist
  const [rows] = await pool.query('SELECT username FROM users WHERE username IN (?, ?)', ['admin', 'staff']);
  const existing = new Set(rows.map(r => r.username));

  const inserts = [];
  if (!existing.has('admin')) {
    const adminHash = await bcrypt.hash('admin123', 10);
    inserts.push(['admin', adminHash, 'admin', 'Administrator']);
  }
  if (!existing.has('staff')) {
    const staffHash = await bcrypt.hash('staff123', 10);
    inserts.push(['staff', staffHash, 'staff', 'Staff']);
  }
  if (inserts.length) {
    await pool.query(
      'INSERT INTO users (username, password_hash, role, name) VALUES ?'
      , [inserts]
    );
  }
}

// Ensure transactions table has required columns for cash/qr payments
async function ensureTransactionsSchema() {
  const pool = getPool();
  // Add cash_received column if missing
  try {
    await pool.query('ALTER TABLE transactions ADD COLUMN cash_received DECIMAL(10,2) NULL AFTER payment_method');
  } catch (e) {
    if (!(e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060))) throw e;
  }
  // Add change_back column if missing
  try {
    await pool.query('ALTER TABLE transactions ADD COLUMN change_back DECIMAL(10,2) NULL AFTER cash_received');
  } catch (e) {
    if (!(e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060))) throw e;
  }
}

// Ensure orders table has payment status
async function ensureOrdersSchema() {
  const pool = getPool();
  // Add payment_status column if missing
  try {
    await pool.query("ALTER TABLE orders ADD COLUMN payment_status ENUM('unpaid','paid','partial') NOT NULL DEFAULT 'unpaid' AFTER status");
  } catch (e) {
    if (!(e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060))) throw e;
  }
  // Add payment_method column if missing
  try {
    await pool.query("ALTER TABLE orders ADD COLUMN payment_method ENUM('cash','qr') NULL AFTER payment_status");
  } catch (e) {
    if (!(e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060))) throw e;
  }
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, username, password_hash, role, name FROM users WHERE username = ?', [username]);
    const user = rows[0];
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: String(user.id), username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: String(user.id), username: user.username, role: user.role, name: user.name } });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Products Routes
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const { category } = req.query;
    const pool = getPool();
    let sql = 'SELECT id, name, category, price, stock, low_stock_threshold AS lowStockThreshold, description, metadata, option_schema AS optionSchema FROM products';
    const params = [];
    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    }
    const [rows] = await pool.query(sql, params);

    // Batch-load per-product option groups and values, and compose optionSchema
    const productIds = rows.map(r => r.id);
    let optionSchemaByProductId = {};
    if (productIds.length) {
      const [groups] = await pool.query(
        'SELECT id, product_id AS productId, `key`, label, type, required FROM product_option_groups WHERE product_id IN (?)',
        [productIds]
      );
      const groupIds = groups.map(g => g.id);
      let valuesByGroupId = {};
      if (groupIds.length) {
        const [values] = await pool.query(
          'SELECT id, group_id AS groupId, label, `value`, price_delta AS priceDelta FROM product_option_values WHERE group_id IN (?)',
          [groupIds]
        );
        values.forEach(v => {
          (valuesByGroupId[v.groupId] = valuesByGroupId[v.groupId] || []).push({ label: v.label, value: v.value, priceDelta: Number(v.priceDelta) });
        });
      }
      groups.forEach(g => {
        const group = { key: g.key, label: g.label, type: g.type, required: !!g.required, options: valuesByGroupId[g.id] || [] };
        (optionSchemaByProductId[g.productId] = optionSchemaByProductId[g.productId] || []).push(group);
      });
    }

    // Ensure metadata and attach computed optionSchema
    const normalized = rows.map(r => ({
      ...r,
      id: String(r.id),
      metadata: safeJsonParse(r.metadata, {}),
      optionSchema: optionSchemaByProductId[r.id] || [],
    }));
    res.json(normalized);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/products/low-stock', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, name, category, price, stock, low_stock_threshold AS lowStockThreshold, description FROM products WHERE stock <= low_stock_threshold'
    );
    rows.forEach(r => (r.id = String(r.id)));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/products', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      const metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : null;
      const [result] = await conn.query(
        `INSERT INTO products (name, category, price, stock, low_stock_threshold, description, metadata, option_schema)
         VALUES (?,?,?,?,?,?,?,NULL)`,
        [req.body.name, req.body.category, req.body.price, req.body.stock, req.body.lowStockThreshold, req.body.description || null, metadata]
      );
      const insertedId = result.insertId;

      // Persist option schema relationally if provided
      if (Array.isArray(req.body.optionSchema) && req.body.optionSchema.length) {
        for (const group of req.body.optionSchema) {
          const [gRes] = await conn.query(
            'INSERT INTO product_option_groups (product_id, `key`, label, type, required) VALUES (?,?,?,?,?)',
            [insertedId, group.key || group.label || '', group.label || '', group.type === 'multi' ? 'multi' : 'single', !!group.required]
          );
          const groupId = gRes.insertId;
          for (const opt of group.options || []) {
            await conn.query(
              'INSERT INTO product_option_values (group_id, label, `value`, price_delta) VALUES (?,?,?,?)',
              [groupId, opt.label || '', opt.value || '', Number(opt.priceDelta || 0)]
            );
          }
        }
      }

      await conn.commit();
      res.status(201).json({ id: String(insertedId), ...req.body });
    } catch (e) {
      await conn.rollback();
      if (e && e.code === 'ER_LOCK_WAIT_TIMEOUT') {
        return res.status(409).json({ message: 'Conflict', error: 'Concurrent edit in progress. Please retry.' });
      }
      throw e;
    } finally {
      conn.release();
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });

  const pool = getPool();
  const id = Number(req.params.id);
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.query('SET SESSION innodb_lock_wait_timeout = 15');
      await conn.query('SET SESSION transaction_isolation="READ-COMMITTED"');
      await conn.beginTransaction();

      // 1) Lock parent row (NOWAIT → fast fail if another writer holds it)
      try {
        await conn.query('SELECT id FROM products WHERE id = ? FOR UPDATE NOWAIT', [id]);
      } catch (e) {
        // ER_LOCK_NOWAIT = 3572
        if ((e.errno || e.code) === 3572) throw Object.assign(new Error('busy'), { transient: true });
        throw e;
      }

      // 2) Update base fields
      const map = { name:'name', category:'category', price:'price', stock:'stock', lowStockThreshold:'low_stock_threshold', description:'description' };
      const fields = [], values = [];
      for (const [k, col] of Object.entries(map)) {
        if (req.body[k] !== undefined) { fields.push(`${col} = ?`); values.push(req.body[k]); }
      }
      if (req.body.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(req.body.metadata)); }
      if (fields.length) {
        values.push(id);
        await conn.query(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
      }

      // 3) Upsert option groups/values, then prune obsolete ones
      const schema = Array.isArray(req.body.optionSchema) ? req.body.optionSchema : null;
      let keepGroupIds = [];

      if (schema) {
        // Preload existing group ids by key → id (reduces races)
        const [existing] = await conn.query(
          'SELECT id, `key` FROM product_option_groups WHERE product_id = ? FOR UPDATE',
          [id]
        );
        const keyToId = new Map(existing.map(r => [r.key, r.id]));

        // Upsert groups
        for (const g of schema) {
          const gkey = (g.key || g.label || '').slice(0, 100);
          const type = g.type === 'multi' ? 'multi' : 'single';
          const required = !!g.required;

          // Use unique (product_id, key) to upsert and get id via LAST_INSERT_ID trick
          const [res] = await conn.query(
            `INSERT INTO product_option_groups (product_id, \`key\`, label, type, required)
             VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
               label=VALUES(label), type=VALUES(type), required=VALUES(required), id=LAST_INSERT_ID(id)`,
            [id, gkey, g.label || '', type, required]
          );
          const groupId = res.insertId || keyToId.get(gkey);
          keepGroupIds.push(groupId);

          // Upsert values for this group
          const opts = Array.isArray(g.options) ? g.options : [];
          if (opts.length) {
            // Build tuples
            const tuples = opts.map(o => [
              groupId,
              (o.label || '').slice(0,255),
              (o.value || '').slice(0,255),
              Number(o.priceDelta || 0)
            ]);
            // Insert/update by unique (group_id, value)
            await conn.query(
              `INSERT INTO product_option_values (group_id, label, \`value\`, price_delta)
               VALUES ?
               ON DUPLICATE KEY UPDATE
                 label=VALUES(label),
                 price_delta=VALUES(price_delta)`,
              [tuples]
            );

            // Prune values that are no longer present
            const keepValues = opts.map(o => (o.value || '').slice(0,255));
            if (keepValues.length) {
              await conn.query(
                `DELETE FROM product_option_values
                 WHERE group_id = ? AND \`value\` NOT IN (?)`,
                [groupId, keepValues]
              );
            } else {
              await conn.query('DELETE FROM product_option_values WHERE group_id = ?', [groupId]);
            }
          } else {
            // No options supplied → clear any existing options for this group
            await conn.query('DELETE FROM product_option_values WHERE group_id = ?', [groupId]);
          }
        }

        // Prune groups that are no longer present
        if (keepGroupIds.length) {
          await conn.query(
            `DELETE FROM product_option_groups
             WHERE product_id = ? AND id NOT IN (?)`,
            [id, keepGroupIds]
          );
        } else {
          // If schema is [] → remove all groups for this product
          await conn.query('DELETE FROM product_option_groups WHERE product_id = ?', [id]);
        }
      }

      await conn.commit();
      conn.release();
      return res.json({ id, ...req.body });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      conn.release();

      const errno = e && (e.errno || e.code);
      const msg = (e && e.message) || '';

      const transient =
        e.transient ||
        errno === 1205 || errno === 'ER_LOCK_WAIT_TIMEOUT' || // lock wait timeout
        errno === 1213 || errno === 'ER_LOCK_DEADLOCK' ||     // deadlock
        errno === 3572;                                       // NOWAIT

      if (transient && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        continue;
      }
      return res.status(500).json({ message: 'Server error', error: msg });
    }
  }
});


// Transactions Routes
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, status } = req.query;
    const pool = getPool();
    let sql = `SELECT t.id, t.subtotal, t.discount, t.total, t.payment_method AS paymentMethod, t.status, t.date, t.customer_id AS customerId,
                      t.loyalty_points_used AS loyaltyPointsUsed, t.loyalty_points_earned AS loyaltyPointsEarned,
                      t.cash_received AS cashReceived, t.change_back AS changeBack
               FROM transactions t`;
    const where = [];
    const params = [];
    if (startDate && endDate) { where.push('t.date BETWEEN ? AND ?'); params.push(startDate, endDate); }
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY t.date DESC';
    const [rows] = await pool.query(sql, params);

    // Fetch items for each transaction
    const ids = rows.map(r => r.id);
    let itemsByTx = {};
    if (ids.length) {
      const [items] = await pool.query(
        'SELECT transaction_id AS transactionId, product_id AS productId, product_name AS productName, quantity, price, customizations FROM transaction_items WHERE transaction_id IN (?)',
        [ids]
      );
      itemsByTx = items.reduce((acc, it) => {
        const parsed = it.customizations ? JSON.parse(it.customizations) : undefined;
        const norm = { ...it, productId: it.productId ? String(it.productId) : undefined, customizations: parsed };
        (acc[it.transactionId] = acc[it.transactionId] || []).push(norm);
        return acc;
      }, {});
    }
    const result = rows.map(r => ({ ...r, id: String(r.id), items: itemsByTx[r.id] || [] }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = new Date();
    // Validate and normalize payment
    const method = req.body.paymentMethod;
    if (method !== 'cash' && method !== 'qr') {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ message: 'Invalid payment method. Use cash or qr.' });
    }

    const subtotal = Number(req.body.subtotal || 0);
    const discount = Number(req.body.discount || 0);
    const total = Number(req.body.total || (subtotal - discount - Number(req.body.loyaltyPointsUsed || 0)));

    let status = req.body.status;
    let cashReceived = null;
    let changeBack = null;
    if (method === 'cash') {
      cashReceived = Number(req.body.cashReceived || 0);
      if (isNaN(cashReceived) || cashReceived < total) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ message: 'Insufficient cash received.' });
      }
      changeBack = Number((cashReceived - total).toFixed(2));
      status = 'paid';
    } else {
      // QR can be 'paid' or 'unpaid'
      status = status === 'paid' ? 'paid' : 'unpaid';
    }

    const [result] = await conn.query(
      `INSERT INTO transactions (subtotal, discount, total, payment_method, cash_received, change_back, status, date, user_id, customer_id, loyalty_points_used, loyalty_points_earned)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        subtotal,
        discount,
        total,
        method,
        cashReceived,
        changeBack,
        status,
        now,
        Number(req.user.id),
        req.body.customerId ? Number(req.body.customerId) : null,
        req.body.loyaltyPointsUsed || 0,
        req.body.loyaltyPointsEarned || 0
      ]
    );
    const txId = result.insertId;

    // Insert items and update stock
    for (const item of req.body.items || []) {
      await conn.query(
        `INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, price, customizations)
         VALUES (?,?,?,?,?,?)`,
        [txId, item.productId ? Number(item.productId) : null, item.productName, item.quantity, item.price, item.customizations ? JSON.stringify(item.customizations) : null]
      );
      if (item.productId) {
        await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, Number(item.productId)]);
      }
    }

    // Auto-create income entry for paid transactions
    if (status === 'paid') {
      await conn.query(
        `INSERT INTO income_expenses (type, category, description, amount, date, user_id)
         VALUES (?,?,?,?,?,?)`,
        ['income', 'Sales', `POS Sale #${txId}`, total, now, Number(req.user.id)]
      );
    }

    await conn.commit();
    res.status(201).json({ id: String(txId), ...req.body, status, cashReceived, changeBack, date: now });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
  }
});

// Income/Expense Routes
app.get('/api/income-expenses', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, type, category } = req.query;
    const pool = getPool();
    let sql = 'SELECT id, type, category, description, amount, date FROM income_expenses WHERE user_id = ?';
    const params = [Number(req.user.id)];
    if (startDate && endDate) { sql += ' AND date BETWEEN ? AND ?'; params.push(startDate, endDate); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (category) { sql += ' AND category = ?'; params.push(category); }
    sql += ' ORDER BY date DESC';
    const [rows] = await pool.query(sql, params);
    rows.forEach(r => (r.id = String(r.id)));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/income-expenses', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const date = req.body.date ? new Date(req.body.date) : new Date();
    const [result] = await pool.query(
      `INSERT INTO income_expenses (type, category, description, amount, date, user_id)
       VALUES (?,?,?,?,?,?)`,
      [req.body.type, req.body.category, req.body.description || null, req.body.amount, date, Number(req.user.id)]
    );
    res.status(201).json({ id: String(result.insertId), ...req.body, date });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Orders Routes
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, customer_id AS customerId, items, total, status, payment_status AS paymentStatus, payment_method AS paymentMethod, created_at AS createdAt, table_number AS tableNumber, notes, metadata
       FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
      [Number(req.user.id)]
    );
    const normalized = rows.map(r => ({
      ...r,
      id: String(r.id),
      items: safeJsonParse(r.items, []),
      metadata: safeJsonParse(r.metadata, {}),
    }));
    res.json(normalized);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const createdAt = new Date();
    const [result] = await pool.query(
      `INSERT INTO orders (customer_id, items, total, status, payment_status, payment_method, created_at, table_number, notes, metadata, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.body.customerId ? Number(req.body.customerId) : null, JSON.stringify(req.body.items || []), req.body.total, 'pending', req.body.paymentStatus || 'unpaid', req.body.paymentMethod || null, createdAt, req.body.tableNumber || null, req.body.notes || null, req.body.metadata ? JSON.stringify(req.body.metadata) : null, Number(req.user.id)]
    );
    res.status(201).json({ id: String(result.insertId), ...req.body, createdAt, status: 'pending' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update order (including metadata)
app.put('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const fields = [];
    const values = [];
    const mapping = { customerId: 'customer_id', items: 'items', total: 'total', status: 'status', paymentStatus: 'payment_status', paymentMethod: 'payment_method', tableNumber: 'table_number', notes: 'notes', metadata: 'metadata' };
    for (const [key, col] of Object.entries(mapping)) {
      if (req.body[key] !== undefined) {
        let v = req.body[key];
        if (key === 'items' || key === 'metadata') v = JSON.stringify(v);
        fields.push(`${col} = ?`);
        values.push(v);
      }
    }
    if (!fields.length) return res.json({ id: req.params.id });
    values.push(req.params.id);
    await pool.query(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ id: req.params.id, ...req.body });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/orders/:id/status', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('UPDATE orders SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    res.json({ id: req.params.id, status: req.body.status });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/orders/:id/payment', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const { paymentStatus, paymentMethod, discount = 0, cashReceived } = req.body;
    const orderId = req.params.id;
    
    // Get the order details
    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    const order = orderRows[0];
    
    if (!order) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ message: 'Order not found' });
    }
    
    // Update order payment status
    const fields = [];
    const values = [];
    
    if (paymentStatus) {
      fields.push('payment_status = ?');
      values.push(paymentStatus);
    }
    if (paymentMethod) {
      fields.push('payment_method = ?');
      values.push(paymentMethod);
    }
    
    if (fields.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ message: 'No payment fields to update' });
    }
    
    values.push(orderId);
    await conn.query(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`, values);
    
    // If payment is completed, create a transaction record
    if (paymentStatus === 'paid') {
      const total = Number(order.total) - Number(discount);
      const now = new Date();
      
      let changeBack = null;
      if (paymentMethod === 'cash' && cashReceived) {
        changeBack = Number((Number(cashReceived) - total).toFixed(2));
      }
      
      const [txResult] = await conn.query(
        `INSERT INTO transactions (subtotal, discount, total, payment_method, cash_received, change_back, status, date, user_id, customer_id, loyalty_points_used, loyalty_points_earned)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          Number(order.total),
          Number(discount),
          total,
          paymentMethod,
          cashReceived ? Number(cashReceived) : null,
          changeBack,
          'paid',
          now,
          Number(req.user.id),
          order.customer_id,
          0, // loyalty points used
          0  // loyalty points earned
        ]
      );
      const txId = txResult.insertId;
      
      // Parse order items and create transaction items
      const items = safeJsonParse(order.items, []);
      for (const item of items) {
        await conn.query(
          `INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, price, customizations)
           VALUES (?,?,?,?,?,?)`,
          [txId, item.productId ? Number(item.productId) : null, item.productName, item.quantity, item.price, item.customizations ? JSON.stringify(item.customizations) : null]
        );
      }
      
      // Create income entry for paid orders
      await conn.query(
        `INSERT INTO income_expenses (type, category, description, amount, date, user_id)
         VALUES (?,?,?,?,?,?)`,
        ['income', 'Sales', `Order #${orderId} Payment`, total, now, Number(req.user.id)]
      );
    }
    
    await conn.commit();
    res.json({ id: req.params.id, paymentStatus, paymentMethod });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
  }
});

// Schemas Routes (per-user, per-type)
// GET /api/schemas/:userId/:type
app.get('/api/schemas/:userId/:type', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { userId, type } = req.params;
    const [rows] = await pool.query('SELECT user_id AS userId, type, schema_json AS `schema` FROM user_schemas WHERE user_id = ? AND type = ?', [Number(userId), type]);
    if (!rows[0]) return res.json({ userId, type, schema: [] });
    const entry = rows[0];
    entry.schema = safeJsonParse(entry.schema, []);
    entry.userId = String(entry.userId);
    res.json(entry);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// POST /api/schemas/:userId/:type -> upsert schema
app.post('/api/schemas/:userId/:type', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { userId, type } = req.params;
    const { schema } = req.body;
    if (!Array.isArray(schema)) return res.status(400).json({ message: 'Schema must be an array' });
    // Ensure we store valid JSON text
    const payloadJson = JSON.stringify(schema || []);
    await pool.query(
      `INSERT INTO user_schemas (user_id, type, schema_json) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE schema_json = VALUES(schema_json)`,
      [Number(userId), type, payloadJson]
    );
    res.json({ userId, type, schema });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Categories Routes (per-user)
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT name FROM user_categories WHERE user_id = ? ORDER BY name', [Number(req.user.id)]);
    res.json(rows.map(r => r.name));
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/categories', authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ message: 'Category name required' });
  try {
    const pool = getPool();
    await pool.query('INSERT IGNORE INTO user_categories (user_id, name) VALUES (?,?)', [Number(req.user.id), name]);
    const [rows] = await pool.query('SELECT name FROM user_categories WHERE user_id = ? ORDER BY name', [Number(req.user.id)]);
    res.status(201).json(rows.map(r => r.name));
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/categories/:name', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('DELETE FROM user_categories WHERE user_id = ? AND name = ?', [Number(req.user.id), req.params.name]);
    const [rows] = await pool.query('SELECT name FROM user_categories WHERE user_id = ? ORDER BY name', [Number(req.user.id)]);
    res.json(rows.map(r => r.name));
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Customers Routes
app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, phone, name, loyalty_points AS loyaltyPoints, member_card AS memberCard, created_at AS createdAt FROM customers ORDER BY created_at DESC');
    rows.forEach(r => (r.id = String(r.id)));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/customers/search', authenticateToken, async (req, res) => {
  try {
    const { phone, memberCard } = req.query;
    const pool = getPool();
    let sql = 'SELECT id, phone, name, loyalty_points AS loyaltyPoints, member_card AS memberCard FROM customers WHERE ';
    const params = [];
    if (phone) { sql += 'phone = ?'; params.push(phone); }
    else if (memberCard) { sql += 'member_card = ?'; params.push(memberCard); }
    else return res.json(null);
    const [rows] = await pool.query(sql, params);
    const c = rows[0];
    if (!c) return res.json(null);
    c.id = String(c.id);
    res.json(c);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/customers', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [result] = await pool.query(
      'INSERT INTO customers (phone, name, loyalty_points, member_card) VALUES (?,?,?,?)',
      [req.body.phone, req.body.name, req.body.loyaltyPoints || 0, req.body.memberCard || null]
    );
    res.status(201).json({ id: String(result.insertId), ...req.body, loyaltyPoints: req.body.loyaltyPoints || 0, createdAt: new Date() });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/customers/:id/points', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { points, operation } = req.body;
    if (operation === 'add') {
      await pool.query('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?', [points, Number(req.params.id)]);
    } else if (operation === 'subtract') {
      // Prevent negative
      await pool.query('UPDATE customers SET loyalty_points = GREATEST(0, loyalty_points - ?) WHERE id = ?', [points, Number(req.params.id)]);
    }
    const [rows] = await pool.query('SELECT id, phone, name, loyalty_points AS loyaltyPoints, member_card AS memberCard FROM customers WHERE id = ?', [Number(req.params.id)]);
    const c = rows[0];
    if (!c) return res.status(404).json({ message: 'Customer not found' });
    c.id = String(c.id);
    res.json(c);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Reports Routes
app.get('/api/reports/sales-summary', authenticateToken, async (req, res) => {
  try {
    const { period, startDate: qsStart, endDate: qsEnd, category } = req.query; // 'daily' | 'monthly' or explicit range
    const now = moment();
    let startDate, endDate;
    if (qsStart && qsEnd) {
      startDate = moment(qsStart + ' 00:00:00', 'YYYY-MM-DD HH:mm:ss');
      endDate = moment(qsEnd + ' 23:59:59', 'YYYY-MM-DD HH:mm:ss');
    } else if (period === 'daily') { startDate = now.startOf('day'); endDate = now.endOf('day'); }
    else { startDate = now.startOf('month'); endDate = now.endOf('month'); }
    const pool = getPool();
    let txWhere = '', txParams = [];
    let ieWhere = '', ieParams = [];
    let orderWhere = '', orderParams = [];
    if (qsStart && qsEnd) {
      txWhere = 'WHERE date BETWEEN ? AND ?';
      ieWhere = 'WHERE date BETWEEN ? AND ?';
      orderWhere = 'WHERE created_at BETWEEN ? AND ?';
      txParams = [startDate.format('YYYY-MM-DD HH:mm:ss'), endDate.format('YYYY-MM-DD HH:mm:ss')];
      ieParams = txParams;
      orderParams = txParams;
    } else if (period === 'daily') {
      txWhere = 'WHERE DATE(date) = CURDATE()';
      ieWhere = 'WHERE DATE(date) = CURDATE()';
      orderWhere = 'WHERE DATE(created_at) = CURDATE()';
    } else {
      txWhere = 'WHERE YEAR(date) = YEAR(CURDATE()) AND MONTH(date) = MONTH(CURDATE())';
      ieWhere = 'WHERE YEAR(date) = YEAR(CURDATE()) AND MONTH(date) = MONTH(CURDATE())';
      orderWhere = 'WHERE YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())';
    }

    const [txRows] = await pool.query(
      `SELECT total, status, date FROM transactions ${txWhere}`,
      txParams
    );
    const [ieRows] = await pool.query(
      `SELECT type, amount, category, date FROM income_expenses ${ieWhere}`,
      ieParams
    );
    const [orderRows] = await pool.query(
      `SELECT total, status, created_at AS createdAt FROM orders ${orderWhere}`,
      orderParams
    );

    // Get detailed item sales data
    let itemWhere = txWhere.replace('date', 't.date');
    let itemParams = txParams;
    if (!itemWhere) {
      if (period === 'daily') {
        itemWhere = 'WHERE DATE(t.date) = CURDATE()';
        itemParams = [];
      } else {
        itemWhere = 'WHERE YEAR(t.date) = YEAR(CURDATE()) AND MONTH(t.date) = MONTH(CURDATE())';
        itemParams = [];
      }
    }

    // Category filter for items
    let categoryFilter = '';
    if (category) {
      categoryFilter = ' AND p.category = ?';
      itemParams.push(category);
    }

    const [itemsRows] = await pool.query(`
      SELECT 
        ti.product_name AS productName,
        ti.product_id AS productId,
        p.category,
        SUM(ti.quantity) AS totalQuantity,
        SUM(ti.quantity * ti.price) AS totalRevenue,
        AVG(ti.price) AS avgPrice,
        COUNT(DISTINCT t.id) AS orderCount
      FROM transaction_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      LEFT JOIN products p ON ti.product_id = p.id
      ${itemWhere}${categoryFilter}
      GROUP BY ti.product_id, ti.product_name
      ORDER BY totalQuantity DESC
    `, itemParams);

    // Get category breakdown
    const [categoryRows] = await pool.query(`
      SELECT 
        COALESCE(p.category, 'Unknown') AS category,
        SUM(ti.quantity) AS totalQuantity,
        SUM(ti.quantity * ti.price) AS totalRevenue,
        COUNT(DISTINCT ti.product_id) AS uniqueProducts
      FROM transaction_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      LEFT JOIN products p ON ti.product_id = p.id
      ${itemWhere}
      GROUP BY p.category
      ORDER BY totalRevenue DESC
    `, txParams);

    // Get hourly sales data for the period
    const [hourlyRows] = await pool.query(`
      SELECT 
        HOUR(t.date) AS hour,
        COUNT(*) AS transactionCount,
        SUM(t.total) AS revenue,
        SUM(ti.quantity) AS itemsSold
      FROM transactions t
      LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
      ${txWhere}
      GROUP BY HOUR(t.date)
      ORDER BY hour
    `, txParams);

    const totalRevenue = txRows.reduce((sum, t) => sum + Number(t.total), 0);
    const totalExpenses = ieRows.filter(ie => ie.type === 'expense').reduce((sum, ie) => sum + Number(ie.amount), 0);
    const additionalIncome = ieRows.filter(ie => ie.type === 'income').reduce((sum, ie) => sum + Number(ie.amount), 0);
    const totalIncome = totalRevenue + additionalIncome;
    const netProfit = totalIncome - totalExpenses;

    const transactionCount = txRows.length;
    const paidTransactionCount = txRows.filter(t => t.status === 'paid').length;
    const unpaidTransactionCount = txRows.filter(t => t.status === 'unpaid').length;

    const orderCount = orderRows.length;
    const orderTotal = orderRows.reduce((sum, o) => sum + Number(o.total), 0);

    // Calculate total items sold
    const totalItemsSold = itemsRows.reduce((sum, item) => sum + Number(item.totalQuantity), 0);
    const averageOrderValue = transactionCount > 0 ? totalRevenue / transactionCount : 0;

    // Breakdowns
    const incomeByCategory = ieRows
      .filter(ie => ie.type === 'income')
      .reduce((acc, ie) => {
        const cat = ie.category || 'Uncategorized';
        acc[cat] = (acc[cat] || 0) + Number(ie.amount);
        return acc;
      }, {});
    const expenseByCategory = ieRows
      .filter(ie => ie.type === 'expense')
      .reduce((acc, ie) => {
        const cat = ie.category || 'Uncategorized';
        acc[cat] = (acc[cat] || 0) + Number(ie.amount);
        return acc;
      }, {});

    res.json({
      period,
      totalRevenue,
      totalExpenses,
      additionalIncome,
      totalIncome,
      netProfit,
      transactionCount,
      paidTransactionCount,
      unpaidTransactionCount,
      orderCount,
      orderTotal,
      totalItemsSold,
      averageOrderValue,
      incomeByCategory,
      expenseByCategory,
      itemsSold: itemsRows.map(item => ({
        productName: item.productName,
        productId: item.productId ? String(item.productId) : null,
        category: item.category,
        quantity: Number(item.totalQuantity),
        revenue: Number(item.totalRevenue),
        avgPrice: Number(item.avgPrice),
        orderCount: Number(item.orderCount)
      })),
      categoryBreakdown: categoryRows.map(cat => ({
        category: cat.category,
        quantity: Number(cat.totalQuantity),
        revenue: Number(cat.totalRevenue),
        uniqueProducts: Number(cat.uniqueProducts)
      })),
      hourlyData: hourlyRows.map(hour => ({
        hour: Number(hour.hour),
        transactionCount: Number(hour.transactionCount),
        revenue: Number(hour.revenue),
        itemsSold: Number(hour.itemsSold)
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete order
app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const orderId = req.params.id;
    
    // Check if order exists
    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (orderRows.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }
    
    // Note: Transactions are not directly linked to orders in this schema
    // They are separate entities created during payment processing
    // So we only delete the order itself
    
    // Delete the order
    await conn.query('DELETE FROM orders WHERE id = ?', [orderId]);
    
    await conn.commit();
    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
  }
});

// Check if product is used in orders
app.get('/api/products/:id/orders', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const productId = req.params.id;
    
    // Check orders that contain this product
    const [orderRows] = await pool.query(`
      SELECT DISTINCT o.id, o.table_number, o.status, o.created_at, o.total
      FROM orders o
      WHERE JSON_CONTAINS(o.items, JSON_OBJECT('productId', ?))
      ORDER BY o.created_at DESC
    `, [productId]);
    
    res.json({
      hasOrders: orderRows.length > 0,
      orders: orderRows.map(order => ({
        id: order.id,
        tableNumber: order.table_number,
        status: order.status,
        createdAt: order.created_at,
        total: Number(order.total)
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete product
app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const productId = req.params.id;
    
    // Check if product exists
    const [productRows] = await conn.query('SELECT * FROM products WHERE id = ?', [productId]);
    if (productRows.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    
    // Check if force delete is requested
    const { force } = req.query;
    
    if (force === 'true') {
      // Delete orders that contain this product
      const [orderRows] = await conn.query(`
        SELECT id FROM orders 
        WHERE JSON_CONTAINS(items, JSON_OBJECT('productId', ?))
      `, [productId]);
      
      for (const order of orderRows) {
        // Note: Transactions are not directly linked to orders in this schema
        // They are separate entities, so we only delete the orders
        await conn.query('DELETE FROM orders WHERE id = ?', [order.id]);
      }
      
      // Delete transaction items that reference this product
      await conn.query('DELETE FROM transaction_items WHERE product_id = ?', [productId]);
      
      // Delete product option values and groups
      await conn.query('DELETE pov FROM product_option_values pov JOIN product_option_groups pog ON pov.group_id = pog.id WHERE pog.product_id = ?', [productId]);
      await conn.query('DELETE FROM product_option_groups WHERE product_id = ?', [productId]);
    } else {
      // Check if product is referenced in transaction_items
      const [txItemsRows] = await conn.query('SELECT COUNT(*) as count FROM transaction_items WHERE product_id = ?', [productId]);
      if (txItemsRows[0].count > 0) {
        return res.status(400).json({ 
          message: 'Cannot delete product: it is referenced in transaction history. Use force delete to remove all related data.',
          hasTransactionItems: true
        });
      }
      
      // Check for option groups/values and delete them first
      await conn.query('DELETE pov FROM product_option_values pov JOIN product_option_groups pog ON pov.group_id = pog.id WHERE pog.product_id = ?', [productId]);
      await conn.query('DELETE FROM product_option_groups WHERE product_id = ?', [productId]);
    }
    
    // Delete the product
    await conn.query('DELETE FROM products WHERE id = ?', [productId]);
    
    await conn.commit();
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
  }
});

// Update income/expense entry
app.put('/api/income-expenses/:id', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { type, category, description, amount } = req.body;
    const id = req.params.id;
    
    await pool.query(
      'UPDATE income_expenses SET type = ?, category = ?, description = ?, amount = ? WHERE id = ?',
      [type, category, description, amount, id]
    );
    
    res.json({ message: 'Entry updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete income/expense entry
app.delete('/api/income-expenses/:id', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const id = req.params.id;
    
    await pool.query('DELETE FROM income_expenses WHERE id = ?', [id]);
    res.json({ message: 'Entry deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Bulk delete income/expense entries
app.delete('/api/income-expenses/bulk', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Invalid or empty IDs array' });
    }
    
    const placeholders = ids.map(() => '?').join(',');
    await conn.query(`DELETE FROM income_expenses WHERE id IN (${placeholders})`, ids);
    
    await conn.commit();
    res.json({ message: `${ids.length} entries deleted successfully` });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

initializeDatabase()
  .then(async () => {
    try {
      await ensureUsersTableAndDefaults();
      await ensureTransactionsSchema();
      await ensureOrdersSchema();
    } catch (e) {
      console.error('User seeding failed:', e);
    }
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });