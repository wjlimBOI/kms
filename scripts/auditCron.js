// scripts/auditCron.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const { sendConfirmationEmail } = require('../services/emailService');

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function validateAuditChain() {
    const startTime = Date.now();
    const client = await pool.connect();
    let status = 'ok';
    let message = 'Audit chain intact';
    let firstTamperedId = null;
    let tamperedIds = [];

    try {
        console.log(`[${new Date().toISOString()}] 🔍 Starting audit chain validation...`);

        // Get all audit logs with computed hashes
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
            console.log(`[${new Date().toISOString()}] 📭 No audit logs to validate`);
        } else {
            let tampered = false;
            
            for (const row of res.rows) {
                if (row.hash !== row.computed_hash) {
                    console.error(`❌ AUDIT TAMPER DETECTED at id ${row.id}`);
                    console.error(`   Expected: ${row.hash}`);
                    console.error(`   Computed: ${row.computed_hash}`);
                    
                    if (!firstTamperedId) firstTamperedId = row.id;
                    tamperedIds.push(row.id);
                    tampered = true;
                }
            }

            if (tampered) {
                status = 'tampered';
                message = `Tampering detected. First affected row ID: ${firstTamperedId}. Total tampered: ${tamperedIds.length}`;
                console.error(`[${new Date().toISOString()}] ${message}`);
                
                // Send email alert if tampered
                if (process.env.ADMIN_EMAIL) {
                    try {
                        await sendConfirmationEmail(
                            process.env.ADMIN_EMAIL,
                            '🚨 AUDIT LOG TAMPER DETECTED',
                            `The audit trail hash chain has been broken.\n\n` +
                            `First affected row ID: ${firstTamperedId}\n` +
                            `Total tampered rows: ${tamperedIds.length}\n` +
                            `All affected IDs: ${tamperedIds.join(', ')}\n\n` +
                            `Timestamp: ${new Date().toISOString()}\n\n` +
                            `Please investigate immediately.`
                        );
                        console.log(`[${new Date().toISOString()}] 📧 Alert email sent to admin`);
                    } catch (emailErr) {
                        console.error(`[${new Date().toISOString()}] Failed to send alert email:`, emailErr);
                    }
                }
            } else {
                console.log(`[${new Date().toISOString()}] ✅ Audit chain intact (${res.rows.length} entries)`);
                message = `All ${res.rows.length} audit records verified`;
            }
        }

        const duration = Date.now() - startTime;

        // Insert health record
        await client.query(
            `INSERT INTO audit_health (status, message, first_tampered_row_id, duration_ms, checked_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [status, message, firstTamperedId, duration]
        );

        console.log(`[${new Date().toISOString()}] 💾 Results saved to audit_health table (${duration}ms)`);

        return { status, message, firstTamperedId, tamperedIds, duration };

    } catch (err) {
        status = 'error';
        message = `Validation error: ${err.message}`;
        console.error(`[${new Date().toISOString()}] ❌ ${message}`);
        
        // Save error state
        try {
            const duration = Date.now() - startTime;
            await client.query(
                `INSERT INTO audit_health (status, message, duration_ms, checked_at)
                 VALUES ($1, $2, $3, NOW())`,
                [status, message, duration]
            );
        } catch (dbErr) {
            console.error(`[${new Date().toISOString()}] Failed to save error state:`, dbErr);
        }

        return { status, message, duration: Date.now() - startTime };
    } finally {
        client.release();
        console.log(`[${new Date().toISOString()}] 🔒 Database connection released`);
    }
}

// Run if called directly
if (require.main === module) {
    validateAuditChain()
        .then(result => {
            console.log(`[${new Date().toISOString()}] ✅ Validation complete. Status: ${result.status}`);
            process.exit(result.status === 'ok' || result.status === 'empty' ? 0 : 1);
        })
        .catch(err => {
            console.error(`[${new Date().toISOString()}] ❌ Validation failed:`, err);
            process.exit(1);
        });
}

module.exports = { validateAuditChain };