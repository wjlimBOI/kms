const router = require('express').Router();
const { requireAuth, authorize } = require('../middleware/auth');

router.get('/logs', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query(`
            SELECT 
                event_type, severity, user_id, user_email,
                target_type, target_id, old_data, new_data,
                ip_address, user_agent, created_at
            FROM audit_log
            ORDER BY created_at DESC
            LIMIT 100
        `);
        const logs = result.rows.map(row => ({
            action: row.event_type,
            user_name: row.user_email || 'System',
            user_email: row.user_email,
            created_at: row.created_at,
            details: row.new_data ? JSON.stringify(row.new_data) : 
                     (row.old_data ? JSON.stringify(row.old_data) : ''),
            target_type: row.target_type,
            target_id: row.target_id
        }));
        res.json(logs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});

module.exports = router;