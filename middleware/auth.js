const jwt = require('jsonwebtoken');
const { logAuthEvent } = require('../lib/audit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const JWT_EXPIRY = '7d';

// Helper: Extract token from request
function getTokenFromRequest(req) {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  
  // Check cookie
  if (req.cookies?.token) {
    return req.cookies.token;
  }
  
  return null;
}

// Helper: Set user from token
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

// Helper: Verify JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Main authentication middleware
async function requireAuth(req, res, next) {
  // Check session first (backward compatibility)
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

  // Check token from header or cookie
  const token = getTokenFromRequest(req);
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      setUserFromToken(req, decoded);
      
      // Sync session with token if session exists
      if (req.session) {
        req.session.userId = decoded.id;
        req.session.username = decoded.username;
        req.session.role = decoded.role || 'user';
      }
      
      return next();
    }
    
    // Invalid token - clear it
    if (req.cookies?.token) {
      res.clearCookie('token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
      });
    }
    
    await logAuthEvent({
      eventType: 'PERMISSION_DENIED',
      userId: null,
      userEmail: null,
      req,
      extraDetails: { reason: 'Invalid JWT token' }
    });
  }

  // No valid authentication found
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      code: 'UNAUTHORIZED'
    });
  }
  
  // Redirect to login for browser requests
  res.redirect('/login');
}

// Role-based authorization middleware
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

// Permission-based authorization middleware
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

// Middleware to refresh token if it's about to expire
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
    const refreshThreshold = 24 * 60 * 60; // 24 hours

    if (timeLeft < refreshThreshold && timeLeft > 0) {
      // Token is about to expire, issue a new one
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
      
      res.cookie('token', newToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      });
      
      // Also set in response header for clients that use Authorization header
      res.setHeader('X-New-Token', newToken);
    }
  } catch (err) {
    // Silent fail - token refresh is a bonus feature
  }
  
  next();
}

module.exports = { 
  requireAuth, 
  authorize, 
  requirePermission,
  getTokenFromRequest,
  verifyToken,
  refreshTokenIfNeeded
};