// services/reminderService.js
const { sendReminderEmail, sendAdminReturnReminder, isNotificationEnabled, getNotificationConfig } = require('./emailService');

/**
 * Get Singapore time (UTC+8) for date comparisons
 */
function getSingaporeDate() {
    const now = new Date();
    return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

/**
 * Format a date to Singapore time string
 */
function formatSingaporeDateTime(isoString) {
    if (!isoString) return 'Not specified';
    const d = new Date(isoString);
    return d.toLocaleString('en-SG', {
        timeZone: 'Asia/Singapore',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    }) + ' (GMT+8)';
}

/**
 * Email sending with retry (exponential backoff)
 */
async function sendEmailWithRetry(emailFn, to, subject, body, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await emailFn(to, subject, body);
            return { success: true, attempt };
        } catch (err) {
            lastError = err;
            if (attempt === maxRetries) break;
            const delay = Math.pow(2, attempt - 1) * baseDelay;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

class ReminderService {
    constructor(db, options = {}) {
        this.db = db;
        this.logger = options.logger || console;
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelayMs = options.retryDelayMs || 1000;
        this.adminEmail = process.env.ADMIN_EMAIL;
    }

    /**
     * Main entry point – run all reminder processing
     */
    async processReminders() {
        // Check if reminders are globally enabled
        if (!(await isNotificationEnabled('send_reminders'))) {
            this.logger.info('Reminders disabled by settings');
            return { disabled: true };
        }

        const start = Date.now();
        this.logger.info('Starting reminder processing');

        // Load config
        const config = await getNotificationConfig('send_reminders');
        const daysBefore = config.reminder_days_before || [1, 0];
        const sendOverdue = config.send_overdue_reminders !== false;

        // 1. Fetch all borrowed transactions with planned_return
        const transactions = await this.fetchDueBorrows();

        // 2. Send individual reminders (with deduplication and retry)
        const sentStats = await this.sendReminders(transactions, daysBefore, sendOverdue);

        // 3. Update overdue status for transactions past their due date
        await this.updateOverdueStatus(transactions);

        // 4. Send admin summary if enabled
        if (config.admin_summary_enabled !== false) {
            await this.sendAdminSummary(transactions);
        }

        const duration = Date.now() - start;
        this.logger.info('Reminder processing completed', { duration, sentStats });

        return { ...sentStats, duration };
    }

    /**
     * Fetch all transactions that are borrowed and have a planned_return
     */
    async fetchDueBorrows() {
        const query = `
            SELECT t.id, t.receiver_email, t.quantity, t.planned_return,
                   k.code, k.brand
            FROM transactions t
            JOIN keys k ON t.key_id = k.id
            WHERE t.status IN ('borrowed', 'overdue')
              AND t.planned_return IS NOT NULL
        `;
        const result = await this.db.query(query);
        return result.rows;
    }

    /**
     * Send reminders for each transaction (deduplicated per day per type)
     */
    async sendReminders(transactions, daysBefore, sendOverdue) {
        const nowSG = getSingaporeDate();
        const todayStr = nowSG.toISOString().slice(0, 10);
        const tomorrowSG = new Date(nowSG);
        tomorrowSG.setDate(tomorrowSG.getDate() + 1);
        const tomorrowStr = tomorrowSG.toISOString().slice(0, 10);

        let stats = { dueToday: 0, dueTomorrow: 0, overdue: 0, errors: 0 };

        for (const tx of transactions) {
            const plannedUTC = new Date(tx.planned_return);
            const plannedSG = new Date(plannedUTC.getTime() + 8 * 60 * 60 * 1000);
            const dueDateStr = plannedSG.toISOString().slice(0, 10);

            let diffDays;
            if (dueDateStr === todayStr) diffDays = 0;
            else if (dueDateStr === tomorrowStr) diffDays = 1;
            else if (dueDateStr < todayStr) diffDays = -1;
            else diffDays = 2; // more than a day away

            // Determine if we should send a reminder for this diffDays
            let shouldSend = false;
            let reminderType = null;
            if (diffDays === -1 && sendOverdue) {
                shouldSend = true;
                reminderType = 'overdue';
            } else if (daysBefore.includes(diffDays)) {
                shouldSend = true;
                if (diffDays === 0) reminderType = 'due_today';
                else if (diffDays === 1) reminderType = 'due_tomorrow';
                else reminderType = `due_in_${diffDays}_days`;
            }

            if (!shouldSend) continue;

            // Deduplicate: check if we already sent this reminder type today
            const logCheck = await this.db.query(
                `SELECT 1 FROM reminders_log
                 WHERE transaction_id = $1 AND reminder_type = $2
                   AND sent_at::date = CURRENT_DATE`,
                [tx.id, reminderType]
            );
            if (logCheck.rowCount > 0) {
                continue; // already sent today
            }

            // Build email content
            let subject, body;
            if (reminderType === 'due_today') {
                subject = 'Key Return Reminder (Due Today)';
                const formattedDueTime = formatSingaporeDateTime(tx.planned_return);
                body = `FINAL REMINDER: Your ${tx.quantity} × ${tx.code} (${tx.brand}) is due today. Please return it by ${formattedDueTime}.`;
            } else if (reminderType === 'due_tomorrow') {
                subject = 'Key Return Reminder (Tomorrow)';
                body = `Reminder: You borrowed ${tx.quantity} × ${tx.code} (${tx.brand}). Please return it by tomorrow (${dueDateStr}).`;
            } else if (reminderType === 'overdue') {
                subject = 'OVERDUE Key Return';
                const formattedDueDateTime = formatSingaporeDateTime(tx.planned_return);
                body = `OVERDUE: You borrowed ${tx.quantity} × ${tx.code} (${tx.brand}) which was due on ${formattedDueDateTime}. Please return it immediately.`;
            } else {
                continue; // unknown
            }

            // Send with retry
            try {
                await sendEmailWithRetry(
                    sendReminderEmail,
                    tx.receiver_email,
                    subject,
                    body,
                    this.retryAttempts,
                    this.retryDelayMs
                );
                // Log success
                await this.db.query(
                    `INSERT INTO reminders_log (transaction_id, reminder_type) VALUES ($1, $2)`,
                    [tx.id, reminderType]
                );
                if (reminderType === 'due_today') stats.dueToday++;
                else if (reminderType === 'due_tomorrow') stats.dueTomorrow++;
                else if (reminderType === 'overdue') stats.overdue++;
            } catch (err) {
                this.logger.error(`Failed to send reminder for tx ${tx.id}:`, err);
                stats.errors++;
            }
        }

        return stats;
    }

    /**
     * Update transaction status to 'overdue' if past due date
     */
    async updateOverdueStatus(transactions) {
        const nowSG = getSingaporeDate();
        const todayStr = nowSG.toISOString().slice(0, 10);

        for (const tx of transactions) {
            if (tx.status === 'overdue') continue;

            const plannedUTC = new Date(tx.planned_return);
            const plannedSG = new Date(plannedUTC.getTime() + 8 * 60 * 60 * 1000);
            const dueDateStr = plannedSG.toISOString().slice(0, 10);

            if (dueDateStr < todayStr) {
                await this.db.query(
                    `UPDATE transactions SET status = 'overdue' WHERE id = $1`,
                    [tx.id]
                );
                this.logger.info(`Marked transaction ${tx.id} as overdue`);
            }
        }
    }

    /**
     * Send a summary email to admin with all due/overdue items
     */
    async sendAdminSummary(transactions) {
        if (!this.adminEmail) {
            this.logger.warn('No ADMIN_EMAIL set – skipping admin summary');
            return;
        }

        const nowSG = getSingaporeDate();
        const todayStr = nowSG.toISOString().slice(0, 10);

        const dueItems = transactions.filter(tx => {
            const plannedUTC = new Date(tx.planned_return);
            const plannedSG = new Date(plannedUTC.getTime() + 8 * 60 * 60 * 1000);
            const dueDateStr = plannedSG.toISOString().slice(0, 10);
            return dueDateStr <= todayStr;
        });

        if (dueItems.length === 0) return;

        // Group by receiver_email
        const grouped = new Map();
        for (const item of dueItems) {
            const email = item.receiver_email;
            if (!grouped.has(email)) {
                grouped.set(email, {
                    receiver_email: email,
                    key_names: [],
                    planned_return: formatSingaporeDateTime(item.planned_return)
                });
            }
            grouped.get(email).key_names.push(`${item.brand} (${item.code})`);
        }

        const groupedItems = Array.from(grouped.values());

        try {
            await sendAdminReturnReminder(this.adminEmail, groupedItems);
            this.logger.info(`Admin summary sent to ${this.adminEmail}`);
        } catch (err) {
            this.logger.error('Failed to send admin summary:', err);
        }
    }
}

module.exports = ReminderService;