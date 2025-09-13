-- Fix Foreign Key Constraint Issue
-- Diagnose and resolve the transaction_items foreign key error

-- 1. Check if transaction_id 47 exists in transactions table
SELECT id, subtotal, total, status, date, user_id 
FROM transactions 
WHERE id = 47;

-- 2. Check the last few transactions to see what IDs are available
SELECT id, subtotal, total, status, date, user_id 
FROM transactions 
ORDER BY id DESC 
LIMIT 10;

-- 3. Check if there are any transactions at all
SELECT COUNT(*) as total_transactions FROM transactions;

-- 4. Check the current AUTO_INCREMENT value for transactions table
SELECT AUTO_INCREMENT 
FROM information_schema.TABLES 
WHERE TABLE_SCHEMA = 'saas_pos' 
AND TABLE_NAME = 'transactions';

-- 5. If transaction 47 doesn't exist, create it first:
-- INSERT INTO transactions (subtotal, discount, total, payment_method, status, date, user_id, customer_id, loyalty_points_used, loyalty_points_earned)
-- VALUES (1.25, 0.00, 1.25, 'cash', 'paid', NOW(), 1, NULL, 0, 0);

-- 6. Then insert the transaction item:
-- INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, price, customizations)
-- VALUES (47, 23, 'Hot Chicken Flavor Ramen', 1, 1.25, NULL);

-- 7. Check existing transaction_items for reference
SELECT * FROM transaction_items ORDER BY id DESC LIMIT 5;
