// config/default.js
module.exports = {
  // Cron schedule (cron expressions)
  cron: {
    reminders: '0 9 * * *',   // 9 AM daily (Singapore time)
    audit: '0 2 * * *'        // 2 AM daily
  },

  // Reminder settings
  reminders: {
    dueThresholdDays: 7,           // Not currently used – reserved for early warnings
    maxEmailsPerBatch: 100,        // Limit to avoid SMTP rate limits
    retryAttempts: 3,              // Number of retries for failed emails
    retryDelayMs: 1000,            // Base delay for exponential backoff (1s, 2s, 4s)
    adminSummaryEnabled: true,     // Send daily admin summary
  },

  // Audit chain validation
  audit: {
    hashAlgorithm: 'sha256',
    alertEmail: process.env.ADMIN_EMAIL || 'admin@example.com'
  },

  // Email sender addresses
  email: {
    from: `"BOI Key Management" <${process.env.EMAIL_USER || 'noreply@example.com'}>`,
    adminFrom: `"BOI Key Management Admin" <${process.env.EMAIL_USER || 'noreply@example.com'}>`
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info'
  }
};