require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const logger = require('./lib/logger');

const authRoutes = require('./routes/auth').router;
const keysRoutes = require('./routes/keys');
const requestsPublic = require('./routes/requestsPublic');
const adminRoutes = require('./routes/admin');
const returnRoutes = require('./routes/returns');
const userRoutes = require('./routes/user');
const adminUsersRoutes = require('./routes/adminUsers');
const auditRoutes = require('./routes/audit');
const permissionsRoutes = require('./routes/permissions');
const emailSettingsRoutes = require('./routes/emailSettings');
const healthRoutes = require('./routes/health');

const { requireAuth, refreshTokenIfNeeded } = require('./middleware/auth');
const { csrfProtection, generateCsrfTokenForSession, getCsrfToken } = require('./middleware/csrf');
const startReminderCron = require('./cron');

let BUILD_HASH = process.env.BUILD_HASH;
if (!BUILD_HASH) {
  try {
    const envBuildPath = path.join(__dirname, '.env.build');
    if (fs.existsSync(envBuildPath)) {
      const envContent = fs.readFileSync(envBuildPath, 'utf8');
      const match = envContent.match(/BUILD_HASH=([^\n]+)/);
      if (match) BUILD_HASH = match[1];
    }
  } catch (e) {
    BUILD_HASH = crypto.randomBytes(8).toString('hex');
  }
}
if (!BUILD_HASH) BUILD_HASH = crypto.randomBytes(8).toString('hex');
global.BUILD_HASH = BUILD_HASH;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const app = express();
const IS_DEVELOPMENT = process.env.NODE_ENV !== 'production';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.set('trust proxy', IS_PRODUCTION ? 1 : false);

app.use((req, res, next) => {
  const path = req.path;
  if (path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return next();
  }
  const htmlPaths = ['/', '/dashboard', '/admin', '/login', '/change-password', '/privacy-policy'];
  const isHtml = htmlPaths.includes(path) || path.endsWith('.html');
  if (isHtml) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (IS_DEVELOPMENT) res.setHeader('ETag', `"${Date.now()}"`);
    return next();
  }
  if (path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
    const maxAge = IS_PRODUCTION ? '1y' : '1h';
    res.setHeader('Cache-Control', `public, max-age=${IS_PRODUCTION ? 31536000 : 3600}, immutable`);
    res.setHeader('Vary', 'Accept-Encoding');
    return next();
  }
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://cdnjs.cloudflare.com",
        "https://kit.fontawesome.com"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdnjs.cloudflare.com",
        "https://kit.fontawesome.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://cdnjs.cloudflare.com",
        "data:"
      ],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin',
  },
}));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  next();
});

app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/assets/v' + BUILD_HASH, express.static(path.join(__dirname, 'public', 'assets', 'v' + BUILD_HASH), {
  maxAge: IS_PRODUCTION ? '1y' : '1h',
  etag: true,
  lastModified: true,
  immutable: IS_PRODUCTION,
}));

app.use('/css', express.static(path.join(__dirname, 'public', 'css'), {
  maxAge: IS_PRODUCTION ? '1y' : '1h',
  etag: true,
  lastModified: true,
  immutable: IS_PRODUCTION,
}));

app.use('/js', express.static(path.join(__dirname, 'public', 'js'), {
  maxAge: IS_PRODUCTION ? '1y' : '1h',
  etag: true,
  lastModified: true,
  immutable: IS_PRODUCTION,
}));

app.use('/images', express.static(path.join(__dirname, 'public', 'images'), {
  maxAge: IS_PRODUCTION ? '1y' : '1h',
  etag: true,
  lastModified: true,
  immutable: IS_PRODUCTION,
}));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: IS_PRODUCTION ? '1y' : '1h',
  etag: true,
  lastModified: true,
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:3001'];

app.use('/api', cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (IS_DEVELOPMENT && origin.match(/^http:\/\/localhost:\d+$/)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 86400,
}));

const sessionStore = new pgSession({
  pool,
  tableName: 'session',
  pruneSessionInterval: 60,
  createTableIfMissing: true,
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'kms.sid',
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
  },
  rolling: true,
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    generateCsrfTokenForSession(req);
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  csrfProtection(req, res, next);
});

