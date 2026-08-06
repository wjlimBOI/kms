const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { sendOtpEmail, generateOtp, sendWelcomeEmail, sendAdminRegistrationAlert } = require('../services/emailService');
const { logAuthEvent, logUpdate, logInsert } = require('../lib/audit');
const logger = require('../lib/logger');
const { requireAuth, authorize } = require('../middleware/auth');
const { validatePasswordComplexity } = require('../lib/passwordValidator');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
}

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;
const JWT_EXPIRY = '7d';
const SESSION_EXPIRY = 7 * 24 * 60 * 60 * 1000;

const APP_URL = process.env.APP_URL ||
    (process.env.NODE_ENV === 'production'
        ? 'https://kms-staging.onrender.com'
        : 'http://localhost:3000');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts. Please try again later.' },
    skipSuccessfulRequests: true,
});

const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: { error: 'Too many OTP requests. Please try again later.' }
});

const registrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: 'Too many registration requests. Please try again later.' },
    skipSuccessfulRequests: false,
});

const verifiedSessions = new Map();

const USER_ROLES = ['admin', 'manager', 'user', 'viewer', 'auditor'];
const DEFAULT_ROLE = 'user';

function getCookieDomain() {
    const nodeEnv = process.env.NODE_ENV || 'development';
    const domain = process.env.COOKIE_DOMAIN;

    if (nodeEnv === 'development' || nodeEnv === 'localhost') {
        return undefined;
    }

    if (domain) {
        if (!domain.startsWith('.') && domain !== 'localhost') {
            return '.' + domain;
        }
        return domain;
    }

    return undefined;
}

function setAuthCookie(res, token) {
    const isProduction = process.env.NODE_ENV === 'production';
    const domain = getCookieDomain();

    const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: SESSION_EXPIRY,
        path: '/',
    };

    if (domain && domain !== 'localhost' && !domain.includes('localhost')) {
        cookieOptions.domain = domain;
    }

    res.cookie('token', token, cookieOptions);
}

function clearAuthCookie(res) {
    const isProduction = process.env.NODE_ENV === 'production';
    const domain = getCookieDomain();

    const clearOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
    };

    res.clearCookie('token', clearOptions);
    res.clearCookie('kms.sid', clearOptions);

    if (domain && domain !== 'localhost' && !domain.includes('localhost')) {
        const domainOptions = { ...clearOptions, domain: domain };
        res.clearCookie('token', domainOptions);
        res.clearCookie('kms.sid', domainOptions);

        const domainWithoutDot = domain.startsWith('.') ? domain.substring(1) : domain;
        if (domainWithoutDot !== domain) {
            const noDotOptions = { ...clearOptions, domain: domainWithoutDot };
            res.clearCookie('token', noDotOptions);
            res.clearCookie('kms.sid', noDotOptions);
        }
    }
}

function generateSecurePassword(length) {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const special = '!@#$%^&*()_+-=';
    const all = upper + lower + digits + special;

    const randomBytes = crypto.randomBytes(length);
    let password = '';

    password += upper[randomBytes[0] % upper.length];
    password += lower[randomBytes[1] % lower.length];
    password += digits[randomBytes[2] % digits.length];
    password += special[randomBytes[3] % special.length];

    for (let i = 4; i < length; i++) {
        password += all[randomBytes[i % randomBytes.length] % all.length];
    }

    return password.split('').sort(() => crypto.randomBytes(1)[0] > 127 ? 1 : -1).join('');
}

async function generateUniqueUsername(db, base) {
    let candidate = base.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (!candidate || candidate.length < 3) {
        candidate = 'user_' + Date.now().toString(36);
    }

    let unique = false;
    let attempts = 0;
    let final = candidate;

    while (!unique && attempts < 20) {
        const check = await db.query(
            `SELECT id FROM users WHERE username = $1
             UNION
             SELECT id FROM pending_users WHERE username = $1`,
            [final]
        );
        if (check.rows.length === 0) {
            unique = true;
        } else {
            attempts++;
            final = candidate + attempts;
        }
    }

    if (!unique) {
        final = candidate + '_' + Date.now().toString(36);
    }

    return final;
}

