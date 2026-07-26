const router = require('express').Router();
const bcrypt = require('bcrypt');
const { requireAuth, authorize, blockIfReadOnly } = require('../middleware/auth');
const { logAuthEvent, logUpdate } = require('../lib/audit');
const logger = require('../lib/logger');
const { validatePasswordComplexity } = require('../lib/passwordValidator');
const validate = require('../middleware/validate');
const { changePasswordSchema, firstPasswordSchema } = require('../lib/validationSchemas');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

router.get('/profile', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const db = req.db;

  try {
    const result = await db.query(
      'SELECT id, username, email, name, role FROM users WHERE id = $1',
      [userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = result.rows[0];
    res.json({
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
    });
  } catch (err) {
    logger.error('[PROFILE] Fetch error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.put('/profile', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { name, email, current_password, new_password } = req.body;
  const db = req.db;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  if (!email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  try {
    const userResult = await db.query(
      'SELECT id, username, email, name, password_hash FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = userResult.rows[0];

    if (new_password) {
      if (!current_password) {
        return res.status(400).json({ error: 'Current password is required to change password.' });
      }
      const match = await bcrypt.compare(current_password, user.password_hash);
      if (!match) {
        await logAuthEvent({
          eventType: 'CHANGE_PASSWORD_FAILED',
          userId,
          userEmail: user.email,
          req,
          extraDetails: { reason: 'current_password_incorrect' },
        });
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
      const complexity = validatePasswordComplexity(new_password);
      if (!complexity.valid) {
        return res.status(400).json({ error: complexity.message });
      }
      const hashed = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
      await db.query(
        'UPDATE users SET name = $1, email = $2, password_hash = $3 WHERE id = $4',
        [name, email, hashed, userId]
      );
    } else {
      await db.query(
        'UPDATE users SET name = $1, email = $2 WHERE id = $3',
        [name, email, userId]
      );
    }

    await logUpdate({
      targetType: 'users',
      targetId: userId,
      oldData: { name: user.name, email: user.email },
      newData: { name, email },
      userId,
      userEmail: user.email,
      req,
      extraDetails: { action: 'profile_update', password_changed: !!new_password },
    });

    res.json({ message: 'Profile updated successfully.' });
  } catch (err) {
    logger.error('[PROFILE] Update error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/permissions', requireAuth, async (req, res) => {
  const db = req.db;
  const userRole = req.user.role;

  try {
    const result = await db.query(
      `SELECT p.permission_code
       FROM permissions p
       JOIN role_permissions rp ON p.permission_id = rp.permission_id
       WHERE rp.role_name = $1`,
      [userRole]
    );
    const permissionCodes = result.rows.map(row => row.permission_code);
    res.json({ permissions: permissionCodes });
  } catch (err) {
    logger.error('[PERMISSIONS] Error:', err);
    res.status(500).json({ error: 'Failed to fetch permissions.' });
  }
});

router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res) => {
  const { current_password, new_password } = req.body;
  const db = req.db;
  const userId = req.user.id;

  try {
    const userResult = await db.query(
      'SELECT password_hash, email, username FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = userResult.rows[0];

    const isValid = await bcrypt.compare(current_password, user.password_hash);
    if (!isValid) {
      await logAuthEvent({
        eventType: 'PERMISSION_DENIED',
        userId,
        userEmail: user.username,
        req,
        extraDetails: { reason: 'incorrect_current_password', action: 'change_password' },
      });
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await db.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newHash, userId]
    );

    const updatedUser = await db.query(
      'SELECT id, username, role, status FROM users WHERE id = $1',
      [userId]
    );
    const newUserData = updatedUser.rows[0];
    await logUpdate({
      targetType: 'users',
      targetId: userId,
      oldData: { password_hash: '***masked***' },
      newData: { ...newUserData, password_hash: '***masked***' },
      userId,
      userEmail: user.username,
      req,
      extraDetails: { action: 'change_password', source: 'api', method: 'self_service' },
    });

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    logger.error('[CHANGE PASSWORD] Error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/change-password-first', requireAuth, validate(firstPasswordSchema), async (req, res) => {
  const { new_password } = req.body;
  const db = req.db;
  const userId = req.user.id;

  try {
    const userCheck = await db.query(
      'SELECT must_change_password, email, username FROM users WHERE id = $1',
      [userId]
    );
    if (userCheck.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = userCheck.rows[0];
    if (!user.must_change_password) {
      return res.status(400).json({ error: 'Password change not required for this user.' });
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2',
      [newHash, userId]
    );

    const updatedUser = await db.query(
      'SELECT id, username, role, status FROM users WHERE id = $1',
      [userId]
    );
    const newUserData = updatedUser.rows[0];
    await logUpdate({
      targetType: 'users',
      targetId: userId,
      oldData: { must_change_password: true },
      newData: { ...newUserData, must_change_password: false, password_hash: '***masked***' },
      userId,
      userEmail: user.username,
      req,
      extraDetails: { action: 'change_password_first_login', source: 'api' },
    });

    res.json({ success: true, message: 'Password set successfully.' });
  } catch (err) {
    logger.error('[CHANGE PASSWORD FIRST] Error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/active-borrows', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter is required' });
  }

  const db = req.db;
  try {
    const result = await db.query(`
      SELECT
        t.id,
        t.key_id,
        t.quantity,
        t.borrowed_at,
        t.planned_return,
        t.status,
        k.code as key_code,
        k.brand,
        k.colour
      FROM transactions t
      JOIN keys k ON t.key_id = k.id
      WHERE t.receiver_email = $1
      AND t.status = 'borrowed'
      ORDER BY t.borrowed_at DESC
    `, [email]);

    const borrows = result.rows.map(row => ({
      id: row.id,
      key_id: row.key_id,
      key_code: row.key_code,
      brand: row.brand,
      colour: row.colour,
      quantity: row.quantity,
      borrowed_at: row.borrowed_at,
      planned_return: row.planned_return,
      status: row.status
    }));

    res.json(borrows);
  } catch (err) {
    console.error('[user] /active-borrows error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

module.exports = router;