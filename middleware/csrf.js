const crypto = require('crypto');

function generateCsrfToken() {
    return crypto.randomBytes(32).toString('hex');
}

function csrfProtection(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    const token = req.headers['x-csrf-token'] || req.body?._csrf;
    const sessionToken = req.session?.csrfToken;

    if (!token || !sessionToken || token !== sessionToken) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }

    next();
}

function generateCsrfTokenForSession(req) {
    const token = generateCsrfToken();
    if (req.session) {
        req.session.csrfToken = token;
    }
    return token;
}

function getCsrfToken(req) {
    return req.session?.csrfToken || null;
}

module.exports = {
    csrfProtection,
    generateCsrfTokenForSession,
    getCsrfToken
};