async function createUser(db, userData, options = {}) {
    const {
        source = 'admin',
        sendEmail = true,
        auditUser = null,
        req = null
    } = options;

    const { name, email, username, role = DEFAULT_ROLE, status = 'active' } = userData;

    if (!name || !email) {
        throw new Error('Name and email are required');
    }

    if (!email.includes('@')) {
        throw new Error('Invalid email address');
    }

    const existing = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
        throw new Error('User with this email already exists');
    }

    if (role && !USER_ROLES.includes(role)) {
        throw new Error(`Invalid role: ${role}. Must be one of: ${USER_ROLES.join(', ')}`);
    }

    const finalUsername = await generateUniqueUsername(db, username || email.split('@')[0]);

    const tempPassword = generateSecurePassword(16);
    const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

    const result = await db.query(
        `INSERT INTO users (name, email, username, password_hash, role, status, must_change_password, created_at, updated_at, last_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
         RETURNING id, name, email, username, role, status, created_at, must_change_password`,
        [name, email.toLowerCase(), finalUsername, hashedPassword, role, status, true]
    );

    const newUser = result.rows[0];

    if (sendEmail) {
        try {
            const changePasswordLink = `${APP_URL}/change-password`;
            await sendWelcomeEmail(email, finalUsername, tempPassword, changePasswordLink);
            logger.info(`Welcome email sent to ${email} with username ${finalUsername}`);
        } catch (emailErr) {
            logger.error('Failed to send welcome email:', emailErr);
        }
    }

    await logInsert({
        targetType: 'users',
        targetId: newUser.id,
        newData: {
            name,
            email,
            username: finalUsername,
            role,
            status,
            source: source || 'admin'
        },
        userId: auditUser?.id || null,
        userEmail: auditUser?.email || null,
        req: req || null,
        extraDetails: {
            action: 'create_user',
            source: source || 'admin',
            has_temp_password: true
        }
    });

    return {
        ...newUser,
        temporary_password: tempPassword
    };
}

function validateSession(token, res) {
    const session = verifiedSessions.get(token);
    if (!session) {
        logger.warn('Invalid session token', { token: token?.substring(0, 8) + '...' });
        res.status(401).json({ error: 'Invalid or expired session' });
        return null;
    }
    return session.email;
}

// OTP ROUTES
router.post('/request-otp', otpLimiter, async (req, res) => {
    const { email } = req.body;
    logger.info('OTP request', { email: email?.substring(0, 3) + '***' });

    if (!email || !email.includes('@')) {
        logger.warn('Invalid OTP request', { email });
        return res.status(400).json({ error: 'Valid email required' });
    }

    const code = generateOtp();
    const db = req.db;
    try {
        await db.query(
            `INSERT INTO otp_codes (email, code) VALUES ($1, $2)
             ON CONFLICT (email, code) DO UPDATE SET code = EXCLUDED.code, created_at = NOW(), used = false`,
            [email, code]
        );
        await sendOtpEmail(email, code);
        logger.info('OTP sent', { email: email.substring(0, 3) + '***' });
        res.json({ message: 'OTP sent to email' });
    } catch (err) {
        logger.error('OTP send failed', { error: err.message });
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

router.post('/verify-otp', otpLimiter, async (req, res) => {
    const { email, code } = req.body;
    const db = req.db;
    try {
        const result = await db.query(
            `SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND used = false
             AND created_at > NOW() - INTERVAL '10 minutes'`,
            [email, code]
        );
        if (result.rowCount === 0) {
            logger.warn('OTP verification failed', { email: email?.substring(0, 3) + '***' });
            return res.status(401).json({ error: 'Invalid or expired OTP' });
        }
        await db.query(`UPDATE otp_codes SET used = true WHERE email = $1 AND code = $2`, [email, code]);
        const sessionToken = crypto.randomBytes(16).toString('hex');
        verifiedSessions.set(sessionToken, { email, timestamp: Date.now() });
        setTimeout(() => verifiedSessions.delete(sessionToken), 10 * 60 * 1000);
        logger.info('OTP verified', { email: email?.substring(0, 3) + '***' });
        res.json({ session_token: sessionToken });
    } catch (err) {
        logger.error('OTP verify error', { error: err.message });
        res.status(500).json({ error: 'Verification failed' });
    }
});

// REGISTRATION ROUTES
router.post('/check-registration-status', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const db = req.db;

        const result = await db.query(
            `SELECT id, status FROM pending_users 
             WHERE email = $1 AND status = 'pending'`,
            [email]
        );

        const userCheck = await db.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );

        res.json({
            hasPending: result.rowCount > 0,
            requestId: result.rowCount > 0 ? result.rows[0].id : null,
            isRegistered: userCheck.rowCount > 0
        });
    } catch (error) {
        console.error('Check registration error:', error);
        res.status(500).json({ error: 'Failed to check registration status' });
    }
});

