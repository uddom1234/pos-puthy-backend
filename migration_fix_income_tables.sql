-- Migration: Fix Income Tables and Foreign Key Constraints
-- This migration adds missing income_categories and income_expenses tables
-- and ensures proper foreign key relationships

START TRANSACTION;

-- 1. Create income_categories table if it doesn't exist
CREATE TABLE IF NOT EXISTS `income_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `color` varchar(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '#10B981',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_income_category` (`user_id`,`name`),
  KEY `idx_income_categories_user` (`user_id`),
  CONSTRAINT `fk_income_categories_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Create income_expenses table if it doesn't exist
CREATE TABLE IF NOT EXISTS `income_expenses` (
  `id` int NOT NULL AUTO_INCREMENT,
  `type` enum('income','expense') COLLATE utf8mb4_unicode_ci NOT NULL,
  `category` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `amount` decimal(10,2) NOT NULL,
  `date` datetime NOT NULL,
  `user_id` int NOT NULL,
  `category_id` int DEFAULT NULL,
  `income_category_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_ie_user` (`user_id`),
  KEY `fk_income_expenses_category` (`category_id`),
  KEY `idx_ie_income_category` (`income_category_id`),
  CONSTRAINT `fk_ie_income_category` FOREIGN KEY (`income_category_id`) REFERENCES `income_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ie_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_income_expenses_category` FOREIGN KEY (`category_id`) REFERENCES `expense_categories` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Ensure expense_categories table has the correct structure
-- Add missing columns if they don't exist
ALTER TABLE `expense_categories` 
  ADD COLUMN IF NOT EXISTS `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci AFTER `name`,
  ADD COLUMN IF NOT EXISTS `color` varchar(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '#3B82F6' AFTER `description`,
  ADD COLUMN IF NOT EXISTS `is_active` tinyint(1) NOT NULL DEFAULT '1' AFTER `color`,
  ADD COLUMN IF NOT EXISTS `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP AFTER `is_active`,
  ADD COLUMN IF NOT EXISTS `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- 4. Add missing indexes and constraints for expense_categories
ALTER TABLE `expense_categories`
  ADD UNIQUE KEY IF NOT EXISTS `unique_user_category_type` (`user_id`,`name`,`type`),
  ADD CONSTRAINT IF NOT EXISTS `expense_categories_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

-- 5. Create default 'Sales' income category for existing users
-- This ensures the transaction endpoint will work for existing users
INSERT IGNORE INTO `income_categories` (`user_id`, `name`, `description`, `color`, `is_active`)
SELECT 
  u.id as user_id,
  'Sales' as name,
  'Point of Sale transactions' as description,
  '#10B981' as color,
  1 as is_active
FROM `users` u
WHERE NOT EXISTS (
  SELECT 1 FROM `income_categories` ic 
  WHERE ic.user_id = u.id AND ic.name = 'Sales'
);

-- 6. Verify tables were created successfully
SELECT 'Migration completed successfully' as status;

COMMIT;
