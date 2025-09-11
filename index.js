const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
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
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Middleware 
app.use(cors());
app.use(express.json());
// Backblaze B2 upload URL endpoint
app.get('/api/storage/b2/upload-url', async (req, res) => {
  try {
    const keyId = '005e168d73cc2b10000000003';
    const appKey = 'K0055biOfO7BFDEEhZynzDdMAhkK9PI';
    const bucketId = '8e41d6d81dc7338c9c920b11';
    const bucketName = 'pu-thy';

    if (!keyId || !appKey || !bucketId || !bucketName) {
      return res.status(501).json({
        message: 'Backblaze is not configured on the server',
        missing: {
          BACKBLAZE_KEY_ID: !keyId,
          BACKBLAZE_APP_KEY: !appKey,
          BACKBLAZE_BUCKET_ID: !bucketId,
          BACKBLAZE_BUCKET_NAME: !bucketName,
        },
      });
    }

    const authHeader = 'Basic ' + Buffer.from(`${keyId}:${appKey}`).toString('base64');
    const authorizeResp = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    if (!authorizeResp.ok) {
      const err = await authorizeResp.text();
      return res.status(500).json({ message: 'Failed to authorize with Backblaze', error: err });
    }
    const authorizeJson = await authorizeResp.json();
    const apiUrl = authorizeJson.apiUrl;
    const downloadUrl = authorizeJson.downloadUrl;
    const accountAuthToken = authorizeJson.authorizationToken;

    const uploadUrlResp = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: 'POST',
      headers: {
        Authorization: accountAuthToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bucketId }),
    });
    if (!uploadUrlResp.ok) {
      const err = await uploadUrlResp.text();
      return res.status(500).json({ message: 'Failed to get upload URL', error: err });
    }
    const uploadInfo = await uploadUrlResp.json();
    return res.json({
      uploadUrl: uploadInfo.uploadUrl,
      authorizationToken: uploadInfo.authorizationToken,
      downloadUrl,
      bucketName,
    });
  } catch (e) {
    console.error('B2 upload-url error', e);
    return res.status(500).json({ message: 'Server error while getting Backblaze upload URL', error: String(e) });
  }
});

// Direct S3-compatible upload via server (optional alternative)
const upload = multer({ storage: multer.memoryStorage() });
const s3 = new AWS.S3({
  endpoint: process.env.B2_S3_ENDPOINT || 's3.us-east-005.backblazeb2.com',
  accessKeyId: process.env.B2_ACCESS_KEY_ID || '005e168d73cc2b10000000003',
  secretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
  region: process.env.B2_REGION || 'us-east-005',
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
});