router.post('/register-request', registrationLimiter, async (req, res) => {
    const { name, email, username } = req.body;
    const db = req.db;

    if (!name || !email) {
        return res.status(400).json({ error: 'Name and email are required.' });
    }
    if (!email.includes('@')) {
        return res.status(400).json({ error: 'Invalid email address.' });
    }

    try {
        const userCheck = await db.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        if (userCheck.rowCount > 0) {
            return res.status(400).json({ error: 'Email already registered. Please login.' });
        }

        const existingPending = await db.query(
            'SELECT id, status FROM pending_users WHERE email = $1',
            [email]
        );

        if (existingPending.rowCount > 0) {
            const record = existingPending.rows[0];
            if (record.status === 'pending') {
                return res.status(400).json({ error: 'You already have a pending request. Please wait for admin approval.' });
            }
            await db.query(
                'DELETE FROM pending_users WHERE email = $1',
                [email]
            );
            logger.info('Cleaned up existing pending record for re-registration', {
                email,
                old_status: record.status
            });
        }

        const finalUsername = await generateUniqueUsername(db, username || email.split('@')[0]);

        const result = await db.query(
            `INSERT INTO pending_users (name, email, username, status, created_at, updated_at)
             VALUES ($1, $2, $3, 'pending', NOW(), NOW()) 
             RETURNING id`,
            [name, email, finalUsername]
        );

        const requestId = result.rows[0].id;

        try {
            const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
            if (adminEmail) {
                sendAdminRegistrationAlert(adminEmail, { name, email, username: finalUsername })
                    .catch(err => console.error('Failed to send admin alert:', err));
            }
        } catch (emailErr) {
            console.error('Failed to send admin registration alert:', emailErr);
        }

        res.status(201).json({
            success: true,
            message: 'Registration request submitted. You will receive an email once approved.',
            requestId: requestId
        });
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'pending_users_email_key') {
            try {
                await db.query('DELETE FROM pending_users WHERE email = $1', [email]);
                logger.info('Cleaned up duplicate pending record on error', { email });
                return res.status(400).json({
                    error: 'There was an issue with your registration. Please try again.'
                });
            } catch (cleanupErr) {
                logger.error('Failed to cleanup duplicate pending record', { error: cleanupErr.message, email });
            }
        }
        logger.error('Registration request error:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

router.get('/admin/pending-requests', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query(
            `SELECT id, name, email, username, created_at
             FROM pending_users
             WHERE status = 'pending'
             ORDER BY created_at ASC`
        );
        res.json(result.rows);
    } catch (err) {
        logger.error('Error fetching pending requests:', err);
        res.status(500).json({ error: 'Failed to fetch pending requests.' });
    }
});

router.post('/admin/pending-requests/:id/approve', requireAuth, authorize('admin'), async (req, res) => {
    const { id } = req.params;
    const db = req.db;
    const adminId = req.session.userId;
    const adminEmail = req.session.username;

    try {
        const pendingResult = await db.query(
            'SELECT * FROM pending_users WHERE id = $1 AND status = $2',
            [id, 'pending']
        );
        if (pendingResult.rowCount === 0) {
            return res.status(404).json({ error: 'Pending request not found or already processed.' });
        }
        const pending = pendingResult.rows[0];

        const existingUser = await db.query('SELECT id FROM users WHERE email = $1', [pending.email]);
        if (existingUser.rowCount > 0) {
            await db.query('UPDATE pending_users SET status = $1 WHERE id = $2', ['rejected', id]);
            return res.status(409).json({ error: 'Email already registered. Request rejected.' });
        }

        await db.query('BEGIN');

        const user = await createUser(db, {
            name: pending.name,
            email: pending.email,
            username: pending.username,
            role: DEFAULT_ROLE,
            status: 'active'
        }, {
            source: 'registration_approval',
            sendEmail: true,
            auditUser: { id: adminId, email: adminEmail },
            req
        });

        await db.query(
            'UPDATE pending_users SET status = $1, approved_at = NOW() WHERE id = $2',
            ['approved', id]
        );

        await db.query('COMMIT');

        await logAuthEvent({
            eventType: 'USER_APPROVED',
            userId: adminId,
            userEmail: adminEmail,
            req,
            extraDetails: { approvedUserId: user.id, email: pending.email, name: pending.name }
        });

        res.json({
            success: true,
            message: 'User approved. Welcome email sent with credentials.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                username: user.username
            }
        });
    } catch (err) {
        await db.query('ROLLBACK');
        logger.error('Approval error:', err);
        res.status(500).json({ error: err.message || 'Failed to approve user.' });
    }
});

