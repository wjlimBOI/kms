module.exports = {
  apps: [
    {
      name: 'kms-staging',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'staging',
        PORT: 3001
      },
      error_file: './logs/staging-error.log',
      out_file: './logs/staging-out.log',
      log_file: './logs/staging-combined.log',
      time: true
    },
    {
      name: 'kms-production',
      script: 'server.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: './logs/production-error.log',
      out_file: './logs/production-out.log',
      log_file: './logs/production-combined.log',
      time: true,
      max_memory_restart: '1G'
    }
  ]
};
