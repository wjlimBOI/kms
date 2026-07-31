const router = require('express').Router();
const { requireAuth, authorize, blockIfReadOnly } = require('../middleware/auth');
const { sendRequestSubmittedEmail, sendRequestApprovedEmail, sendAdminNewRequestAlert } = require('../services/emailService');
const { logInsert, logUpdate } = require('../lib/audit');
const validate = require('../middleware/validate');
const { requestSchema } = require('../lib/validationSchemas');

async function hasPendingForKeys(db, items, excludeRequestId = null) {
    for (const item of items) {
        let query = `SELECT 1 FROM key_requests WHERE status = 'pending' AND items::jsonb @> jsonb_build_array(jsonb_build_object('key_id', $1))`;
        const params = [item.key_id];
        if (excludeRequestId) {
            query += ` AND id != $2`;
            params.push(excludeRequestId);
        }
        const res = await db.query(query, params);
        if (res.rowCount > 0) return true;
    }
    return false;
}

router.post('/submit', validate(requestSchema), async (req, res) => {
    const { requester_name, requester_email, items, reason, planned_return, borrow_datetime, borrow_type } = req.body;
    const db = req.db;

    if (await hasPendingForKeys(db, items)) {
        return res.status(409).json({ error: 'One or more keys already have a pending request' });
    }

    try {
        const result = await db.query(
            `INSERT INTO key_requests (requester_name, requester_email, items, reason, intended_draw_date, planned_return, borrow_datetime, borrow_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [requester_name, requester_email, JSON.stringify(items), reason || null, null, planned_return, borrow_datetime || null, borrow_type || null]
        );
        const newRequestId = result.rows[0].id;

        const newRequest = await db.query('SELECT * FROM key_requests WHERE id = $1', [newRequestId]);
        const requestData = newRequest.rows[0];

        await logInsert({
            targetType: 'key_requests',
            targetId: newRequestId,
            newData: requestData,
            userId: req.user?.id || null,
            userEmail: req.user?.username || requester_email,
            req,
            extraDetails: { action: 'submit_request' }
        });

        await sendRequestSubmittedEmail(requester_email, requester_name, items, planned_return);
        await sendAdminNewRequestAlert(process.env.ADMIN_EMAIL, {
            id: newRequestId,
            requester_name,
            requester_email,
            items,
            planned_return,
            created_at: new Date().toISOString()
        });

        res.status(201).json({ message: 'Request submitted successfully. Awaiting admin approval.' });
    } catch (err) {
        console.error('[requests] /submit error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/last-request', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const db = req.db;
    try {
        const result = await db.query(
            `SELECT items FROM key_requests
             WHERE requester_email = $1 AND status = 'approved'
             ORDER BY created_at DESC LIMIT 1`,
            [email]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'No previous approved request found' });
        let items = result.rows[0].items;
        if (typeof items === 'string') items = JSON.parse(items);
        res.json({ items });
    } catch (err) {
        console.error('[requests] /last-request error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/pending', async (req, res) => {
    const db = req.db;
    try {
        const result = await db.query(`
            SELECT r.*,
                   (SELECT json_agg(json_build_object('code', k.code, 'brand', k.brand, 'key_id', r_item.key_id, 'quantity', r_item.quantity))
                    FROM jsonb_to_recordset(r.items) AS r_item(key_id INT, quantity INT)
                    JOIN keys k ON k.id = r_item.key_id) AS key_details
            FROM key_requests r
            WHERE r.status = 'pending'
            ORDER BY r.created_at ASC
        `);
        const rows = result.rows.map(row => {
            if (row.items && typeof row.items === 'string') row.items = JSON.parse(row.items);
            return row;
        });
        res.json(rows);
    } catch (err) {
        console.error('[requests] /pending error:', err);
        res.status(500).json({ error: 'Failed to fetch pending requests' });
    }
});

router.post('/approve', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { request_id, admin_notes } = req.body;
    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const reqResult = await client.query(
            'SELECT * FROM key_requests WHERE id = $1 AND status = $2',
            [request_id, 'pending']
        );
        if (reqResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Request not found or already processed' });
        }

        const request = reqResult.rows[0];
        let items = request.items;
        if (typeof items === 'string') items = JSON.parse(items);
        if (!items || !items.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Request has no items' });
        }

        const adminEmail = req.session.userEmail || req.user?.email || 'admin@kms.com';
        const oldRequestData = { ...request };

        for (const item of items) {
            await client.query(
                `INSERT INTO transactions
                 (giver_email, receiver_email, action, key_id, quantity, planned_return, borrowed_at, status,
                  giver_verification_method, giver_signature_name,
                  receiver_verification_method, receiver_signature_name, reason, borrow_datetime)
                 VALUES ($1, $2, 'borrow', $3, $4, $5, NOW(), 'borrowed', 'admin_approval', $6, 'admin_approval', $7, $8, $9)`,
                [adminEmail, request.requester_email, item.key_id, item.quantity, request.planned_return,
                 'Admin', request.requester_name, request.reason, request.borrow_datetime || null]
            );
        }

        const updateResult = await client.query(
            `UPDATE key_requests SET status = 'approved', admin_notes = $1, approved_at = NOW() WHERE id = $2 RETURNING *`,
            [admin_notes || null, request_id]
        );
        const newRequestData = updateResult.rows[0];

        await logUpdate({
            targetType: 'key_requests',
            targetId: request_id,
            oldData: oldRequestData,
            newData: newRequestData,
            userId: req.user?.id || null,
            userEmail: req.user?.username || adminEmail,
            req,
            extraDetails: { action: 'approve_request' }
        });

        await client.query('COMMIT');

        await sendRequestApprovedEmail(request.requester_email, request.requester_name, items, request.planned_return);
        res.json({ message: `Request approved. ${items.length} transaction(s) created.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[requests] /approve error:', err);
        res.status(500).json({ error: 'Approval failed: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/deny', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { request_id, admin_notes } = req.body;
    const db = req.db;
    try {
        const oldResult = await db.query('SELECT * FROM key_requests WHERE id = $1 AND status = $2', [request_id, 'pending']);
        if (oldResult.rowCount === 0) {
            return res.status(404).json({ error: 'Request not found or already processed' });
        }
        const oldData = oldResult.rows[0];

        const updateResult = await db.query(
            `UPDATE key_requests SET status = 'denied', admin_notes = $1, denied_at = NOW() WHERE id = $2 AND status = 'pending' RETURNING *`,
            [admin_notes || null, request_id]
        );
        const newData = updateResult.rows[0];

        await logUpdate({
            targetType: 'key_requests',
            targetId: request_id,
            oldData,
            newData,
            userId: req.user?.id || null,
            userEmail: req.user?.username || null,
            req,
            extraDetails: { action: 'deny_request' }
        });

        res.json({ message: 'Request denied.' });
    } catch (err) {
        console.error('[requests] /deny error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/extend', requireAuth, async (req, res) => {
    const { transaction_id, new_return_date, borrower_email } = req.body;

    if (!transaction_id || !new_return_date || !borrower_email) {
        return res.status(400).json({
            error: 'transaction_id, new_return_date, and borrower_email are required'
        });
    }

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const txResult = await client.query(
            `SELECT * FROM transactions WHERE id = $1 AND receiver_email = $2 AND status = 'borrowed'`,
            [transaction_id, borrower_email]
        );

        if (txResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                error: 'Transaction not found, not borrowed, or email mismatch'
            });
        }

        const oldTx = txResult.rows[0];
        const currentReturn = new Date(oldTx.planned_return);
        const newDate = new Date(new_return_date);

        if (newDate <= currentReturn) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: 'New return date must be later than the current planned return date'
            });
        }

        const updateResult = await client.query(
            `UPDATE transactions SET planned_return = $1 WHERE id = $2 RETURNING *`,
            [new_return_date, transaction_id]
        );
        const newTx = updateResult.rows[0];

        await logInsert({
            targetType: 'transactions',
            targetId: transaction_id,
            newData: newTx,
            userId: req.user?.id || null,
            userEmail: req.user?.username || borrower_email,
            req,
            extraDetails: {
                action: 'extension_requested',
                old_return_date: oldTx.planned_return,
                new_return_date: new_return_date,
                requested_by: borrower_email
            }
        });

        await client.query('COMMIT');

        res.json({
            message: 'Extension request submitted successfully. New return date updated.',
            transaction: newTx
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[requests] /extend error:', err);
        res.status(500).json({ error: 'Failed to process extension: ' + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;