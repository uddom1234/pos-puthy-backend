-- Migration to make user_categories and user_schemas shared across all users
-- This removes the user_id dependency and makes them global

-- First, create new tables without user_id dependency
CREATE TABLE IF NOT EXISTS shared_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shared_schemas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('product','order') NOT NULL UNIQUE,
  schema_json JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migrate existing data from user_categories to shared_categories
-- Get unique category names from all users
INSERT IGNORE INTO shared_categories (name)
SELECT DISTINCT name FROM user_categories;

-- Migrate existing data from user_schemas to shared_schemas
-- For schemas, we'll take the first occurrence of each type
-- (assuming all users should have the same schema for each type)
INSERT IGNORE INTO shared_schemas (type, schema_json)
SELECT type, schema_json 
FROM user_schemas 
WHERE (type, user_id) IN (
  SELECT type, MIN(user_id) 
  FROM user_schemas 
  GROUP BY type
);

-- Drop the old tables
DROP TABLE IF EXISTS user_categories;
DROP TABLE IF EXISTS user_schemas;

-- Rename the new tables to the original names
RENAME TABLE shared_categories TO user_categories;
RENAME TABLE shared_schemas TO user_schemas;
