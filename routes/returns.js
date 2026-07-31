const router = require('express').Router();
const crypto = require('crypto');
const { requireAuth, authorize, blockIfReadOnly } = require('../middleware/auth');
const { sendConfirmationEmail } = require('../services/emailService');

router.get('/active-loans', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { borrower_email, borrower_name } = req.query;

    if (!borrower_email && !borrower_name) {
        return res.status(400).json({ error: 'Either borrower_email or borrower_name query param is required' });
    }

    const db = req.db;
    try {
        let result;
        if (borrower_email) {
            result = await db.query(`
                SELECT t.id, t.key_id, t.quantity, t.borrowed_at, t.planned_return,
                       k.code as key_code, k.brand
                FROM transactions t
                JOIN keys k ON t.key_id = k.id
                WHERE t.receiver_email ILIKE $1 AND t.status = 'borrowed'
                ORDER BY t.borrowed_at DESC
            `, [borrower_email]);
        } else {
            result = await db.query(`
                SELECT t.id, t.key_id, t.quantity, t.borrowed_at, t.planned_return,
                       k.code as key_code, k.brand
                FROM transactions t
                JOIN keys k ON t.key_id = k.id
                WHERE t.receiver_signature_name ILIKE $1 AND t.status = 'borrowed'
                ORDER BY t.borrowed_at DESC
            `, [borrower_name]);
        }
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[returns] /active-loans error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/request', async (req, res) => {
    const { borrower_name, borrower_email, loan_ids } = req.body;
    const identifier = borrower_name || borrower_email;
    if (!identifier || !loan_ids || !loan_ids.length) {
        return res.status(400).json({ error: 'Borrower name/email and at least one loan ID required' });
    }
    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        for (const loanId of loan_ids) {
            const txRes = await client.query(`
                SELECT t.id, t.receiver_email, t.receiver_signature_name, t.key_id, k.code, k.brand
                FROM transactions t
                JOIN keys k ON t.key_id = k.id
                WHERE t.id = $1 AND t.status = 'borrowed'
            `, [loanId]);
            if (txRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: `Transaction ${loanId} not found or already processed` });
            }
            const tx = txRes.rows[0];
            const existing = await client.query(
                `SELECT 1 FROM return_requests WHERE transaction_id = $1 AND status = 'pending'`,
                [loanId]
            );
            if (existing.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: `Return already requested for transaction ${loanId}` });
            }
            await client.query(`
                INSERT INTO return_requests (transaction_id, requester_name, requester_email, key_id, key_code, brand)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [loanId, identifier, tx.receiver_email, tx.key_id, tx.code, tx.brand]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Return request submitted. Please hand keys to administrator.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[returns] /request error:', err);
        res.status(500).json({ error: 'Internal server error: ' + err.message });
    } finally {
        client.release();
    }
});

router.get('/pending', requireAuth, authorize('admin'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const db = req.db;
    try {
        const result = await db.query(`
            SELECT rr.id, rr.requester_name, rr.requester_email,
                   string_agg(rr.key_code, ', ') AS key_list,
                   rr.created_at
            FROM return_requests rr
            WHERE rr.status = 'pending'
            GROUP BY rr.id, rr.requester_name, rr.requester_email, rr.created_at
            ORDER BY rr.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[returns] /pending error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/verify', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const { return_request_id } = req.body;
    if (!return_request_id) {
        return res.status(400).json({ error: 'return_request_id required' });
    }
    const db = req.db;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const rrRes = await client.query(
            `SELECT * FROM return_requests WHERE id = $1 AND status = 'pending'`,
            [return_request_id]
        );
        if (rrRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Return request not found or already processed' });
        }
        const returnReq = rrRes.rows[0];
        await client.query(
            `UPDATE transactions SET status = 'returned', returned_at = NOW() WHERE id = $1`,
            [returnReq.transaction_id]
        );
        await client.query(
            `UPDATE return_requests SET status = 'verified', verified_at = NOW() WHERE id = $1`,
            [return_request_id]
        );
        await sendConfirmationEmail(
            returnReq.requester_email,
            'Key Return Confirmed',
            `Dear ${returnReq.requester_name},\n\nYour return of key ${returnReq.key_code} (${returnReq.brand}) has been verified by the administrator. Thank you for returning the key.`
        );
        await client.query('COMMIT');
        res.json({ message: 'Return verified and key marked as available.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[returns] /verify error:', err);
        res.status(500).json({ error: 'Verification failed: ' + err.message });
    } finally {
        client.release();
    }
});

