// scripts/build.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Generate build hash
const BUILD_HASH = crypto.randomBytes(8).toString('hex');
const BUILD_TIMESTAMP = new Date().toISOString();
const VERSION = process.env.npm_package_version || '1.0.0';

console.log(`🔨 Building KMS v${VERSION}...`);
console.log(`📦 Build Hash: ${BUILD_HASH}`);
console.log(`🕐 Timestamp: ${BUILD_TIMESTAMP}`);

// Directories
const publicDir = path.join(__dirname, '..', 'public');
const buildInfoPath = path.join(__dirname, '..', 'build-info.json');

// Files to process with build hash
const htmlFiles = ['index.html', 'admin.html', 'login.html', 'change-password.html'];

// Create build-info.json
const buildInfo = {
  version: VERSION,
  buildHash: BUILD_HASH,
  timestamp: BUILD_TIMESTAMP,
  environment: process.env.NODE_ENV || 'development',
  assets: {
    css: `/assets/v${BUILD_HASH}/css/style.css`,
    js: `/assets/v${BUILD_HASH}/js/main.js`,
    index: `/assets/v${BUILD_HASH}/index.html`,
    admin: `/assets/v${BUILD_HASH}/admin.html`,
  }
};

fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));
console.log(`✅ Build info saved to build-info.json`);

// Process HTML files
htmlFiles.forEach(file => {
  const filePath = path.join(publicDir, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Replace build hash placeholders
    content = content.replace(/\{\{BUILD_HASH\}\}/g, BUILD_HASH);
    content = content.replace(/\{\{VERSION\}\}/g, VERSION);
    content = content.replace(/\{\{TIMESTAMP\}\}/g, BUILD_TIMESTAMP);
    
    // Add meta tags for cache control
    const metaTags = `
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <meta name="build-hash" content="${BUILD_HASH}" />
    <meta name="build-version" content="${VERSION}" />`;
    
    // Insert meta tags after the charset meta tag
    content = content.replace(
      /<meta charset="[^"]*" \/>/,
      `<meta charset="UTF-8" />${metaTags}`
    );
    
    fs.writeFileSync(filePath, content);
    console.log(`✅ Updated ${file} with build hash: ${BUILD_HASH}`);
  } else {
    console.log(`⚠️ ${file} not found, skipping`);
  }
});

// Create versioned asset directory structure
const assetsDir = path.join(publicDir, `assets`, `v${BUILD_HASH}`);
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
  console.log(`✅ Created asset directory: ${assetsDir}`);
}

// Copy CSS files to versioned directory
const cssDir = path.join(publicDir, 'css');
if (fs.existsSync(cssDir)) {
  const targetCssDir = path.join(assetsDir, 'css');
  if (!fs.existsSync(targetCssDir)) {
    fs.mkdirSync(targetCssDir, { recursive: true });
  }
  // Copy all CSS files
  const cssFiles = fs.readdirSync(cssDir);
  cssFiles.forEach(file => {
    if (file.endsWith('.css')) {
      const src = path.join(cssDir, file);
      const dest = path.join(targetCssDir, file);
      fs.copyFileSync(src, dest);
      console.log(`✅ Copied CSS: ${file} → assets/v${BUILD_HASH}/css/${file}`);
    }
  });
}

// Copy JS files to versioned directory
const jsDir = path.join(publicDir, 'js');
if (fs.existsSync(jsDir)) {
  const targetJsDir = path.join(assetsDir, 'js');
  if (!fs.existsSync(targetJsDir)) {
    fs.mkdirSync(targetJsDir, { recursive: true });
  }
  // Copy all JS files
  const jsFiles = fs.readdirSync(jsDir);
  jsFiles.forEach(file => {
    if (file.endsWith('.js')) {
      const src = path.join(jsDir, file);
      const dest = path.join(targetJsDir, file);
      fs.copyFileSync(src, dest);
      console.log(`✅ Copied JS: ${file} → assets/v${BUILD_HASH}/js/${file}`);
    }
  });
}

// Copy root CSS files (index.css, etc.)
const rootFiles = ['index.css', 'style.css'];
rootFiles.forEach(file => {
  const src = path.join(publicDir, file);
  if (fs.existsSync(src)) {
    const dest = path.join(assetsDir, file);
    fs.copyFileSync(src, dest);
    console.log(`✅ Copied root CSS: ${file} → assets/v${BUILD_HASH}/${file}`);
  }
});

// Update environment file with build hash
const envPath = path.join(__dirname, '..', '.env.build');
fs.writeFileSync(envPath, `BUILD_HASH=${BUILD_HASH}\nBUILD_TIMESTAMP=${BUILD_TIMESTAMP}\n`);
console.log(`✅ Build environment saved to .env.build`);

// Generate a manifest file for service workers (if needed)
const manifest = {
  version: VERSION,
  buildHash: BUILD_HASH,
  assets: {
    css: `/assets/v${BUILD_HASH}/css/style.css`,
    js: `/assets/v${BUILD_HASH}/js/main.js`,
  },
  urls: [
    `/assets/v${BUILD_HASH}/index.html`,
    `/assets/v${BUILD_HASH}/admin.html`,
  ]
};

fs.writeFileSync(
  path.join(publicDir, 'asset-manifest.json'),
  JSON.stringify(manifest, null, 2)
);
console.log(`✅ Asset manifest created`);

console.log(`\n🎉 Build completed successfully!`);
console.log(`📦 Build Hash: ${BUILD_HASH}`);
console.log(`🚀 Ready for deployment`);