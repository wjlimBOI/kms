const router = require('express').Router();
const { sendRequestSubmittedEmail, sendAdminNewRequestAlert } = require('../services/emailService');

router.post('/submit', async (req, res) => {
    const { requester_name, requester_email, items, reason, intended_draw_date, planned_return } = req.body;

    if (!requester_name) return res.status(400).json({ error: 'Name is required' });
    if (!requester_email) return res.status(400).json({ error: 'Email is required' });
    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'At least one key is required' });
    }
    if (!planned_return) return res.status(400).json({ error: 'Planned return date is required' });

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        for (const item of items) {
            const pendingCheck = await client.query(
                `SELECT 1 FROM key_requests WHERE status = 'pending' AND EXISTS (
                    SELECT 1 FROM jsonb_to_recordset(items) AS i(key_id INT) WHERE i.key_id = $1
                )`,
                [item.key_id]
            );
            if (pendingCheck.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: `Key ${item.key_id} already has a pending request` });
            }
        }

        const result = await client.query(
            `INSERT INTO key_requests (requester_name, requester_email, items, reason, intended_draw_date, planned_return)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [requester_name, requester_email, JSON.stringify(items), reason || null, intended_draw_date || null, planned_return]
        );
        const newRequestId = result.rows[0].id;

        await client.query('COMMIT');

        await sendRequestSubmittedEmail(requester_email, requester_name, items, planned_return);
        await sendAdminNewRequestAlert(process.env.ADMIN_EMAIL, {
            id: newRequestId,
            requester_name,
            requester_email,
            items,
            planned_return,
            created_at: new Date().toISOString()
        });

        res.status(201).json({ message: 'Request submitted. Awaiting admin approval.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;