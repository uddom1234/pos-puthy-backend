-- Fix Lock Timeout Issues
-- Run these commands to diagnose and fix lock timeout problems

-- 1. Check for long-running transactions
SELECT 
    trx_id,
    trx_state,
    trx_started,
    trx_mysql_thread_id,
    trx_query,
    trx_operation_state,
    trx_tables_in_use,
    trx_tables_locked,
    trx_rows_locked,
    trx_rows_modified
FROM information_schema.INNODB_TRX 
ORDER BY trx_started;

-- 2. Check for lock waits (MySQL 8.0+ compatible)
SELECT 
    waiting_trx_id,
    waiting_pid,
    waiting_query,
    blocking_trx_id,
    blocking_pid,
    blocking_query
FROM performance_schema.data_locks dl1
INNER JOIN performance_schema.data_lock_waits dlw ON dl1.engine_lock_id = dlw.requesting_engine_lock_id
INNER JOIN performance_schema.data_locks dl2 ON dl2.engine_lock_id = dlw.blocking_engine_lock_id;

-- 3. Alternative: Check for lock waits (older MySQL versions)
-- If the above doesn't work, try this:
SELECT 
    r.trx_id waiting_trx_id,
    r.trx_mysql_thread_id waiting_thread,
    r.trx_query waiting_query,
    b.trx_id blocking_trx_id,
    b.trx_mysql_thread_id blocking_thread,
    b.trx_query blocking_query
FROM information_schema.INNODB_TRX r
INNER JOIN information_schema.INNODB_TRX b ON b.trx_id != r.trx_id
WHERE r.trx_state = 'LOCK WAIT';

-- 3. Kill any long-running transactions (be careful!)
-- Uncomment the following lines if you need to kill specific transactions
-- KILL <thread_id>;

-- 4. Optimize transaction_items table for better performance
ALTER TABLE transaction_items 
ADD INDEX idx_transaction_id (transaction_id),
ADD INDEX idx_product_id (product_id);

-- 5. Optimize products table for stock updates
ALTER TABLE products 
ADD INDEX idx_has_stock_id (has_stock, id);

-- 6. Check current lock wait timeout setting
SHOW VARIABLES LIKE 'innodb_lock_wait_timeout';

-- 7. Temporarily increase lock wait timeout (if needed)
-- SET GLOBAL innodb_lock_wait_timeout = 10;

-- 8. Check for deadlocks in error log
-- SHOW ENGINE INNODB STATUS;
