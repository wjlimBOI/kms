// routes/health.js
const router = require('express').Router();

/**
 * GET /api/health/audit
 * Returns the latest audit chain health status.
 * Public endpoint (no authentication required for monitoring tools).
 */
router.get('/audit', async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query(
            `SELECT status, message, first_tampered_row_id, duration_ms, checked_at
             FROM audit_health
             ORDER BY checked_at DESC
             LIMIT 1`
        );
        
        if (result.rows.length === 0) {
            return res.status(200).json({
                status: 'unknown',
                message: 'No audit health record found – validation may not have run yet.',
                checkedAt: null,
                isHealthy: false
            });
        }
        
        const row = result.rows[0];
        const healthy = row.status === 'ok' || row.status === 'empty';
        
        // Always return 200 with status field for consistency
        res.status(200).json({
            status: row.status,
            message: row.message,
            firstTamperedRow: row.first_tampered_row_id,
            duration: row.duration_ms,
            checkedAt: row.checked_at,
            isHealthy: healthy
        });
    } catch (err) {
        console.error('[HEALTH] Audit health error:', err);
        res.status(500).json({ 
            status: 'error',
            message: 'Internal server error',
            error: err.message,
            isHealthy: false
        });
    }
});

/**
 * GET /api/health/liveness
 * Simple liveness check – always returns 200.
 * Used by orchestration (Kubernetes, etc.)
 */
router.get('/liveness', (req, res) => {
    res.status(200).json({ 
        status: 'alive',
        timestamp: new Date().toISOString()
    });
});

/**
 * GET /api/health/readiness
 * Checks if the database is reachable.
 */
router.get('/readiness', async (req, res) => {
    const db = req.db;
    try {
        await db.query('SELECT 1');
        res.status(200).json({ 
            status: 'ready',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('[HEALTH] Readiness check failed:', err);
        res.status(503).json({ 
            status: 'not ready', 
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET /api/health/run-validation
 * Triggers an on-demand audit validation (admin only)
 * This is called by the admin panel refresh button
 */
router.get('/run-validation', async (req, res) => {
    // Check if admin (uncomment when you have auth middleware)
    // if (!req.user || req.user.role !== 'admin') {
    //     return res.status(403).json({ error: 'Admin access required' });
    // }
    
    try {
        const { validateAuditChain } = require('../scripts/auditCron');
        
        console.log('[HEALTH] Manual audit validation triggered by admin');
        const result = await validateAuditChain();
        
        res.json({
            status: 'validation_complete',
            result: {
                status: result.status,
                message: result.message,
                firstTamperedRow: result.firstTamperedId,
                duration: result.duration,
                checkedAt: new Date().toISOString()
            }
        });
    } catch (err) {
        console.error('[HEALTH] Manual validation error:', err);
        res.status(500).json({ 
            status: 'validation_failed',
            error: err.message 
        });
    }
});

module.exports = router;