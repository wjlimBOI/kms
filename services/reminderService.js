// services/reminderService.js
const { sendReminderEmail, sendAdminReturnReminder, isNotificationEnabled, getNotificationConfig } = require('./emailService');

function getSingaporeDate() {
    const now = new Date();
    return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function formatSingaporeDateTime(isoString) {
    if (!isoString) return 'Not specified';
    try {
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
    } catch (err) {
        return isoString || 'Not specified';
    }
}

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
    throw lastError || new Error('Email send failed after retries');
}

class ReminderService {
    constructor(db, options = {}) {
        this.db = db;
        this.logger = options.logger || console;
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelayMs = options.retryDelayMs || 1000;
        this.adminEmail = process.env.ADMIN_EMAIL;
        this.isRunning = false;
    }

    async processReminders() {
        if (this.isRunning) {
            this.logger.warn('Reminder processing already running, skipping');
            return { alreadyRunning: true };
        }

        try {
            this.isRunning = true;

            const enabled = await isNotificationEnabled('send_reminders');
            if (!enabled) {
                this.logger.info('Reminders disabled by settings');
                return { disabled: true };
            }

            const start = Date.now();
            this.logger.info('Starting reminder processing');

            const config = await getNotificationConfig('send_reminders');
            const daysBefore = config.reminder_days_before || [1, 0];
            const sendOverdue = config.send_overdue_reminders !== false;

            const transactions = await this.fetchDueBorrows();
            const sentStats = await this.sendReminders(transactions, daysBefore, sendOverdue);
            await this.updateOverdueStatus(transactions);

            if (config.admin_summary_enabled !== false) {
                await this.sendAdminSummary(transactions);
            }

            const duration = Date.now() - start;
            this.logger.info('Reminder processing completed', { duration, sentStats });

            return { ...sentStats, duration };
        } catch (err) {
            this.logger.error('Reminder processing failed:', err);
            throw err;
        } finally {
            this.isRunning = false;
        }
    }

    async fetchDueBorrows() {
        try {
            const query = `
                SELECT t.id, t.receiver_email, t.quantity, t.planned_return, t.status,
                       k.code, k.brand
                FROM transactions t
                JOIN keys k ON t.key_id = k.id
                WHERE t.status IN ('borrowed', 'overdue')
                  AND t.planned_return IS NOT NULL
            `;
            const result = await this.db.query(query);
            return result.rows;
        } catch (err) {
            this.logger.error('Failed to fetch due borrows:', err);
            throw err;
        }
    }

    async sendReminders(transactions, daysBefore, sendOverdue) {
        const nowSG = getSingaporeDate();
        const todayStr = nowSG.toISOString().slice(0, 10);
        const tomorrowSG = new Date(nowSG);
        tomorrowSG.setDate(tomorrowSG.getDate() + 1);
        const tomorrowStr = tomorrowSG.toISOString().slice(0, 10);

        let stats = { dueToday: 0, dueTomorrow: 0, overdue: 0, errors: 0 };

        for (const tx of transactions) {
            try {
                const plannedUTC = new Date(tx.planned_return);
                const plannedSG = new Date(plannedUTC.getTime() + 8 * 60 * 60 * 1000);
                const dueDateStr = plannedSG.toISOString().slice(0, 10);

                let diffDays;
                if (dueDateStr === todayStr) diffDays = 0;
                else if (dueDateStr === tomorrowStr) diffDays = 1;
                else if (dueDateStr < todayStr) diffDays = -1;
                else diffDays = 2;

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

                const logCheck = await this.db.query(
                    `SELECT 1 FROM reminders_log
                     WHERE transaction_id = $1 AND reminder_type = $2
                       AND sent_at::date = CURRENT_DATE`,
                    [tx.id, reminderType]
                );
                if (logCheck.rowCount > 0) continue;

                let subject, body;
                const formattedDueTime = formatSingaporeDateTime(tx.planned_return);
                const displayBrand = tx.brand || 'Unknown';
                const displayCode = tx.code || 'Unknown';
                const quantity = tx.quantity || 1;

                if (reminderType === 'due_today') {
                    subject = 'Key Return Reminder (Due Today)';
                    body = `FINAL REMINDER: Your ${quantity} × ${displayCode} (${displayBrand}) is due today. Please return it by ${formattedDueTime}.`;
                } else if (reminderType === 'due_tomorrow') {
                    subject = 'Key Return Reminder (Tomorrow)';
                    body = `Reminder: You borrowed ${quantity} × ${displayCode} (${displayBrand}). Please return it by tomorrow (${formattedDueTime}).`;
                } else if (reminderType === 'overdue') {
                    subject = 'OVERDUE Key Return';
                    body = `OVERDUE: You borrowed ${quantity} × ${displayCode} (${displayBrand}) which was due on ${formattedDueTime}. Please return it immediately.`;
                } else {
                    continue;
                }

                // Send reminder directly - sendReminderEmail handles HTML wrapping
                await sendEmailWithRetry(
                    sendReminderEmail,
                    tx.receiver_email,
                    subject,
                    body,
                    this.retryAttempts,
                    this.retryDelayMs
                );

                await this.db.query(
                    `INSERT INTO reminders_log (transaction_id, reminder_type)
                     VALUES ($1, $2)`,
                    [tx.id, reminderType]
                );

                if (reminderType === 'due_today') stats.dueToday++;
                else if (reminderType === 'due_tomorrow') stats.dueTomorrow++;
                else if (reminderType === 'overdue') stats.overdue++;

            } catch (err) {
                this.logger.error(`Failed to send reminder for tx ${tx.id}:`, err.message);
                stats.errors++;
            }
        }

        return stats;
    }

