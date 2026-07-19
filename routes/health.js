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
            return res.status(503).json({
                status: 'unknown',
                message: 'No audit health record found – validation may not have run yet.'
            });
        }
        const row = result.rows[0];
        const healthy = row.status === 'ok';
        res.status(healthy ? 200 : 500).json({
            status: row.status,
            message: row.message,
            firstTamperedRow: row.first_tampered_row_id,
            duration: row.duration_ms,
            checkedAt: row.checked_at
        });
    } catch (err) {
        console.error('[HEALTH] Audit health error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/health/liveness
 * Simple liveness check – always returns 200.
 * Used by orchestration (Kubernetes, etc.)
 */
router.get('/liveness', (req, res) => {
    res.status(200).json({ status: 'alive' });
});

/**
 * GET /api/health/readiness
 * Checks if the database is reachable.
 */
router.get('/readiness', async (req, res) => {
    const db = req.db;
    try {
        await db.query('SELECT 1');
        res.status(200).json({ status: 'ready' });
    } catch (err) {
        console.error('[HEALTH] Readiness check failed:', err);
        res.status(503).json({ status: 'not ready', error: err.message });
    }
});

module.exports = router;