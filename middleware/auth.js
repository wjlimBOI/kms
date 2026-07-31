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
    '/api/auth/check-session',
    '/api/auth/logout',
    '/api/csrf-token',
    '/change-password',
    '/privacy-policy',
    '/forgot-password',
    '/reset-password',
    '/force-logout'
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
        id: decoded.id || decoded.userId,
        userId: decoded.id || decoded.userId,
        role: decoded.role || 'user',
        username: decoded.username || decoded.email,
        email: decoded.email || decoded.username,
        name: decoded.name || decoded.username || decoded.email,
        permissions: decoded.permissions || []
    };
    req.userId = req.user.id;
    return req.user;
}

function verifyToken(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return { expired: true, error: 'TokenExpiredError' };
        }
        if (err.name === 'JsonWebTokenError') {
            return { invalid: true, error: 'JsonWebTokenError' };
        }
        return null;
    }
}

function decodeToken(token) {
    if (!token) return null;
    try {
        return jwt.decode(token);
    } catch (err) {
        return null;
    }
}

function generateToken(user) {
    const payload = {
        id: user.id || user.userId,
        username: user.username || user.email,
        email: user.email || user.username,
        role: user.role || 'user',
        name: user.name || user.username || user.email
    };
    
    if (user.permissions) {
        payload.permissions = user.permissions;
    }
    
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function clearAuthCookies(res) {
    const isProduction = process.env.NODE_ENV === 'production';
    const domain = process.env.COOKIE_DOMAIN || undefined;
    
    const clearOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
    };
    
    res.clearCookie('token', clearOptions);
    if (domain) {
        res.clearCookie('token', { ...clearOptions, domain });
        res.clearCookie('token', { ...clearOptions, domain: domain.replace(/^\./, '') });
    }
    
    res.clearCookie('kms.sid', clearOptions);
    if (domain) {
        res.clearCookie('kms.sid', { ...clearOptions, domain });
        res.clearCookie('kms.sid', { ...clearOptions, domain: domain.replace(/^\./, '') });
    }
    
    ['token', 'kms.sid', 'auth_token', 'session'].forEach(cookie => {
        res.clearCookie(cookie, clearOptions);
        if (domain) {
            res.clearCookie(cookie, { ...clearOptions, domain });
        }
    });
}

function setAuthCookie(res, token) {
    const isProduction = process.env.NODE_ENV === 'production';
    const domain = process.env.COOKIE_DOMAIN || undefined;
    
    res.cookie('token', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
        domain: domain
    });
}

function getUpdatedBy(req) {
    if (!req.user) return 'system';
    return req.user.name || req.user.username || req.user.email || req.user.id || 'system';
}

function getUserId(req) {
    return req.user?.id || req.user?.userId || null;
}

function getUserRole(req) {
    return req.user?.role || 'user';
}

function isAuthenticated(req) {
    return !!(req.user || req.session?.userId);
}

async function blockIfReadOnly(req, res, next) {
    try {
        if (!req.user || !req.user.role) {
            return next();
        }

        const db = req.db;
        if (!db) {
            console.error('[blockIfReadOnly] Database connection not available');
            return next();
        }

        const result = await db.query(
            `SELECT 1 FROM role_permissions rp
             JOIN permissions p ON p.permission_id = rp.permission_id
             WHERE rp.role_name = $1 AND p.permission_code = 'view_all'`,
            [req.user.role]
        );
        
        if (result.rowCount > 0) {
            return res.status(403).json({ 
                error: 'Read-only access. You cannot perform this action.' 
            });
        }
        next();
    } catch (error) {
        console.error('[blockIfReadOnly] Error checking read-only status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
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
            email: req.session.username,
            name: req.session.name || req.session.username,
            permissions: req.session.permissions || []
        };
        req.userId = req.session.userId;
        return next();
    }

    const token = getTokenFromRequest(req);
    if (token) {
        const decoded = verifyToken(token);
        
        if (decoded && !decoded.expired && !decoded.invalid) {
            setUserFromToken(req, decoded);
            
            if (req.session) {
                req.session.userId = decoded.id || decoded.userId;
                req.session.username = decoded.username || decoded.email;
                req.session.role = decoded.role || 'user';
                req.session.name = decoded.name || decoded.username || decoded.email;
                req.session.permissions = decoded.permissions || [];
            }
            
            return next();
        }
        
        if (decoded?.expired) {
            clearAuthCookies(res);
            await logAuthEvent({
                eventType: 'TOKEN_EXPIRED',
                userId: null,
                userEmail: null,
                req,
                extraDetails: { 
                    reason: 'JWT token expired',
                    path: req.path
                }
            });
        }
        
        if (decoded?.invalid) {
            clearAuthCookies(res);
            await logAuthEvent({
                eventType: 'INVALID_TOKEN',
                userId: null,
                userEmail: null,
                req,
                extraDetails: { 
                    reason: 'Invalid JWT token',
                    path: req.path
                }
            });
        }
    }

    if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/')) {
        return res.status(401).json({ 
            error: 'Unauthorized',
            code: 'UNAUTHORIZED',
            message: 'Authentication required'
        });
    }
    
    res.redirect('/login?t=' + Date.now());
}

