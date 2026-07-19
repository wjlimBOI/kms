// lib/metrics.js
const statsd = require('node-statsd');

const metrics = new statsd({
    host: process.env.STATSD_HOST || 'localhost',
    port: parseInt(process.env.STATSD_PORT) || 8125
});

// Usage
metrics.increment('audit.validation.run');
metrics.timing('audit.validation.duration', duration);
metrics.gauge('audit.reminders.sent', count);