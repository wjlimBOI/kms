const router = require('express').Router();
const { requireAuth, authorize } = require('../middleware/auth');
const logger = require('../lib/logger');

router.get('/templates', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query('SELECT * FROM email_templates ORDER BY template_key');
        res.json(result.rows);
    } catch (err) {
        logger.error('Error fetching templates:', err);
        res.status(500).json({ error: 'Failed to load templates' });
    }
});

router.get('/templates/:key', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    const { key } = req.params;
    try {
        const result = await db.query('SELECT * FROM email_templates WHERE template_key = $1', [key]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
        res.json(result.rows[0]);
    } catch (err) {
        logger.error('Error fetching template:', err);
        res.status(500).json({ error: 'Failed to fetch template' });
    }
});

router.put('/templates/:key', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    const { key } = req.params;
    const { subject, body_html, is_active } = req.body;
    if (!subject || !body_html) {
        return res.status(400).json({ error: 'Subject and body are required' });
    }
    try {
        await db.query(
            `UPDATE email_templates 
             SET subject = $1, body_html = $2, is_active = $3, updated_at = NOW()
             WHERE template_key = $4`,
            [subject, body_html, is_active, key]
        );
        res.json({ message: 'Template updated' });
    } catch (err) {
        logger.error('Error updating template:', err);
        res.status(500).json({ error: 'Failed to update template' });
    }
});

router.get('/settings', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query('SELECT * FROM notification_settings ORDER BY setting_key');
        res.json(result.rows);
    } catch (err) {
        logger.error('Error fetching settings:', err);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.put('/settings/:key', requireAuth, authorize('admin'), async (req, res) => {
    const db = req.db;
    const { key } = req.params;
    const { enabled, config } = req.body;
    try {
        await db.query(
            `UPDATE notification_settings 
             SET enabled = $1, config = $2, updated_at = NOW()
             WHERE setting_key = $3`,
            [enabled, config || {}, key]
        );
        res.json({ message: 'Setting updated' });
    } catch (err) {
        logger.error('Error updating setting:', err);
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

module.exports = router;