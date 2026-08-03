const router = require('express').Router();
const { requireAuth, authorize, requirePermission, blockIfReadOnly } = require('../middleware/auth');
const {
    sendRequestApprovedEmail,
    sendManualWelcomeEmail,
    sendWelcomeEmail
} = require('../services/emailService');
const { logUpdate, logDelete, logInsert } = require('../lib/audit');

async function setAuditContext(req) {
    if (!req.db) return;
    try {
        const userId = req.user?.userId || req.session?.userId;
        const userEmail = req.user?.email || req.session?.username;
        if (userId) await req.db.query('SELECT set_config($1, $2, false)', ['my_app.user_id', userId.toString()]);
        if (userEmail) await req.db.query('SELECT set_config($1, $2, false)', ['my_app.user_email', userEmail]);
        await req.db.query('SELECT set_config($1, $2, false)', ['my_app.client_ip', req.ip]);
        await req.db.query('SELECT set_config($1, $2, false)', ['my_app.user_agent', req.headers['user-agent'] || '']);
    } catch (err) {
        console.warn('[Audit] Context not set:', err.message);
    }
}

async function sendAdminNotification(db, subject, message) {
    try {
        const result = await db.query(`
            SELECT u.email
            FROM admin_notification_recipients a
            JOIN users u ON u.id = a.user_id
            WHERE a.enabled = true AND u.status = 'active'
        `);
        const emails = result.rows.map(r => r.email);
        if (!emails.length) return;
        const { sendEmail } = require('../services/emailService');
        for (const email of emails) {
            await sendEmail(email, subject, message);
        }
    } catch (err) {
        console.error('[admin] sendAdminNotification error:', err);
    }
}

// ============================================================
// TRANSACTIONS
// ============================================================

