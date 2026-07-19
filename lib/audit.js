// lib/audit.js

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

  const query = `
    INSERT INTO audit_log (
      event_type, severity, user_id, user_email,
      target_type, target_id, old_data, new_data,
      ip_address, user_agent, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
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
    userAgent
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

module.exports = { logInsert, logUpdate, logDelete, logAuthEvent };