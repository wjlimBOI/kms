// scripts/validateAuditChain.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function validateAuditChain() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT id, previous_hash, hash,
                   encode(digest(
                       COALESCE(previous_hash,'') || '|' ||
                       event_type || '|' || COALESCE(user_id::TEXT,'') || '|' ||
                       COALESCE(target_id::TEXT,'') || '|' ||
                       created_at::TEXT || '|' ||
                       COALESCE(old_data::TEXT,'') || '|' ||
                       COALESCE(new_data::TEXT,''),
                   'sha256'), 'hex') AS computed_hash
            FROM audit_log
            ORDER BY id
        `);
        let tampered = false;
        for (const row of res.rows) {
            if (row.hash !== row.computed_hash) {
                console.error(`❌ AUDIT TAMPER DETECTED at id ${row.id}`);
                tampered = true;
            }
        }
        if (!tampered) {
            console.log('✅ Audit chain intact', new Date().toISOString());
        }
        // Optional: send email alert if tampered
        if (tampered && process.env.ADMIN_EMAIL) {
            // Use your emailService to notify admin
            const { sendConfirmationEmail } = require('../services/emailService');
            await sendConfirmationEmail(
                process.env.ADMIN_EMAIL,
                'AUDIT LOG TAMPER DETECTED',
                'The audit trail hash chain has been broken. Investigate immediately.'
            );
        }
    } catch (err) {
        console.error('Audit validation error:', err);
    } finally {
        client.release();
        process.exit(0);
    }
}

validateAuditChain();