router.get('/transactions', requireAuth, authorize('admin'), async (req, res) => {
    await setAuditContext(req);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    const {
        giver, receiver, branch, action, status, from, to,
        page = 1,
        limit = 25
    } = req.query;

    const db = req.db;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
        SELECT
          t.*,
          k.code as key_code,
          k.brand,
          k.colour,
          (SELECT planned_return FROM transactions t2
           WHERE t2.key_id = t.key_id AND t2.action = 'borrow'
           ORDER BY t2.borrowed_at DESC LIMIT 1) AS planned_return_at_borrow
        FROM transactions t
        LEFT JOIN keys k ON t.key_id = k.id
        WHERE 1=1
    `;

    let countQuery = `
        SELECT COUNT(*) AS total
        FROM transactions t
        LEFT JOIN keys k ON t.key_id = k.id
        WHERE 1=1
    `;

    const params = [];
    let idx = 1;

    const filterConditions = [];

    if (giver) {
        filterConditions.push(`(t.giver_email ILIKE $${idx} OR t.giver_signature_name ILIKE $${idx})`);
        params.push(`%${giver}%`);
        idx++;
    }
    if (receiver) {
        filterConditions.push(`(t.receiver_email ILIKE $${idx} OR t.receiver_signature_name ILIKE $${idx})`);
        params.push(`%${receiver}%`);
        idx++;
    }
    if (branch) {
        filterConditions.push(`(k.brand ILIKE $${idx} OR k.code ILIKE $${idx})`);
        params.push(`%${branch}%`);
        idx++;
    }
    if (action) {
        filterConditions.push(`t.action = $${idx}`);
        params.push(action);
        idx++;
    }
    if (status) {
        filterConditions.push(`t.status = $${idx}`);
        params.push(status);
        idx++;
    }
    if (from) {
        filterConditions.push(`t.borrowed_at >= $${idx}`);
        params.push(from);
        idx++;
    }
    if (to) {
        filterConditions.push(`t.borrowed_at <= $${idx}`);
        params.push(to);
        idx++;
    }

    if (filterConditions.length > 0) {
        const whereClause = ' AND ' + filterConditions.join(' AND ');
        query += whereClause;
        countQuery += whereClause;
    }

    query += ` ORDER BY t.borrowed_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(parseInt(limit), offset);

    try {
        const [dataResult, countResult] = await Promise.all([
            db.query(query, params),
            db.query(countQuery, params.slice(0, params.length - 2))
        ]);

        const total = parseInt(countResult.rows[0]?.total || 0);

        res.json({
            data: dataResult.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('[admin] /transactions error:', err);
        res.status(500).json({ error: 'Failed to load transactions: ' + err.message });
    }
});

router.post('/force-return', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    await setAuditContext(req);
    const { transaction_id } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldTx = await client.query('SELECT * FROM transactions WHERE id = $1', [transaction_id]);
        if (oldTx.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transaction not found' });
        }

        await client.query('UPDATE transactions SET status = $1, returned_at = NOW() WHERE id = $2', ['returned', transaction_id]);

        await logUpdate({
            targetType: 'transactions',
            targetId: transaction_id,
            oldData: oldTx.rows[0],
            newData: { ...oldTx.rows[0], status: 'returned' },
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'force_return' }
        });

        await client.query('COMMIT');
        res.json({ message: 'Transaction force-returned' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /force-return error:', err);
        res.status(500).json({ error: 'Force return failed: ' + err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// KEY REQUESTS
// ============================================================

router.get('/requests/pending', requireAuth, authorize('admin'), async (req, res) => {
    await setAuditContext(req);
    const db = req.db;
    try {
        const result = await db.query(`
            SELECT
                kr.id,
                kr.requester_name,
                kr.requester_email,
                kr.reason,
                kr.intended_draw_date,
                kr.planned_return,
                kr.items,
                kr.created_at,
                COALESCE(
                    (SELECT json_agg(
                        json_build_object(
                            'key_id', k.id,
                            'code', k.code,
                            'brand', k.brand,
                            'quantity', ki.quantity
                        )
                    )
                    FROM jsonb_array_elements(kr.items) AS ki
                    JOIN keys k ON k.id = (ki->>'key_id')::int
                    ),
                    CASE
                        WHEN kr.key_id IS NOT NULL THEN
                            json_build_array(
                                json_build_object(
                                    'key_id', kr.key_id,
                                    'code', k2.code,
                                    'brand', k2.brand,
                                    'quantity', kr.quantity
                                )
                            )
                        ELSE '[]'::json
                    END
                ) AS key_details
            FROM key_requests kr
            LEFT JOIN keys k2 ON k2.id = kr.key_id
            WHERE kr.status = 'pending'
            ORDER BY kr.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[admin] /requests/pending error:', err);
        res.status(500).json({ error: 'Failed to load pending requests: ' + err.message });
    }
});

router.post('/requests/approve', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    await setAuditContext(req);
    const { request_id, admin_notes } = req.body;
    if (!request_id) return res.status(400).json({ error: 'request_id required' });

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const reqResult = await client.query('SELECT * FROM key_requests WHERE id = $1 AND status = $2', [request_id, 'pending']);
        if (reqResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Request not found or already processed' });
        }

        const request = reqResult.rows[0];
        const adminEmail = req.session?.userEmail || req.user?.email || 'admin@kms.com';
        let items = [];
        try {
            items = typeof request.items === 'string' ? JSON.parse(request.items) : (request.items || []);
        } catch (e) {
            items = [{ key_id: request.key_id, quantity: request.quantity || 1 }];
        }

        for (const item of items) {
            await client.query(
                `INSERT INTO transactions
                 (giver_email, receiver_email, action, key_id, quantity, planned_return, borrowed_at, status,
                  giver_verification_method, giver_signature_name,
                  receiver_verification_method, receiver_signature_name, reason)
                 VALUES ($1, $2, 'borrow', $3, $4, $5, NOW(), 'borrowed', 'admin_approval', $6, 'admin_approval', $7, $8)`,
                [adminEmail, request.requester_email, item.key_id, item.quantity, request.planned_return,
                    'Admin', request.requester_name, request.reason]
            );
        }

        await client.query(
            `UPDATE key_requests SET status = 'approved', admin_notes = $1, approved_at = NOW() WHERE id = $2 RETURNING id`,
            [admin_notes || null, request_id]
        );

        await logUpdate({
            targetType: 'key_requests',
            targetId: request_id,
            oldData: request,
            newData: { ...request, status: 'approved', admin_notes: admin_notes || null, approved_at: new Date() },
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'approve_request', items_approved: items.length }
        });

        await client.query('COMMIT');

        try {
            await sendRequestApprovedEmail(request.requester_email, request.requester_name, items, request.planned_return);
        } catch (emailErr) {
            console.error('Failed to send approval email:', emailErr.message);
        }

        await sendAdminNotification(client,
            `Key Request Approved: ${request.requester_name}`,
            `A key request from ${request.requester_name} (${request.requester_email}) has been approved for ${items.length} key(s).`
        );

        res.json({ message: `Approved ${items.length} key(s).` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /requests/approve error:', err);
        res.status(500).json({ error: 'Approval failed: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/requests/deny', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    await setAuditContext(req);
    const { request_id, admin_notes } = req.body;
    if (!request_id) return res.status(400).json({ error: 'request_id required' });

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldRequest = await client.query('SELECT * FROM key_requests WHERE id = $1 AND status = $2', [request_id, 'pending']);
        if (oldRequest.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Request not found or already processed' });
        }

        await client.query(
            `UPDATE key_requests SET status = 'denied', admin_notes = $1, denied_at = NOW() WHERE id = $2 AND status = 'pending' RETURNING id`,
            [admin_notes || null, request_id]
        );

        await logUpdate({
            targetType: 'key_requests',
            targetId: request_id,
            oldData: oldRequest.rows[0],
            newData: { ...oldRequest.rows[0], status: 'denied', admin_notes: admin_notes || null, denied_at: new Date() },
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'deny_request' }
        });

        await client.query('COMMIT');
        res.json({ message: 'Request denied.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /requests/deny error:', err);
        res.status(500).json({ error: 'Denial failed: ' + err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// AUDIT
// ============================================================

router.get('/audit-health', requireAuth, authorize('admin'), async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT status, message, checked_at, duration_ms FROM audit_health ORDER BY checked_at DESC LIMIT 1`
        );
        if (result.rows.length === 0) return res.json({ status: 'unknown', message: 'No audit health records yet' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[admin] /audit-health error:', err);
        res.status(500).json({ error: 'Failed to fetch audit health: ' + err.message });
    }
});

// ============================================================
// LOST KEYS
// ============================================================

router.get('/lost-keys', requireAuth, authorize('admin'), async (req, res) => {
    try {
        const result = await req.db.query(`
            SELECT
                t.id,
                t.receiver_email AS borrower_email,
                t.receiver_signature_name AS borrower_name,
                t.key_id,
                k.code AS key_code,
                k.brand,
                t.lost_at,
                t.reason AS lost_reason,
                t.resolved_at,
                f.id AS fine_id,
                f.status AS fine_status,
                f.amount
            FROM transactions t
            JOIN keys k ON t.key_id = k.id
            LEFT JOIN fines f ON f.transaction_id = t.id
            WHERE t.status = 'lost'
            ORDER BY t.lost_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[admin] /lost-keys error:', err);
        res.status(500).json({ error: 'Failed to fetch lost keys: ' + err.message });
    }
});

router.get('/lost-keys/:id', requireAuth, authorize('admin'), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.db.query(`
            SELECT
                t.id AS transaction_id,
                t.key_id,
                t.receiver_signature_name AS borrower_name,
                t.receiver_email AS borrower_email,
                t.borrowed_at AS lost_at,
                t.planned_return,
                t.returned_at,
                t.status AS transaction_status,
                t.reason AS lost_reason,
                t.resolved_at,
                k.code AS key_code,
                k.brand,
                k.is_lost,
                f.id AS fine_id,
                f.amount AS fine_amount,
                f.status AS fine_status,
                f.created_at AS fine_created_at,
                f.paid_at AS fine_paid_at,
                f.waived_at AS fine_waived_at
            FROM transactions t
            JOIN keys k ON t.key_id = k.id
            LEFT JOIN fines f ON t.id = f.transaction_id
            WHERE t.id = $1 AND t.status = 'lost'
        `, [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Lost key transaction not found' });
        const row = result.rows[0];
        res.json({
            id: row.transaction_id,
            key_id: row.key_id,
            key_code: row.key_code,
            brand: row.brand,
            is_lost: row.is_lost,
            borrower_name: row.borrower_name,
            borrower_email: row.borrower_email,
            lost_at: row.lost_at,
            planned_return: row.planned_return,
            returned_at: row.returned_at,
            reason: row.lost_reason,
            resolved_at: row.resolved_at,
            fine: row.fine_id ? {
                id: row.fine_id,
                amount: row.fine_amount || 50.00,
                status: row.fine_status,
                created_at: row.fine_created_at,
                paid_at: row.fine_paid_at,
                waived_at: row.fine_waived_at
            } : null
        });
    } catch (err) {
        console.error('[admin] /lost-keys/:id error:', err);
        res.status(500).json({ error: 'Failed to fetch lost key details: ' + err.message });
    }
});

router.post('/lost-keys/:id/update', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;
    const { reason, lost_at, status } = req.body;

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM transactions WHERE id = $1 AND status = $2', [id, 'lost']);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Lost key transaction not found' });
        }

        const updates = [];
        const params = [];
        let idx = 1;
        if (reason !== undefined) {
            updates.push(`reason = $${idx}`);
            params.push(reason);
            idx++;
        }
        if (lost_at !== undefined) {
            updates.push(`lost_at = $${idx}`);
            params.push(lost_at);
            idx++;
        }
        if (status === 'resolved') {
            updates.push(`resolved_at = NOW()`);
        } else if (status === 'lost') {
            updates.push(`resolved_at = NULL`);
        }
        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No fields to update' });
        }
        params.push(id);
        await client.query(
            `UPDATE transactions SET ${updates.join(', ')} WHERE id = $${idx} AND status = 'lost' RETURNING id`,
            params
        );

        const newData = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
        await logUpdate({
            targetType: 'transactions',
            targetId: id,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'update_lost_key' }
        });

        await client.query('COMMIT');
        res.json({ message: 'Lost key updated successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /lost-keys/:id/update error:', err);
        res.status(500).json({ error: 'Failed to update lost key: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/lost-keys/:id/close', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;
    const { resolution_notes } = req.body;

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM transactions WHERE id = $1 AND status = $2 AND resolved_at IS NULL', [id, 'lost']);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Lost ticket not found or already resolved' });
        }

        await client.query(
            `UPDATE transactions SET resolved_at = NOW(), admin_notes = COALESCE(admin_notes, '') || $1
             WHERE id = $2 AND status = 'lost' AND resolved_at IS NULL
             RETURNING id`,
            [resolution_notes ? '\nResolved: ' + resolution_notes : '', id]
        );

        const newData = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
        await logUpdate({
            targetType: 'transactions',
            targetId: id,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'close_lost_ticket', resolution_notes: resolution_notes || null }
        });

        await client.query('COMMIT');
        res.json({ message: 'Ticket closed successfully.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /lost-keys/:id/close error:', err);
        res.status(500).json({ error: 'Failed to close ticket: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/lost-keys/:id/make-available', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const lostTxResult = await client.query(`
            SELECT
                t.*,
                k.id as key_id,
                k.code as key_code,
                k.brand,
                k.status as key_status
            FROM transactions t
            JOIN keys k ON t.key_id = k.id
            WHERE t.id = $1 AND t.status = 'lost'
        `, [id]);

        if (lostTxResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Lost key transaction not found or already resolved' });
        }

        const lostTx = lostTxResult.rows[0];

        await client.query(
            `UPDATE transactions
             SET status = 'returned',
                 returned_at = NOW(),
                 admin_notes = COALESCE(admin_notes, '') || $1,
                 resolved_at = NOW()
             WHERE id = $2 AND status = 'lost'
             RETURNING id`,
            [
                notes ? '\n' + notes + ' (Key found and marked available)' : '\nKey found and marked available by admin.',
                id
            ]
        );

        await client.query(
            `UPDATE keys
             SET status = 'available',
                 updated_at = NOW(),
                 updated_by = $1
             WHERE id = $2
             RETURNING id, status`,
            [req.user?.userId || req.session?.userId, lostTx.key_id]
        );

        const fineResult = await client.query(
            `UPDATE fines
             SET status = 'waived',
                 waived_at = NOW(),
                 waived_by = $1,
                 notes = COALESCE(notes, '') || 'Fine waived - key found and returned to inventory'
             WHERE transaction_id = $2 AND status = 'pending'
             RETURNING id`,
            [req.user?.userId || req.session?.userId, id]
        );

        await logUpdate({
            targetType: 'transactions',
            targetId: id,
            oldData: { transaction: lostTx, key_status: 'lost' },
            newData: { transaction: { ...lostTx, status: 'returned', returned_at: new Date() }, key_status: 'available' },
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: {
                action: 'make_lost_key_available',
                key_code: lostTx.key_code,
                key_id: lostTx.key_id,
                notes: notes || null,
                fine_waived: fineResult.rowCount > 0
            }
        });

        await client.query('COMMIT');

        try {
            await sendAdminNotification(client,
                `Key Found: ${lostTx.key_code} (${lostTx.brand})`,
                `The lost key ${lostTx.key_code} (${lostTx.brand}) has been found and marked as available.\n` +
                `Borrower: ${lostTx.receiver_signature_name || lostTx.receiver_email}\n` +
                `Resolved by: ${req.user?.email || req.session?.username || 'Admin'}\n` +
                `Fine ${fineResult.rowCount > 0 ? 'waived' : 'not applicable'}`
            );
        } catch (notifyErr) {
            console.warn('[admin] Failed to send admin notification:', notifyErr.message);
        }

        res.json({
            success: true,
            message: `Key ${lostTx.key_code} has been marked as available and is back in inventory.`,
            data: {
                transaction_id: id,
                key_id: lostTx.key_id,
                key_code: lostTx.key_code,
                status: 'available',
                fine_waived: fineResult.rowCount > 0
            }
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /lost-keys/:id/make-available error:', err);
        res.status(500).json({ error: 'Failed to mark key as available: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/lost-keys/:transactionId/create-fine', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const transactionId = parseInt(req.params.transactionId);
    if (isNaN(transactionId)) return res.status(400).json({ error: 'Invalid transaction ID' });

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const txRes = await client.query(
            `SELECT t.*, k.code, k.brand FROM transactions t JOIN keys k ON t.key_id = k.id WHERE t.id = $1 AND t.status = 'lost' AND t.resolved_at IS NULL`,
            [transactionId]
        );
        if (txRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transaction not found, not lost, or already resolved' });
        }
        const tx = txRes.rows[0];

        const fineCheck = await client.query('SELECT id FROM fines WHERE transaction_id = $1', [transactionId]);
        if (fineCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Fee already exists for this transaction' });
        }

        await client.query(
            `INSERT INTO fines (user_id, transaction_id, amount, reason, status, issued_at)
             VALUES (NULL, $1, 50.00, $2, 'pending', NOW())`,
            [transactionId, `Key replacement fee: ${tx.code} (${tx.brand})`]
        );

        await logInsert({
            targetType: 'fines',
            targetId: transactionId,
            newData: { transaction_id: transactionId, amount: 50.00, reason: `Key replacement fee: ${tx.code} (${tx.brand})`, status: 'pending' },
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'create_fine', key_code: tx.code }
        });

        await client.query('COMMIT');
        res.json({ message: 'Fee created successfully.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /lost-keys/:transactionId/create-fine error:', err);
        res.status(500).json({ error: 'Failed to create fee: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/fines/:fineId/:action', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { fineId, action } = req.params;
    if (!['paid', 'waived'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use "paid" or "waived".' });
    }

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM fines WHERE id = $1 AND status = $2', [fineId, 'pending']);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Fee not found or already processed' });
        }

        if (action === 'paid') {
            await client.query('UPDATE fines SET status = $1, paid_at = NOW() WHERE id = $2 AND status = $3', ['paid', fineId, 'pending']);
        } else {
            const userId = req.user?.userId || req.session?.userId;
            await client.query('UPDATE fines SET status = $1, waived_at = NOW(), waived_by = $2 WHERE id = $3 AND status = $4', ['waived', userId, fineId, 'pending']);
        }

        const newData = await client.query('SELECT * FROM fines WHERE id = $1', [fineId]);
        await logUpdate({
            targetType: 'fines',
            targetId: fineId,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: `fine_${action}` }
        });

        await client.query('COMMIT');
        res.json({ message: `Fee ${action} successfully.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[admin] /fines/${fineId}/${action} error:`, err);
        res.status(500).json({ error: 'Failed to update fee status: ' + err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// KEY MANAGEMENT
// ============================================================

router.get('/keys', requireAuth, authorize('admin'), async (req, res) => {
    try {
        const result = await req.db.query(`
            SELECT
                k.id,
                k.code,
                k.brand,
                k.status,
                k.is_lost,
                k.updated_at,
                (SELECT name FROM users WHERE id::text = k.updated_by) AS updated_by_name,
                EXISTS(SELECT 1 FROM transactions t WHERE t.key_id = k.id AND t.status = 'borrowed') AS is_borrowed,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'id', ks.id,
                        'owner_name', ks.owner_name,
                        'quantity', ks.quantity,
                        'remarks', ks.remarks
                    ) ORDER BY ks.id)
                    FROM key_sets ks WHERE ks.key_id = k.id),
                    '[]'::json
                ) AS sets,
                COALESCE(
                    (SELECT SUM(quantity) FROM key_sets WHERE key_id = k.id),
                    0
                ) AS total_quantity
            FROM keys k
            ORDER BY k.code ASC
        `);
        const keys = result.rows.map(k => ({
            ...k,
            updated_by: k.updated_by_name || '—',
            last_updated: k.updated_at
        }));
        res.json(keys);
    } catch (err) {
        console.error('[admin] /keys GET error:', err);
        res.status(500).json({ error: 'Failed to fetch keys: ' + err.message });
    }
});

router.get('/keys/:id', requireAuth, authorize('admin'), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.db.query(`
            SELECT
                k.id,
                k.code,
                k.brand,
                k.status,
                k.is_lost,
                k.updated_at,
                (SELECT name FROM users WHERE id::text = k.updated_by) AS updated_by_name,
                EXISTS(SELECT 1 FROM transactions t WHERE t.key_id = k.id AND t.status = 'borrowed') AS is_borrowed,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'id', ks.id,
                        'owner_name', ks.owner_name,
                        'quantity', ks.quantity,
                        'remarks', ks.remarks
                    ) ORDER BY ks.id)
                    FROM key_sets ks WHERE ks.key_id = k.id),
                    '[]'::json
                ) AS sets,
                COALESCE(
                    (SELECT SUM(quantity) FROM key_sets WHERE key_id = k.id),
                    0
                ) AS total_quantity
            FROM keys k
            WHERE k.id = $1
        `, [id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Key not found' });
        const key = result.rows[0];
        key.updated_by = key.updated_by_name || '—';
        res.json(key);
    } catch (err) {
        console.error('[admin] /keys/:id GET error:', err);
        res.status(500).json({ error: 'Failed to fetch key: ' + err.message });
    }
});

router.post('/keys', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { code, brand, sets = [], status = 'available' } = req.body;
    if (!code || !brand) return res.status(400).json({ error: 'Code and brand are required' });
    if (!['available', 'lost', 'unavailable'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Cannot manually set to "borrowed".' });
    }
    const userId = req.user?.userId || req.session?.userId;
    const client = await req.db.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT id FROM keys WHERE code = $1', [code]);
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Key code already exists' });
        }
        const keyResult = await client.query(
            `INSERT INTO keys (code, brand, status, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING id, code, brand, status, updated_at`,
            [code, brand, status, userId]
        );
        const keyId = keyResult.rows[0].id;
        if (sets && Array.isArray(sets) && sets.length) {
            for (const set of sets) {
                await client.query(
                    `INSERT INTO key_sets (key_id, owner_name, quantity, remarks, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
                    [keyId, set.owner_name || 'Unknown', set.quantity || 1, set.remarks || null]
                );
            }
        }
        await client.query('COMMIT');

        await logInsert({
            targetType: 'keys',
            targetId: keyId,
            newData: { code, brand, status, sets },
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'create_key' }
        });

        const result = await client.query(
            `SELECT
                k.id, k.code, k.brand, k.status, k.updated_at,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'id', ks.id,
                        'owner_name', ks.owner_name,
                        'quantity', ks.quantity,
                        'remarks', ks.remarks
                    ) ORDER BY ks.id)
                    FROM key_sets ks WHERE ks.key_id = k.id),
                    '[]'::json
                ) AS sets
             FROM keys k WHERE k.id = $1`,
            [keyId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /keys POST error:', err);
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Key code already exists' });
        }
        res.status(500).json({ error: 'Failed to create key: ' + err.message });
    } finally {
        client.release();
    }
});

