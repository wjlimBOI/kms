const router = require('express').Router();
const bcrypt = require('bcrypt');
const { requireAuth, authorize, blockIfReadOnly } = require('../middleware/auth');
const { logInsert, logUpdate, logDelete } = require('../lib/audit');
const validate = require('../middleware/validate');
const { userSchema } = require('../lib/validationSchemas');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function generateTempPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

function buildFilterClause(search, role, status) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (search) {
    conditions.push(`(name ILIKE $${paramIndex} OR username ILIKE $${paramIndex})`);
    params.push(`%${search}%`);
    paramIndex++;
  }
  if (role && role !== 'all') {
    conditions.push(`role = $${paramIndex}`);
    params.push(role);
    paramIndex++;
  }
  if (status && status !== 'all') {
    conditions.push(`status = $${paramIndex}`);
    params.push(status);
    paramIndex++;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

router.get('/', requireAuth, authorize('admin'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const search = (req.query.search || '').trim();
    const role = req.query.role || 'all';
    const status = req.query.status || 'all';
    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 10;

    if (page < 1) page = 1;
    if (limit < 1 || limit > 100) limit = 10;

    const offset = (page - 1) * limit;

    const { whereClause, params } = buildFilterClause(search, role, status);

    const countQuery = `SELECT COUNT(*) AS total FROM users ${whereClause}`;
    const countResult = await req.db.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    let dataResult;
    try {
      const dataQuery = `
        SELECT id, name, username AS email, role, status, 
               COALESCE(last_active, NOW()) AS "lastActive",
               must_change_password AS "mustChangePassword"
        FROM users
        ${whereClause}
        ORDER BY last_active DESC NULLS LAST
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      dataResult = await req.db.query(dataQuery, [...params, limit, offset]);
    } catch (orderErr) {
      const fallbackQuery = `
        SELECT id, name, username AS email, role, status, 
               COALESCE(last_active, NOW()) AS "lastActive",
               must_change_password AS "mustChangePassword"
        FROM users
        ${whereClause}
        ORDER BY id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      dataResult = await req.db.query(fallbackQuery, [...params, limit, offset]);
    }

    res.json({
      users: dataResult.rows,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('[AdminUsers] GET error:', err);
    res.status(500).json({
      error: IS_PRODUCTION ? 'Internal server error' : `Failed to fetch users: ${err.message}`
    });
  }
});

router.post('/', requireAuth, authorize('admin'), blockIfReadOnly, validate(userSchema), async (req, res) => {
  try {
    const { name, email, role, status } = req.body;

    const existing = await req.db.query('SELECT id FROM users WHERE username = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    const tempPassword = generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    const result = await req.db.query(
      `INSERT INTO users (name, username, role, status, last_active, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, NOW(), $5, true)
       RETURNING id, name, username AS email, role, status, last_active AS "lastActive", must_change_password AS "mustChangePassword"`,
      [name, email, role || 'viewer', status || 'active', hashedPassword]
    );

    const newUser = result.rows[0];

    await logInsert({
      targetType: 'users',
      targetId: newUser.id,
      newData: { ...newUser, password_hash: '***masked***' },
      userId: req.user.id,
      userEmail: req.user.username,
      req,
      extraDetails: { action: 'create_user' }
    });

    res.status(201).json({
      ...newUser,
      temporary_password: tempPassword
    });
  } catch (err) {
    console.error('POST /admin/users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const updateUserSchema = userSchema.partial();
router.put('/:id', requireAuth, authorize('admin'), blockIfReadOnly, validate(updateUserSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, status } = req.body;

    if (email) {
      const emailCheck = await req.db.query(
        'SELECT id FROM users WHERE username = $1 AND id != $2',
        [email, id]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ error: 'Email already in use by another user' });
      }
    }

    const oldResult = await req.db.query(
      'SELECT id, name, username, role, status, must_change_password FROM users WHERE id = $1',
      [id]
    );
    if (oldResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const oldUser = oldResult.rows[0];

    const fields = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (email !== undefined) { fields.push(`username = $${idx++}`); values.push(email); }
    if (role !== undefined) { fields.push(`role = $${idx++}`); values.push(role); }
    if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
    fields.push(`last_active = NOW()`);

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `
      UPDATE users
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING id, name, username AS email, role, status, last_active AS "lastActive", must_change_password AS "mustChangePassword"
    `;
    const result = await req.db.query(query, values);
    const newUser = result.rows[0];

    await logUpdate({
      targetType: 'users',
      targetId: id,
      oldData: { ...oldUser, password_hash: '***masked***' },
      newData: { ...newUser, password_hash: '***masked***' },
      userId: req.user.id,
      userEmail: req.user.username,
      req,
      extraDetails: { action: 'update_user' }
    });

    res.json(newUser);
  } catch (err) {
    console.error('PUT /admin/users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const oldResult = await req.db.query(
      'SELECT id, name, username, role, status FROM users WHERE id = $1',
      [id]
    );
    if (oldResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const oldUser = oldResult.rows[0];

    await req.db.query(
      'UPDATE users SET status = $1 WHERE id = $2',
      ['inactive', id]
    );

    await logDelete({
      targetType: 'users',
      targetId: id,
      oldData: { ...oldUser, password_hash: '***masked***' },
      userId: req.user.id,
      userEmail: req.user.username,
      req,
      extraDetails: { action: 'delete_user', soft_delete: true }
    });

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /admin/users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/suspend', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'You cannot suspend your own account' });
    }

    const current = await req.db.query('SELECT status, name, username, role FROM users WHERE id = $1', [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const oldUser = current.rows[0];
    const newStatus = oldUser.status === 'suspended' ? 'active' : 'suspended';

    const result = await req.db.query(
      'UPDATE users SET status = $1, last_active = NOW() WHERE id = $2 RETURNING id, status',
      [newStatus, id]
    );

    await logUpdate({
      targetType: 'users',
      targetId: id,
      oldData: { ...oldUser, password_hash: '***masked***' },
      newData: { ...oldUser, status: newStatus, password_hash: '***masked***' },
      userId: req.user.id,
      userEmail: req.user.username,
      req,
      extraDetails: { action: 'suspend_user', new_status: newStatus }
    });

    res.json({ status: result.rows[0].status });
  } catch (err) {
    console.error('PATCH /admin/users/suspend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;