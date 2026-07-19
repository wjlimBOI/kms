// cron.js
const cron = require('node-cron');
const config = require('./config'); // your config/index.js
const ReminderService = require('./services/reminderService');
const AuditValidator = require('./lib/auditValidator'); // your validator class
const { sendConfirmationEmail } = require('./services/emailService');

// Default logger – replace with your structured logger if available
const logger = console;

/**
 * Start all scheduled cron jobs
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {Object} emailService - not directly used, but available
 */
function startCron(pool, emailService) {
  // ----- 1. Daily Reminders (9 AM) -----
  cron.schedule(config.cron.reminders, async () => {
    logger.info('⏰ Running reminder cron job');
    try {
      const reminderService = new ReminderService(pool, {
        logger,
        config: config.reminders,
        adminEmail: process.env.ADMIN_EMAIL
      });
      const stats = await reminderService.processReminders();
      logger.info('✅ Reminders processed', stats);
    } catch (err) {
      logger.error('❌ Reminder cron failed:', err);
    }
  });

  // ----- 2. Audit Chain Validation (2 AM) -----
  cron.schedule(config.cron.audit, async () => {
    logger.info('🔍 Running audit chain validation');
    try {
      const validator = new AuditValidator(pool, {
        logger,
        algorithm: config.audit.hashAlgorithm || 'sha256'
      });

      const result = await validator.validateChain();

      logger.info(`Audit validation completed: ${result.status}`, {
        duration: result.duration,
        tamperedCount: result.tamperedRows?.length || 0
      });

      // If tampering detected, send an alert email
      if (result.status === 'tampered' && process.env.ADMIN_EMAIL) {
        const tamperedIds = result.tamperedRows.map(r => r.id).join(', ');
        await sendConfirmationEmail(
          process.env.ADMIN_EMAIL,
          '🚨 AUDIT LOG TAMPER DETECTED',
          `The audit trail hash chain has been broken.\n\nFirst affected row ID: ${result.tamperedRows[0]?.id}\nAll affected IDs: ${tamperedIds}\n\nPlease investigate immediately.`
        );
        logger.warn('⚠️ Tamper alert email sent to admin');
      }
    } catch (err) {
      logger.error('❌ Audit validation cron failed:', err);
      // Optionally notify admin of cron failure
      if (process.env.ADMIN_EMAIL) {
        await sendConfirmationEmail(
          process.env.ADMIN_EMAIL,
          '⚠️ Audit Validation Cron Failed',
          `The audit validation cron job failed with error:\n\n${err.message}\n\nPlease check the server logs.`
        ).catch(e => logger.error('Failed to send failure alert:', e));
      }
    }
  });

  logger.info(`✅ Cron jobs scheduled:
    - Reminders: ${config.cron.reminders}
    - Audit validation: ${config.cron.audit}
  `);
}

module.exports = startCron;