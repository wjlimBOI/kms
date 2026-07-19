// config/production.js
module.exports = {
  cron: {
    reminders: '0 9 * * *',   // 9 AM daily
    audit: '0 2 * * *'        // 2 AM daily
  },
  reminders: {
    maxEmailsPerBatch: 200,      // Larger batch size in production
    retryAttempts: 5,            // More retries for reliability
    retryDelayMs: 2000,          // Slower backoff to respect rate limits
  },
  audit: {
    hashAlgorithm: 'sha256',
    alertEmail: process.env.ADMIN_EMAIL,  // Must be set in env
  },
  logging: {
    level: 'warn'                // Reduce log noise in production
  }
};