router.put('/keys/:id', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;
    const { code, brand, sets = [], status } = req.body;
    if (!code || !brand) return res.status(400).json({ error: 'Code and brand are required' });

    const client = await req.db.connect();
    try {
        await client.query('BEGIN');

        const existing = await client.query('SELECT id, status FROM keys WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Key not found' });
        }
        const currentStatus = existing.rows[0].status;

        if (currentStatus === 'borrowed' && status && status !== 'borrowed') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Key is currently borrowed. Process a return before changing its status.' });
        }
        const finalStatus = (status && ['available', 'lost', 'unavailable'].includes(status))
            ? status
            : currentStatus;

        const dup = await client.query('SELECT id FROM keys WHERE code = $1 AND id != $2', [code, id]);
        if (dup.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Key code already used by another key' });
        }

        const userId = req.user?.userId || req.session?.userId;
        const oldData = await client.query('SELECT * FROM keys WHERE id = $1', [id]);

        await client.query(
            `UPDATE keys SET code = $1, brand = $2, status = $3, updated_by = $4, updated_at = NOW() WHERE id = $5`,
            [code, brand, finalStatus, userId, id]
        );
        await client.query('DELETE FROM key_sets WHERE key_id = $1', [id]);
        for (const set of sets) {
            await client.query(
                `INSERT INTO key_sets (key_id, owner_name, quantity, remarks, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, NOW(), NOW())`,
                [id, set.owner_name || 'Unknown', set.quantity || 1, set.remarks || null]
            );
        }
        await client.query('COMMIT');

        const newData = await client.query('SELECT * FROM keys WHERE id = $1', [id]);
        await logUpdate({
            targetType: 'keys',
            targetId: id,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'update_key' }
        });

        const result = await client.query(
            `SELECT
                k.id, k.code, k.brand, k.status, k.updated_at,
                (SELECT name FROM users WHERE id::text = k.updated_by) AS updated_by_name,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'id', ks.id,
                        'owner_name', ks.owner_name,
                        'quantity', ks.quantity,
                        'remarks', ks.remarks
                    ) ORDER BY ks.id)
                    FROM key_sets ks WHERE ks.key_id = k.id),
                    '[]'::json
                ) AS sets
             FROM keys k WHERE k.id = $1`,
            [id]
        );
        const key = result.rows[0];
        key.updated_by = key.updated_by_name || '—';
        res.json(key);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /keys/:id PUT error:', err);
        res.status(500).json({ error: 'Failed to update key: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/keys/:keyId/unavailable', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const keyId = parseInt(req.params.keyId);
    if (isNaN(keyId)) return res.status(400).json({ error: 'Invalid key ID' });

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM keys WHERE id = $1', [keyId]);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Key not found' });
        }

        const result = await client.query(
            `UPDATE keys SET status = 'unavailable' WHERE id = $1 AND status != 'borrowed' RETURNING id, status`,
            [keyId]
        );
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Key is currently borrowed and cannot be marked unavailable' });
        }

        const newData = await client.query('SELECT * FROM keys WHERE id = $1', [keyId]);
        await logUpdate({
            targetType: 'keys',
            targetId: keyId,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'mark_unavailable' }
        });

        await client.query('COMMIT');
        res.json({ message: 'Key marked as unavailable.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /keys/:keyId/unavailable error:', err);
        res.status(500).json({ error: 'Failed to update key: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/keys/:keyId/available', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const keyId = parseInt(req.params.keyId);
    if (isNaN(keyId)) return res.status(400).json({ error: 'Invalid key ID' });

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM keys WHERE id = $1', [keyId]);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Key not found' });
        }

        const result = await client.query(
            `UPDATE keys SET status = 'available' WHERE id = $1 AND status != 'borrowed' RETURNING id, status`,
            [keyId]
        );
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Key is currently borrowed' });
        }

        const newData = await client.query('SELECT * FROM keys WHERE id = $1', [keyId]);
        await logUpdate({
            targetType: 'keys',
            targetId: keyId,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'mark_available' }
        });

        await client.query('COMMIT');
        res.json({ message: 'Key marked as available again.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /keys/:keyId/available error:', err);
        res.status(500).json({ error: 'Failed to update key: ' + err.message });
    } finally {
        client.release();
    }
});

