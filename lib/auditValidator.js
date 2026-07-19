// lib/auditValidator.js

const crypto = require('crypto');

class AuditValidator {
    constructor(db, options = {}) {
        this.db = db;
        this.logger = options.logger || console;
        this.algorithm = options.algorithm || 'sha256';
        this.adminEmail = process.env.ADMIN_EMAIL;
    }

    async validateChain() {
        const startTime = Date.now();
        try {
            const rows = await this.computeHashes();
            const tamperedRows = this.detectTampering(rows);
            const status = tamperedRows.length ? 'tampered' : 'ok';
            const message = tamperedRows.length 
                ? `Tampering detected at IDs: ${tamperedRows.map(r => r.id).join(', ')}`
                : 'Audit chain intact';

            const firstTamperedId = tamperedRows.length ? tamperedRows[0].id : null;
            await this.recordHealth(status, message, firstTamperedId, Date.now() - startTime);

            return {
                status,
                message,
                tamperedRows,
                duration: Date.now() - startTime
            };
        } catch (err) {
            this.logger.error('Audit validation failed:', err);
            await this.recordHealth('error', `Validation error: ${err.message}`, null, Date.now() - startTime);
            return {
                status: 'error',
                message: err.message,
                tamperedRows: [],
                duration: Date.now() - startTime
            };
        }
    }

    async computeHashes() {
        const query = `
            SELECT id, previous_hash, hash,
                   encode(digest(
                       COALESCE(previous_hash,'') || '|' ||
                       event_type || '|' || COALESCE(user_id::TEXT,'') || '|' ||
                       COALESCE(target_id::TEXT,'') || '|' ||
                       created_at::TEXT || '|' ||
                       COALESCE(old_data::TEXT,'') || '|' ||
                       COALESCE(new_data::TEXT,''),
                   '${this.algorithm}'), 'hex') AS computed_hash
            FROM audit_log
            ORDER BY id
        `;
        const res = await this.db.query(query);
        return res.rows;
    }

    detectTampering(rows) {
        const tampered = [];
        for (const row of rows) {
            if (row.hash !== row.computed_hash) {
                tampered.push(row);
                this.logger.error(`Tamper detected at ID ${row.id}`);
            }
        }
        return tampered;
    }

    async recordHealth(status, message, firstTamperedId, duration) {
        await this.db.query(
            `INSERT INTO audit_health (status, message, first_tampered_row_id, duration_ms)
             VALUES ($1, $2, $3, $4)`,
            [status, message, firstTamperedId || null, duration]
        );
    }
}

module.exports = AuditValidator;