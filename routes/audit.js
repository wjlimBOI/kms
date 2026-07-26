const router = require('express').Router();
const { requireAuth, authorize } = require('../middleware/auth');

router.get('/logs', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    const { page = 1, limit = 50, action, target, user, from, to } = req.query;
    
    try {
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 50;
        const offset = (pageNum - 1) * limitNum;
        
        const conditions = [];
        const params = [];
        let paramIndex = 1;
        
        if (action) {
            conditions.push(`event_type ILIKE $${paramIndex++}`);
            params.push(`%${action}%`);
        }
        
        if (target) {
            conditions.push(`(target_type ILIKE $${paramIndex++} OR target_id::text ILIKE $${paramIndex++})`);
            params.push(`%${target}%`, `%${target}%`);
        }
        
        if (user) {
            conditions.push(`user_email ILIKE $${paramIndex++}`);
            params.push(`%${user}%`);
        }
        
        if (from) {
            conditions.push(`created_at >= $${paramIndex++}`);
            params.push(from);
        }
        
        if (to) {
            conditions.push(`created_at <= $${paramIndex++}`);
            params.push(to);
        }
        
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        
        const countQuery = `SELECT COUNT(*) AS total FROM audit_log ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].total);
        
        const dataQuery = `
            SELECT 
                id,
                event_type, 
                severity, 
                user_id, 
                user_email,
                target_type, 
                target_id, 
                old_data, 
                new_data,
                ip_address, 
                user_agent, 
                created_at,
                chain_hash
            FROM audit_log
            ${whereClause}
            ORDER BY created_at DESC, id DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `;
        params.push(limitNum, offset);
        
        const result = await db.query(dataQuery, params);
        
        const logs = result.rows.map(row => {
            let details = '';
            try {
                if (row.new_data && typeof row.new_data === 'string') {
                    const parsed = JSON.parse(row.new_data);
                    details = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
                } else if (row.new_data && typeof row.new_data === 'object') {
                    details = JSON.stringify(row.new_data);
                } else if (row.old_data && typeof row.old_data === 'string') {
                    const parsed = JSON.parse(row.old_data);
                    details = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
                } else if (row.old_data && typeof row.old_data === 'object') {
                    details = JSON.stringify(row.old_data);
                }
            } catch (e) {
                details = row.new_data || row.old_data || '';
            }
            
            return {
                id: row.id,
                action: row.event_type,
                severity: row.severity,
                user_name: row.user_email || 'System',
                user_email: row.user_email,
                created_at: row.created_at,
                details: details,
                target_type: row.target_type,
                target_id: row.target_id,
                ip_address: row.ip_address,
                chain_hash: row.chain_hash
            };
        });
        
        res.json({
            data: logs,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: total,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (err) {
        console.error('[AUDIT] GET /logs error:', err);
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});

router.get('/logs/:id', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    
    if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid audit log ID' });
    }
    
    try {
        const result = await db.query(`
            SELECT 
                id,
                event_type, 
                severity, 
                user_id, 
                user_email,
                target_type, 
                target_id, 
                old_data, 
                new_data,
                ip_address, 
                user_agent, 
                created_at,
                chain_hash
            FROM audit_log
            WHERE id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Audit log not found' });
        }
        
        const row = result.rows[0];
        let oldData = row.old_data;
        let newData = row.new_data;
        
        try {
            if (oldData && typeof oldData === 'string') {
                oldData = JSON.parse(oldData);
            }
            if (newData && typeof newData === 'string') {
                newData = JSON.parse(newData);
            }
        } catch (e) {
            // Keep as is if parsing fails
        }
        
        res.json({
            id: row.id,
            event_type: row.event_type,
            severity: row.severity,
            user_id: row.user_id,
            user_email: row.user_email,
            target_type: row.target_type,
            target_id: row.target_id,
            old_data: oldData,
            new_data: newData,
            ip_address: row.ip_address,
            user_agent: row.user_agent,
            created_at: row.created_at,
            chain_hash: row.chain_hash
        });
    } catch (err) {
        console.error('[AUDIT] GET /logs/:id error:', err);
        res.status(500).json({ error: 'Failed to fetch audit log details' });
    }
});

router.get('/health', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query(`
            SELECT 
                COUNT(*) AS total,
                MAX(created_at) AS last_entry,
                MIN(created_at) AS first_entry,
                COUNT(DISTINCT event_type) AS event_types,
                COUNT(DISTINCT user_email) AS unique_users
            FROM audit_log
        `);
        
        const chainResult = await db.query(`
            SELECT 
                COUNT(*) AS total,
                COUNT(DISTINCT chain_hash) AS unique_hashes,
                COUNT(*) - COUNT(chain_hash) AS null_hashes
            FROM audit_log
        `);
        
        res.json({
            status: 'ok',
            statistics: {
                total_entries: parseInt(result.rows[0].total),
                last_entry: result.rows[0].last_entry,
                first_entry: result.rows[0].first_entry,
                event_types: parseInt(result.rows[0].event_types),
                unique_users: parseInt(result.rows[0].unique_users)
            },
            chain: {
                total_entries: parseInt(chainResult.rows[0].total),
                unique_hashes: parseInt(chainResult.rows[0].unique_hashes),
                null_hashes: parseInt(chainResult.rows[0].null_hashes),
                integrity: parseInt(chainResult.rows[0].null_hashes) === 0 ? 'verified' : 'warning'
            }
        });
    } catch (err) {
        console.error('[AUDIT] GET /health error:', err);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to fetch audit health status' 
        });
    }
});

router.get('/export', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    const { from, to, format = 'json' } = req.query;
    
    try {
        let query = `
            SELECT 
                event_type, 
                severity, 
                user_email,
                target_type, 
                target_id, 
                new_data,
                ip_address, 
                created_at
            FROM audit_log
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        
        if (from) {
            query += ` AND created_at >= $${paramIndex++}`;
            params.push(from);
        }
        
        if (to) {
            query += ` AND created_at <= $${paramIndex++}`;
            params.push(to);
        }
        
        query += ` ORDER BY created_at DESC`;
        
        const result = await db.query(query, params);
        
        if (format === 'csv') {
            const headers = ['Event Type', 'Severity', 'User Email', 'Target Type', 'Target ID', 'Details', 'IP Address', 'Created At'];
            const rows = result.rows.map(row => [
                row.event_type,
                row.severity,
                row.user_email || 'System',
                row.target_type,
                row.target_id || '',
                row.new_data ? JSON.stringify(row.new_data) : '',
                row.ip_address || '',
                row.created_at
            ]);
            
            let csv = headers.join(',') + '\n';
            rows.forEach(row => {
                const escaped = row.map(cell => `"${String(cell).replace(/"/g, '""')}"`);
                csv += escaped.join(',') + '\n';
            });
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=audit_log_${new Date().toISOString().slice(0,10)}.csv`);
            return res.send(csv);
        }
        
        res.json({
            exported_at: new Date().toISOString(),
            count: result.rows.length,
            data: result.rows
        });
    } catch (err) {
        console.error('[AUDIT] GET /export error:', err);
        res.status(500).json({ error: 'Failed to export audit logs' });
    }
});

module.exports = router;