router.delete('/keys/:id', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;
    const client = await req.db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM keys WHERE id = $1', [id]);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Key not found' });
        }

        await client.query('DELETE FROM key_sets WHERE key_id = $1', [id]);
        await client.query('DELETE FROM keys WHERE id = $1 RETURNING id', [id]);

        await logDelete({
            targetType: 'keys',
            targetId: id,
            oldData: oldData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'delete_key' }
        });

        await client.query('COMMIT');
        res.json({ message: 'Key deleted successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /keys/:id DELETE error:', err);
        res.status(500).json({ error: 'Failed to delete key: ' + err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// USER MANAGEMENT
// ============================================================

router.get('/users', requireAuth, authorize('admin'), async (req, res) => {
    const { search, role, status, page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let idx = 1;
    let whereClauses = [];

    if (search) {
        whereClauses.push(`(u.name ILIKE $${idx} OR u.email ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
    }
    if (role && role !== 'all') {
        whereClauses.push(`u.role = $${idx}`);
        params.push(role);
        idx++;
    }
    if (status && status !== 'all') {
        whereClauses.push(`u.status = $${idx}`);
        params.push(status);
        idx++;
    }

    const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const query = `
        SELECT u.id, u.name, u.email, u.role, u.status, u.last_active AS "lastActive"
        FROM users u
        ${where}
        ORDER BY u.name ASC
        LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const countQuery = `
        SELECT COUNT(*) AS total
        FROM users u
        ${where}
    `;

    try {
        const [dataResult, countResult] = await Promise.all([
            req.db.query(query, [...params, parseInt(limit), offset]),
            req.db.query(countQuery, params)
        ]);
        const total = parseInt(countResult.rows[0]?.total || 0);
        res.json({
            users: dataResult.rows,
            total: total
        });
    } catch (err) {
        console.error('[admin] /users GET error:', err);
        res.status(500).json({ error: 'Failed to fetch users: ' + err.message });
    }
});

router.put('/users/:id', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;
    const { name, email, role, status } = req.body;
    if (!name || !email || !role) {
        return res.status(400).json({ error: 'Name, email, and role are required' });
    }

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM users WHERE id = $1', [id]);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }

        const result = await client.query(
            `UPDATE users
             SET name = $1, email = $2, role = $3, status = $4
             WHERE id = $5
             RETURNING id, name, email, role, status`,
            [name, email, role, status, id]
        );

        const newData = await client.query('SELECT * FROM users WHERE id = $1', [id]);
        await logUpdate({
            targetType: 'users',
            targetId: id,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'update_user' }
        });

        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /users/:id PUT error:', err);
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: 'Failed to update user: ' + err.message });
    } finally {
        client.release();
    }
});

router.patch('/users/:id/suspend', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM users WHERE id = $1', [id]);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }

        const newStatus = oldData.rows[0].status === 'suspended' ? 'active' : 'suspended';
        const result = await client.query(
            `UPDATE users SET status = $1 WHERE id = $2 RETURNING status`,
            [newStatus, id]
        );

        const newData = await client.query('SELECT * FROM users WHERE id = $1', [id]);
        await logUpdate({
            targetType: 'users',
            targetId: id,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'toggle_user_suspend', new_status: newStatus }
        });

        await client.query('COMMIT');
        res.json({ status: result.rows[0].status });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /users/:id/suspend error:', err);
        res.status(500).json({ error: 'Failed to suspend/unsuspend user: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/users/:id/unlock', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { id } = req.params;

    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const oldData = await client.query('SELECT * FROM users WHERE id = $1', [id]);
        if (oldData.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }

        const result = await client.query(
            `UPDATE users SET status = 'active' WHERE id = $1 AND status = 'locked' RETURNING id`,
            [id]
        );
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found or not locked' });
        }

        const newData = await client.query('SELECT * FROM users WHERE id = $1', [id]);
        await logUpdate({
            targetType: 'users',
            targetId: id,
            oldData: oldData.rows[0],
            newData: newData.rows[0],
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'unlock_user' }
        });

        await client.query('COMMIT');
        res.json({ message: 'User unlocked successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /users/:id/unlock error:', err);
        res.status(500).json({ error: 'Failed to unlock user: ' + err.message });
    } finally {
        client.release();
    }
});