router.post('/admin/pending-requests/:id/reject', requireAuth, authorize('admin'), async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const db = req.db;
    const adminId = req.session.userId;
    const adminEmail = req.session.username;

    try {
        const pendingResult = await db.query(
            'SELECT * FROM pending_users WHERE id = $1 AND status = $2',
            [id, 'pending']
        );
        if (pendingResult.rowCount === 0) {
            return res.status(404).json({ error: 'Pending request not found.' });
        }
        const pending = pendingResult.rows[0];

        await db.query(
            'UPDATE pending_users SET status = $1, rejected_at = NOW(), admin_notes = $2 WHERE id = $3',
            ['rejected', reason || null, id]
        );

        await logAuthEvent({
            eventType: 'USER_REJECTED',
            userId: adminId,
            userEmail: adminEmail,
            req,
            extraDetails: { email: pending.email, name: pending.name, reason }
        });

        res.json({ message: 'Request rejected.' });
    } catch (err) {
        logger.error('Rejection error:', err);
        res.status(500).json({ error: 'Failed to reject request.' });
    }
});

router.post('/admin/cleanup-registrations', requireAuth, authorize('admin'), async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const db = req.db;

        const result = await db.query(
            `DELETE FROM pending_users 
             WHERE email = $1 AND status = 'pending' 
             RETURNING id`,
            [email]
        );

        const rejectedResult = await db.query(
            `DELETE FROM pending_users 
             WHERE email = $1 AND status = 'rejected' 
             RETURNING id`,
            [email]
        );

        logger.info('Cleaned up registration requests', {
            email,
            pending: result.rowCount,
            rejected: rejectedResult.rowCount
        });

        res.json({
            success: true,
            message: `Cleaned up ${result.rowCount + rejectedResult.rowCount} registration requests`,
            count: result.rowCount + rejectedResult.rowCount
        });
    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ error: 'Failed to cleanup registration requests' });
    }
});

