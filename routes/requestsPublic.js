const router = require('express').Router();
const { z } = require('zod');
const { sendRequestSubmittedEmail, sendAdminNewRequestAlert } = require('../services/emailService');

// Validation Schemas
const itemSchema = z.object({
    key_id: z.number().int().positive({ message: 'Key ID must be a positive integer' }),
    quantity: z.number().int().min(1, { message: 'Quantity must be at least 1' }).default(1),
});

const requestSchema = z.object({
    requester_name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters').trim(),
    requester_email: z.string().min(1, 'Email is required').email('Invalid email format').max(255).trim().toLowerCase(),
    items: z.array(itemSchema).min(1, 'At least one key is required').max(50, 'Maximum 50 keys per request'),
    reason: z.string().max(500, 'Reason must be less than 500 characters').trim().optional().nullable(),
    intended_draw_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Intended draw date must be in YYYY-MM-DD format').optional().nullable(),
    planned_return: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Planned return date must be in YYYY-MM-DD format').min(1, 'Planned return date is required'),
});

// Submit a key request
router.post('/submit', async (req, res) => {
    const db = req.db;
    const client = await db.connect();

    try {
        const validatedData = requestSchema.safeParse(req.body);
        if (!validatedData.success) {
            return res.status(400).json({
                error: 'Validation failed',
                details: validatedData.error.errors.map(err => ({ field: err.path.join('.'), message: err.message })),
            });
        }

        const { requester_name, requester_email, items, reason, intended_draw_date, planned_return } = validatedData.data;

        const keyIds = items.map(item => item.key_id);
        const keyCheck = await client.query(`SELECT id, code, brand, status FROM keys WHERE id = ANY($1)`, [keyIds]);

        const foundKeyIds = keyCheck.rows.map(row => row.id);
        const missingKeyIds = keyIds.filter(id => !foundKeyIds.includes(id));
        if (missingKeyIds.length > 0) {
            return res.status(400).json({ error: 'Invalid keys provided', details: `Keys not found: ${missingKeyIds.join(', ')}` });
        }

        const borrowedKeys = keyCheck.rows.filter(row => row.status === 'borrowed');
        if (borrowedKeys.length > 0) {
            return res.status(409).json({
                error: 'Some keys are currently borrowed',
                details: `Borrowed keys: ${borrowedKeys.map(k => k.code).join(', ')}`,
                keys: borrowedKeys.map(k => ({ id: k.id, code: k.code })),
            });
        }

        const pendingCheck = await client.query(
            `SELECT kr.id, kr.requester_name, kr.items
             FROM key_requests kr
             WHERE kr.status = 'pending'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(kr.items) AS i WHERE (i->>'key_id')::INT = ANY($1))`,
            [keyIds]
        );

        if (pendingCheck.rowCount > 0) {
            return res.status(409).json({
                error: 'One or more keys already have pending requests',
                conflicting_requests: pendingCheck.rows.map(row => ({ requestId: row.id, requester: row.requester_name })),
            });
        }

        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO key_requests (requester_name, requester_email, items, reason, intended_draw_date, planned_return)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
            [requester_name, requester_email, JSON.stringify(items), reason || null, intended_draw_date || null, planned_return]
        );

        const newRequestId = result.rows[0].id;
        const createdAt = result.rows[0].created_at;

        await client.query('COMMIT');

        const itemsWithDetails = items.map(item => {
            const key = keyCheck.rows.find(k => k.id === item.key_id);
            return { ...item, code: key?.code || 'Unknown', brand: key?.brand || 'Unknown' };
        });

        try {
            await sendRequestSubmittedEmail(requester_email, requester_name, itemsWithDetails, planned_return);
        } catch (emailErr) {
            console.error('[requestsPublic] Failed to send confirmation email:', emailErr.message);
        }

        try {
            const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
            if (adminEmail) {
                await sendAdminNewRequestAlert(adminEmail, {
                    id: newRequestId,
                    requester_name,
                    requester_email,
                    items: itemsWithDetails,
                    planned_return,
                    created_at: createdAt,
                });
            }
        } catch (adminErr) {
            console.error('[requestsPublic] Failed to send admin notification:', adminErr.message);
        }

        res.status(201).json({
            success: true,
            message: 'Request submitted successfully. Awaiting admin approval.',
            request_id: newRequestId,
            items: itemsWithDetails.map(item => ({ key_id: item.key_id, code: item.code, brand: item.brand, quantity: item.quantity })),
            created_at: createdAt,
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[requestsPublic] Error submitting request:', err);
        res.status(500).json({
            error: 'Failed to submit request',
            message: process.env.NODE_ENV === 'development' ? err.message : 'An internal error occurred. Please try again later.',
        });
    } finally {
        client.release();
    }
});

// Get request status by email
router.get('/status', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        const result = await req.db.query(
            `SELECT id, requester_name, requester_email, items, status, reason, planned_return, created_at, approved_at, denied_at, admin_notes
             FROM key_requests
             WHERE requester_email = $1 AND status != 'approved'
             ORDER BY created_at DESC LIMIT 10`,
            [email.toLowerCase()]
        );

        res.json({
            requests: result.rows.map(row => ({
                id: row.id,
                status: row.status,
                items: row.items,
                reason: row.reason,
                planned_return: row.planned_return,
                created_at: row.created_at,
                admin_notes: row.admin_notes,
            })),
        });
    } catch (err) {
        console.error('[requestsPublic] Error fetching status:', err);
        res.status(500).json({ error: 'Failed to fetch request status' });
    }
});

// Cancel a pending request
router.delete('/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const { email } = req.body;

    if (!email) return res.status(400).json({ error: 'Email is required to cancel a request' });
    if (!requestId || isNaN(parseInt(requestId))) return res.status(400).json({ error: 'Invalid request ID' });

    const db = req.db;
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const requestCheck = await client.query(
            `SELECT id, requester_email, status FROM key_requests WHERE id = $1 AND requester_email = $2 AND status = 'pending'`,
            [requestId, email.toLowerCase()]
        );

        if (requestCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pending request not found or does not belong to this email' });
        }

        await client.query(
            `UPDATE key_requests SET status = 'cancelled', admin_notes = COALESCE(admin_notes, '') || 'Cancelled by requester', denied_at = NOW() WHERE id = $1`,
            [requestId]
        );

        await client.query('COMMIT');

        res.json({ success: true, message: 'Request cancelled successfully', request_id: requestId });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[requestsPublic] Error cancelling request:', err);
        res.status(500).json({
            error: 'Failed to cancel request',
            message: process.env.NODE_ENV === 'development' ? err.message : 'An internal error occurred',
        });
    } finally {
        client.release();
    }
});

module.exports = router;