router.post('/users/:userId/send-welcome', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { userId } = req.params;
    const db = req.db;

    try {
        const userResult = await db.query(
            'SELECT id, name, email, status FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        if (user.status !== 'active') {
            return res.status(400).json({ error: 'User is not active. Please activate the user first.' });
        }

        const tempPassword = require('crypto').randomBytes(8).toString('hex');
        const bcrypt = require('bcrypt');
        const hashed = await bcrypt.hash(tempPassword, 10);

        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, userId]);

        const changePasswordLink = `${process.env.APP_URL || 'https://kms-staging.onrender.com'}/change-password`;
        await sendManualWelcomeEmail(user.email, user.name, tempPassword, changePasswordLink);

        await logUpdate({
            targetType: 'users',
            targetId: userId,
            oldData: { ...user, password_hash: '[REDACTED]' },
            newData: { ...user, password_hash: '[REDACTED]', password_reset: true },
            userId: req.user?.userId || req.session?.userId,
            userEmail: req.user?.email || req.session?.username,
            req,
            extraDetails: { action: 'send_manual_welcome_email' }
        });

        res.json({ message: `Welcome email sent to ${user.email}` });
    } catch (err) {
        console.error('[admin] /users/:userId/send-welcome error:', err);
        res.status(500).json({ error: 'Failed to send welcome email: ' + err.message });
    }
});

