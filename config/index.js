// config/index.js
const defaultConfig = require('./default');
let envConfig = {};

try {
  if (process.env.NODE_ENV === 'production') {
    envConfig = require('./production');
  } else if (process.env.NODE_ENV === 'staging') {
    envConfig = require('./staging'); // optional
  }
} catch (err) {
  // No environment-specific config – use defaults
}

// Deep merge (simple version – override top-level keys)
module.exports = {
  ...defaultConfig,
  ...envConfig,
  // If you have nested objects, merge them manually
  cron: { ...defaultConfig.cron, ...envConfig.cron },
  reminders: { ...defaultConfig.reminders, ...envConfig.reminders },
  audit: { ...defaultConfig.audit, ...envConfig.audit },
  email: { ...defaultConfig.email, ...envConfig.email },
  logging: { ...defaultConfig.logging, ...envConfig.logging }
};