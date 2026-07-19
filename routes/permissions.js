const router = require('express').Router();
const { requireAuth, authorize } = require('../middleware/auth');

// GET /api/permissions – list all permissions (admin only)
router.get('/', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query(
            'SELECT permission_id, permission_code, permission_name, module FROM permissions ORDER BY module, permission_name'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[PERMISSIONS] List error:', err);
        res.status(500).json({ error: 'Failed to fetch permissions' });
    }
});

// GET /api/permissions/roles – list all roles with their permissions (admin only)
router.get('/roles', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    try {
        const rolesResult = await db.query('SELECT DISTINCT role_name FROM role_permissions');
        const roles = rolesResult.rows.map(r => r.role_name);
        const result = {};
        for (const role of roles) {
            const permResult = await db.query(
                `SELECT p.permission_code
                 FROM permissions p
                 JOIN role_permissions rp ON p.permission_id = rp.permission_id
                 WHERE rp.role_name = $1`,
                [role]
            );
            result[role] = permResult.rows.map(row => row.permission_code);
        }
        res.json(result);
    } catch (err) {
        console.error('[PERMISSIONS] Roles error:', err);
        res.status(500).json({ error: 'Failed to fetch role permissions' });
    }
});

// POST /api/permissions/roles – update permissions for a role (admin only)
router.post('/roles', requireAuth, authorize('admin'), async (req, res) => {
    const { role_name, permission_ids } = req.body;
    const db = req.db;
    if (!role_name || !Array.isArray(permission_ids)) {
        return res.status(400).json({ error: 'role_name and permission_ids array required' });
    }

    try {
        await db.query('BEGIN');

        // Delete existing permissions for this role
        await db.query('DELETE FROM role_permissions WHERE role_name = $1', [role_name]);

        // Insert new permissions
        for (const permId of permission_ids) {
            await db.query(
                'INSERT INTO role_permissions (role_name, permission_id) VALUES ($1, $2)',
                [role_name, permId]
            );
        }

        await db.query('COMMIT');
        res.json({ success: true, message: 'Permissions updated successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('[PERMISSIONS] Update error:', err);
        res.status(500).json({ error: 'Failed to update permissions' });
    }
});

module.exports = router;