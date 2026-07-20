const jwt = require('jsonwebtoken');
const { logAuthEvent } = require('../lib/audit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const JWT_EXPIRY = '7d';

const PUBLIC_PATHS = [
  '/login',
  '/css/',
  '/js/',
  '/assets/',
  '/images/',
  '/favicon.ico',
  '/robots.txt',
  '/health',
  '/api/auth/login',
  '/api/auth/request-otp',
  '/api/auth/verify-otp',
  '/api/auth/register-request',
  '/api/auth/validate-password-token',
  '/api/auth/set-password-from-token',
  '/api/csrf-token',
  '/change-password',
  '/privacy-policy'
];

function isPublicPath(path) {
  return PUBLIC_PATHS.some(publicPath => 
    path === publicPath || path.startsWith(publicPath)
  );
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  
  if (req.cookies?.token) {
    return req.cookies.token;
  }
  
  return null;
}

function setUserFromToken(req, decoded) {
  req.user = {
    id: decoded.id,
    userId: decoded.id,
    role: decoded.role || 'user',
    username: decoded.username,
    email: decoded.email || decoded.username,
    name: decoded.name || decoded.username
  };
  return req.user;
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function clearAuthCookies(res) {
  const isProduction = process.env.NODE_ENV === 'production';
  const domain = process.env.COOKIE_DOMAIN || undefined;
  
  // Clear token cookie with all possible variations
  res.clearCookie('token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/'
  });
  if (domain) {
    res.clearCookie('token', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      domain: domain
    });
  }
  
  // Clear session cookie with all possible variations
  res.clearCookie('kms.sid', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/'
  });
  if (domain) {
    res.clearCookie('kms.sid', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      domain: domain
    });
  }
  
  // Also clear any other potential auth cookies
  res.clearCookie('token', {
    path: '/',
    secure: isProduction,
    sameSite: 'lax'
  });
  res.clearCookie('kms.sid', {
    path: '/',
    secure: isProduction,
    sameSite: 'lax'
  });
}

async function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) {
    return next();
  }

  if (req.session?.userId) {
    req.user = {
      id: req.session.userId,
      userId: req.session.userId,
      role: req.session.role || 'user',
      username: req.session.username,
      email: req.session.username
    };
    return next();
  }

  const token = getTokenFromRequest(req);
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      setUserFromToken(req, decoded);
      
      if (req.session) {
        req.session.userId = decoded.id;
        req.session.username = decoded.username;
        req.session.role = decoded.role || 'user';
      }
      
      return next();
    }
    
    // Token is invalid - clear all auth cookies
    if (req.cookies?.token) {
      clearAuthCookies(res);
    }
    
    await logAuthEvent({
      eventType: 'PERMISSION_DENIED',
      userId: null,
      userEmail: null,
      req,
      extraDetails: { 
        reason: 'Invalid JWT token',
        path: req.path
      }
    });
  }

  // For API requests, return 401 JSON
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      code: 'UNAUTHORIZED'
    });
  }
  
  // For HTML requests, redirect to login with cache-busting
  res.redirect('/login?t=' + Date.now());
}

function authorize(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const userRole = req.user.role;
    if (!allowedRoles.includes(userRole)) {
      await logAuthEvent({
        eventType: 'PERMISSION_DENIED',
        userId: req.user.id,
        userEmail: req.user.username,
        req,
        extraDetails: {
          reason: 'Insufficient role',
          required: allowedRoles,
          actual: userRole,
          route: req.originalUrl
        }
      });
      return res.status(403).json({ 
        error: 'Forbidden: insufficient role',
        required: allowedRoles,
        actual: userRole
      });
    }
    next();
  };
}

function requirePermission(permissionCode) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const db = req.db;
      if (!db) {
        console.error('[Permission] Database connection not available');
        return res.status(500).json({ error: 'Permission check failed' });
      }

      const result = await db.query(
        `SELECT 1
         FROM role_permissions rp
         JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE rp.role_name = $1 AND p.permission_code = $2`,
        [req.user.role, permissionCode]
      );
      
      if (result.rowCount === 0) {
        await logAuthEvent({
          eventType: 'PERMISSION_DENIED',
          userId: req.user.id,
          userEmail: req.user.username,
          req,
          extraDetails: {
            reason: 'Missing permission',
            required: permissionCode,
            role: req.user.role,
            route: req.originalUrl
          }
        });
        return res.status(403).json({ 
          error: 'Forbidden: missing permission',
          required: permissionCode,
          actual: req.user.role
        });
      }
      next();
    } catch (err) {
      console.error('[Permission] Error:', err);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

function refreshTokenIfNeeded(req, res, next) {
  if (!req.user || !req.cookies?.token) {
    return next();
  }

  try {
    const decoded = jwt.decode(req.cookies.token);
    if (!decoded || !decoded.exp) {
      return next();
    }

    const now = Math.floor(Date.now() / 1000);
    const timeLeft = decoded.exp - now;
    const refreshThreshold = 24 * 60 * 60;

    if (timeLeft < refreshThreshold && timeLeft > 0) {
      const newToken = jwt.sign(
        {
          id: req.user.id,
          username: req.user.username,
          role: req.user.role,
          email: req.user.email,
          name: req.user.name
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );
      
      const isProduction = process.env.NODE_ENV === 'production';
      const domain = process.env.COOKIE_DOMAIN || undefined;
      
      res.cookie('token', newToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
        domain: domain
      });
      
      res.setHeader('X-New-Token', newToken);
    }
  } catch (err) {
    // Silent fail
  }
  
  next();
}

module.exports = { 
  requireAuth, 
  authorize, 
  requirePermission,
  getTokenFromRequest,
  verifyToken,
  refreshTokenIfNeeded,
  isPublicPath,
  clearAuthCookies
};