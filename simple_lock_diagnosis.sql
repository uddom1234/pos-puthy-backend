-- Simple Lock Diagnosis for MySQL
-- Use these queries to diagnose lock timeout issues

-- 1. Check for active transactions
SELECT 
    trx_id,
    trx_state,
    trx_started,
    trx_mysql_thread_id,
    LEFT(trx_query, 100) as query_preview,
    trx_rows_locked,
    trx_rows_modified,
    TIMESTAMPDIFF(SECOND, trx_started, NOW()) as duration_seconds
FROM information_schema.INNODB_TRX 
ORDER BY trx_started;

-- 2. Check current processes and their state
SELECT 
    ID,
    USER,
    HOST,
    DB,
    COMMAND,
    TIME,
    STATE,
    LEFT(INFO, 100) as query_preview
FROM information_schema.PROCESSLIST 
WHERE COMMAND != 'Sleep'
ORDER BY TIME DESC;

-- 3. Check for lock waits (simplified)
SELECT 
    trx_id,
    trx_mysql_thread_id,
    trx_state,
    LEFT(trx_query, 100) as query_preview,
    TIMESTAMPDIFF(SECOND, trx_started, NOW()) as wait_seconds
FROM information_schema.INNODB_TRX 
WHERE trx_state = 'LOCK WAIT';

-- 4. Check current lock wait timeout setting
SHOW VARIABLES LIKE 'innodb_lock_wait_timeout';

-- 5. Check for deadlocks (run this to see recent deadlocks)
SHOW ENGINE INNODB STATUS;

-- 6. Kill specific transaction (replace <thread_id> with actual ID)
-- KILL <thread_id>;

-- 7. Kill all sleeping connections (be careful!)
-- KILL QUERY <thread_id>;

-- 8. Check table locks
SHOW OPEN TABLES WHERE In_use > 0;
