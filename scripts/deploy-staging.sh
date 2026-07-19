#!/bin/bash
# scripts/deploy-staging.sh

echo "🚀 Deploying to STAGING (UAT)..."

# Load environment
export NODE_ENV=staging

# Pull latest code
git pull origin staging

# Install dependencies
npm install

# Build assets
npm run build:all

# Run database migrations
npm run migrate:staging

# Restart PM2 process (if using PM2)
pm2 restart kms-staging || pm2 start ecosystem.config.js --only kms-staging

echo "✅ Staging deployment complete!"