router.get('/:token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const { token } = req.params;
    const db = req.db;
    try {
        const tokenRecord = await db.query(
            'SELECT user_email FROM return_tokens WHERE token = $1 AND expires_at > NOW()',
            [token]
        );
        if (tokenRecord.rowCount === 0) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>Invalid Link</title></head>
                <body style="font-family:Inter, sans-serif; text-align:center; padding:2rem;">
                  <h1>Invalid or expired return link</h1>
                  <p>Please request a new link from the key management system.</p>
                </body>
                </html>
            `);
        }
        const userEmail = tokenRecord.rows[0].user_email;
        const borrows = await db.query(`
            SELECT t.id, t.key_id, t.quantity, t.planned_return, k.code, k.brand, k.colour
            FROM transactions t
            JOIN keys k ON t.key_id = k.id
            WHERE t.receiver_email = $1 AND t.status = 'borrowed'
        `, [userEmail]);

        const csrfToken = req.session?.csrfToken || '';

        let html = `<!DOCTYPE html>
        <html>
        <head>
            <title>Return Keys</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: #f1f5f9;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .container {
                    background: white;
                    max-width: 500px;
                    width: 100%;
                    padding: 32px 28px;
                    border-radius: 16px;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.06);
                }
                h2 {
                    color: #0f172a;
                    font-size: 1.4rem;
                    margin-bottom: 4px;
                }
                .subtitle {
                    color: #64748b;
                    font-size: 0.9rem;
                    margin-bottom: 20px;
                }
                .key-list {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    margin: 16px 0 20px;
                }
                .key-item {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 10px 14px;
                    background: #f8fafc;
                    border-radius: 10px;
                    border: 1px solid #e2e8f0;
                    transition: border-color 0.2s;
                    cursor: pointer;
                }
                .key-item:hover {
                    border-color: #94a3b8;
                }
                .key-item input[type="checkbox"] {
                    width: 18px;
                    height: 18px;
                    accent-color: #3b82f6;
                    flex-shrink: 0;
                    cursor: pointer;
                }
                .key-item .key-info {
                    flex: 1;
                }
                .key-item .key-code {
                    font-weight: 600;
                    color: #0f172a;
                    font-size: 0.95rem;
                }
                .key-item .key-brand {
                    color: #64748b;
                    font-size: 0.8rem;
                    margin-left: 6px;
                }
                .key-item .key-due {
                    color: #94a3b8;
                    font-size: 0.75rem;
                }
                .btn-submit {
                    width: 100%;
                    padding: 12px;
                    background: #3b82f6;
                    color: white;
                    border: none;
                    border-radius: 10px;
                    font-size: 1rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .btn-submit:hover {
                    background: #2563eb;
                }
                .btn-submit:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
                .empty-state {
                    text-align: center;
                    padding: 20px 0;
                    color: #94a3b8;
                }
                .error-message {
                    color: #dc2626;
                    font-size: 0.85rem;
                    margin-top: 10px;
                    display: none;
                }
                .success-message {
                    color: #16a34a;
                    font-size: 0.85rem;
                    margin-top: 10px;
                    display: none;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>Return Keys</h2>
                <p class="subtitle">Select the keys you wish to return</p>
                <p style="color: #475569; font-size: 0.85rem; margin-bottom: 4px;">
                    <strong>Email:</strong> ${userEmail}
                </p>
                <div class="key-list">
                    ${borrows.rows.length === 0 ? `
                        <div class="empty-state">You have no active loans to return.</div>
                    ` : borrows.rows.map(b => `
                        <label class="key-item">
                            <input type="checkbox" name="tx" value="${b.id}">
                            <div class="key-info">
                                <span class="key-code">${b.code}</span>
                                <span class="key-brand">${b.brand}</span>
                                <div class="key-due">Due: ${new Date(b.planned_return).toLocaleDateString()}</div>
                            </div>
                        </label>
                    `).join('')}
                </div>
                <input type="hidden" id="csrfToken" value="${csrfToken}">
                <div id="errorMessage" class="error-message"></div>
                <div id="successMessage" class="success-message"></div>
                <button type="button" id="submitBtn" class="btn-submit" ${borrows.rows.length === 0 ? 'disabled' : ''}>
                    Return Selected Keys
                </button>
            </div>
            <script>
                document.getElementById('submitBtn').addEventListener('click', async () => {
                    const selected = Array.from(document.querySelectorAll('input[name="tx"]:checked')).map(cb => cb.value);
                    const errorEl = document.getElementById('errorMessage');
                    const successEl = document.getElementById('successMessage');
                    const submitBtn = document.getElementById('submitBtn');

                    errorEl.style.display = 'none';
                    successEl.style.display = 'none';

                    if (selected.length === 0) {
                        errorEl.textContent = 'Please select at least one key to return.';
                        errorEl.style.display = 'block';
                        return;
                    }

                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Processing...';

                    try {
                        const csrfToken = document.getElementById('csrfToken').value;
                        const res = await fetch('/api/return/process', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-CSRF-Token': csrfToken
                            },
                            body: JSON.stringify({
                                token: '${token}',
                                transaction_ids: selected
                            })
                        });
                        const data = await res.json();

                        if (res.ok) {
                            successEl.textContent = 'Return(s) processed successfully!';
                            successEl.style.display = 'block';
                            // Disable checkboxes and button
                            document.querySelectorAll('input[name="tx"]').forEach(cb => cb.disabled = true);
                            submitBtn.disabled = true;
                            submitBtn.textContent = 'Completed ✓';
                        } else {
                            errorEl.textContent = data.error || 'An error occurred. Please try again.';
                            errorEl.style.display = 'block';
                        }
                    } catch (err) {
                        errorEl.textContent = 'Network error. Please check your connection and try again.';
                        errorEl.style.display = 'block';
                    } finally {
                        if (!submitBtn.disabled) {
                            submitBtn.disabled = false;
                            submitBtn.textContent = 'Return Selected Keys';
                        }
                    }
                });
            </script>
        </body>
        </html>`;
        res.send(html);
    } catch (err) {
        console.error('[returns] Token page error:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/process', async (req, res) => {
    const { token, transaction_ids } = req.body;
    if (!token || !transaction_ids || !transaction_ids.length) {
        return res.status(400).json({ error: 'Token and transaction IDs required' });
    }
    const db = req.db;
    const client = await db.connect();
    try {
        const tokenRecord = await db.query(
            'SELECT user_email FROM return_tokens WHERE token = $1 AND expires_at > NOW()',
            [token]
        );
        if (tokenRecord.rowCount === 0) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        const userEmail = tokenRecord.rows[0].user_email;
        await client.query('BEGIN');
        for (const txId of transaction_ids) {
            await client.query(
                `UPDATE transactions SET status = 'returned', returned_at = NOW()
                 WHERE id = $1 AND receiver_email = $2 AND status = 'borrowed'`,
                [txId, userEmail]
            );
        }
        await client.query('COMMIT');
        res.json({ message: 'Return(s) processed successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[returns] /process error:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

module.exports = router;