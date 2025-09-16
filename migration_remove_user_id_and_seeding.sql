-- Migration: Remove all user_id columns and initial seeding
-- This migration converts the system from user-specific data to shared data

-- =============================================
-- PART 1: REMOVE USER_ID COLUMNS
-- =============================================

-- 1. Remove user_id from orders table
-- First drop foreign key constraint if it exists
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'orders' 
    AND CONSTRAINT_NAME = 'fk_orders_user'
);

SET @sql = IF(@constraint_exists > 0, 
    'ALTER TABLE orders DROP FOREIGN KEY fk_orders_user', 
    'SELECT "Foreign key fk_orders_user does not exist" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop user_id column if it exists
SET @column_exists = (
    SELECT COUNT(*) 
    FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'orders' 
    AND COLUMN_NAME = 'user_id'
);

SET @sql = IF(@column_exists > 0, 
    'ALTER TABLE orders DROP COLUMN user_id', 
    'SELECT "Column user_id does not exist in orders table" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Remove user_id from income_expenses table
-- First drop foreign key constraint if it exists
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'income_expenses' 
    AND CONSTRAINT_NAME = 'fk_ie_user'
);

SET @sql = IF(@constraint_exists > 0, 
    'ALTER TABLE income_expenses DROP FOREIGN KEY fk_ie_user', 
    'SELECT "Foreign key fk_ie_user does not exist" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop user_id column if it exists
SET @column_exists = (
    SELECT COUNT(*) 
    FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'income_expenses' 
    AND COLUMN_NAME = 'user_id'
);

SET @sql = IF(@column_exists > 0, 
    'ALTER TABLE income_expenses DROP COLUMN user_id', 
    'SELECT "Column user_id does not exist in income_expenses table" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Remove user_id from income_categories table
-- First drop foreign key constraint if it exists
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'income_categories' 
    AND CONSTRAINT_NAME = 'fk_income_categories_user'
);

SET @sql = IF(@constraint_exists > 0, 
    'ALTER TABLE income_categories DROP FOREIGN KEY fk_income_categories_user', 
    'SELECT "Foreign key fk_income_categories_user does not exist" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Handle duplicate category names before removing user_id
-- Keep the first occurrence of each duplicate category name
DELETE ic1 FROM income_categories ic1
INNER JOIN income_categories ic2 
WHERE ic1.id > ic2.id 
AND ic1.name = ic2.name;

-- Drop user_id column if it exists
SET @column_exists = (
    SELECT COUNT(*) 
    FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'income_categories' 
    AND COLUMN_NAME = 'user_id'
);

SET @sql = IF(@column_exists > 0, 
    'ALTER TABLE income_categories DROP COLUMN user_id', 
    'SELECT "Column user_id does not exist in income_categories table" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add unique constraint on name if it doesn't exist
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'income_categories' 
    AND CONSTRAINT_NAME = 'unique_name'
);

SET @sql = IF(@constraint_exists = 0, 
    'ALTER TABLE income_categories ADD UNIQUE KEY unique_name (name)', 
    'SELECT "Unique constraint unique_name already exists" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Remove user_id from expense_categories table
-- First drop foreign key constraint if it exists
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'expense_categories' 
    AND CONSTRAINT_NAME = 'expense_categories_ibfk_1'
);

SET @sql = IF(@constraint_exists > 0, 
    'ALTER TABLE expense_categories DROP FOREIGN KEY expense_categories_ibfk_1', 
    'SELECT "Foreign key expense_categories_ibfk_1 does not exist" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Handle duplicate category names before removing user_id
-- Keep the first occurrence of each duplicate category name
DELETE ec1 FROM expense_categories ec1
INNER JOIN expense_categories ec2 
WHERE ec1.id > ec2.id 
AND ec1.name = ec2.name;

-- Drop user_id column if it exists
SET @column_exists = (
    SELECT COUNT(*) 
    FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'expense_categories' 
    AND COLUMN_NAME = 'user_id'
);

SET @sql = IF(@column_exists > 0, 
    'ALTER TABLE expense_categories DROP COLUMN user_id', 
    'SELECT "Column user_id does not exist in expense_categories table" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add unique constraint on name if it doesn't exist
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'expense_categories' 
    AND CONSTRAINT_NAME = 'unique_name'
);

SET @sql = IF(@constraint_exists = 0, 
    'ALTER TABLE expense_categories ADD UNIQUE KEY unique_name (name)', 
    'SELECT "Unique constraint unique_name already exists" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 5. Remove user_id from transactions table
-- First drop foreign key constraint if it exists
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'transactions' 
    AND CONSTRAINT_NAME = 'fk_transactions_user'
);

SET @sql = IF(@constraint_exists > 0, 
    'ALTER TABLE transactions DROP FOREIGN KEY fk_transactions_user', 
    'SELECT "Foreign key fk_transactions_user does not exist" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop user_id column if it exists
SET @column_exists = (
    SELECT COUNT(*) 
    FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'transactions' 
    AND COLUMN_NAME = 'user_id'
);

SET @sql = IF(@column_exists > 0, 
    'ALTER TABLE transactions DROP COLUMN user_id', 
    'SELECT "Column user_id does not exist in transactions table" as message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =============================================
-- PART 2: REMOVE INITIAL SEEDING
-- =============================================

-- Remove default user categories (coffee, food)
DELETE FROM user_categories WHERE name IN ('coffee', 'food');

-- Remove default expense categories
DELETE FROM expense_categories WHERE name IN (
    'General', 
    'Office Supplies', 
    'Utilities', 
    'Rent', 
    'Marketing'
);

-- Remove default income categories
DELETE FROM income_categories WHERE name IN (
    'Sales', 
    'Services', 
    'Other'
);

-- Note: Default users (admin, staff) are kept for system functionality
-- If you want to remove them, uncomment the following lines:
-- DELETE FROM users WHERE username IN ('admin', 'staff');

-- =============================================
-- PART 3: VERIFICATION
-- =============================================

-- Verify that user_id columns have been removed
SELECT 
    TABLE_NAME,
    COLUMN_NAME,
    'STILL EXISTS' as status
FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
AND COLUMN_NAME = 'user_id'
UNION ALL
SELECT 
    'All user_id columns' as TABLE_NAME,
    'removed successfully' as COLUMN_NAME,
    'SUCCESS' as status
WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
    AND COLUMN_NAME = 'user_id'
);

-- Show remaining categories (should be empty or only user-created ones)
SELECT 'user_categories' as table_name, COUNT(*) as remaining_count FROM user_categories
UNION ALL
SELECT 'expense_categories' as table_name, COUNT(*) as remaining_count FROM expense_categories
UNION ALL
SELECT 'income_categories' as table_name, COUNT(*) as remaining_count FROM income_categories;
