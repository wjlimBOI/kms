#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
const { AuditValidator } = require('../lib/auditValidator');
const { AuditNotifier } = require('../lib/auditNotifier');
const logger = require('../lib/logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
    const validator = new AuditValidator(pool, { logger });
    const notifier = new AuditNotifier({ email: process.env.ADMIN_EMAIL, logger });

    try {
        const result = await validator.validateChain();
        if (result.tampered) {
            await notifier.sendTamperAlert(result);
        }
        logger.info('Audit validation completed', { status: result.status });
    } catch (err) {
        logger.error('Audit validation failed', { error: err.message });
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();