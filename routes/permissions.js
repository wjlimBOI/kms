const router = require('express').Router();
const { requireAuth, authorize, blockIfReadOnly } = require('../middleware/auth');

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

router.post('/roles', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { role_name, permission_ids } = req.body;
    const db = req.db;
    if (!role_name || !Array.isArray(permission_ids)) {
        return res.status(400).json({ error: 'role_name and permission_ids array required' });
    }

    try {
        await db.query('BEGIN');

        await db.query('DELETE FROM role_permissions WHERE role_name = $1', [role_name]);

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

router.post('/roles/create', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { role_name, permission_ids } = req.body;
    const db = req.db;
    
    if (!role_name) {
        return res.status(400).json({ error: 'role_name is required' });
    }
    
    if (!Array.isArray(permission_ids)) {
        return res.status(400).json({ error: 'permission_ids array required' });
    }

    try {
        await db.query('BEGIN');

        const existing = await db.query(
            'SELECT 1 FROM role_permissions WHERE role_name = $1 LIMIT 1',
            [role_name]
        );
        
        if (existing.rows.length > 0) {
            await db.query('ROLLBACK');
            return res.status(409).json({ error: 'Role already exists' });
        }

        for (const permId of permission_ids) {
            await db.query(
                'INSERT INTO role_permissions (role_name, permission_id) VALUES ($1, $2)',
                [role_name, permId]
            );
        }

        await db.query('COMMIT');
        res.status(201).json({ 
            success: true, 
            message: 'Role created successfully',
            role: role_name,
            permissions: permission_ids
        });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('[PERMISSIONS] Create role error:', err);
        res.status(500).json({ error: 'Failed to create role' });
    }
});

router.delete('/roles/:role', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { role } = req.params;
    const db = req.db;
    
    if (!role || role.toLowerCase() === 'admin') {
        return res.status(400).json({ error: 'Cannot delete the admin role' });
    }

    try {
        const existing = await db.query(
            'SELECT 1 FROM role_permissions WHERE role_name = $1 LIMIT 1',
            [role]
        );
        
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Role not found' });
        }

        const userCheck = await db.query(
            'SELECT 1 FROM users WHERE role = $1 LIMIT 1',
            [role]
        );
        
        if (userCheck.rows.length > 0) {
            return res.status(409).json({ 
                error: 'Cannot delete role: users are currently assigned to this role' 
            });
        }

        await db.query('DELETE FROM role_permissions WHERE role_name = $1', [role]);

        res.json({ 
            success: true, 
            message: `Role "${role}" deleted successfully` 
        });
    } catch (err) {
        console.error('[PERMISSIONS] Delete role error:', err);
        res.status(500).json({ error: 'Failed to delete role' });
    }
});

router.get('/roles/:role/permissions', requireAuth, authorize('admin'), async (req, res) => {
    const { role } = req.params;
    const db = req.db;
    
    try {
        const result = await db.query(
            `SELECT p.permission_id, p.permission_code, p.permission_name, p.module
             FROM permissions p
             JOIN role_permissions rp ON p.permission_id = rp.permission_id
             WHERE rp.role_name = $1
             ORDER BY p.module, p.permission_name`,
            [role]
        );
        
        const allPermissions = await db.query(
            'SELECT permission_id, permission_code, permission_name, module FROM permissions ORDER BY module, permission_name'
        );
        
        const assignedIds = result.rows.map(row => row.permission_id);
        
        res.json({
            role: role,
            permissions: result.rows,
            all_permissions: allPermissions.rows,
            assigned_ids: assignedIds
        });
    } catch (err) {
        console.error('[PERMISSIONS] Get role permissions error:', err);
        res.status(500).json({ error: 'Failed to fetch role permissions' });
    }
});

router.post('/roles/:role/permissions/:permissionId', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { role, permissionId } = req.params;
    const db = req.db;
    
    try {
        const roleCheck = await db.query(
            'SELECT 1 FROM role_permissions WHERE role_name = $1 LIMIT 1',
            [role]
        );
        
        if (roleCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Role not found' });
        }
        
        const permCheck = await db.query(
            'SELECT 1 FROM permissions WHERE permission_id = $1',
            [permissionId]
        );
        
        if (permCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Permission not found' });
        }
        
        const existing = await db.query(
            'SELECT 1 FROM role_permissions WHERE role_name = $1 AND permission_id = $2',
            [role, permissionId]
        );
        
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Permission already assigned to this role' });
        }
        
        await db.query(
            'INSERT INTO role_permissions (role_name, permission_id) VALUES ($1, $2)',
            [role, permissionId]
        );
        
        res.status(201).json({ 
            success: true, 
            message: 'Permission assigned to role successfully' 
        });
    } catch (err) {
        console.error('[PERMISSIONS] Assign permission error:', err);
        res.status(500).json({ error: 'Failed to assign permission to role' });
    }
});

router.delete('/roles/:role/permissions/:permissionId', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { role, permissionId } = req.params;
    const db = req.db;
    
    if (role.toLowerCase() === 'admin') {
        return res.status(400).json({ error: 'Cannot remove permissions from admin role' });
    }
    
    try {
        const result = await db.query(
            'DELETE FROM role_permissions WHERE role_name = $1 AND permission_id = $2 RETURNING 1',
            [role, permissionId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Permission not found for this role' });
        }
        
        res.json({ 
            success: true, 
            message: 'Permission removed from role successfully' 
        });
    } catch (err) {
        console.error('[PERMISSIONS] Remove permission error:', err);
        res.status(500).json({ error: 'Failed to remove permission from role' });
    }
});

module.exports = router;