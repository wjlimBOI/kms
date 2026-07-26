const router = require('express').Router();
const { requireAuth, authorize, getUpdatedBy, blockIfReadOnly } = require('../middleware/auth');

async function isKeyBorrowed(db, keyId) {
    const result = await db.query(
        `SELECT EXISTS (
            SELECT 1 FROM transactions 
            WHERE key_id = $1 AND status = 'borrowed'
        ) AS borrowed`,
        [keyId]
    );
    return result.rows[0]?.borrowed || false;
}

async function hasPendingRequests(db, keyId) {
    const result = await db.query(
        `SELECT EXISTS (
            SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
            WHERE r.status = 'pending' AND items.key_id = $1
        ) AS pending`,
        [keyId]
    );
    return result.rows[0]?.pending || false;
}

async function hasTransactionHistory(db, keyId) {
    const result = await db.query(
        `SELECT EXISTS (
            SELECT 1 FROM transactions WHERE key_id = $1 LIMIT 1
        ) AS has_history`,
        [keyId]
    );
    return result.rows[0]?.has_history || false;
}

router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = req.db;
    try {
        const result = await db.query(`
            SELECT 
                k.id, 
                k.brand, 
                k.colour, 
                k.code,
                k.description,
                k.status,
                k.owner,
                k.sets,
                k.date_owned,
                k.remarks,
                k.updated_at,
                k.updated_by,
                (k.status = 'available'
                    AND NOT EXISTS (
                        SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
                        WHERE r.status = 'pending' AND items.key_id = k.id
                    )
                ) AS available,
                EXISTS (
                    SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
                    WHERE r.status = 'pending' AND items.key_id = k.id
                ) AS pending,
                EXISTS (
                    SELECT 1 FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                ) AS is_borrowed,
                (
                    SELECT receiver_signature_name 
                    FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                    ORDER BY t.borrowed_at DESC 
                    LIMIT 1
                ) AS borrower_name,
                (
                    SELECT borrower_email 
                    FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                    ORDER BY t.borrowed_at DESC 
                    LIMIT 1
                ) AS borrower_email,
                (
                    SELECT planned_return 
                    FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                    ORDER BY t.borrowed_at DESC 
                    LIMIT 1
                ) AS planned_return
            FROM keys k
            ORDER BY k.code ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[keys] GET all error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/:id', async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    try {
        const result = await db.query(`
            SELECT 
                k.id, 
                k.brand, 
                k.colour, 
                k.code,
                k.description,
                k.status,
                k.owner,
                k.sets,
                k.date_owned,
                k.remarks,
                k.updated_at,
                k.updated_by,
                (k.status = 'available'
                    AND NOT EXISTS (
                        SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
                        WHERE r.status = 'pending' AND items.key_id = k.id
                    )
                ) AS available,
                EXISTS (
                    SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
                    WHERE r.status = 'pending' AND items.key_id = k.id
                ) AS pending,
                EXISTS (
                    SELECT 1 FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                ) AS is_borrowed,
                (
                    SELECT receiver_signature_name 
                    FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                    ORDER BY t.borrowed_at DESC 
                    LIMIT 1
                ) AS borrower_name,
                (
                    SELECT borrower_email 
                    FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                    ORDER BY t.borrowed_at DESC 
                    LIMIT 1
                ) AS borrower_email,
                (
                    SELECT planned_return 
                    FROM transactions t
                    WHERE t.key_id = k.id AND t.status = 'borrowed'
                    ORDER BY t.borrowed_at DESC 
                    LIMIT 1
                ) AS planned_return
            FROM keys k
            WHERE k.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[keys] GET by id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const db = req.db;
    const { code, brand, colour, description, owner, sets, date_owned, remarks, status } = req.body;

    if (!code || !brand) {
        return res.status(400).json({ error: 'code and brand are required' });
    }

    const finalStatus = ['available', 'lost', 'unavailable'].includes(status) ? status : 'available';
    const updated_by = getUpdatedBy(req);

    try {
        const existing = await db.query('SELECT id FROM keys WHERE code = $1', [code]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Key code already exists' });
        }

        const result = await db.query(
            `INSERT INTO keys 
                (code, brand, colour, description, owner, sets, date_owned, remarks, status, updated_at, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
             RETURNING *`,
            [code, brand, colour || null, description || null, owner || null, sets || null, date_owned || null, remarks || null, finalStatus, updated_by]
        );

        console.log(`[keys] Key created: ${code} by ${updated_by}`);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[keys] POST error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.put('/:id', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    const { code, brand, colour, description, owner, sets, date_owned, remarks, status } = req.body;

    if (!code || !brand) {
        return res.status(400).json({ error: 'code and brand are required' });
    }

    const updated_by = getUpdatedBy(req);

    try {
        const existing = await db.query('SELECT id, status, code FROM keys WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }

        const currentStatus = existing.rows[0].status;
        const currentCode = existing.rows[0].code;

        if (currentStatus === 'borrowed' && status && status !== 'borrowed') {
            return res.status(409).json({ 
                error: 'Key is currently borrowed. Process a return before changing its status.' 
            });
        }

        if (currentStatus === 'borrowed' && code !== currentCode) {
            return res.status(409).json({ 
                error: 'Cannot change code of a borrowed key. Process a return first.' 
            });
        }

        const finalStatus = (status && ['available', 'lost', 'unavailable'].includes(status))
            ? status
            : currentStatus;

        const dup = await db.query('SELECT id FROM keys WHERE code = $1 AND id != $2', [code, id]);
        if (dup.rows.length > 0) {
            return res.status(409).json({ error: 'Key code already used by another key' });
        }

        const result = await db.query(
            `UPDATE keys
             SET code = $1, brand = $2, colour = $3, description = $4,
                 owner = $5, sets = $6, date_owned = $7, remarks = $8,
                 status = $9, updated_at = NOW(), updated_by = $10
             WHERE id = $11
             RETURNING *`,
            [code, brand, colour || null, description || null, owner || null, sets || null, date_owned || null, remarks || null, finalStatus, updated_by, id]
        );

        console.log(`[keys] Key updated: ${code} by ${updated_by} (ID: ${id})`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[keys] PUT error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/:id', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    try {
        const keyCheck = await db.query('SELECT id, code, status FROM keys WHERE id = $1', [id]);
        if (keyCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }

        const key = keyCheck.rows[0];

        if (key.status === 'borrowed' || await isKeyBorrowed(db, id)) {
            return res.status(409).json({ 
                error: 'Cannot delete key: currently borrowed' 
            });
        }

        if (await hasPendingRequests(db, id)) {
            return res.status(409).json({ 
                error: 'Cannot delete key: has pending requests' 
            });
        }

        if (await hasTransactionHistory(db, id)) {
            const updated_by = getUpdatedBy(req);
            await db.query(
                `UPDATE keys SET status = 'archived', updated_at = NOW(), updated_by = $1 WHERE id = $2`,
                [updated_by, id]
            );
            console.log(`[keys] Key archived: ${key.code} by ${updated_by} (has history)`);
            return res.status(200).json({ 
                message: 'Key archived successfully (has transaction history)',
                action: 'archived'
            });
        }

        const result = await db.query('DELETE FROM keys WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }

        console.log(`[keys] Key permanently deleted: ${key.code} by ${getUpdatedBy(req)} (no history)`);
        res.status(204).send();
    } catch (err) {
        console.error('[keys] DELETE error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/unavailable', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    const updated_by = getUpdatedBy(req);

    try {
        const keyCheck = await db.query('SELECT code, status FROM keys WHERE id = $1', [id]);
        if (keyCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }

        const key = keyCheck.rows[0];

        if (key.status === 'borrowed' || await isKeyBorrowed(db, id)) {
            return res.status(409).json({ 
                error: 'Cannot mark as unavailable: key is currently borrowed' 
            });
        }

        const result = await db.query(
            `UPDATE keys 
             SET status = 'lost', updated_at = NOW(), updated_by = $1 
             WHERE id = $2 AND status != 'borrowed' 
             RETURNING *`,
            [updated_by, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(409).json({ error: 'Key not found or currently borrowed' });
        }

        console.log(`[keys] Key marked as lost: ${key.code} by ${updated_by}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[keys] unavailable error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/available', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    const updated_by = getUpdatedBy(req);

    try {
        const keyCheck = await db.query('SELECT code, status FROM keys WHERE id = $1', [id]);
        if (keyCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }

        const key = keyCheck.rows[0];

        if (key.status === 'borrowed' || await isKeyBorrowed(db, id)) {
            return res.status(409).json({ 
                error: 'Cannot mark as available: key is currently borrowed' 
            });
        }

        const result = await db.query(
            `UPDATE keys 
             SET status = 'available', updated_at = NOW(), updated_by = $1 
             WHERE id = $2 AND status != 'borrowed' 
             RETURNING *`,
            [updated_by, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(409).json({ error: 'Key not found or currently borrowed' });
        }

        console.log(`[keys] Key marked as available: ${key.code} by ${updated_by}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[keys] available error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/status', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    const { status } = req.body;
    const validStatuses = ['available', 'lost', 'unavailable', 'archived'];
    
    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ 
            error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
        });
    }

    const updated_by = getUpdatedBy(req);

    try {
        const keyCheck = await db.query('SELECT code, status FROM keys WHERE id = $1', [id]);
        if (keyCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }

        const key = keyCheck.rows[0];

        if (key.status === 'borrowed' || await isKeyBorrowed(db, id)) {
            return res.status(409).json({ 
                error: 'Cannot change status: key is currently borrowed' 
            });
        }

        const result = await db.query(
            `UPDATE keys 
             SET status = $1, updated_at = NOW(), updated_by = $2 
             WHERE id = $3 
             RETURNING *`,
            [status, updated_by, id]
        );

        console.log(`[keys] Key status changed: ${key.code} -> ${status} by ${updated_by}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[keys] status update error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/borrow', requireAuth, authorize('admin'), blockIfReadOnly, async (req, res) => {
    const db = req.db;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

    const { borrower_name, borrower_email, planned_return } = req.body;
    const updated_by = getUpdatedBy(req);

    if (!borrower_name || !borrower_email) {
        return res.status(400).json({ 
            error: 'borrower_name and borrower_email are required' 
        });
    }

    try {
        const keyCheck = await db.query('SELECT code, status FROM keys WHERE id = $1', [id]);
        if (keyCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Key not found' });
        }

        const key = keyCheck.rows[0];

        if (key.status === 'borrowed' || await isKeyBorrowed(db, id)) {
            return res.status(409).json({ error: 'Key is already borrowed' });
        }

        await db.query('BEGIN');

        await db.query(
            `UPDATE keys SET status = 'borrowed', updated_at = NOW(), updated_by = $1 WHERE id = $2`,
            [updated_by, id]
        );

        const result = await db.query(
            `INSERT INTO transactions 
                (key_id, borrower_email, receiver_signature_name, planned_return, status, borrowed_at)
             VALUES ($1, $2, $3, $4, 'borrowed', NOW())
             RETURNING *`,
            [id, borrower_email, borrower_name, planned_return || null]
        );

        await db.query('COMMIT');

        console.log(`[keys] Key manually borrowed: ${key.code} by ${borrower_name} (admin: ${updated_by})`);
        res.json({
            message: 'Key marked as borrowed successfully',
            transaction: result.rows[0]
        });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error('[keys] borrow error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;