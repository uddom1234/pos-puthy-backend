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
  secretAccessKey: process.env.B2_SECRET_ACCESS_KEY || 'K0055biOfO7BFDEEhZynzDdMAhkK9PI',
  region: process.env.B2_REGION || 'us-east-005',
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
});

app.post('/api/storage/b2/upload', upload.single('file'), async (req, res) => {
  try {
    const bucket = 'pu-thy';
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
    const bucket = 'pu-thy';
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
    const bucket = 'pu-thy';
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

// Ensure order preview snapshot table
async function ensureOrderPreviewSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_preview_snapshot (
      id TINYINT PRIMARY KEY DEFAULT 1,
      payload JSON NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Ensure a single row exists
  await pool.query(`INSERT IGNORE INTO order_preview_snapshot (id, payload) VALUES (1, JSON_OBJECT())`);
}

// Simple in-memory list of SSE clients for order preview
const orderPreviewClients = new Set();

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

  // Create user_categories table if it doesn't exist (now shared across all users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create income_categories table if it doesn't exist (shared across all users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS income_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      color VARCHAR(7) DEFAULT '#10B981',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create expense_categories table if it doesn't exist (shared across all users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      color VARCHAR(7) DEFAULT '#3B82F6',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create income_expenses table if it doesn't exist (shared across all users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS income_expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('income','expense') NOT NULL,
      category VARCHAR(100) NOT NULL,
      description TEXT,
      amount DECIMAL(10,2) NOT NULL,
      date DATETIME NOT NULL,
      category_id INT DEFAULT NULL,
      income_category_id INT DEFAULT NULL,
      FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
      FOREIGN KEY (income_category_id) REFERENCES income_categories(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create transactions table if it doesn't exist (shared across all users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      subtotal DECIMAL(10,2) NOT NULL,
      discount DECIMAL(10,2) NOT NULL DEFAULT '0.00',
      total DECIMAL(10,2) NOT NULL,
      payment_method ENUM('cash','qr') NOT NULL,
      cash_received DECIMAL(10,2) DEFAULT NULL,
      change_back DECIMAL(10,2) DEFAULT NULL,
      status ENUM('paid','unpaid') NOT NULL,
      date DATETIME NOT NULL,
      customer_id INT DEFAULT NULL,
      loyalty_points_used INT DEFAULT '0',
      loyalty_points_earned INT DEFAULT '0',
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create transaction_items table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transaction_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      transaction_id INT NOT NULL,
      product_id INT DEFAULT NULL,
      product_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      customizations JSON DEFAULT NULL,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create products table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      price_khr DECIMAL(10,2) DEFAULT NULL,
      stock INT NOT NULL DEFAULT '0',
      has_stock TINYINT(1) NOT NULL DEFAULT '1',
      low_stock_threshold INT NOT NULL DEFAULT '0',
      description TEXT,
      metadata JSON DEFAULT NULL,
      option_schema JSON DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      image_url VARCHAR(512) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create product_option_groups table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_option_groups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      \`key\` VARCHAR(100) NOT NULL,
      label VARCHAR(255) NOT NULL,
      type ENUM('single','multi') NOT NULL DEFAULT 'single',
      required TINYINT(1) NOT NULL DEFAULT '0',
      UNIQUE KEY uniq_product_key (product_id, \`key\`),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create product_option_values table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_option_values (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id INT NOT NULL,
      label VARCHAR(255) NOT NULL,
      \`value\` VARCHAR(255) NOT NULL,
      value_type ENUM('text','number','boolean','date') NOT NULL DEFAULT 'text',
      value_number DECIMAL(12,4) DEFAULT NULL,
      value_boolean TINYINT(1) DEFAULT NULL,
      value_date DATE DEFAULT NULL,
      price_delta DECIMAL(10,2) NOT NULL DEFAULT '0.00',
      UNIQUE KEY uniq_group_value (group_id, \`value\`),
      FOREIGN KEY (group_id) REFERENCES product_option_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create customers table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      loyalty_points INT NOT NULL DEFAULT '0',
      member_card VARCHAR(100) DEFAULT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create orders table if it doesn't exist (shared across all users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT DEFAULT NULL,
      items JSON NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      payment_status ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid',
      payment_method ENUM('cash','qr') DEFAULT NULL,
      created_at DATETIME NOT NULL,
      table_number VARCHAR(50) DEFAULT NULL,
      notes TEXT,
      metadata JSON DEFAULT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create user_schemas table if it doesn't exist (now shared across all users)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_schemas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('product','order') NOT NULL UNIQUE,
      schema_json JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Create currency_rates table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS currency_rates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      from_currency VARCHAR(3) NOT NULL,
      to_currency VARCHAR(3) NOT NULL,
      rate DECIMAL(10,4) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_currency_pair (from_currency, to_currency)
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

  // No default seeding - categories will be created by users as needed
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

// Remove user_id from orders table (migration to shared system)
async function removeUserIdFromOrders() {
  const pool = getPool();
  try {
    // Check if user_id column exists
    const [columns] = await pool.query("SHOW COLUMNS FROM orders LIKE 'user_id'");
    if (columns.length > 0) {
      // First drop the foreign key constraint
      try {
        await pool.query("ALTER TABLE orders DROP FOREIGN KEY fk_orders_user");
      } catch (e) {
        if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
          console.log('Could not drop fk_orders_user constraint:', e.message);
        }
      }
      // Then drop the user_id column
      await pool.query("ALTER TABLE orders DROP COLUMN user_id");
      console.log('Removed user_id column from orders table');
    }
  } catch (e) {
    if (e.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
      console.log('user_id column does not exist in orders table');
    } else {
      console.error('Error removing user_id from orders:', e);
    }
  }
}

// Remove user_id from income_expenses table (migration to shared system)
async function removeUserIdFromIncomeExpenses() {
  const pool = getPool();
  try {
    // Check if user_id column exists
    const [columns] = await pool.query("SHOW COLUMNS FROM income_expenses LIKE 'user_id'");
    if (columns.length > 0) {
      // First drop the foreign key constraint
      try {
        await pool.query("ALTER TABLE income_expenses DROP FOREIGN KEY fk_ie_user");
      } catch (e) {
        if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
          console.log('Could not drop fk_ie_user constraint:', e.message);
        }
      }
      // Then drop the user_id column
      await pool.query("ALTER TABLE income_expenses DROP COLUMN user_id");
      console.log('Removed user_id column from income_expenses table');
    }
  } catch (e) {
    if (e.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
      console.log('user_id column does not exist in income_expenses table');
    } else {
      console.error('Error removing user_id from income_expenses:', e);
    }
  }
}

// Remove user_id from income_categories table (migration to shared system)
async function removeUserIdFromIncomeCategories() {
  const pool = getPool();
  try {
    // Check if user_id column exists
    const [columns] = await pool.query("SHOW COLUMNS FROM income_categories LIKE 'user_id'");
    if (columns.length > 0) {
      // First drop the foreign key constraint
      try {
        await pool.query("ALTER TABLE income_categories DROP FOREIGN KEY fk_income_categories_user");
      } catch (e) {
        if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
          console.log('Could not drop fk_income_categories_user constraint:', e.message);
        }
      }
      
      // Handle duplicate category names before removing user_id
      // Get all categories grouped by name
      const [duplicates] = await pool.query(`
        SELECT name, COUNT(*) as count, GROUP_CONCAT(id ORDER BY id) as ids
        FROM income_categories 
        GROUP BY name 
        HAVING COUNT(*) > 1
      `);
      
      // For each duplicate name, keep the first one and delete the rest
      for (const dup of duplicates) {
        const ids = dup.ids.split(',').map(id => parseInt(id.trim()));
        const keepId = ids[0]; // Keep the first one
        const deleteIds = ids.slice(1); // Delete the rest
        
        if (deleteIds.length > 0) {
          console.log(`Removing duplicate income categories for '${dup.name}': keeping ID ${keepId}, deleting IDs ${deleteIds.join(', ')}`);
          await pool.query(`DELETE FROM income_categories WHERE id IN (${deleteIds.join(',')})`);
        }
      }
      
      // Drop the user_id column
      await pool.query("ALTER TABLE income_categories DROP COLUMN user_id");
      
      // Add unique constraint on name if it doesn't exist
      try {
        await pool.query("ALTER TABLE income_categories ADD UNIQUE KEY unique_name (name)");
      } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
      }
      console.log('Removed user_id column from income_categories table');
    }
  } catch (e) {
    if (e.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
      console.log('user_id column does not exist in income_categories table');
    } else {
      console.error('Error removing user_id from income_categories:', e);
    }
  }
}

// Remove user_id from expense_categories table (migration to shared system)
async function removeUserIdFromExpenseCategories() {
  const pool = getPool();
  try {
    // Check if user_id column exists
    const [columns] = await pool.query("SHOW COLUMNS FROM expense_categories LIKE 'user_id'");
    if (columns.length > 0) {
      // First drop the foreign key constraint
      try {
        await pool.query("ALTER TABLE expense_categories DROP FOREIGN KEY expense_categories_ibfk_1");
      } catch (e) {
        if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
          console.log('Could not drop expense_categories_ibfk_1 constraint:', e.message);
        }
      }
      
      // Handle duplicate category names before removing user_id
      // Get all categories grouped by name
      const [duplicates] = await pool.query(`
        SELECT name, COUNT(*) as count, GROUP_CONCAT(id ORDER BY id) as ids
        FROM expense_categories 
        GROUP BY name 
        HAVING COUNT(*) > 1
      `);
      
      // For each duplicate name, keep the first one and delete the rest
      for (const dup of duplicates) {
        const ids = dup.ids.split(',').map(id => parseInt(id.trim()));
        const keepId = ids[0]; // Keep the first one
        const deleteIds = ids.slice(1); // Delete the rest
        
        if (deleteIds.length > 0) {
          console.log(`Removing duplicate expense categories for '${dup.name}': keeping ID ${keepId}, deleting IDs ${deleteIds.join(', ')}`);
          await pool.query(`DELETE FROM expense_categories WHERE id IN (${deleteIds.join(',')})`);
        }
      }
      
      // Drop the user_id column
      await pool.query("ALTER TABLE expense_categories DROP COLUMN user_id");
      
      // Add unique constraint on name if it doesn't exist
      try {
        await pool.query("ALTER TABLE expense_categories ADD UNIQUE KEY unique_name (name)");
      } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
      }
      console.log('Removed user_id column from expense_categories table');
    }
  } catch (e) {
    if (e.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
      console.log('user_id column does not exist in expense_categories table');
    } else {
      console.error('Error removing user_id from expense_categories:', e);
    }
  }
}

// Remove user_id from transactions table (migration to shared system)
async function removeUserIdFromTransactions() {
  const pool = getPool();
  try {
    // Check if user_id column exists
    const [columns] = await pool.query("SHOW COLUMNS FROM transactions LIKE 'user_id'");
    if (columns.length > 0) {
      // First drop the foreign key constraint
      try {
        await pool.query("ALTER TABLE transactions DROP FOREIGN KEY fk_transactions_user");
      } catch (e) {
        if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
          console.log('Could not drop fk_transactions_user constraint:', e.message);
        }
      }
      // Then drop the user_id column
      await pool.query("ALTER TABLE transactions DROP COLUMN user_id");
      console.log('Removed user_id column from transactions table');
    }
  } catch (e) {
    if (e.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
      console.log('user_id column does not exist in transactions table');
    } else {
      console.error('Error removing user_id from transactions:', e);
    }
  }
}

// Add price_khr column to products table (migration for dual currency support)
async function addPriceKhrToProducts() {
  const pool = getPool();
  try {
    // Check if price_khr column exists
    const [columns] = await pool.query("SHOW COLUMNS FROM products LIKE 'price_khr'");
    if (columns.length === 0) {
      await pool.query("ALTER TABLE products ADD COLUMN price_khr DECIMAL(10,2) DEFAULT NULL AFTER price");
      console.log('Added price_khr column to products table');
    }
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log('price_khr column already exists in products table');
    } else {
      console.error('Error adding price_khr column to products:', e);
    }
  }
}

// Initialize default currency rates
async function initializeCurrencyRates() {
  const pool = getPool();
  try {
    // Check if currency rates exist
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM currency_rates');
    if (rows[0].count === 0) {
      // Insert default USD to KHR rate (4100)
      await pool.query(
        'INSERT INTO currency_rates (from_currency, to_currency, rate) VALUES (?, ?, ?)',
        ['USD', 'KHR', 4100]
      );
      // Insert reverse rate
      await pool.query(
        'INSERT INTO currency_rates (from_currency, to_currency, rate) VALUES (?, ?, ?)',
        ['KHR', 'USD', 0.000244]
      );
      console.log('Initialized default currency rates');
    }
  } catch (e) {
    console.error('Error initializing currency rates:', e);
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

// User Management Routes (Admin only)
app.get('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, username, role, name, created_at FROM users ORDER BY created_at DESC');
    const users = rows.map(user => ({
      id: String(user.id),
      username: user.username,
      role: user.role,
      name: user.name,
      createdAt: user.created_at
    }));
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  try {
    const { username, password, name, role } = req.body;
    if (!username || !password || !name || !role) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    
    const pool = getPool();
    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)',
      [username, hashedPassword, name, role]
    );
    
    res.status(201).json({
      id: String(result.insertId),
      username,
      name,
      role,
      createdAt: new Date()
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ message: 'Username already exists' });
    } else {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
});

app.put('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  try {
    const { name, role } = req.body;
    const userId = req.params.id;
    
    if (!name || !role) {
      return res.status(400).json({ message: 'Name and role are required' });
    }
    
    const pool = getPool();
    await pool.query(
      'UPDATE users SET name = ?, role = ? WHERE id = ?',
      [name, role, userId]
    );
    
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/users/:id/password', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  try {
    const { password } = req.body;
    const userId = req.params.id;
    
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }
    
    const pool = getPool();
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [hashedPassword, userId]
    );
    
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  try {
    const userId = req.params.id;
    
    // Prevent admin from deleting themselves
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }
    
    const pool = getPool();
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Products Routes
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const { category } = req.query;
    const pool = getPool();
    let sql = 'SELECT id, name, category, price, price_khr AS priceKhr, stock, has_stock AS hasStock, low_stock_threshold AS lowStockThreshold, description, image_url AS imageUrl, metadata, option_schema AS optionSchema FROM products';
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
        `INSERT INTO products (name, category, price, price_khr, stock, has_stock, low_stock_threshold, description, image_url, metadata, option_schema)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
        [
          req.body.name,
          req.body.category,
          req.body.price,
          req.body.priceKhr || null,
          req.body.stock,
          req.body.hasStock !== undefined ? req.body.hasStock : true,
          req.body.lowStockThreshold,
          req.body.description || null,
          req.body.imageUrl || null,
          metadata,
        ]
      );
      const insertedId = result.insertId;

      // Category will be created by user if needed

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
      const map = { name:'name', category:'category', price:'price', priceKhr:'price_khr', stock:'stock', hasStock:'has_stock', lowStockThreshold:'low_stock_threshold', description:'description', imageUrl:'image_url' };
      const fields = [], values = [];
      for (const [k, col] of Object.entries(map)) {
        if (req.body[k] !== undefined) { fields.push(`${col} = ?`); values.push(req.body[k]); }
      }
      if (req.body.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(req.body.metadata)); }
      if (fields.length) {
        values.push(id);
        await conn.query(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
      }

      // Category will be created by user if needed

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
  console.log('Transaction request received:', JSON.stringify(req.body, null, 2));
  const pool = getPool();
  const MAX_RETRIES = 3;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const conn = await pool.getConnection();
    try {
      console.log(`Transaction attempt ${attempt}/${MAX_RETRIES}...`);
      await conn.query('SET SESSION innodb_lock_wait_timeout = 5');
      await conn.query('SET SESSION transaction_isolation="READ-COMMITTED"');
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
      // Only check cash sufficiency if the transaction is being marked as paid
      if (status === 'paid' && (isNaN(cashReceived) || cashReceived < total)) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ message: 'Insufficient cash received.' });
      }
      if (status === 'paid') {
        changeBack = Number((cashReceived - total).toFixed(2));
      } else {
        changeBack = null;
      }
    } else {
      // QR can be 'paid' or 'unpaid'
      status = status === 'paid' ? 'paid' : 'unpaid';
    }

    const [result] = await conn.query(
      `INSERT INTO transactions (subtotal, discount, total, payment_method, cash_received, change_back, status, date, customer_id, loyalty_points_used, loyalty_points_earned)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        subtotal,
        discount,
        total,
        method,
        cashReceived,
        changeBack,
        status,
        now,
        req.body.customerId ? Number(req.body.customerId) : null,
        req.body.loyaltyPointsUsed || 0,
        req.body.loyaltyPointsEarned || 0
      ]
    );
    const txId = result.insertId;

    // Lock products first to prevent deadlocks, then insert items
    const productIds = [];
    for (const item of req.body.items || []) {
      if (item.productId) {
        productIds.push(Number(item.productId));
      }
    }
    
    // Lock all products at once to prevent deadlocks
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      await conn.query(`SELECT id FROM products WHERE id IN (${placeholders}) AND has_stock = 1 FOR UPDATE`, productIds);
    }

    // Insert transaction items
    for (const item of req.body.items || []) {
      await conn.query(
        `INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, price, customizations)
         VALUES (?,?,?,?,?,?)`,
        [txId, item.productId ? Number(item.productId) : null, item.productName, item.quantity, item.price, item.customizations ? JSON.stringify(item.customizations) : null]
      );
    }

    // Update stock for all items (products are already locked)
    for (const item of req.body.items || []) {
      if (item.productId) {
        await conn.query('UPDATE products SET stock = stock - ? WHERE id = ? AND has_stock = 1', [item.quantity, Number(item.productId)]);
      }
    }

      // Auto-create income entry for paid transactions
      if (status === 'paid') {
        // Check if 'Sales' income category exists
        const [incomeCategoryResult] = await conn.query(
          'SELECT id FROM income_categories WHERE name = ?',
          ['Sales']
        );
        
        if (incomeCategoryResult.length > 0) {
          const incomeDescription = req.body.description
            ? String(req.body.description)
            : (req.body.orderId ? `Order #${req.body.orderId} Payment` : `POS Sale #${txId}`);
          await conn.query(
            `INSERT INTO income_expenses (type, category, description, amount, date, income_category_id)
             VALUES (?,?,?,?,?,?)`,
            ['income', 'Sales', incomeDescription, total, now, incomeCategoryResult[0].id]
          );
        }
      }

      console.log('Committing transaction...');
      await conn.commit();
      console.log('Transaction completed successfully with ID:', txId, 'status:', status, 'method:', method);
      res.status(201).json({ id: String(txId), ...req.body, status, cashReceived, changeBack, date: now });
      conn.release();
      return; // Success, exit retry loop
    } catch (error) {
      console.error(`Transaction attempt ${attempt} error:`, error);
      await conn.rollback();
      conn.release();
      
      // Check if this is a retryable error
      const errno = error.errno || error.code;
      const isRetryable = errno === 1205 || errno === 'ER_LOCK_WAIT_TIMEOUT' || // lock wait timeout
                         errno === 1213 || errno === 'ER_LOCK_DEADLOCK' ||     // deadlock
                         errno === 3572;                                       // NOWAIT
      
      if (isRetryable && attempt < MAX_RETRIES) {
        console.log(`Retrying transaction (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, 100 * attempt)); // Exponential backoff
        continue;
      }
      
      // If not retryable or max retries reached, return error
      res.status(500).json({ message: 'Server error', error: error.message });
      return;
    }
  }
});

// Income/Expense Routes (shared across all users)
app.get('/api/income-expenses', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, type, category } = req.query;
    const pool = getPool();
    let sql = `SELECT ie.id, ie.type, ie.category, ie.category_id, ie.income_category_id, ie.description, ie.amount, ie.date,
               ec.name as category_name, ec.color as category_color,
               ic.name as income_category_name, ic.color as income_category_color
               FROM income_expenses ie
               LEFT JOIN expense_categories ec ON ie.category_id = ec.id
               LEFT JOIN income_categories ic ON ie.income_category_id = ic.id
               WHERE 1=1`;
    const params = [];
    if (startDate && endDate) {
      // Normalize to full day range to avoid timezone cutoffs
      const start = new Date(String(startDate));
      const end = new Date(String(endDate));
      const startIso = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0)).toISOString();
      const endIso = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999)).toISOString();
      sql += ' AND date BETWEEN ? AND ?';
      params.push(startIso, endIso);
    }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (category) { sql += ' AND category = ?'; params.push(category); }
    sql += ' ORDER BY date DESC';
    const [rows] = await pool.query(sql, params);
    rows.forEach(r => { r.id = String(r.id); r.date = new Date(r.date).toISOString(); });
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
      `INSERT INTO income_expenses (type, category, category_id, income_category_id, description, amount, date)
       VALUES (?,?,?,?,?,?,?)`,
      [req.body.type, req.body.category, categoryId, incomeCategoryId, req.body.description || null, req.body.amount, date]
    );
    res.status(201).json({ id: String(result.insertId), ...req.body, date });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Orders Routes (shared across all users)
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, customer_id AS customerId, items, total, created_at AS createdAt, table_number AS tableNumber, notes, metadata, payment_status AS paymentStatus, payment_method AS paymentMethod
       FROM orders ORDER BY created_at DESC`
    );
    const normalized = rows.map(r => ({
      ...r,
      id: String(r.id),
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      items: safeJsonParse(r.items, []),
      metadata: safeJsonParse(r.metadata, {}),
    }));
    res.json(normalized);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const createdAt = new Date(); // store UTC; client will localize
    
    // Decrease stock for all items in the order
    const items = req.body.items || [];
    const productIds = [];
    
    // Collect all product IDs and validate stock
    for (const item of items) {
      if (item.productId) {
        productIds.push(Number(item.productId));
      }
    }
    
    // Lock all products at once to prevent deadlocks
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      await conn.query(`SELECT id FROM products WHERE id IN (${placeholders}) AND has_stock = 1 FOR UPDATE`, productIds);
    }
    
    // Decrease stock for each product
    for (const item of items) {
      if (item.productId) {
        await conn.query('UPDATE products SET stock = stock - ? WHERE id = ? AND has_stock = 1', [item.quantity, Number(item.productId)]);
      }
    }
    
    // Create the order
    const [result] = await conn.query(
      `INSERT INTO orders (customer_id, items, total, created_at, table_number, notes, metadata)
       VALUES (?,?,?,?,?,?,?)`,
      [req.body.customerId ? Number(req.body.customerId) : null, JSON.stringify(items), req.body.total, createdAt, req.body.tableNumber || null, req.body.notes || null, req.body.metadata ? JSON.stringify(req.body.metadata) : null]
    );
    
    await conn.commit();
    res.status(201).json({ id: String(result.insertId), ...req.body, createdAt });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
  }
});

