#!/bin/bash
# scripts/deploy-production.sh

echo "🚀 Deploying to PRODUCTION..."

# Load environment
export NODE_ENV=production

# Pull latest code
git pull origin main

# Install production dependencies only
npm install --production

# Build assets
npm run build:all

# Run database migrations
npm run migrate:production

# Restart PM2 process (if using PM2)
pm2 restart kms-production || pm2 start ecosystem.config.js --only kms-production

echo "✅ Production deployment complete!"