function optionalAuth(req, res, next) {
    if (req.session?.userId) {
        req.user = {
            id: req.session.userId,
            userId: req.session.userId,
            role: req.session.role || 'user',
            username: req.session.username,
            email: req.session.username,
            name: req.session.name || req.session.username,
            permissions: req.session.permissions || []
        };
        req.userId = req.session.userId;
        return next();
    }

    const token = getTokenFromRequest(req);
    if (token) {
        const decoded = verifyToken(token);
        if (decoded && !decoded.expired && !decoded.invalid) {
            setUserFromToken(req, decoded);
        }
    }
    next();
}

function authorize(...allowedRoles) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ 
                error: 'Unauthorized',
                code: 'UNAUTHORIZED',
                message: 'Authentication required'
            });
        }
        
        const userRole = req.user.role;
        
        if (userRole === 'superadmin') {
            return next();
        }
        
        if (!allowedRoles.includes(userRole)) {
            await logAuthEvent({
                eventType: 'PERMISSION_DENIED',
                userId: req.user.id,
                userEmail: req.user.username || req.user.email,
                req,
                extraDetails: {
                    reason: 'Insufficient role',
                    required: allowedRoles,
                    actual: userRole,
                    route: req.originalUrl,
                    method: req.method
                }
            });
            
            return res.status(403).json({ 
                error: 'Forbidden: insufficient role',
                code: 'FORBIDDEN',
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
            return res.status(401).json({ 
                error: 'Unauthorized',
                code: 'UNAUTHORIZED'
            });
        }

        if (req.user.role === 'superadmin') {
            return next();
        }

        if (req.user.permissions && req.user.permissions.includes(permissionCode)) {
            return next();
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
                    userEmail: req.user.username || req.user.email,
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
                    code: 'FORBIDDEN',
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

async function userHasPermission(db, role, permissionCode) {
    try {
        const result = await db.query(
            `SELECT 1
             FROM role_permissions rp
             JOIN permissions p ON p.permission_id = rp.permission_id
             WHERE rp.role_name = $1 AND p.permission_code = $2`,
            [role, permissionCode]
        );
        return result.rowCount > 0;
    } catch (err) {
        console.error('[Permission] Check error:', err);
        return false;
    }
}

async function userHasAnyPermission(db, role, permissionCodes) {
    if (!permissionCodes || permissionCodes.length === 0) return false;
    
    try {
        const result = await db.query(
            `SELECT 1
             FROM role_permissions rp
             JOIN permissions p ON p.permission_id = rp.permission_id
             WHERE rp.role_name = $1 AND p.permission_code = ANY($2)
             LIMIT 1`,
            [role, permissionCodes]
        );
        return result.rowCount > 0;
    } catch (err) {
        console.error('[Permission] Check error:', err);
        return false;
    }
}

function refreshTokenIfNeeded(req, res, next) {
    if (!req.user) {
        return next();
    }

    const token = getTokenFromRequest(req);
    if (!token) {
        return next();
    }

    try {
        const decoded = decodeToken(token);
        if (!decoded || !decoded.exp) {
            return next();
        }

        const now = Math.floor(Date.now() / 1000);
        const timeLeft = decoded.exp - now;
        const refreshThreshold = 24 * 60 * 60;

        if (timeLeft < refreshThreshold && timeLeft > 0) {
            const newToken = generateToken(req.user);
            setAuthCookie(res, newToken);
            res.setHeader('X-Refresh-Token', newToken);
            res.setHeader('X-Token-Refreshed', 'true');
        }
    } catch (err) {
        // Silent fail
    }
    
    next();
}

function loginSuccess(req, res, user, additionalData = {}) {
    const token = generateToken(user);
    setAuthCookie(res, token);
    
    if (req.session) {
        req.session.userId = user.id || user.userId;
        req.session.username = user.username || user.email;
        req.session.role = user.role || 'user';
        req.session.name = user.name || user.username || user.email;
        req.session.permissions = user.permissions || [];
    }
    
    logAuthEvent({
        eventType: 'LOGIN_SUCCESS',
        userId: user.id || user.userId,
        userEmail: user.email || user.username,
        req,
        extraDetails: {
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            ...additionalData
        }
    }).catch(() => {});
    
    return token;
}

async function logout(req, res) {
    const userId = req.user?.id || req.session?.userId;
    const userEmail = req.user?.email || req.user?.username || req.session?.username;
    
    await logAuthEvent({
        eventType: 'LOGOUT',
        userId: userId,
        userEmail: userEmail,
        req,
        extraDetails: {
            ip: req.ip,
            userAgent: req.headers['user-agent']
        }
    }).catch(() => {});
    
    clearAuthCookies(res);
    
    if (req.session) {
        req.session.destroy(() => {});
    }
    
    delete req.user;
    delete req.userId;
}

module.exports = {
    requireAuth,
    optionalAuth,
    authorize,
    requirePermission,
    blockIfReadOnly,
    refreshTokenIfNeeded,
    isPublicPath,
    getTokenFromRequest,
    verifyToken,
    decodeToken,
    generateToken,
    setUserFromToken,
    setAuthCookie,
    clearAuthCookies,
    getUpdatedBy,
    getUserId,
    getUserRole,
    isAuthenticated,
    loginSuccess,
    logout,
    userHasPermission,
    userHasAnyPermission,
    JWT_SECRET,
    JWT_EXPIRY,
    PUBLIC_PATHS
};