app.post('/api/storage/b2/upload', upload.single('file'), async (req, res) => {
  try {
    const bucket = process.env.B2_BUCKET_NAME;
    if (!bucket) return res.status(501).json({ message: 'B2 bucket not configured' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const key = `${Date.now()}-${(req.file.originalname || 'file').replace(/\s+/g, '-')}`;
    const params = {
      Bucket: bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read',
    };
    const result = await s3.upload(params).promise();
    return res.json({ url: result.Location, key: result.Key });
  } catch (e) {
    console.error('S3 upload error', e);
    return res.status(500).json({ message: 'Failed to upload to B2 S3', error: String(e) });
  }
});

// Media upload routes using controller-style organization (compatibility with your previous setup)
// Lightweight inline versions mimicking your pasted TypeScript controllers
app.post('/api/media/upload', upload.single('file'), async (req, res) => {
  try {
    const bucket = process.env.B2_BUCKET_NAME;
    if (!bucket) return res.status(501).json({ error: 'B2 bucket not configured' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const key = `images/${Date.now()}-${(req.file.originalname || 'file').replace(/\s+/g, '-')}`;
    const params = {
      Bucket: bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read',
    };
    const result = await s3.upload(params).promise();
    res.json({
      message: 'Media uploaded successfully',
      mediaUrl: result.Location,
      s3Key: result.Key,
      mediaType: (req.file.mimetype || '').startsWith('video/') ? 'video' : 'image',
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (e) {
    console.error('Upload error', e);
    res.status(500).json({ error: 'Failed to upload media' });
  }
});

app.delete('/api/media/:s3Key', async (req, res) => {
  try {
    const bucket = process.env.B2_BUCKET_NAME;
    const { s3Key } = req.params;
    if (!bucket) return res.status(501).json({ error: 'B2 bucket not configured' });
    if (!s3Key) return res.status(400).json({ error: 'S3 key is required' });
    await s3.deleteObject({ Bucket: bucket, Key: s3Key }).promise();
    res.json({ message: 'Media deleted successfully' });
  } catch (e) {
    console.error('Delete media error', e);
    res.status(500).json({ error: 'Failed to delete media' });
  }
});

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

  // Create user_categories table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_category (user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create expense_categories table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      color VARCHAR(7) DEFAULT '#3B82F6',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_category (user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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

  // Add default categories for admin user
  const [adminUser] = await pool.query('SELECT id FROM users WHERE username = ?', ['admin']);
  if (adminUser.length > 0) {
    const adminId = adminUser[0].id;
    await pool.query(
      'INSERT IGNORE INTO user_categories (user_id, name) VALUES (?, ?), (?, ?)',
      [adminId, 'coffee', adminId, 'food']
    );
    
    // Add default expense categories for admin user
    try {
      // First try with description column
      await pool.query(
        `INSERT IGNORE INTO expense_categories (user_id, name, description, color) VALUES 
         (?, 'General', 'General expense category', '#6B7280'),
         (?, 'Office Supplies', 'Office supplies and stationery', '#10B981'),
         (?, 'Utilities', 'Electricity, water, internet, etc.', '#F59E0B'),
         (?, 'Rent', 'Rent and lease payments', '#EF4444'),
         (?, 'Marketing', 'Marketing and advertising expenses', '#8B5CF6')`,
        [adminId, adminId, adminId, adminId, adminId]
      );
    } catch (e) {
      // If description column doesn't exist, try without it
      if (e.code === 'ER_BAD_FIELD_ERROR' && e.sqlMessage.includes('description')) {
        await pool.query(
          `INSERT IGNORE INTO expense_categories (user_id, name, color) VALUES 
           (?, 'General', '#6B7280'),
           (?, 'Office Supplies', '#10B981'),
           (?, 'Utilities', '#F59E0B'),
           (?, 'Rent', '#EF4444'),
           (?, 'Marketing', '#8B5CF6')`,
          [adminId, adminId, adminId, adminId, adminId]
        );
      } else {
        throw e;
      }
    }
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

// Ensure orders table has payment status and method columns
async function ensureOrdersSchema() {
  const pool = getPool();
  // Add payment_status column if missing
  try {
        await pool.query("ALTER TABLE orders ADD COLUMN payment_status ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid'");
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
    let sql = 'SELECT id, name, category, price, stock, has_stock AS hasStock, low_stock_threshold AS lowStockThreshold, description, image_url AS imageUrl, metadata, option_schema AS optionSchema FROM products';
    const params = [];
    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    }
    sql += ' ORDER BY name';
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
          'SELECT id, group_id AS groupId, label, `value`, price_delta AS priceDelta, value_type AS valueType, value_number AS valueNumber, value_boolean AS valueBoolean, value_date AS valueDate FROM product_option_values WHERE group_id IN (?)',
          [groupIds]
        );
        values.forEach(v => {
          const option = { 
            label: v.label, 
            value: v.value, 
            priceDelta: Number(v.priceDelta),
            valueType: v.valueType || 'text',
            valueNumber: v.valueNumber,
            valueBoolean: v.valueBoolean === 1,
            valueDate: v.valueDate
          };
          (valuesByGroupId[v.groupId] = valuesByGroupId[v.groupId] || []).push(option);
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
      'SELECT id, name, category, price, stock, low_stock_threshold AS lowStockThreshold, description, image_url AS imageUrl FROM products WHERE stock <= low_stock_threshold'
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
        `INSERT INTO products (name, category, price, stock, has_stock, low_stock_threshold, description, image_url, metadata, option_schema)
         VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
        [
          req.body.name,
          req.body.category,
          req.body.price,
          req.body.stock,
          req.body.hasStock !== undefined ? req.body.hasStock : true,
          req.body.lowStockThreshold,
          req.body.description || null,
          req.body.imageUrl || null,
          metadata,
        ]
      );
      const insertedId = result.insertId;

      // Ensure category exists in user_categories
      await conn.query(
        'INSERT IGNORE INTO user_categories (user_id, name) VALUES (?,?)',
        [Number(req.user.id), req.body.category]
      );

      // Persist option schema relationally if provided
      if (Array.isArray(req.body.optionSchema) && req.body.optionSchema.length) {
        for (const group of req.body.optionSchema) {
          const [gRes] = await conn.query(
            'INSERT INTO product_option_groups (product_id, `key`, label, type, required) VALUES (?,?,?,?,?)',
            [insertedId, group.key || group.label || '', group.label || '', group.type === 'multi' ? 'multi' : 'single', !!group.required]
          );
          const groupId = gRes.insertId;
          for (const opt of group.options || []) {
            const valueType = opt.valueType || 'text';
            const valueNumber = valueType === 'number' ? (opt.valueNumber || 0) : null;
            const valueBoolean = valueType === 'boolean' ? (opt.valueBoolean ? 1 : 0) : null;
            const valueDate = valueType === 'date' ? (opt.valueDate || null) : null;
            const canonicalValue = (
              valueType === 'text' ? (opt.value || '') :
              valueType === 'number' ? String(valueNumber ?? '') :
              valueType === 'boolean' ? (valueBoolean ? 'true' : 'false') :
              valueType === 'date' ? (valueDate || '') :
              ''
            );
            
            await conn.query(
              'INSERT INTO product_option_values (group_id, label, `value`, price_delta, value_type, value_number, value_boolean, value_date) VALUES (?,?,?,?,?,?,?,?)',
              [groupId, opt.label || '', canonicalValue, Number(opt.priceDelta || 0), valueType, valueNumber, valueBoolean, valueDate]
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
      const map = { name:'name', category:'category', price:'price', stock:'stock', hasStock:'has_stock', lowStockThreshold:'low_stock_threshold', description:'description', imageUrl:'image_url' };
      const fields = [], values = [];
      for (const [k, col] of Object.entries(map)) {
        if (req.body[k] !== undefined) { fields.push(`${col} = ?`); values.push(req.body[k]); }
      }
      if (req.body.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(req.body.metadata)); }
      if (fields.length) {
        values.push(id);
        await conn.query(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
      }

      // Ensure category exists in user_categories if category was updated
      if (req.body.category !== undefined) {
        await conn.query(
          'INSERT IGNORE INTO user_categories (user_id, name) VALUES (?,?)',
          [Number(req.user.id), req.body.category]
        );
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
            // Build tuples with typed values
            const tuples = opts.map(o => {
              const valueType = o.valueType || 'text';
              const valueNumber = valueType === 'number' ? (o.valueNumber || 0) : null;
              const valueBoolean = valueType === 'boolean' ? (o.valueBoolean ? 1 : 0) : null;
              const valueDate = valueType === 'date' ? (o.valueDate || null) : null;
              const canonicalValue = (
                valueType === 'text' ? (o.value || '') :
                valueType === 'number' ? String(valueNumber ?? '') :
                valueType === 'boolean' ? (valueBoolean ? 'true' : 'false') :
                valueType === 'date' ? (valueDate || '') :
                ''
              );
              
              return [
                groupId,
                (o.label || '').slice(0,255),
                canonicalValue.slice(0,255),
                Number(o.priceDelta || 0),
                valueType,
                valueNumber,
                valueBoolean,
                valueDate
              ];
            });
            // Insert/update by unique (group_id, value)
            await conn.query(
              `INSERT INTO product_option_values (group_id, label, \`value\`, price_delta, value_type, value_number, value_boolean, value_date)
               VALUES ?
               ON DUPLICATE KEY UPDATE
                 label=VALUES(label),
                 price_delta=VALUES(price_delta),
                 value_type=VALUES(value_type),
                 value_number=VALUES(value_number),
                 value_boolean=VALUES(value_boolean),
                 value_date=VALUES(value_date)`,
              [tuples]
            );

            // Prune values that are no longer present
            // Use a combination of label and value to identify unique options
            const keepIdentifiers = opts.map(o => {
              const valueType = o.valueType || 'text';
              const valueNumber = valueType === 'number' ? (o.valueNumber || 0) : null;
              const valueBoolean = valueType === 'boolean' ? (o.valueBoolean ? 1 : 0) : null;
              const valueDate = valueType === 'date' ? (o.valueDate || null) : null;
              const canonicalValue = (
                valueType === 'text' ? (o.value || '') :
                valueType === 'number' ? String(valueNumber ?? '') :
                valueType === 'boolean' ? (valueBoolean ? 'true' : 'false') :
                valueType === 'date' ? (valueDate || '') :
                ''
              );
              return `${(o.label || '').slice(0,255)}|${canonicalValue.slice(0,255)}`;
            });
            if (keepIdentifiers.length) {
              // Delete options that don't match any of the current identifiers
              const [existingValues] = await conn.query(
                'SELECT id, label, `value` FROM product_option_values WHERE group_id = ?',
                [groupId]
              );
              const toDelete = existingValues.filter(existing => {
                const identifier = `${existing.label}|${existing.value}`;
                return !keepIdentifiers.includes(identifier);
              });
              if (toDelete.length) {
                await conn.query(
                  'DELETE FROM product_option_values WHERE id IN (?)',
                  [toDelete.map(v => v.id)]
                );
              }
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
        // Only update stock for items that have stock management enabled
        await conn.query('UPDATE products SET stock = stock - ? WHERE id = ? AND has_stock = 1', [item.quantity, Number(item.productId)]);
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
    let sql = `SELECT ie.id, ie.type, ie.category, ie.category_id, ie.description, ie.amount, ie.date,
               ec.name as category_name, ec.color as category_color
               FROM income_expenses ie
               LEFT JOIN expense_categories ec ON ie.category_id = ec.id
               WHERE ie.user_id = ?`;
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
    
    // Determine which category_id to use based on type
    let categoryId = null;
    let incomeCategoryId = null;
    
    if (req.body.type === 'income' && req.body.categoryId) {
      incomeCategoryId = req.body.categoryId;
    } else if (req.body.type === 'expense' && req.body.categoryId) {
      categoryId = req.body.categoryId;
    }
    
    const [result] = await pool.query(
      `INSERT INTO income_expenses (type, category, category_id, income_category_id, description, amount, date, user_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.body.type, req.body.category, categoryId, incomeCategoryId, req.body.description || null, req.body.amount, date, Number(req.user.id)]
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
      `SELECT id, customer_id AS customerId, items, total, created_at AS createdAt, table_number AS tableNumber, notes, metadata, payment_status AS paymentStatus, payment_method AS paymentMethod
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
      `INSERT INTO orders (customer_id, items, total, created_at, table_number, notes, metadata, user_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.body.customerId ? Number(req.body.customerId) : null, JSON.stringify(req.body.items || []), req.body.total, createdAt, req.body.tableNumber || null, req.body.notes || null, req.body.metadata ? JSON.stringify(req.body.metadata) : null, Number(req.user.id)]
    );
    res.status(201).json({ id: String(result.insertId), ...req.body, createdAt });
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
    const mapping = { customerId: 'customer_id', items: 'items', total: 'total', tableNumber: 'table_number', notes: 'notes', metadata: 'metadata' };
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

// Update order payment status and method
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
    
    // Update order payment status and method
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
    const categoryName = req.params.name;
    
    // Check if any products use this category
    const [productRows] = await pool.query(
      'SELECT COUNT(*) as count FROM products WHERE category = ?',
      [categoryName]
    );
    
    if (productRows[0].count > 0) {
      return res.status(400).json({ 
        message: `Cannot delete category "${categoryName}" because it is used by ${productRows[0].count} product(s). Please update or delete those products first.` 
      });
    }
    
    await pool.query('DELETE FROM user_categories WHERE user_id = ? AND name = ?', [Number(req.user.id), categoryName]);
    const [rows] = await pool.query('SELECT name FROM user_categories WHERE user_id = ? ORDER BY name', [Number(req.user.id)]);
    res.json(rows.map(r => r.name));
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Income Categories Routes (per-user)
app.get('/api/income-categories', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    let rows;
    try {
      // First try with all columns
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM income_categories WHERE user_id = ? ORDER BY name', 
        [Number(req.user.id)]
      );
    } catch (e) {
      // If table doesn't exist, return empty array
      if (e.code === 'ER_NO_SUCH_TABLE') {
        rows = [];
      } else {
        throw e;
      }
    }
    rows.forEach(r => (r.id = String(r.id)));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/income-categories', authenticateToken, async (req, res) => {
  const { name, description, color } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ message: 'Category name required' });
  
  try {
    const pool = getPool();
    let result, rows;
    
    try {
      // First try with all columns
      [result] = await pool.query(
        'INSERT INTO income_categories (user_id, name, description, color, is_active) VALUES (?, ?, ?, ?, ?)',
        [Number(req.user.id), name, description || null, color || '#10B981', 1]
      );
      
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM income_categories WHERE id = ?',
        [result.insertId]
      );
    } catch (e) {
      // If table doesn't exist, return error
      if (e.code === 'ER_NO_SUCH_TABLE') {
        return res.status(400).json({ message: 'Income categories table not found. Please run the migration script first.' });
      } else {
        throw e;
      }
    }
    
    const category = rows[0];
    category.id = String(category.id);
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ message: 'Category name already exists' });
    } else {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
});

app.put('/api/income-categories/:id', authenticateToken, async (req, res) => {
  const { name, description, color, isActive } = req.body;
  const categoryId = req.params.id;
  
  if (!name || typeof name !== 'string') return res.status(400).json({ message: 'Category name required' });
  
  try {
    const pool = getPool();
    
    // Check if category belongs to user
    const [existing] = await pool.query(
      'SELECT id FROM income_categories WHERE id = ? AND user_id = ?',
      [categoryId, Number(req.user.id)]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    let rows;
    try {
      // First try with all columns
      await pool.query(
        'UPDATE income_categories SET name = ?, description = ?, color = ?, is_active = ? WHERE id = ? AND user_id = ?',
        [name, description || null, color || '#10B981', isActive !== undefined ? isActive : 1, categoryId, Number(req.user.id)]
      );
      
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM income_categories WHERE id = ?',
        [categoryId]
      );
    } catch (e) {
      // If table doesn't exist, return error
      if (e.code === 'ER_NO_SUCH_TABLE') {
        return res.status(400).json({ message: 'Income categories table not found. Please run the migration script first.' });
      } else {
        throw e;
      }
    }
    
    const category = rows[0];
    category.id = String(category.id);
    res.json(category);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ message: 'Category name already exists' });
    } else {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
});

app.delete('/api/income-categories/:id', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const categoryId = req.params.id;
    
    // Check if any income entries use this category
    const [incomeRows] = await pool.query(
      'SELECT COUNT(*) as count FROM income_expenses WHERE income_category_id = ?',
      [categoryId]
    );
    
    if (incomeRows[0].count > 0) {
      return res.status(400).json({ 
        message: `Cannot delete category because it is used by ${incomeRows[0].count} income entry(ies). Please update or delete those entries first.` 
      });
    }
    
    // Check if category belongs to user
    const [existing] = await pool.query(
      'SELECT id FROM income_categories WHERE id = ? AND user_id = ?',
      [categoryId, Number(req.user.id)]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    await pool.query('DELETE FROM income_categories WHERE id = ? AND user_id = ?', [categoryId, Number(req.user.id)]);
    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Expense Categories Routes (per-user)
app.get('/api/expense-categories', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    let rows;
    try {
      // First try with all columns
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM expense_categories WHERE user_id = ? ORDER BY name', 
        [Number(req.user.id)]
      );
    } catch (e) {
      // If columns don't exist, try with minimal columns
      if (e.code === 'ER_BAD_FIELD_ERROR' && (e.sqlMessage.includes('description') || e.sqlMessage.includes('is_active'))) {
        [rows] = await pool.query(
          'SELECT id, name, color, created_at AS createdAt FROM expense_categories WHERE user_id = ? ORDER BY name', 
          [Number(req.user.id)]
        );
        // Add missing fields for compatibility
        rows = rows.map(row => ({ 
          ...row, 
          description: null, 
          isActive: true,
          updatedAt: row.createdAt 
        }));
      } else {
        throw e;
      }
    }
    rows.forEach(r => (r.id = String(r.id)));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/expense-categories', authenticateToken, async (req, res) => {
  const { name, description, color } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ message: 'Category name required' });
  
  try {
    const pool = getPool();
    let result, rows;
    
    try {
      // First try with all columns
      [result] = await pool.query(
        'INSERT INTO expense_categories (user_id, name, description, color, is_active) VALUES (?, ?, ?, ?, ?)',
        [Number(req.user.id), name, description || null, color || '#3B82F6', 1]
      );
      
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM expense_categories WHERE id = ?',
        [result.insertId]
      );
    } catch (e) {
      // If columns don't exist, try with minimal columns
      if (e.code === 'ER_BAD_FIELD_ERROR' && (e.sqlMessage.includes('description') || e.sqlMessage.includes('is_active'))) {
        [result] = await pool.query(
          'INSERT INTO expense_categories (user_id, name, color) VALUES (?, ?, ?)',
          [Number(req.user.id), name, color || '#3B82F6']
        );
        
        [rows] = await pool.query(
          'SELECT id, name, color, created_at AS createdAt FROM expense_categories WHERE id = ?',
          [result.insertId]
        );
        // Add missing fields for compatibility
        rows = rows.map(row => ({ 
          ...row, 
          description: null, 
          isActive: true,
          updatedAt: row.createdAt 
        }));
      } else {
        throw e;
      }
    }
    
    const category = rows[0];
    category.id = String(category.id);
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ message: 'Category name already exists' });
    } else {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
});

app.put('/api/expense-categories/:id', authenticateToken, async (req, res) => {
  const { name, description, color, isActive } = req.body;
  const categoryId = req.params.id;
  
  if (!name || typeof name !== 'string') return res.status(400).json({ message: 'Category name required' });
  
  try {
    const pool = getPool();
    
    // Check if category belongs to user
    const [existing] = await pool.query(
      'SELECT id FROM expense_categories WHERE id = ? AND user_id = ?',
      [categoryId, Number(req.user.id)]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    let rows;
    try {
      // First try with all columns
      await pool.query(
        'UPDATE expense_categories SET name = ?, description = ?, color = ?, is_active = ? WHERE id = ? AND user_id = ?',
        [name, description || null, color || '#3B82F6', isActive !== undefined ? isActive : 1, categoryId, Number(req.user.id)]
      );
      
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM expense_categories WHERE id = ?',
        [categoryId]
      );
    } catch (e) {
      // If columns don't exist, try with minimal columns
      if (e.code === 'ER_BAD_FIELD_ERROR' && (e.sqlMessage.includes('description') || e.sqlMessage.includes('is_active'))) {
        await pool.query(
          'UPDATE expense_categories SET name = ?, color = ? WHERE id = ? AND user_id = ?',
          [name, color || '#3B82F6', categoryId, Number(req.user.id)]
        );
        
        [rows] = await pool.query(
          'SELECT id, name, color, created_at AS createdAt FROM expense_categories WHERE id = ?',
          [categoryId]
        );
        // Add missing fields for compatibility
        rows = rows.map(row => ({ 
          ...row, 
          description: null, 
          isActive: true,
          updatedAt: row.createdAt 
        }));
      } else {
        throw e;
      }
    }
    
    const category = rows[0];
    category.id = String(category.id);
    res.json(category);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ message: 'Category name already exists' });
    } else {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
});

app.delete('/api/expense-categories/:id', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const categoryId = req.params.id;
    
    // Check if any income/expenses use this category
    const [expenseRows] = await pool.query(
      'SELECT COUNT(*) as count FROM income_expenses WHERE category_id = ?',
      [categoryId]
    );
    
    if (expenseRows[0].count > 0) {
      return res.status(400).json({ 
        message: `Cannot delete category because it is used by ${expenseRows[0].count} expense(s). Please update or delete those expenses first.` 
      });
    }
    
    // Check if category belongs to user
    const [existing] = await pool.query(
      'SELECT id FROM expense_categories WHERE id = ? AND user_id = ?',
      [categoryId, Number(req.user.id)]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    await pool.query('DELETE FROM expense_categories WHERE id = ? AND user_id = ?', [categoryId, Number(req.user.id)]);
    res.json({ message: 'Category deleted successfully' });
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
      `SELECT total, created_at AS createdAt FROM orders ${orderWhere}`,
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
    const { type, category, categoryId, description, amount } = req.body;
    const id = req.params.id;
    
    await pool.query(
      'UPDATE income_expenses SET type = ?, category = ?, category_id = ?, description = ?, amount = ? WHERE id = ?',
      [type, category, categoryId || null, description, amount, id]
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