// ============================================================
// PERMISSIONS
// ============================================================

router.get('/permissions/roles', requireAuth, authorize('admin'), async (req, res) => {
    try {
        const result = await req.db.query(`
            SELECT rp.role_name, array_agg(rp.permission_id) AS permission_ids
            FROM role_permissions rp
            GROUP BY rp.role_name
        `);
        const roleMap = {};
        result.rows.forEach(row => {
            roleMap[row.role_name] = row.permission_ids || [];
        });
        res.json(roleMap);
    } catch (err) {
        console.error('[admin] /permissions/roles error:', err);
        res.status(500).json({ error: 'Failed to fetch role permissions: ' + err.message });
    }
});

router.post('/permissions/roles', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { role_name, permission_ids } = req.body;
    if (!role_name || !Array.isArray(permission_ids)) {
        return res.status(400).json({ error: 'role_name and permission_ids array required' });
    }
    const client = await req.db.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM role_permissions WHERE role_name = $1', [role_name]);
        for (const permId of permission_ids) {
            await client.query(
                'INSERT INTO role_permissions (role_name, permission_id) VALUES ($1, $2)',
                [role_name, permId]
            );
        }
        await client.query('COMMIT');
        res.json({ message: 'Permissions updated successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[admin] /permissions/roles POST error:', err);
        res.status(500).json({ error: 'Failed to update permissions: ' + err.message });
    } finally {
        client.release();
    }
});

