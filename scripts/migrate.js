// scripts/migrate.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5
});

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('🚀 Starting database migrations...');
    console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);

    await client.query('BEGIN');

    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP DEFAULT NOW(),
        environment VARCHAR(50) DEFAULT 'all'
      )
    `);

    // Get already executed migrations
    const executedResult = await client.query(
      'SELECT name FROM migrations WHERE environment = $1 OR environment = $2',
      ['all', process.env.NODE_ENV || 'development']
    );
    const executedMigrations = executedResult.rows.map(r => r.name);

    const migrations = [
      {
        name: '001_create_admin_notification_recipients',
        sql: `
          CREATE TABLE IF NOT EXISTS admin_notification_recipients (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            enabled BOOLEAN DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(user_id)
          )
        `
      },
      {
        name: '002_add_borrow_datetime_to_requests',
        sql: `
          ALTER TABLE key_requests 
          ADD COLUMN IF NOT EXISTS borrow_datetime TIMESTAMP,
          ADD COLUMN IF NOT EXISTS borrow_type VARCHAR(20)
        `
      },
      {
        name: '003_add_borrow_datetime_to_transactions',
        sql: `
          ALTER TABLE transactions 
          ADD COLUMN IF NOT EXISTS borrow_datetime TIMESTAMP
        `
      },
      {
        name: '004_create_indexes',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
          CREATE INDEX IF NOT EXISTS idx_transactions_key_id ON transactions(key_id);
          CREATE INDEX IF NOT EXISTS idx_transactions_receiver_email ON transactions(receiver_email);
          CREATE INDEX IF NOT EXISTS idx_keys_code ON keys(code);
        `
      },
      {
        name: '005_add_audit_indexes',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
          CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
          CREATE INDEX IF NOT EXISTS idx_audit_log_target_type_target_id ON audit_log(target_type, target_id);
        `
      }
    ];

    let executedCount = 0;
    let skippedCount = 0;

    for (const migration of migrations) {
      if (executedMigrations.includes(migration.name)) {
        console.log(`⏭️  Skipping ${migration.name} (already executed)`);
        skippedCount++;
        continue;
      }

      console.log(`🔄 Executing ${migration.name}...`);
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO migrations (name, environment) VALUES ($1, $2)',
        [migration.name, process.env.NODE_ENV || 'development']
      );
      executedCount++;
      console.log(`✅ ${migration.name} completed`);
    }

    await client.query('COMMIT');
    console.log(`\n🎉 Migration completed!`);
    console.log(`   ✅ ${executedCount} new migrations executed`);
    console.log(`   ⏭️  ${skippedCount} migrations skipped`);
    console.log(`   📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();