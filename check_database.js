const { initializeDatabase, getPool } = require('./db');
const fs = require('fs');

async function checkDatabaseStructure() {
  try {
    console.log('Initializing database connection...');
    await initializeDatabase();

    const pool = getPool();
    console.log('Connected to database successfully!');

    // Get all tables in the database
    const [tables] = await pool.query("SHOW TABLES");
    console.log('\n=== TABLES IN DATABASE ===');
    tables.forEach(table => {
      console.log(`- ${Object.values(table)[0]}`);
    });

    // Get full database structure
    let sqlDump = '-- Database Structure Dump\n';
    sqlDump += `-- Generated on: ${new Date().toISOString()}\n\n`;

    for (const tableObj of tables) {
      const tableName = Object.values(tableObj)[0];

      console.log(`\n=== TABLE: ${tableName} ===`);

      // Get table structure
      const [columns] = await pool.query(`DESCRIBE ${tableName}`);
      console.log('Columns:');
      columns.forEach(col => {
        console.log(`  ${col.Field} | ${col.Type} | ${col.Null} | ${col.Key} | ${col.Default} | ${col.Extra}`);
      });

      // Get CREATE TABLE statement
      const [createTable] = await pool.query(`SHOW CREATE TABLE ${tableName}`);
      sqlDump += `-- Table structure for ${tableName}\n`;
      sqlDump += `${createTable[0]['Create Table']};\n\n`;

      // Get row count
      const [count] = await pool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      console.log(`Row count: ${count[0].count}`);

      // Show sample data if table has data
      if (count[0].count > 0) {
        const [sample] = await pool.query(`SELECT * FROM ${tableName} LIMIT 3`);
        console.log('Sample data:');
        sample.forEach((row, idx) => {
          console.log(`  Row ${idx + 1}:`, JSON.stringify(row, null, 2));
        });
      }
    }

    // Look for any tables related to orders
    console.log('\n=== SEARCHING FOR ORDER-RELATED TABLES ===');
    const orderTables = tables.filter(tableObj => {
      const tableName = Object.values(tableObj)[0].toLowerCase();
      return tableName.includes('order') || tableName.includes('item') || tableName.includes('product');
    });

    console.log('Order-related tables found:');
    orderTables.forEach(table => {
      console.log(`- ${Object.values(table)[0]}`);
    });

    // Check if orders table exists and its structure
    const ordersTable = tables.find(tableObj =>
      Object.values(tableObj)[0].toLowerCase() === 'orders'
    );

    if (ordersTable) {
      console.log('\n=== ORDERS TABLE ANALYSIS ===');
      const [ordersData] = await pool.query('SELECT * FROM orders LIMIT 3');
      if (ordersData.length > 0) {
        console.log('Sample order data:');
        ordersData.forEach(order => {
          console.log(JSON.stringify(order, null, 2));
        });

        // Check if orders have items column or separate items data
        const sampleOrder = ordersData[0];
        if (sampleOrder.items) {
          console.log('\nOrders table contains items column (JSON format)');
          try {
            const items = JSON.parse(sampleOrder.items);
            console.log('Sample items structure:', JSON.stringify(items, null, 2));
          } catch (e) {
            console.log('Items column contains non-JSON data:', sampleOrder.items);
          }
        }
      }
    }

    // Save structure to file
    fs.writeFileSync('/Users/uddomp/Desktop/puthy-pos/pos-puthy-backend/database_structure.sql', sqlDump);
    console.log('\n=== DATABASE STRUCTURE SAVED ===');
    console.log('Structure saved to: database_structure.sql');

    await pool.end();

  } catch (error) {
    console.error('Error checking database structure:', error);
    process.exit(1);
  }
}

// Run the check
checkDatabaseStructure();