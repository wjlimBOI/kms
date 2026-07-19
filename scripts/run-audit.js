#!/usr/bin/env node
// scripts/run-audit.js
require('dotenv').config();
const { Pool } = require('pg');
const AuditValidator = require('../lib/auditValidator');
const { sendConfirmationEmail } = require('../services/emailService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const logger = console;
  const validator = new AuditValidator(pool, { logger });

  console.log('🔍 Running audit chain validation...');
  const start = Date.now();

  try {
    const result = await validator.validateChain();
    const duration = Date.now() - start;

    console.log(`✅ Validation completed in ${duration}ms`);
    console.log(`   Status: ${result.status}`);
    console.log(`   Message: ${result.message}`);
    if (result.tamperedRows?.length) {
      console.log(`   Tampered row IDs: ${result.tamperedRows.map(r => r.id).join(', ')}`);
    }

    // Send email alert if tampered
    if (result.status === 'tampered' && process.env.ADMIN_EMAIL) {
      const tamperedIds = result.tamperedRows.map(r => r.id).join(', ');
      await sendConfirmationEmail(
        process.env.ADMIN_EMAIL,
        '🚨 AUDIT LOG TAMPER DETECTED (Manual Run)',
        `The audit trail hash chain has been broken.\n\nFirst affected row ID: ${result.tamperedRows[0]?.id}\nAll affected IDs: ${tamperedIds}\n\nPlease investigate immediately.`
      );
      console.log('📧 Alert email sent to admin.');
    }

    process.exit(result.status === 'tampered' ? 1 : 0);
  } catch (err) {
    console.error('❌ Audit validation failed:', err);
    process.exit(2);
  } finally {
    await pool.end();
  }
}

main();