// LOGIN
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;

    logger.info('Login attempt', { username, ip: clientIp });

    if (!username || !password) {
        logger.warn('Login failed - missing credentials', { username, ip: clientIp });
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const db = req.db;
    try {
        const result = await db.query(
            `SELECT id, username, email, password_hash, role, must_change_password,
                    failed_login_attempts, locked_until, name
             FROM users WHERE LOWER(username) = LOWER($1)`,
            [username]
        );

        if (result.rowCount === 0) {
            logger.warn('Login failed – user not found', { username, ip: clientIp });
            await logAuthEvent({
                eventType: 'LOGIN_FAILED',
                userId: null,
                userEmail: username,
                req,
                extraDetails: { reason: 'User not found', ip: clientIp }
            });
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const user = result.rows[0];

        if (user.locked_until && new Date() < user.locked_until) {
            const remainingMs = user.locked_until - new Date();
            const remainingMinutes = Math.ceil(remainingMs / 60000);
            logger.warn('Login attempt on locked account', { username, ip: clientIp, remainingMinutes });
            await logAuthEvent({
                eventType: 'LOGIN_FAILED',
                userId: user.id,
                userEmail: username,
                req,
                extraDetails: { reason: 'Account locked', ip: clientIp, remainingMinutes }
            });
            return res.status(403).json({
                error: `Account is temporarily locked. Try again in ${remainingMinutes} minutes.`
            });
        }

        const storedHash = user.password_hash;
        if (!storedHash || !storedHash.startsWith('$2')) {
            logger.error('Invalid hash format', { username, hash: storedHash });
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        let match = false;
        try {
            match = await bcrypt.compare(password, storedHash);
        } catch (compareErr) {
            logger.error('bcrypt compare error', { error: compareErr.message, username });
            return res.status(500).json({ error: 'Internal server error during password verification' });
        }

        if (!match) {
            const newAttempts = (user.failed_login_attempts || 0) + 1;
            let lockedUntil = null;
            let remainingAttempts = MAX_FAILED_ATTEMPTS - newAttempts;

            if (newAttempts >= MAX_FAILED_ATTEMPTS) {
                lockedUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000);
                logger.warn('Account locked due to repeated failures', { username, ip: clientIp });
                await logAuthEvent({
                    eventType: 'ACCOUNT_LOCKED',
                    userId: user.id,
                    userEmail: username,
                    req,
                    extraDetails: { attempts: newAttempts, lockDuration: LOCK_DURATION_MINUTES, ip: clientIp }
                });
                await db.query(
                    'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
                    [newAttempts, lockedUntil, user.id]
                );
                return res.status(403).json({
                    error: 'Account locked due to too many failed attempts.',
                    locked: true,
                    remainingAttempts: 0
                });
            } else {
                await logAuthEvent({
                    eventType: 'LOGIN_FAILED',
                    userId: user.id,
                    userEmail: username,
                    req,
                    extraDetails: { reason: 'Wrong password', ip: clientIp, attemptNumber: newAttempts }
                });
                await db.query(
                    'UPDATE users SET failed_login_attempts = $1 WHERE id = $2',
                    [newAttempts, user.id]
                );
                return res.status(401).json({
                    error: 'Invalid username or password',
                    remainingAttempts: remainingAttempts
                });
            }
        }

        await db.query(
            'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_active = NOW() WHERE id = $1',
            [user.id]
        );

        const jwtToken = jwt.sign(
            {
                id: user.id,
                username: user.username,
                role: user.role || 'user',
                email: user.email,
                name: user.name
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );

        setAuthCookie(res, jwtToken);

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role || 'user';
        req.session.mustChangePassword = user.must_change_password || false;

        await logAuthEvent({
            eventType: 'LOGIN',
            userId: user.id,
            userEmail: user.username,
            req,
            extraDetails: { role: user.role, ip: clientIp }
        });

        logger.info('Login successful', { username, userId: user.id });

        let redirectPath = '/';
        if (user.role === 'admin') {
            redirectPath = '/admin';
        }

        res.json({
            token: jwtToken,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                name: user.name || user.username,
                role: user.role || 'user'
            },
            role: user.role || 'user',
            mustChangePassword: user.must_change_password || false,
            redirect: redirectPath
        });
    } catch (err) {
        logger.error('Login error', { error: err.message, username, stack: err.stack });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// PASSWORD MANAGEMENT - FIXED
// ============================================================

router.post('/change-password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    const userId = req.user?.id || req.session.userId;
    const username = req.user?.username || req.session.username;

    if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Current and new password are required.' });
    }

    const complexity = validatePasswordComplexity(new_password);
    if (!complexity.valid) {
        return res.status(400).json({ error: complexity.message });
    }

    const db = req.db;
    try {
        const userResult = await db.query(
            'SELECT password_hash, must_change_password FROM users WHERE id = $1',
            [userId]
        );
        if (userResult.rowCount === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        const storedHash = userResult.rows[0].password_hash;

        const match = await bcrypt.compare(current_password, storedHash);
        if (!match) {
            await logAuthEvent({
                eventType: 'CHANGE_PASSWORD_FAILED',
                userId,
                userEmail: username,
                req,
                extraDetails: { reason: 'Current password incorrect' }
            });
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

        // FIX: Update password and clear must_change_password flag
        await db.query(
            `UPDATE users 
             SET password_hash = $1, 
                 must_change_password = false, 
                 updated_at = NOW() 
             WHERE id = $2`,
            [newHash, userId]
        );

        await logAuthEvent({
            eventType: 'CHANGE_PASSWORD',
            userId,
            userEmail: username,
            req,
            extraDetails: { action: 'password_changed' }
        });

        // FIX: Clear session flag and save
        if (req.session) {
            req.session.mustChangePassword = false;
            // Force session save
            await new Promise((resolve, reject) => {
                req.session.save(function(err) {
                    if (err) {
                        logger.error('Session save error after password change:', err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        }

        // FIX: Regenerate JWT token if it exists
        const existingToken = req.cookies?.token;
        if (existingToken) {
            try {
                const decoded = jwt.verify(existingToken, JWT_SECRET);
                if (decoded && decoded.id) {
                    const newToken = jwt.sign(
                        {
                            id: decoded.id,
                            username: decoded.username || username,
                            role: decoded.role || 'user',
                            email: decoded.email || '',
                            name: decoded.name || username
                        },
                        JWT_SECRET,
                        { expiresIn: JWT_EXPIRY }
                    );
                    setAuthCookie(res, newToken);
                }
            } catch (tokenErr) {
                // Token invalid - clear it
                clearAuthCookie(res);
                logger.warn('Invalid token during password change, cleared cookie');
            }
        }

        res.json({
            message: 'Password updated successfully.',
            mustChangePassword: false
        });
    } catch (err) {
        logger.error('Change password error', { error: err.message, userId });
        res.status(500).json({ error: 'Internal server error.' });
    }
});

router.post('/validate-password-token', async (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ valid: false });
    }
    const db = req.db;
    try {
        const result = await db.query(
            `SELECT id FROM password_reset_tokens
             WHERE token = $1 AND used = false AND expires_at > NOW()`,
            [token.trim()]
        );
        res.json({ valid: result.rowCount > 0 });
    } catch {
        res.status(500).json({ valid: false });
    }
});

router.post('/set-password-from-token', async (req, res) => {
    const { token, new_password } = req.body;

    const complexity = validatePasswordComplexity(new_password);
    if (!complexity.valid) {
        return res.status(400).json({ error: complexity.message });
    }

    const db = req.db;
    const sanitizedToken = token.trim();
    const hashedPassword = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    try {
        await db.query('BEGIN');

        const tokenResult = await db.query(
            `SELECT user_id FROM password_reset_tokens
             WHERE token = $1 AND used = false AND expires_at > NOW()`,
            [sanitizedToken]
        );
        if (tokenResult.rowCount === 0) {
            await db.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid or expired token' });
        }
        const userId = tokenResult.rows[0].user_id;

        await db.query(
            'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2',
            [hashedPassword, userId]
        );
        await db.query(
            'UPDATE password_reset_tokens SET used = true WHERE token = $1',
            [sanitizedToken]
        );

        await db.query('COMMIT');

        await logUpdate({
            targetType: 'users',
            targetId: userId,
            oldData: { password_hash: '***masked***' },
            newData: { password_hash: '***masked***', must_change_password: false },
            userId,
            userEmail: null,
            req,
            extraDetails: { action: 'set_password_from_token' }
        });

        res.json({ success: true, message: 'Password set successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        logger.error('Set-password error', { error: err.message });
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// UNIFIED ADMIN USER CREATION
router.post('/admin/users', requireAuth, authorize('admin'), async (req, res) => {
    try {
        const { name, email, username, role, status } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: 'Name and email are required.' });
        }

        const user = await createUser(req.db, {
            name,
            email,
            username: username || email.split('@')[0],
            role: role || DEFAULT_ROLE,
            status: status || 'active'
        }, {
            source: 'admin',
            sendEmail: true,
            auditUser: req.user,
            req
        });

        res.status(201).json({
            message: 'User created successfully. Welcome email sent with temporary password.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                username: user.username,
                role: user.role,
                status: user.status
            },
            temporary_password: user.temporary_password
        });
    } catch (err) {
        logger.error('Admin user creation error:', err);
        res.status(400).json({ error: err.message });
    }
});

// SESSION & LOGOUT
router.get('/session', requireAuth, (req, res) => {
    res.json({
        loggedIn: true,
        username: req.user?.username || req.session.username,
        role: req.user?.role || req.session.role,
        mustChangePassword: req.session?.mustChangePassword || false
    });
});

router.get('/check-session', async (req, res) => {
    try {
        const token = req.cookies?.token;
        if (token) {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded) {
                return res.json({
                    authenticated: true,
                    user: {
                        id: decoded.id,
                        username: decoded.username,
                        role: decoded.role,
                        email: decoded.email,
                        name: decoded.name
                    }
                });
            }
        }

        if (req.session?.userId) {
            return res.json({
                authenticated: true,
                user: {
                    id: req.session.userId,
                    username: req.session.username,
                    role: req.session.role
                }
            });
        }

        if (req.cookies?.token) {
            clearAuthCookie(res);
        }

        res.json({ authenticated: false });
    } catch (err) {
        if (req.cookies?.token) {
            clearAuthCookie(res);
        }
        res.json({ authenticated: false });
    }
});

router.post('/logout', async (req, res) => {
    const userId = req.user?.id || req.session.userId;
    const username = req.user?.username || req.session.username;

    logger.info('Logout', { userId, username });

    clearAuthCookie(res);

    req.session.destroy(async (err) => {
        if (err) {
            logger.error('Logout failed', { error: err.message, userId, username });
            clearAuthCookie(res);

            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');

            return res.status(200).json({
                message: 'Logged out successfully',
                redirect: '/login?t=' + Date.now()
            });
        }

        await logAuthEvent({
            eventType: 'LOGOUT',
            userId: userId || null,
            userEmail: username || null,
            req,
            extraDetails: {}
        });

        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
        res.setHeader('ETag', `"${Date.now()}"`);

        res.json({
            message: 'Logged out successfully',
            redirect: '/login?t=' + Date.now()
        });
    });
});

// FORGOT PASSWORD
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    const db = req.db;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    try {
        const userResult = await db.query(
            'SELECT id, email FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        if (userResult.rowCount === 0) {
            return res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
        }

        const user = userResult.rows[0];
        const token = crypto.randomBytes(32).toString('hex');

        await db.query(
            `INSERT INTO password_reset_tokens (user_id, token, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '1 hour')
             ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at`,
            [user.id, token]
        );

        const resetLink = `${APP_URL}/reset-password?token=${token}`;

        try {
            const { sendPasswordResetEmail } = require('../services/emailService');
            await sendPasswordResetEmail(email, resetLink);
            logger.info(`Password reset email sent to ${email}`);
        } catch (emailErr) {
            logger.error('Failed to send password reset email:', emailErr);
        }

        res.json({ message: 'If an account with that email exists, a reset link has been sent.' });

    } catch (err) {
        logger.error('Forgot password error:', err);
        res.status(500).json({ error: 'Failed to process request.' });
    }
});

module.exports = {
    router,
    validateSession,
    verifiedSessions,
    createUser,
    generateSecurePassword
};