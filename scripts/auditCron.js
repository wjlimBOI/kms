// scripts/auditCron.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const { sendConfirmationEmail } = require('../services/emailService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function validateAuditChain() {
    const startTime = Date.now();
    const client = await pool.connect();
    let status = 'ok';
    let message = 'Audit chain intact';
    let firstTamperedId = null;

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
                if (!firstTamperedId) firstTamperedId = row.id;
                tampered = true;
            }
        }
        
        if (tampered) {
            status = 'tampered';
            message = `Tampering detected. First affected row ID: ${firstTamperedId}`;
            console.error(message);
            
            if (process.env.ADMIN_EMAIL) {
                await sendConfirmationEmail(
                    process.env.ADMIN_EMAIL,
                    'AUDIT LOG TAMPER DETECTED',
                    message
                );
            }
        } else {
            console.log(`✅ Audit chain intact - ${new Date().toISOString()}`);
        }
    } catch (err) {
        status = 'error';
        message = `Validation error: ${err.message}`;
        console.error(message);
    } finally {
        const duration = Date.now() - startTime;
        
        // Insert health record
        await client.query(
            `INSERT INTO audit_health (status, message, first_tampered_row_id, duration_ms)
             VALUES ($1, $2, $3, $4)`,
            [status, message, firstTamperedId, duration]
        );
        client.release();
    }
}

validateAuditChain()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Cron failed:', err);
        process.exit(1);
    });