// scripts/validateAuditChain.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function validateAuditChain() {
    const client = await pool.connect();
    let status = 'ok';
    let message = 'Audit chain intact';
    let firstTamperedRowId = null;
    let durationMs = 0;
    const startTime = Date.now();

    try {
        console.log('🔍 Starting audit chain validation...');

        // 1. Get all audit logs with computed hashes
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

        if (res.rows.length === 0) {
            status = 'empty';
            message = 'No audit logs found';
            console.log('📭 No audit logs to validate');
        } else {
            // 2. Check each row for tampering
            for (const row of res.rows) {
                if (row.hash !== row.computed_hash) {
                    status = 'tampered';
                    message = `Audit log tampered at ID ${row.id}`;
                    firstTamperedRowId = row.id;
                    console.error(`❌ AUDIT TAMPER DETECTED at id ${row.id}`);
                    console.error(`   Expected: ${row.hash}`);
                    console.error(`   Computed: ${row.computed_hash}`);
                    break;
                }
            }

            if (status === 'ok') {
                console.log(`✅ Audit chain intact (${res.rows.length} entries)`);
                message = `All ${res.rows.length} audit records verified`;
            }
        }

        durationMs = Date.now() - startTime;

        // 3. SAVE RESULTS TO DATABASE
        await client.query(
            `INSERT INTO audit_health (status, message, first_tampered_row_id, duration_ms, checked_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [status, message, firstTamperedRowId, durationMs]
        );

        console.log(`💾 Results saved to audit_health table (${durationMs}ms)`);

        // 4. Send email alert if tampered
        if (status === 'tampered' && process.env.ADMIN_EMAIL) {
            try {
                const { sendConfirmationEmail } = require('../services/emailService');
                await sendConfirmationEmail(
                    process.env.ADMIN_EMAIL,
                    '🚨 AUDIT LOG TAMPER DETECTED',
                    `The audit trail hash chain has been broken at row ${firstTamperedRowId}.\n\n` +
                    `Please investigate immediately.\n\n` +
                    `Timestamp: ${new Date().toISOString()}`
                );
                console.log('📧 Alert email sent to admin');
            } catch (emailErr) {
                console.error('Failed to send alert email:', emailErr);
            }
        }

        return { status, message, firstTamperedRowId, durationMs };

    } catch (err) {
        console.error('❌ Audit validation error:', err);
        status = 'error';
        message = err.message;
        durationMs = Date.now() - startTime;

        // Save error state
        try {
            await client.query(
                `INSERT INTO audit_health (status, message, duration_ms, checked_at)
                 VALUES ($1, $2, $3, NOW())`,
                [status, message, durationMs]
            );
        } catch (dbErr) {
            console.error('Failed to save error state:', dbErr);
        }

        return { status, message, durationMs };
    } finally {
        client.release();
        console.log(`🔒 Database connection released`);
    }
}

// Run if called directly
if (require.main === module) {
    validateAuditChain()
        .then(result => {
            console.log('✅ Validation complete:', result.status);
            process.exit(result.status === 'ok' || result.status === 'empty' ? 0 : 1);
        })
        .catch(err => {
            console.error('❌ Validation failed:', err);
            process.exit(1);
        });
}

module.exports = { validateAuditChain };