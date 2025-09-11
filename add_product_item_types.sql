-- Inventory Item Types for products
-- This migration introduces a normalized way to classify inventory items,
-- similar to order types, and supports stock vs non-stock items.

START TRANSACTION;

-- 1) Create a lookup table for item types (optional but future-proof)
CREATE TABLE IF NOT EXISTS inventory_item_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(32) NOT NULL UNIQUE,
  `label` VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed common types
INSERT IGNORE INTO inventory_item_types (`key`, `label`) VALUES
  ('stock', 'Stock Tracked'),
  ('no_stock', 'Made-to-Order / No Stock'),
  ('service', 'Service'),
  ('bundle', 'Bundle');

-- 2) Add item_type and related fields on products
--    Use ENUM for fast validation while also keeping the lookup table above for UI
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS item_type ENUM('stock','no_stock','service','bundle') NOT NULL DEFAULT 'stock' AFTER category,
  ADD COLUMN IF NOT EXISTS unit VARCHAR(32) NULL AFTER price,
  ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,2) NULL AFTER price,
  ADD COLUMN IF NOT EXISTS sku VARCHAR(64) NULL AFTER name,
  ADD UNIQUE KEY IF NOT EXISTS uq_products_sku (sku);

-- 3) Backfill item_type from existing has_stock flag
UPDATE products SET item_type = 'stock' WHERE has_stock = 1 AND (item_type IS NULL OR item_type = 'stock');
UPDATE products SET item_type = 'no_stock' WHERE has_stock = 0 AND (item_type IS NULL OR item_type = 'stock');

-- 4) Optional: keep has_stock coherent with item_type
UPDATE products SET has_stock = 0 WHERE item_type IN ('no_stock','service','bundle');
UPDATE products SET has_stock = 1 WHERE item_type = 'stock';

COMMIT;


