const router = require('express').Router();
const { validateSession, verifiedSessions } = require('./auth');
const { sendConfirmationEmail } = require('../services/emailService');
const { logInsert } = require('../lib/audit');

function formatSingaporeDateTime(isoUtcString) {
    if (!isoUtcString) return '—';
    const date = new Date(isoUtcString);
    const singaporeTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const options = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Singapore'
    };
    return singaporeTime.toLocaleString('en-SG', options);
}

router.post('/complete', async (req, res) => {
    const {
        giver_token,
        receiver_token,
        action,
        items,
        planned_return,
        giver_signature_name,
        receiver_signature_name,
        reason
    } = req.body;

    const giverEmail = validateSession(giver_token, res);
    const receiverEmail = validateSession(receiver_token, res);
    if (!giverEmail || !receiverEmail) return;

    if (giverEmail === receiverEmail) {
        return res.status(400).json({ error: 'Giver and receiver must be different' });
    }

    if (!items || !items.length) {
        return res.status(400).json({ error: 'At least one key is required' });
    }

    if (!giver_signature_name || !receiver_signature_name) {
        return res.status(400).json({ error: 'Both parties must provide their name (signature)' });
    }

    const db = req.db;
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const insertedIds = [];
        const insertedRows = [];

        for (const item of items) {
            const { key_id, quantity } = item;
            let query, values, auditAction;

            if (action === 'borrow') {
                query = `
                    INSERT INTO transactions (
                        giver_email, receiver_email, action, key_id, quantity,
                        planned_return,
                        giver_verification_method, giver_signature_name,
                        receiver_verification_method, receiver_signature_name,
                        reason
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6,
                        'otp_with_signature', $7,
                        'otp_with_signature', $8,
                        $9
                    ) RETURNING *
                `;
                values = [
                    giverEmail,
                    receiverEmail,
                    action,
                    key_id,
                    quantity,
                    planned_return || null,
                    giver_signature_name,
                    receiver_signature_name,
                    reason || null
                ];
                auditAction = 'borrow_handover';
            } else if (action === 'return') {
                query = `
                    INSERT INTO transactions (
                        giver_email, receiver_email, action, key_id, quantity,
                        returned_at, status,
                        giver_verification_method, giver_signature_name,
                        receiver_verification_method, receiver_signature_name,
                        reason
                    ) VALUES (
                        $1, $2, $3, $4, $5,
                        NOW(), 'returned',
                        'otp_with_signature', $6,
                        'otp_with_signature', $7,
                        NULL
                    ) RETURNING *
                `;
                values = [
                    giverEmail,
                    receiverEmail,
                    action,
                    key_id,
                    quantity,
                    giver_signature_name,
                    receiver_signature_name
                ];
                auditAction = 'return_handover';
            } else {
                throw new Error('Invalid action. Must be "borrow" or "return".');
            }

            const result = await client.query(query, values);
            const newTrans = result.rows[0];
            insertedIds.push(newTrans.id);
            insertedRows.push(newTrans);

            await logInsert({
                targetType: 'transactions',
                targetId: newTrans.id,
                newData: newTrans,
                userId: null,
                userEmail: giverEmail,
                req,
                extraDetails: {
                    action: auditAction,
                    giver_email: giverEmail,
                    receiver_email: receiverEmail
                }
            });
        }

        await client.query('COMMIT');

        const keyDetails = await Promise.all(
            items.map(async (item) => {
                const { rows } = await db.query(
                    'SELECT code, brand FROM keys WHERE id = $1',
                    [item.key_id]
                );
                const key = rows[0];
                return `${item.quantity} × ${key.code} (${key.brand})`;
            })
        );
        const keyList = keyDetails.join(', ');

        let subject, body;
        const nowFormatted = formatSingaporeDateTime(new Date().toISOString());

        if (action === 'borrow') {
            subject = `[BOI KMS] Key Borrow Handover Confirmation – ${nowFormatted}`;
            body = `
                <p>This is to confirm a key borrow handover.</p>
                <ul>
                    <li><strong>Giver:</strong> ${giver_signature_name} (${giverEmail})</li>
                    <li><strong>Receiver:</strong> ${receiver_signature_name} (${receiverEmail})</li>
                    <li><strong>Keys:</strong> ${keyList}</li>
                    <li><strong>Planned Return:</strong> ${planned_return ? formatSingaporeDateTime(planned_return) : 'Not specified'}</li>
                    ${reason ? `<li><strong>Reason:</strong> ${reason}</li>` : ''}
                    <li><strong>Time:</strong> ${nowFormatted}</li>
                </ul>
                <p>Please keep this email for your records.</p>
            `;
        } else {
            subject = `[BOI KMS] Key Return Handover Confirmation – ${nowFormatted}`;
            body = `
                <p>This is to confirm a key return handover.</p>
                <ul>
                    <li><strong>Returner (Giver):</strong> ${giver_signature_name} (${giverEmail})</li>
                    <li><strong>Receiver (Admin):</strong> ${receiver_signature_name} (${receiverEmail})</li>
                    <li><strong>Keys:</strong> ${keyList}</li>
                    <li><strong>Time:</strong> ${nowFormatted}</li>
                </ul>
                <p>The keys have been physically returned and logged.</p>
            `;
        }

        await Promise.all([
            sendConfirmationEmail(giverEmail, subject, body, null),
            sendConfirmationEmail(receiverEmail, subject, body, null)
        ]);

        verifiedSessions.delete(giver_token);
        verifiedSessions.delete(receiver_token);

        res.status(201).json({ transaction_ids: insertedIds });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Handover error:', err);
        res.status(500).json({ error: 'Internal server error: ' + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;