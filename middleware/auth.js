const jwt = require('jsonwebtoken');
const { logAuthEvent } = require('../lib/audit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

function getTokenFromHeader(req) {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
}

async function requireAuth(req, res, next) {
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

  const token = getTokenFromHeader(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = {
        id: decoded.id,
        userId: decoded.id,
        role: decoded.role || 'user',
        username: decoded.username,
        email: decoded.username
      };
      return next();
    } catch (err) {
      await logAuthEvent({
        eventType: 'PERMISSION_DENIED',
        userId: null,
        userEmail: null,
        req,
        extraDetails: { reason: 'Invalid JWT', error: err.message }
      });
    }
  }

  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

function authorize(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!allowedRoles.includes(req.user.role)) {
      await logAuthEvent({
        eventType: 'PERMISSION_DENIED',
        userId: req.user.id,
        userEmail: req.user.username,
        req,
        extraDetails: {
          reason: 'Insufficient role',
          required: allowedRoles,
          actual: req.user.role,
          route: req.originalUrl
        }
      });
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

function requirePermission(permissionCode) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

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
        return res.status(403).json({ error: 'Forbidden: missing permission' });
      }
      next();
    } catch (err) {
      console.error('[Permission] Error:', err);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

module.exports = { requireAuth, authorize, requirePermission };