    async updateOverdueStatus(transactions) {
        const nowSG = getSingaporeDate();
        const todayStr = nowSG.toISOString().slice(0, 10);
        let updated = 0;

        for (const tx of transactions) {
            if (tx.status === 'overdue') continue;

            try {
                const plannedUTC = new Date(tx.planned_return);
                const plannedSG = new Date(plannedUTC.getTime() + 8 * 60 * 60 * 1000);
                const dueDateStr = plannedSG.toISOString().slice(0, 10);

                if (dueDateStr < todayStr) {
                    await this.db.query(
                        `UPDATE transactions SET status = 'overdue' WHERE id = $1`,
                        [tx.id]
                    );
                    updated++;
                    this.logger.info(`Marked transaction ${tx.id} as overdue`);
                }
            } catch (err) {
                this.logger.error(`Failed to update status for tx ${tx.id}:`, err.message);
            }
        }

        return updated;
    }

    async sendAdminSummary(transactions) {
        if (!this.adminEmail) {
            this.logger.warn('No ADMIN_EMAIL set – skipping admin summary');
            return;
        }

        try {
            const nowSG = getSingaporeDate();
            const todayStr = nowSG.toISOString().slice(0, 10);

            const dueItems = transactions.filter(tx => {
                try {
                    const plannedUTC = new Date(tx.planned_return);
                    const plannedSG = new Date(plannedUTC.getTime() + 8 * 60 * 60 * 1000);
                    const dueDateStr = plannedSG.toISOString().slice(0, 10);
                    return dueDateStr <= todayStr;
                } catch (err) {
                    return false;
                }
            });

            if (dueItems.length === 0) return;

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
                const displayBrand = item.brand || 'Unknown';
                const displayCode = item.code || 'Unknown';
                grouped.get(email).key_names.push(`${displayBrand} (${displayCode})`);
            }

            const groupedItems = Array.from(grouped.values());

            // sendAdminReturnReminder handles its own HTML wrapping
            await sendAdminReturnReminder(this.adminEmail, groupedItems);
            this.logger.info(`Admin summary sent to ${this.adminEmail}`);

        } catch (err) {
            this.logger.error('Failed to send admin summary:', err.message);
        }
    }

    async getStats() {
        try {
            const today = new Date();
            const todayStr = today.toISOString().slice(0, 10);

            const result = await this.db.query(
                `SELECT reminder_type, COUNT(*) as count
                 FROM reminders_log
                 WHERE sent_at::date = $1
                 GROUP BY reminder_type`,
                [todayStr]
            );

            const stats = { today: todayStr, total: 0, byType: {} };
            for (const row of result.rows) {
                stats.byType[row.reminder_type] = parseInt(row.count);
                stats.total += parseInt(row.count);
            }

            return stats;
        } catch (err) {
            this.logger.error('Failed to get reminder stats:', err.message);
            return { error: err.message };
        }
    }
}

module.exports = ReminderService;