app.use('/api', refreshTokenIfNeeded);

app.get('/api/csrf-token', (req, res) => {
  const token = getCsrfToken(req);
  res.json({ csrfToken: token });
});

app.use((req, res, next) => {
  req.db = pool;
  next();
});

if (IS_DEVELOPMENT) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (!req.path.startsWith('/api/health')) {
        logger.debug(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      }
    });
    next();
  });
}

app.use('/api/auth', authRoutes);
app.use('/api/keys', keysRoutes);
app.use('/api/requests', requestsPublic);
app.use('/api/return', returnRoutes);
app.use('/api/user', userRoutes);
app.use('/api/health', healthRoutes);

app.use('/api/admin', requireAuth, adminRoutes);
app.use('/api/admin/users', requireAuth, adminUsersRoutes);
app.use('/api/admin/email', requireAuth, emailSettingsRoutes);
app.use('/api/audit', requireAuth, auditRoutes);
app.use('/api/permissions', requireAuth, permissionsRoutes);

const sendHtml = (res, filePath, extraHeaders = {}) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  Object.entries(extraHeaders).forEach(([key, value]) => res.setHeader(key, value));
  res.sendFile(path.join(__dirname, 'public', filePath));
};

app.get('/login', (req, res) => {
  if (req.session?.userId || req.cookies?.token) {
    const role = req.session?.role || 'user';
    return res.redirect(role === 'admin' ? '/admin' : '/');
  }
  sendHtml(res, 'login.html', { 'X-Build-Hash': BUILD_HASH });
});

app.get('/', requireAuth, (req, res) => {
  sendHtml(res, 'index.html', { 'X-Build-Hash': BUILD_HASH });
});

app.get('/dashboard', requireAuth, (req, res) => {
  sendHtml(res, 'index.html', { 'X-Build-Hash': BUILD_HASH });
});

app.get('/admin', requireAuth, (req, res) => {
  if (req.user?.role !== 'admin' && req.session.role !== 'admin') {
    return res.status(403).send('Access denied. Admin privileges required.');
  }
  sendHtml(res, 'admin.html', { 'X-Build-Hash': BUILD_HASH });
});

app.get('/change-password', requireAuth, (req, res) => {
  sendHtml(res, 'change-password.html', { 'X-Build-Hash': BUILD_HASH });
});

app.get('/privacy-policy', (req, res) => {
  sendHtml(res, 'privacy-policy.html');
});

app.get(/^\/assets\/v([^\/]+)\/(.*)$/, (req, res) => {
  const requestedHash = req.params[0];
  const filePath = req.params[1];

  if (requestedHash !== BUILD_HASH) {
    return res.redirect(301, `/assets/v${BUILD_HASH}/${filePath}`);
  }

  const fullPath = path.join(__dirname, 'public', filePath);
  res.sendFile(fullPath, {
    maxAge: IS_PRODUCTION ? 31536000000 : 3600000,
    immutable: IS_PRODUCTION,
    lastModified: true,
    etag: true,
  });
});

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    buildHash: BUILD_HASH,
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
    return res.status(404).send('Asset not found');
  }
  if (req.path !== '/login' && !req.path.startsWith('/assets')) {
    return res.redirect('/login');
  }
  sendHtml(res, 'index.html');
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  if (req.path.startsWith('/api/')) {
    res.status(500).json({
      error: 'Internal server error',
      ...(IS_DEVELOPMENT && { details: err.message }),
    });
  } else {
    res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
  }
});

startReminderCron(pool);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`🚀 KMS server running on port ${PORT}`);
  logger.info(`📦 Build hash: ${BUILD_HASH}`);
  logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
});

const shutdown = (signal) => {
  logger.info(`${signal} received – closing server...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    pool.end(() => {
      logger.info('Database connections closed.');
      process.exit(0);
    });
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGQUIT', () => shutdown('SIGQUIT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
  if (!IS_PRODUCTION) process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  if (!IS_PRODUCTION) process.exit(1);
});

module.exports = { app, server, pool, BUILD_HASH };