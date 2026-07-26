const crypto = require('crypto');

async function logAudit({
  eventType,
  severity = 'INFO',
  userId,
  userEmail,
  targetType,
  targetId,
  oldData,
  newData,
  req,
  extraDetails = {}
}) {
  const db = req.db;
  if (!db) {
    console.error('Audit error: req.db not available');
    return;
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  let finalNewData = newData;
  if (extraDetails && Object.keys(extraDetails).length > 0) {
    if (newData && typeof newData === 'object') {
      finalNewData = { ...newData, ...extraDetails };
    } else {
      finalNewData = extraDetails;
    }
  }

  const hash = crypto.createHash('sha256');
  const hashData = `${eventType}|${targetType}|${targetId || ''}|${JSON.stringify(finalNewData || {})}|${Date.now()}`;
  const chainHash = hash.update(hashData).digest('hex');

  const query = `
    INSERT INTO audit_log (
      event_type, severity, user_id, user_email,
      target_type, target_id, old_data, new_data,
      ip_address, user_agent, created_at, chain_hash
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
  `;
  const params = [
    eventType,
    severity,
    userId || null,
    userEmail || null,
    targetType,
    targetId !== undefined && targetId !== null ? String(targetId) : null,
    oldData ? JSON.stringify(oldData) : null,
    finalNewData ? JSON.stringify(finalNewData) : null,
    ip,
    userAgent,
    chainHash
  ];
  await db.query(query, params);
}

async function logInsert({ targetType, targetId, newData, userId, userEmail, req, extraDetails = {} }) {
  await logAudit({
    eventType: 'INSERT',
    userId,
    userEmail,
    targetType,
    targetId,
    oldData: null,
    newData,
    req,
    extraDetails
  });
}

async function logUpdate({ targetType, targetId, oldData, newData, userId, userEmail, req, extraDetails = {} }) {
  await logAudit({
    eventType: 'UPDATE',
    userId,
    userEmail,
    targetType,
    targetId,
    oldData,
    newData,
    req,
    extraDetails
  });
}

async function logDelete({ targetType, targetId, oldData, userId, userEmail, req, extraDetails = {} }) {
  await logAudit({
    eventType: 'DELETE',
    userId,
    userEmail,
    targetType,
    targetId,
    oldData,
    newData: null,
    req,
    extraDetails
  });
}

async function logAuthEvent({ eventType, userId, userEmail, req, extraDetails = {} }) {
  await logAudit({
    eventType,
    severity: eventType === 'LOGIN_FAILED' ? 'WARNING' : 'INFO',
    userId,
    userEmail,
    targetType: 'auth',
    targetId: null,
    oldData: null,
    newData: extraDetails,
    req,
    extraDetails: {}
  });
}

async function logCustomEvent({ 
  eventType, 
  severity = 'INFO',
  userId, 
  userEmail, 
  targetType, 
  targetId, 
  data, 
  req, 
  extraDetails = {} 
}) {
  await logAudit({
    eventType,
    severity,
    userId,
    userEmail,
    targetType,
    targetId,
    oldData: null,
    newData: data,
    req,
    extraDetails
  });
}

async function verifyChain(db) {
  try {
    const result = await db.query(
      `SELECT id, event_type, target_type, target_id, new_data, created_at, chain_hash 
       FROM audit_log 
       ORDER BY id ASC`
    );
    
    if (result.rows.length === 0) {
      return { status: 'ok', message: 'No entries to verify' };
    }

    let previousHash = null;
    let tampered = false;
    let tamperedId = null;

    for (const row of result.rows) {
      const hash = crypto.createHash('sha256');
      const hashData = `${row.event_type}|${row.target_type}|${row.target_id || ''}|${row.new_data || '{}'}|${new Date(row.created_at).getTime()}`;
      const expectedHash = hash.update(hashData).digest('hex');

      if (row.chain_hash !== expectedHash) {
        tampered = true;
        tamperedId = row.id;
        break;
      }

      if (previousHash && row.chain_hash !== previousHash) {
        tampered = true;
        tamperedId = row.id;
        break;
      }

      previousHash = row.chain_hash;
    }

    if (tampered) {
      return { 
        status: 'tampered', 
        message: `Chain integrity compromised at entry ${tamperedId}`,
        tamperedId 
      };
    }

    return { 
      status: 'ok', 
      message: 'Chain integrity verified',
      totalEntries: result.rows.length,
      lastEntryId: result.rows[result.rows.length - 1]?.id || null
    };
  } catch (err) {
    console.error('Chain verification error:', err);
    return { 
      status: 'error', 
      message: 'Failed to verify chain: ' + err.message 
    };
  }
}

async function getAuditLogs(db, options = {}) {
  const {
    page = 1,
    limit = 25,
    eventType,
    targetType,
    targetId,
    userId,
    userEmail,
    fromDate,
    toDate,
    search
  } = options;

  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (eventType) {
    conditions.push(`event_type = $${paramIndex++}`);
    params.push(eventType);
  }

  if (targetType) {
    conditions.push(`target_type = $${paramIndex++}`);
    params.push(targetType);
  }

  if (targetId) {
    conditions.push(`target_id = $${paramIndex++}`);
    params.push(String(targetId));
  }

  if (userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(userId);
  }

  if (userEmail) {
    conditions.push(`user_email ILIKE $${paramIndex++}`);
    params.push(`%${userEmail}%`);
  }

  if (fromDate) {
    conditions.push(`created_at >= $${paramIndex++}`);
    params.push(fromDate);
  }

  if (toDate) {
    conditions.push(`created_at <= $${paramIndex++}`);
    params.push(toDate);
  }

  if (search) {
    conditions.push(`(
      event_type ILIKE $${paramIndex} OR 
      target_type ILIKE $${paramIndex} OR 
      target_id::text ILIKE $${paramIndex} OR 
      user_email ILIKE $${paramIndex}
    )`);
    params.push(`%${search}%`);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countQuery = `SELECT COUNT(*) AS total FROM audit_log ${whereClause}`;
  const countResult = await db.query(countQuery, params);
  const total = parseInt(countResult.rows[0]?.total || 0);

  const dataQuery = `
    SELECT id, event_type, severity, user_id, user_email,
           target_type, target_id, old_data, new_data,
           ip_address, user_agent, created_at, chain_hash
    FROM audit_log
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}
  `;
  params.push(limit, offset);

  const dataResult = await db.query(dataQuery, params);

  const rows = dataResult.rows.map(row => {
    if (row.old_data && typeof row.old_data === 'string') {
      try { row.old_data = JSON.parse(row.old_data); } catch (e) {}
    }
    if (row.new_data && typeof row.new_data === 'string') {
      try { row.new_data = JSON.parse(row.new_data); } catch (e) {}
    }
    return row;
  });

  return {
    data: rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

async function getAuditLogById(db, id) {
  const result = await db.query(
    `SELECT id, event_type, severity, user_id, user_email,
            target_type, target_id, old_data, new_data,
            ip_address, user_agent, created_at, chain_hash
     FROM audit_log
     WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  if (row.old_data && typeof row.old_data === 'string') {
    try { row.old_data = JSON.parse(row.old_data); } catch (e) {}
  }
  if (row.new_data && typeof row.new_data === 'string') {
    try { row.new_data = JSON.parse(row.new_data); } catch (e) {}
  }

  return row;
}

module.exports = { 
  logInsert, 
  logUpdate, 
  logDelete, 
  logAuthEvent,
  logCustomEvent,
  verifyChain,
  getAuditLogs,
  getAuditLogById
};