router.get('/permissions', requireAuth, authorize('admin'), async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT permission_id, permission_code, permission_name FROM permissions ORDER BY permission_code`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[admin] /permissions error:', err);
        res.status(500).json({ error: 'Failed to fetch permissions: ' + err.message });
    }
});

router.get('/user/permissions', requireAuth, async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT p.permission_code
             FROM role_permissions rp
             JOIN permissions p ON p.permission_id = rp.permission_id
             WHERE rp.role_name = $1`,
            [req.user.role]
        );
        res.json(result.rows.map(r => r.permission_code));
    } catch (err) {
        console.error('[admin] /user/permissions error:', err);
        res.status(500).json({ error: 'Failed to fetch permissions: ' + err.message });
    }
});

// ============================================================
// ADMIN NOTIFICATION RECIPIENTS
// ============================================================

router.get('/admin-notification-recipients', requireAuth, requirePermission('manage_notification_settings'), async (req, res) => {
    try {
        const result = await req.db.query(`
            SELECT u.id, u.name, u.email, a.enabled
            FROM admin_notification_recipients a
            JOIN users u ON u.id = a.user_id
            WHERE u.status = 'active'
            ORDER BY u.name ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[admin] /admin-notification-recipients error:', err);
        res.status(500).json({ error: 'Failed to fetch notification recipients: ' + err.message });
    }
});

router.get('/admin-notification-recipients/available', requireAuth, requirePermission('manage_notification_settings'), async (req, res) => {
    try {
        const result = await req.db.query(`
            SELECT id, name, email
            FROM users
            WHERE status = 'active' AND role = 'admin'
            ORDER BY name ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[admin] /admin-notification-recipients/available error:', err);
        res.status(500).json({ error: 'Failed to fetch available users: ' + err.message });
    }
});

router.post('/admin-notification-recipients', requireAuth, requirePermission('manage_notification_settings'), blockIfReadOnly, async (req, res) => {
    const { user_id, enabled = true } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    try {
        const result = await req.db.query(
            `INSERT INTO admin_notification_recipients (user_id, enabled, created_at, updated_at)
             VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (user_id) DO UPDATE SET enabled = $2, updated_at = NOW()
             RETURNING *`,
            [user_id, enabled]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[admin] /admin-notification-recipients POST error:', err);
        res.status(500).json({ error: 'Failed to add notification recipient: ' + err.message });
    }
});

router.delete('/admin-notification-recipients/:userId', requireAuth, requirePermission('manage_notification_settings'), blockIfReadOnly, async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await req.db.query('DELETE FROM admin_notification_recipients WHERE user_id = $1 RETURNING user_id', [userId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Recipient not found' });
        res.json({ message: 'Recipient removed successfully' });
    } catch (err) {
        console.error('[admin] /admin-notification-recipients DELETE error:', err);
        res.status(500).json({ error: 'Failed to remove notification recipient: ' + err.message });
    }
});

// ============================================================
// EMAIL TEMPLATES
// ============================================================

router.get('/email/templates', requireAuth, requirePermission('manage_email_templates'), async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT template_key, subject, body_html, is_active, created_at, updated_at
             FROM email_templates
             ORDER BY template_key`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[admin] /email/templates GET error:', err);
        res.status(500).json({ error: 'Failed to fetch templates: ' + err.message });
    }
});

router.post('/email/templates', requireAuth, requirePermission('manage_email_templates'), blockIfReadOnly, async (req, res) => {
    const { subject, body_html, is_active = true } = req.body;
    if (!subject || !body_html) {
        return res.status(400).json({ error: 'Subject and body are required' });
    }
    const key = req.body.template_key || (subject.toLowerCase().replace(/\s+/g, '_'));
    try {
        const existing = await req.db.query('SELECT template_key FROM email_templates WHERE template_key = $1', [key]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Template key already exists' });
        }
        const result = await req.db.query(
            `INSERT INTO email_templates (template_key, subject, body_html, is_active)
             VALUES ($1, $2, $3, $4)
             RETURNING template_key, subject, body_html, is_active`,
            [key, subject, body_html, is_active]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[admin] /email/templates POST error:', err);
        res.status(500).json({ error: 'Failed to create template: ' + err.message });
    }
});

router.put('/email/templates/:key', requireAuth, requirePermission('manage_email_templates'), blockIfReadOnly, async (req, res) => {
    const { key } = req.params;
    const { subject, body_html, is_active } = req.body;
    if (!subject || !body_html) {
        return res.status(400).json({ error: 'Subject and body are required' });
    }
    try {
        const result = await req.db.query(
            `UPDATE email_templates
             SET subject = $1, body_html = $2, is_active = $3, updated_at = NOW()
             WHERE template_key = $4
             RETURNING template_key, subject, body_html, is_active`,
            [subject, body_html, is_active, key]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[admin] /email/templates PUT error:', err);
        res.status(500).json({ error: 'Failed to update template: ' + err.message });
    }
});

router.delete('/email/templates/:key', requireAuth, requirePermission('manage_email_templates'), blockIfReadOnly, async (req, res) => {
    const { key } = req.params;
    try {
        const result = await req.db.query('DELETE FROM email_templates WHERE template_key = $1 RETURNING template_key', [key]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
        res.json({ message: 'Template deleted' });
    } catch (err) {
        console.error('[admin] /email/templates DELETE error:', err);
        res.status(500).json({ error: 'Failed to delete template: ' + err.message });
    }
});

// ============================================================
// EMAIL SETTINGS
// ============================================================

router.get('/email/settings', requireAuth, requirePermission('manage_notification_settings'), async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT setting_key, enabled, config FROM notification_settings ORDER BY setting_key`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[admin] /email/settings GET error:', err);
        res.status(500).json({ error: 'Failed to fetch settings: ' + err.message });
    }
});

router.put('/email/settings/:key', requireAuth, requirePermission('manage_notification_settings'), blockIfReadOnly, async (req, res) => {
    const { key } = req.params;
    const { enabled, config } = req.body;
    try {
        const result = await req.db.query(
            `UPDATE notification_settings
             SET enabled = $1, config = $2, updated_at = NOW()
             WHERE setting_key = $3
             RETURNING setting_key, enabled, config`,
            [enabled, config || {}, key]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Setting not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[admin] /email/settings PUT error:', err);
        res.status(500).json({ error: 'Failed to update setting: ' + err.message });
    }
});

module.exports = router;