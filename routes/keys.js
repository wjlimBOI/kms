const router = require('express').Router();

function getUpdatedBy(req) {
  return (req.user && req.user.name) || (req.user && req.user.email) || 'system';
}

// GET all keys
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
        k.is_lost,
        k.owner,
        k.sets,
        k.date_owned,
        k.remarks,
        k.updated_at,
        k.updated_by,
        NOT EXISTS (
          SELECT 1 FROM transactions t
          WHERE t.key_id = k.id AND t.status = 'borrowed'
        ) AND NOT EXISTS (
          SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
          WHERE r.status = 'pending' AND items.key_id = k.id
        ) AND k.is_lost = false AS available,
        EXISTS (
          SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
          WHERE r.status = 'pending' AND items.key_id = k.id
        ) AS pending,
        (
          SELECT receiver_signature_name 
          FROM transactions t
          WHERE t.key_id = k.id AND t.status = 'borrowed'
          ORDER BY t.borrowed_at DESC 
          LIMIT 1
        ) AS borrower_name,
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

// GET a single key by ID
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
        k.is_lost,
        k.owner,
        k.sets,
        k.date_owned,
        k.remarks,
        k.updated_at,
        k.updated_by,
        NOT EXISTS (
          SELECT 1 FROM transactions t
          WHERE t.key_id = k.id AND t.status = 'borrowed'
        ) AND NOT EXISTS (
          SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
          WHERE r.status = 'pending' AND items.key_id = k.id
        ) AND k.is_lost = false AS available,
        EXISTS (
          SELECT 1 FROM key_requests r, jsonb_to_recordset(r.items) AS items(key_id INT)
          WHERE r.status = 'pending' AND items.key_id = k.id
        ) AS pending,
        (
          SELECT receiver_signature_name 
          FROM transactions t
          WHERE t.key_id = k.id AND t.status = 'borrowed'
          ORDER BY t.borrowed_at DESC 
          LIMIT 1
        ) AS borrower_name,
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

// POST - create a new key
router.post('/', async (req, res) => {
  const db = req.db;
  const { code, brand, colour, description, owner, sets, date_owned, remarks, is_lost } = req.body;

  if (!code || !brand) {
    return res.status(400).json({ error: 'code and brand are required' });
  }

  const updated_by = getUpdatedBy(req);

  try {
    const existing = await db.query('SELECT id FROM keys WHERE code = $1', [code]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Key code already exists' });
    }

    const result = await db.query(
      `INSERT INTO keys 
        (code, brand, colour, description, owner, sets, date_owned, remarks, is_lost, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
       RETURNING *`,
      [code, brand, colour || null, description || null, owner || null, sets || null, date_owned || null, remarks || null, is_lost || false, updated_by]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[keys] POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT - update an existing key
router.put('/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

  const { code, brand, colour, description, owner, sets, date_owned, remarks, is_lost } = req.body;

  if (!code || !brand) {
    return res.status(400).json({ error: 'code and brand are required' });
  }

  const updated_by = getUpdatedBy(req);

  try {
    const existing = await db.query('SELECT id FROM keys WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }

    const dup = await db.query('SELECT id FROM keys WHERE code = $1 AND id != $2', [code, id]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'Key code already used by another key' });
    }

    const result = await db.query(
      `UPDATE keys
       SET code = $1, brand = $2, colour = $3, description = $4,
           owner = $5, sets = $6, date_owned = $7, remarks = $8,
           is_lost = $9, updated_at = NOW(), updated_by = $10
       WHERE id = $11
       RETURNING *`,
      [code, brand, colour || null, description || null, owner || null, sets || null, date_owned || null, remarks || null, is_lost || false, updated_by, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[keys] PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE - remove a key
router.delete('/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

  try {
    const result = await db.query('DELETE FROM keys WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('[keys] DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/unavailable - mark as lost
router.post('/:id/unavailable', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

  const updated_by = getUpdatedBy(req);

  try {
    const result = await db.query(
      `UPDATE keys SET is_lost = true, updated_at = NOW(), updated_by = $1 WHERE id = $2 RETURNING *`,
      [updated_by, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[keys] unavailable error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/available - mark as available (not lost)
router.post('/:id/available', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid key ID' });

  const updated_by = getUpdatedBy(req);

  try {
    const result = await db.query(
      `UPDATE keys SET is_lost = false, updated_at = NOW(), updated_by = $1 WHERE id = $2 RETURNING *`,
      [updated_by, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[keys] available error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;