// Update order (including metadata)
app.put('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const fields = [];
    const values = [];
    const mapping = { customerId: 'customer_id', items: 'items', total: 'total', notes: 'notes', metadata: 'metadata' };
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
  console.log('Order payment update called for order:', req.params.id, 'status:', req.body.paymentStatus);
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const { paymentStatus, paymentMethod, discount = 0, cashReceived, suppressIncome } = req.body;
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
      console.log('Creating transaction for paid order:', orderId);
      const total = Number(order.total) - Number(discount);
      const now = new Date();
      
      let changeBack = null;
      if (paymentMethod === 'cash' && cashReceived) {
        changeBack = Number((Number(cashReceived) - total).toFixed(2));
      }
      
      const [txResult] = await conn.query(
        `INSERT INTO transactions (subtotal, discount, total, payment_method, cash_received, change_back, status, date, customer_id, loyalty_points_used, loyalty_points_earned)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          Number(order.total),
          Number(discount),
          total,
          paymentMethod,
          cashReceived ? Number(cashReceived) : null,
          changeBack,
          'paid',
          now,
          order.customer_id,
          0, // loyalty points used
          0  // loyalty points earned
        ]
      );
      const txId = txResult.insertId;
      console.log('Transaction created with ID:', txId);
      
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
      // Ensure 'Sales' income category exists
      await conn.query(
        `INSERT IGNORE INTO income_categories (name, description, color)
         VALUES (?,?,?)`,
        ['Sales', 'Point of Sale transactions', '#10B981']
      );
      
      // Get the income category ID
      const [incomeCategoryResult] = await conn.query(
        'SELECT id FROM income_categories WHERE name = ?',
        ['Sales']
      );

      // Ensure we only create one income entry per order payment
      const incomeDescription = `Order #${orderId} Payment`;
      const [existingIncome] = await conn.query(
        'SELECT id FROM income_expenses WHERE description = ? LIMIT 1',
        [incomeDescription]
      );

      if (incomeCategoryResult.length > 0 && (!existingIncome || existingIncome.length === 0)) {
        // Create income unless it already exists (suppressIncome flag becomes advisory)
        console.log('Creating income entry for order:', orderId, 'amount:', total);
        await conn.query(
          `INSERT INTO income_expenses (type, category, description, amount, date, income_category_id)
           VALUES (?,?,?,?,?,?)`,
          ['income', 'Sales', incomeDescription, total, now, incomeCategoryResult[0].id]
        );
        console.log('Income entry created successfully');
      } else {
        console.log('Income entry not created - category exists:', incomeCategoryResult.length > 0, 'existing income:', existingIncome?.length || 0);
      }
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

// Schemas Routes (shared across all users)
// GET /api/schemas/:type
app.get('/api/schemas/:type', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { type } = req.params;
    const [rows] = await pool.query('SELECT type, schema_json AS `schema` FROM user_schemas WHERE type = ?', [type]);
    if (!rows[0]) return res.json({ type, schema: [] });
    const entry = rows[0];
    entry.schema = safeJsonParse(entry.schema, []);
    res.json(entry);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// POST /api/schemas/:type -> upsert schema
app.post('/api/schemas/:type', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const { type } = req.params;
    const { schema } = req.body;
    if (!Array.isArray(schema)) return res.status(400).json({ message: 'Schema must be an array' });
    // Ensure we store valid JSON text
    const payloadJson = JSON.stringify(schema || []);
    await pool.query(
      `INSERT INTO user_schemas (type, schema_json) VALUES (?,?)
       ON DUPLICATE KEY UPDATE schema_json = VALUES(schema_json)`,
      [type, payloadJson]
    );
    res.json({ type, schema });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Categories Routes (shared across all users)
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT name FROM user_categories ORDER BY name');
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
    await pool.query('INSERT IGNORE INTO user_categories (name) VALUES (?)', [name]);
    const [rows] = await pool.query('SELECT name FROM user_categories ORDER BY name');
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
    
    await pool.query('DELETE FROM user_categories WHERE name = ?', [categoryName]);
    const [rows] = await pool.query('SELECT name FROM user_categories ORDER BY name');
    res.json(rows.map(r => r.name));
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Income Categories Routes (shared across all users)
app.get('/api/income-categories', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    let rows;
    try {
      // First try with all columns
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM income_categories ORDER BY name'
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
        'INSERT INTO income_categories (name, description, color, is_active) VALUES (?, ?, ?, ?)',
        [name, description || null, color || '#10B981', 1]
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
    
    // Check if category exists
    const [existing] = await pool.query(
      'SELECT id FROM income_categories WHERE id = ?',
      [categoryId]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    let rows;
    try {
      // First try with all columns
      await pool.query(
        'UPDATE income_categories SET name = ?, description = ?, color = ?, is_active = ? WHERE id = ?',
        [name, description || null, color || '#10B981', isActive !== undefined ? isActive : 1, categoryId]
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
    
    // Check if category exists
    const [existing] = await pool.query(
      'SELECT id FROM income_categories WHERE id = ?',
      [categoryId]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    await pool.query('DELETE FROM income_categories WHERE id = ?', [categoryId]);
    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Expense Categories Routes (shared across all users)
app.get('/api/expense-categories', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    let rows;
    try {
      // First try with all columns
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM expense_categories ORDER BY name'
      );
    } catch (e) {
      // If columns don't exist, try with minimal columns
      if (e.code === 'ER_BAD_FIELD_ERROR' && (e.sqlMessage.includes('description') || e.sqlMessage.includes('is_active'))) {
        [rows] = await pool.query(
          'SELECT id, name, color, created_at AS createdAt FROM expense_categories ORDER BY name'
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
        'INSERT INTO expense_categories (name, description, color, is_active) VALUES (?, ?, ?, ?)',
        [name, description || null, color || '#3B82F6', 1]
      );
      
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM expense_categories WHERE id = ?',
        [result.insertId]
      );
    } catch (e) {
      // If columns don't exist, try with minimal columns
      if (e.code === 'ER_BAD_FIELD_ERROR' && (e.sqlMessage.includes('description') || e.sqlMessage.includes('is_active'))) {
        [result] = await pool.query(
          'INSERT INTO expense_categories (name, color) VALUES (?, ?)',
          [name, color || '#3B82F6']
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
    
    // Check if category exists
    const [existing] = await pool.query(
      'SELECT id FROM expense_categories WHERE id = ?',
      [categoryId]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    let rows;
    try {
      // First try with all columns
      await pool.query(
        'UPDATE expense_categories SET name = ?, description = ?, color = ?, is_active = ? WHERE id = ?',
        [name, description || null, color || '#3B82F6', isActive !== undefined ? isActive : 1, categoryId]
      );
      
      [rows] = await pool.query(
        'SELECT id, name, description, color, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt FROM expense_categories WHERE id = ?',
        [categoryId]
      );
    } catch (e) {
      // If columns don't exist, try with minimal columns
      if (e.code === 'ER_BAD_FIELD_ERROR' && (e.sqlMessage.includes('description') || e.sqlMessage.includes('is_active'))) {
        await pool.query(
          'UPDATE expense_categories SET name = ?, color = ? WHERE id = ?',
          [name, color || '#3B82F6', categoryId]
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
    
    // Check if category exists
    const [existing] = await pool.query(
      'SELECT id FROM expense_categories WHERE id = ?',
      [categoryId]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    
    await pool.query('DELETE FROM expense_categories WHERE id = ?', [categoryId]);
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

    const [ieRows] = await pool.query(
      `SELECT type, amount, category, date FROM income_expenses ${ieWhere}`,
      ieParams
    );
    const [orderRows] = await pool.query(
      `SELECT total, created_at AS createdAt FROM orders ${orderWhere}`,
      orderParams
    );
    // Compute dashboard metrics solely from income_expenses
    const incomeSum = ieRows.filter(ie => ie.type === 'income').reduce((sum, ie) => sum + Number(ie.amount), 0);
    const additionalIncome = incomeSum;
    const totalExpenses = ieRows.filter(ie => ie.type === 'expense').reduce((sum, ie) => sum + Number(ie.amount), 0);
    const totalRevenue = incomeSum; // treat all income as revenue for dashboard
    const totalIncome = incomeSum;
    const netProfit = totalIncome - totalExpenses;

    const transactionCount = 0; // dashboard no longer uses transactions
    const paidTransactionCount = 0;
    const unpaidTransactionCount = 0;

    const orderCount = orderRows.length;
    const orderTotal = orderRows.reduce((sum, o) => sum + Number(o.total), 0);

    // Dashboard does not use itemized sales when transactions are ignored
    const totalItemsSold = 0;
    const averageOrderValue = 0;

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
      itemsSold: [],
      categoryBreakdown: [],
      hourlyData: []
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get top selling items report
app.get('/api/reports/top-selling-items', authenticateToken, async (req, res) => {
  try {
    const { period, startDate: qsStart, endDate: qsEnd, limit = 50 } = req.query;
    const now = moment();
    let startDate, endDate;
    
    if (qsStart && qsEnd) {
      startDate = moment(qsStart);
      endDate = moment(qsEnd);
    } else if (period === 'daily') {
      startDate = now.clone().startOf('day');
      endDate = now.clone().endOf('day');
    } else if (period === 'monthly') {
      startDate = now.clone().startOf('month');
      endDate = now.clone().endOf('month');
    } else {
      startDate = now.clone().startOf('month');
      endDate = now.clone().endOf('month');
    }

    const pool = getPool();
    const [rows] = await pool.query(`
      SELECT 
        oi.product_name as productName,
        oi.product_id as productId,
        oi.category,
        SUM(oi.quantity) as totalQuantity,
        SUM(oi.quantity * oi.price) as totalRevenue,
        AVG(oi.price) as avgPrice,
        COUNT(DISTINCT o.id) as orderCount
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at BETWEEN ? AND ?
        AND o.payment_status = 'paid'
      GROUP BY oi.product_id, oi.product_name, oi.category
      ORDER BY totalQuantity DESC
      LIMIT ?
    `, [startDate.format('YYYY-MM-DD HH:mm:ss'), endDate.format('YYYY-MM-DD HH:mm:ss'), parseInt(limit)]);

    res.json({
      period: period || 'custom',
      startDate: startDate.format('YYYY-MM-DD'),
      endDate: endDate.format('YYYY-MM-DD'),
      items: rows
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get income/expense trends chart data
app.get('/api/reports/income-expense-trends', authenticateToken, async (req, res) => {
  try {
    const { period, startDate: qsStart, endDate: qsEnd, groupBy = 'day' } = req.query;
    const now = moment();
    let startDate, endDate;
    
    if (qsStart && qsEnd) {
      startDate = moment(qsStart);
      endDate = moment(qsEnd);
    } else if (period === 'daily') {
      startDate = now.clone().startOf('day');
      endDate = now.clone().endOf('day');
    } else if (period === 'monthly') {
      startDate = now.clone().startOf('month');
      endDate = now.clone().endOf('month');
    } else {
      startDate = now.clone().subtract(30, 'days');
      endDate = now.clone();
    }

    let dateFormat, groupByClause;
    if (groupBy === 'hour') {
      dateFormat = '%Y-%m-%d %H:00:00';
      groupByClause = 'DATE_FORMAT(date, "%Y-%m-%d %H:00:00")';
    } else if (groupBy === 'week') {
      dateFormat = '%Y-%u';
      groupByClause = 'YEARWEEK(date)';
    } else if (groupBy === 'month') {
      dateFormat = '%Y-%m';
      groupByClause = 'DATE_FORMAT(date, "%Y-%m")';
    } else {
      dateFormat = '%Y-%m-%d';
      groupByClause = 'DATE(date)';
    }

    const pool = getPool();
    const [rows] = await pool.query(`
      SELECT 
        ${groupByClause} as period,
        SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
        COUNT(CASE WHEN type = 'income' THEN 1 END) as incomeCount,
        COUNT(CASE WHEN type = 'expense' THEN 1 END) as expenseCount
      FROM income_expenses
      WHERE date BETWEEN ? AND ?
      GROUP BY ${groupByClause}
      ORDER BY period ASC
    `, [startDate.format('YYYY-MM-DD HH:mm:ss'), endDate.format('YYYY-MM-DD HH:mm:ss')]);

    res.json({
      period: period || 'custom',
      groupBy,
      startDate: startDate.format('YYYY-MM-DD'),
      endDate: endDate.format('YYYY-MM-DD'),
      trends: rows
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all orders report
app.get('/api/reports/orders', authenticateToken, async (req, res) => {
  try {
    const { 
      period, 
      startDate: qsStart, 
      endDate: qsEnd, 
      status, 
      paymentStatus, 
      page = 1, 
      limit = 100,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = req.query;
    
    const now = moment();
    let startDate, endDate;
    
    if (qsStart && qsEnd) {
      startDate = moment(qsStart);
      endDate = moment(qsEnd);
    } else if (period === 'daily') {
      startDate = now.clone().startOf('day');
      endDate = now.clone().endOf('day');
    } else if (period === 'monthly') {
      startDate = now.clone().startOf('month');
      endDate = now.clone().endOf('month');
    } else {
      startDate = now.clone().subtract(30, 'days');
      endDate = now.clone();
    }

    let whereClause = 'WHERE o.created_at BETWEEN ? AND ?';
    let params = [startDate.format('YYYY-MM-DD HH:mm:ss'), endDate.format('YYYY-MM-DD HH:mm:ss')];

    if (status) {
      whereClause += ' AND o.status = ?';
      params.push(status);
    }

    if (paymentStatus) {
      whereClause += ' AND o.payment_status = ?';
      params.push(paymentStatus);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const validSortColumns = ['created_at', 'total', 'status', 'payment_status', 'customer_name'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const pool = getPool();
    // Get total count
    const [countRows] = await pool.query(`
      SELECT COUNT(*) as total
      FROM orders o
      ${whereClause}
    `, params);

    // Get orders with pagination
    const [orderRows] = await pool.query(`
      SELECT 
        o.id,
        o.customer_name as customerName,
        o.customer_phone as customerPhone,
        o.items,
        o.subtotal,
        o.discount,
        o.total,
        o.status,
        o.payment_status as paymentStatus,
        o.payment_method as paymentMethod,
        o.cash_received as cashReceived,
        o.change_amount as changeAmount,
        o.created_at as createdAt,
        o.updated_at as updatedAt
      FROM orders o
      ${whereClause}
      ORDER BY o.${sortColumn} ${sortDirection}
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    // Get order items for each order
    const orderIds = orderRows.map(o => o.id);
    let orderItems = [];
    if (orderIds.length > 0) {
      const [itemRows] = await pool.query(`
        SELECT 
          order_id as orderId,
          product_name as productName,
          product_id as productId,
          category,
          quantity,
          price,
          total
        FROM order_items
        WHERE order_id IN (${orderIds.map(() => '?').join(',')})
        ORDER BY order_id, id
      `, orderIds);
      orderItems = itemRows;
    }

    // Group items by order
    const itemsByOrder = orderItems.reduce((acc, item) => {
      if (!acc[item.orderId]) acc[item.orderId] = [];
      acc[item.orderId].push(item);
      return acc;
    }, {});

    // Add items to orders
    const ordersWithItems = orderRows.map(order => ({
      ...order,
      items: itemsByOrder[order.id] || []
    }));

    res.json({
      period: period || 'custom',
      startDate: startDate.format('YYYY-MM-DD'),
      endDate: endDate.format('YYYY-MM-DD'),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countRows[0].total,
        totalPages: Math.ceil(countRows[0].total / parseInt(limit))
      },
      orders: ordersWithItems
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get comprehensive dashboard data
app.get('/api/reports/dashboard', authenticateToken, async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const now = moment();
    let startDate, endDate;
    
    if (period === 'daily') {
      startDate = now.clone().startOf('day');
      endDate = now.clone().endOf('day');
    } else if (period === 'monthly') {
      startDate = now.clone().startOf('month');
      endDate = now.clone().endOf('month');
    } else {
      startDate = now.clone().subtract(30, 'days');
      endDate = now.clone();
    }

    const pool = getPool();
    // Get income/expense data
    const [ieRows] = await pool.query(`
      SELECT type, amount, category, date
      FROM income_expenses
      WHERE date BETWEEN ? AND ?
    `, [startDate.format('YYYY-MM-DD HH:mm:ss'), endDate.format('YYYY-MM-DD HH:mm:ss')]);

    // Get order data
    const [orderRows] = await pool.query(`
      SELECT id, total, status, payment_status, created_at
      FROM orders
      WHERE created_at BETWEEN ? AND ?
    `, [startDate.format('YYYY-MM-DD HH:mm:ss'), endDate.format('YYYY-MM-DD HH:mm:ss')]);

    // Get low stock alerts
    const [lowStockRows] = await pool.query(`
      SELECT id, name, category, stock_quantity, min_stock_level
      FROM products
      WHERE stock_quantity <= min_stock_level
      ORDER BY (stock_quantity - min_stock_level) ASC
      LIMIT 10
    `);

    // Calculate metrics
    const totalRevenue = ieRows.filter(ie => ie.type === 'income').reduce((sum, ie) => sum + Number(ie.amount), 0);
    const totalExpenses = ieRows.filter(ie => ie.type === 'expense').reduce((sum, ie) => sum + Number(ie.amount), 0);
    const netProfit = totalRevenue - totalExpenses;
    const orderCount = orderRows.length;
    const paidOrderCount = orderRows.filter(o => o.payment_status === 'paid').length;
    const lowStockCount = lowStockRows.length;

    res.json({
      period,
      startDate: startDate.format('YYYY-MM-DD'),
      endDate: endDate.format('YYYY-MM-DD'),
      totalRevenue,
      totalExpenses,
      netProfit,
      orderCount,
      paidOrderCount,
      lowStockCount,
      lowStockAlerts: lowStockRows,
      incomeByCategory: ieRows
        .filter(ie => ie.type === 'income')
        .reduce((acc, ie) => {
          const cat = ie.category || 'Uncategorized';
          acc[cat] = (acc[cat] || 0) + Number(ie.amount);
          return acc;
        }, {}),
      expenseByCategory: ieRows
        .filter(ie => ie.type === 'expense')
        .reduce((acc, ie) => {
          const cat = ie.category || 'Uncategorized';
          acc[cat] = (acc[cat] || 0) + Number(ie.amount);
          return acc;
        }, {})
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Bulk delete orders
app.delete('/api/orders/bulk', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Invalid or empty IDs array' });
    }
    
    // Validate that all orders exist
    const placeholders = ids.map(() => '?').join(',');
    const [orderRows] = await conn.query(
      `SELECT id, items, total FROM orders WHERE id IN (${placeholders})`,
      ids
    );
    
    if (orderRows.length !== ids.length) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ message: 'Some orders not found' });
    }
    
    // Restore stock for all products in all orders
    const allProductIds = new Set();
    const stockRestore = [];
    
    for (const order of orderRows) {
      const items = safeJsonParse(order.items, []);
      for (const item of items) {
        if (item.productId) {
          allProductIds.add(Number(item.productId));
          stockRestore.push({
            productId: Number(item.productId),
            quantity: Number(item.quantity) || 0
          });
        }
      }
    }
    
    // Lock all products at once
    if (allProductIds.size > 0) {
      const productPlaceholders = Array.from(allProductIds).map(() => '?').join(',');
      await conn.query(`SELECT id FROM products WHERE id IN (${productPlaceholders}) AND has_stock = 1 FOR UPDATE`, Array.from(allProductIds));
    }
    
    // Restore stock for each product
    for (const restore of stockRestore) {
      await conn.query('UPDATE products SET stock = stock + ? WHERE id = ? AND has_stock = 1', [restore.quantity, restore.productId]);
    }
    
    // Delete matching transactions for all orders
    for (const order of orderRows) {
      try {
        const orderSubtotal = Number(order.total);
        const [candidateTx] = await conn.query(
          `SELECT id FROM transactions 
           WHERE status = 'paid' AND subtotal = ? 
             AND date >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
          [orderSubtotal]
        );
        
        if (Array.isArray(candidateTx) && candidateTx.length > 0) {
          const items = safeJsonParse(order.items, []);
          const normalizeItems = (arr) => arr
            .map((it) => ({
              productId: it.productId ? Number(it.productId) : null,
              productName: String(it.productName || ''),
              quantity: Number(it.quantity || 0),
              price: Number(it.price || 0),
            }))
            .sort((a, b) => {
              if ((a.productId || 0) !== (b.productId || 0)) return (a.productId || 0) - (b.productId || 0);
              if (a.productName !== b.productName) return a.productName.localeCompare(b.productName);
              if (a.price !== b.price) return a.price - b.price;
              return a.quantity - b.quantity;
            });
          const orderSig = normalizeItems(items);

          for (const row of candidateTx) {
            const txId = row.id;
            const [txItems] = await conn.query(
              `SELECT product_id AS productId, product_name AS productName, quantity, price 
               FROM transaction_items WHERE transaction_id = ?`,
              [txId]
            );
            const txSig = normalizeItems(txItems || []);
            const sameLength = orderSig.length === txSig.length;
            let equal = sameLength;
            if (equal) {
              for (let i = 0; i < orderSig.length; i++) {
                const a = orderSig[i];
                const b = txSig[i];
                if (
                  (a.productId || null) !== (b.productId || null) ||
                  a.productName !== String(b.productName || '') ||
                  Number(a.quantity) !== Number(b.quantity) ||
                  Number(a.price) !== Number(b.price)
                ) { equal = false; break; }
              }
            }
            if (equal) {
              await conn.query('DELETE FROM transaction_items WHERE transaction_id = ?', [txId]);
              await conn.query('DELETE FROM transactions WHERE id = ?', [txId]);
            }
          }
        }
      } catch (e) {
        // Non-fatal: proceed with order deletion even if transaction matching fails
      }
    }
    
    // Delete all orders
    await conn.query(`DELETE FROM orders WHERE id IN (${placeholders})`, ids);
    
    // Delete income entries for all orders (try multiple description formats)
    for (const orderId of ids) {
      // Delete income entries with different possible description formats
      await conn.query(
        `DELETE FROM income_expenses WHERE type = 'income' AND (
          description = ? OR 
          description = ? OR 
          description LIKE ?
        )`,
        [
          `Order #${orderId} Payment`,
          `Order #${orderId}`,
          `%Order #${orderId}%`
        ]
      );
    }
    
    await conn.commit();
    res.json({ message: `${ids.length} orders deleted successfully` });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
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
    
    // Restore stock for products contained in the order (respect quantities)
    const items = safeJsonParse(orderRows[0].items, []);
    const productIds = [];
    for (const item of items) {
      if (item.productId) productIds.push(Number(item.productId));
    }
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      await conn.query(`SELECT id FROM products WHERE id IN (${placeholders}) AND has_stock = 1 FOR UPDATE`, productIds);
    }
    for (const item of items) {
      if (item.productId) {
        await conn.query('UPDATE products SET stock = stock + ? WHERE id = ? AND has_stock = 1', [Number(item.quantity) || 0, Number(item.productId)]);
      }
    }
    
    // Best-effort: delete matching transaction(s) that were created for this order
    // We match by: same user, status = 'paid', subtotal equals order.total, and identical item set
    try {
      const orderSubtotal = Number(orderRows[0].total);
        // Fetch candidate transactions by subtotal. Limit to recent 7 days for safety.
        const [candidateTx] = await conn.query(
          `SELECT id FROM transactions 
           WHERE status = 'paid' AND subtotal = ? 
             AND date >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
          [orderSubtotal]
        );
      if (Array.isArray(candidateTx) && candidateTx.length > 0) {
        // Build normalized signature of order items
        const normalizeItems = (arr) => arr
          .map((it) => ({
            productId: it.productId ? Number(it.productId) : null,
            productName: String(it.productName || ''),
            quantity: Number(it.quantity || 0),
            price: Number(it.price || 0),
          }))
          .sort((a, b) => {
            if ((a.productId || 0) !== (b.productId || 0)) return (a.productId || 0) - (b.productId || 0);
            if (a.productName !== b.productName) return a.productName.localeCompare(b.productName);
            if (a.price !== b.price) return a.price - b.price;
            return a.quantity - b.quantity;
          });
        const orderSig = normalizeItems(items);

        for (const row of candidateTx) {
          const txId = row.id;
          const [txItems] = await conn.query(
            `SELECT product_id AS productId, product_name AS productName, quantity, price 
             FROM transaction_items WHERE transaction_id = ?`,
            [txId]
          );
          const txSig = normalizeItems(txItems || []);
          const sameLength = orderSig.length === txSig.length;
          let equal = sameLength;
          if (equal) {
            for (let i = 0; i < orderSig.length; i++) {
              const a = orderSig[i];
              const b = txSig[i];
              if (
                (a.productId || null) !== (b.productId || null) ||
                a.productName !== String(b.productName || '') ||
                Number(a.quantity) !== Number(b.quantity) ||
                Number(a.price) !== Number(b.price)
              ) { equal = false; break; }
            }
          }
          if (equal) {
            await conn.query('DELETE FROM transaction_items WHERE transaction_id = ?', [txId]);
            await conn.query('DELETE FROM transactions WHERE id = ?', [txId]);
          }
        }
      }
    } catch (e) {
      // Non-fatal: proceed with order deletion even if transaction matching fails
    }

    // Delete the order
    await conn.query('DELETE FROM orders WHERE id = ?', [orderId]);

    // Also delete any income entries that were recorded for this order (if present)
    await conn.query(
      `DELETE FROM income_expenses WHERE type = 'income' AND (
        description = ? OR 
        description = ? OR 
        description LIKE ?
      )`,
      [
        `Order #${orderId} Payment`,
        `Order #${orderId}`,
        `%Order #${orderId}%`
      ]
    );

    // Note: transactions table has no link/description to order; we cannot safely delete here.
    
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


// Bulk delete products
app.delete('/api/products/bulk', authenticateToken, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const { ids, force } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Invalid or empty IDs array' });
    }
    
    // Validate that all products exist
    const placeholders = ids.map(() => '?').join(',');
    const [productRows] = await conn.query(
      `SELECT id, name FROM products WHERE id IN (${placeholders})`,
      ids
    );
    
    if (productRows.length !== ids.length) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ message: 'Some products not found' });
    }
    
    if (force === true) {
      // Force delete - remove all related data
      for (const productId of ids) {
        // Delete orders that contain this product
        const [orderRows] = await conn.query(
          `SELECT id FROM orders 
           WHERE JSON_CONTAINS(items, JSON_OBJECT('productId', ?))`,
          [productId]
        );
        
        for (const order of orderRows) {
          await conn.query('DELETE FROM orders WHERE id = ?', [order.id]);
        }
        
        // Delete transaction items that reference this product
        await conn.query('DELETE FROM transaction_items WHERE product_id = ?', [productId]);
        
        // Delete product option values and groups
        await conn.query('DELETE pov FROM product_option_values pov JOIN product_option_groups pog ON pov.group_id = pog.id WHERE pog.product_id = ?', [productId]);
        await conn.query('DELETE FROM product_option_groups WHERE product_id = ?', [productId]);
      }
    } else {
      // Regular delete - check for references first
      const referencedProducts = [];
      
      for (const productId of ids) {
        // Check if product is referenced in transaction_items
        const [txItemsRows] = await conn.query('SELECT COUNT(*) as count FROM transaction_items WHERE product_id = ?', [productId]);
        if (txItemsRows[0].count > 0) {
          const product = productRows.find(p => p.id == productId);
          referencedProducts.push(product.name);
        }
      }
      
      if (referencedProducts.length > 0) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ 
          message: `Cannot delete products: ${referencedProducts.join(', ')} are referenced in transaction history. Use force delete to remove all related data.`,
          hasTransactionItems: true,
          referencedProducts
        });
      }
      
      // Delete option groups/values for all products
      for (const productId of ids) {
        await conn.query('DELETE pov FROM product_option_values pov JOIN product_option_groups pog ON pov.group_id = pog.id WHERE pog.product_id = ?', [productId]);
        await conn.query('DELETE FROM product_option_groups WHERE product_id = ?', [productId]);
      }
    }
    
    // Delete all products
    await conn.query(`DELETE FROM products WHERE id IN (${placeholders})`, ids);
    
    await conn.commit();
    res.json({ message: `${ids.length} products deleted successfully` });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: error.message });
  } finally {
    conn.release();
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
app.delete('/api/income-expenses/:id(\\d+)', authenticateToken, async (req, res) => {
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

// Currency Rates Routes
app.get('/api/currency-rates', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT from_currency, to_currency, rate, is_active FROM currency_rates WHERE is_active = 1 ORDER BY from_currency, to_currency'
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Public Order Preview Routes (no auth, device-agnostic)
app.get('/api/public/order-preview', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT payload, updated_at FROM order_preview_snapshot WHERE id = 1');
    const row = rows && rows[0];
    const payload = row?.payload || {};
    res.json({ payload, updatedAt: row?.updated_at });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/public/order-preview', async (req, res) => {
  try {
    const pool = getPool();
    const payload = req.body?.payload ?? {};
    // Broadcast first to minimize perceived latency
    const data = JSON.stringify({ type: 'snapshot', payload });
    for (const resClient of orderPreviewClients) {
      try { resClient.write(`data: ${data}\n\n`); } catch {}
    }
    // Persist asynchronously (do not block response)
    (async () => {
      try {
        await pool.query('UPDATE order_preview_snapshot SET payload = ? WHERE id = 1', [JSON.stringify(payload)]);
      } catch (e) {
        console.warn('Failed to persist order preview snapshot:', e);
      }
    })();
    res.json({ message: 'Saved' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// SSE stream for instant order-preview updates
app.get('/api/public/order-preview/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();
  orderPreviewClients.add(res);

  // Send initial snapshot
  (async () => {
    try {
      const pool = getPool();
      const [rows] = await pool.query('SELECT payload FROM order_preview_snapshot WHERE id = 1');
      const row = rows && rows[0];
      const payload = row?.payload || {};
      const data = JSON.stringify({ type: 'snapshot', payload });
      // Initial comment to open the stream eagerly in some proxies
      try { res.write(': connected\n\n'); } catch {}
      res.write(`data: ${data}\n\n`);
    } catch {}
  })();

  // Heartbeat to keep connections alive
  const heartbeat = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    orderPreviewClients.delete(res);
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  });
});

app.put('/api/currency-rates', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  try {
    const { fromCurrency, toCurrency, rate } = req.body;
    if (!fromCurrency || !toCurrency || !rate) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    
    const pool = getPool();
    await pool.query(
      `INSERT INTO currency_rates (from_currency, to_currency, rate) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = CURRENT_TIMESTAMP`,
      [fromCurrency, toCurrency, rate]
    );
    
    res.json({ message: 'Currency rate updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
      await ensureOrderPreviewSchema();
      
      // Run migrations to remove user_id columns (migration to shared system)
      console.log('Running migrations to remove user_id columns...');
      await removeUserIdFromOrders();
      await removeUserIdFromIncomeExpenses();
      await removeUserIdFromIncomeCategories();
      await removeUserIdFromExpenseCategories();
      await removeUserIdFromTransactions();
      console.log('Migrations completed successfully');
      
      // Run dual currency migrations
      console.log('Running dual currency migrations...');
      await addPriceKhrToProducts();
      await initializeCurrencyRates();
      console.log('Dual currency migrations completed successfully');
    } catch (e) {
      console.error('Database initialization failed:', e);
    }
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });