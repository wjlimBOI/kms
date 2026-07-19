// scripts/clear-cache.js
const fs = require('fs');
const path = require('path');

console.log('🧹 Clearing cache...');

const publicDir = path.join(__dirname, '..', 'public');
const assetsDir = path.join(publicDir, 'assets');

// Remove all versioned assets
if (fs.existsSync(assetsDir)) {
  const versions = fs.readdirSync(assetsDir);
  versions.forEach(version => {
    const versionPath = path.join(assetsDir, version);
    if (fs.statSync(versionPath).isDirectory()) {
      fs.rmSync(versionPath, { recursive: true, force: true });
      console.log(`🗑️ Removed version: ${version}`);
    }
  });
}

// Remove build info
const buildInfoPath = path.join(__dirname, '..', 'build-info.json');
if (fs.existsSync(buildInfoPath)) {
  fs.unlinkSync(buildInfoPath);
  console.log('🗑️ Removed build-info.json');
}

// Remove build env
const envPath = path.join(__dirname, '..', '.env.build');
if (fs.existsSync(envPath)) {
  fs.unlinkSync(envPath);
  console.log('🗑️ Removed .env.build');
}

console.log('✅ Cache cleared successfully!');
console.log('💡 Run npm run build to rebuild assets');