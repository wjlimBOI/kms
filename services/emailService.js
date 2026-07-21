// services/emailService.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Template cache for better performance
const templateCache = {};
const TEMPLATE_CACHE_TTL = 60000; // 1 minute cache

// Email queue for non-blocking sends
let emailQueue = [];
let isProcessingQueue = false;
const MAX_QUEUE_SIZE = 1000;
const BATCH_SIZE = 10;
const BATCH_DELAY = 100; // ms between batches

let cachedLogoBase64 = null;

function getLogoBase64() {
    if (cachedLogoBase64) return cachedLogoBase64;
    try {
        const logoPath = path.join(process.cwd(), 'public', 'boi.png');
        if (fs.existsSync(logoPath)) {
            const imageBuffer = fs.readFileSync(logoPath);
            const base64 = imageBuffer.toString('base64');
            cachedLogoBase64 = `data:image/png;base64,${base64}`;
            console.log('✅ Logo embedded as base64 for emails');
        } else {
            console.warn('⚠️ Logo not found at public/boi.png – emails will show no logo');
            cachedLogoBase64 = '';
        }
    } catch (err) {
        console.error('❌ Failed to read logo:', err);
        cachedLogoBase64 = '';
    }
    return cachedLogoBase64;
}

function getEmailHtml(content, subject) {
    const logoBase64 = getLogoBase64();
    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const cleanBase = baseUrl.replace(/\/$/, '');
    const currentYear = new Date().getFullYear();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .button { width: 100% !important; text-align: center !important; }
      .responsive-padding { padding: 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f7fc;font-family: 'Segoe UI', Arial, Helvetica, sans-serif;">
  <center style="width:100%;table-layout:fixed;">
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;margin:20px auto;border:1px solid #e0e7ef;border-radius:24px;overflow:hidden;">
      <tr>
        <td bgcolor="#0f2b3d" style="background-color:#0f2b3d;padding:30px 24px;text-align:center;">
          <img src="${logoBase64}" alt="Beauty One International" width="180" style="display:block;max-width:180px;width:100%;height:auto;margin:0 auto 16px auto;border:0;" />
          <h1 style="color:#ffffff;font-size:26px;font-weight:600;margin:0;">Key Management System</h1>
          <p style="color:#e2e8f0;font-size:15px;margin:8px 0 0;">Beauty One International</p>
        </td>
      </tr>
      <tr>
        <td style="padding:30px 28px;" class="responsive-padding">
          ${content}
        </td>
      </tr>
      <tr>
        <td bgcolor="#f8fafc" style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 28px;text-align:center;">
          <p style="margin:0 0 6px;font-size:12px;color:#64748b;">
            © ${currentYear} Beauty One International Pte Ltd. All rights reserved.
          </p>
          <p style="margin:0;font-size:12px;color:#64748b;">
            This is an automated message — please do not reply.
          </p>
          <p style="margin:10px 0 0;">
            <a href="${cleanBase}" style="color:#0d9488;text-decoration:none;font-size:12px;">Visit our portal</a>
          </p>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
}

// ============================================================
//  TRANSPORTER WITH RETRY
// ============================================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 10 // Max 10 messages per second
});

// ============================================================
//  EMAIL QUEUE SYSTEM
// ============================================================
async function processEmailQueue() {
    if (isProcessingQueue || emailQueue.length === 0) return;
    isProcessingQueue = true;
    
    console.log(`📧 Processing ${emailQueue.length} emails in queue...`);
    
    try {
        let processed = 0;
        let failed = 0;
        
        while (emailQueue.length > 0) {
            // Process in batches
            const batch = emailQueue.splice(0, BATCH_SIZE);
            
            const batchPromises = batch.map(async (emailJob) => {
                try {
                    await emailJob();
                    processed++;
                } catch (err) {
                    failed++;
                    console.error('❌ Email send error:', err.message);
                }
            });
            
            await Promise.all(batchPromises);
            
            // Add delay between batches
            if (emailQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
        }
        
        console.log(`📧 Queue processed: ${processed} sent, ${failed} failed`);
    } finally {
        isProcessingQueue = false;
        
        // If more emails were added while processing, continue
        if (emailQueue.length > 0) {
            processEmailQueue();
        }
    }
}

function queueEmail(sendFn) {
    return new Promise((resolve, reject) => {
        // Limit queue size to prevent memory issues
        if (emailQueue.length >= MAX_QUEUE_SIZE) {
            console.warn('⚠️ Email queue full, dropping email');
            reject(new Error('Email queue is full'));
            return;
        }
        
        emailQueue.push(async () => {
            try {
                await sendFn();
                resolve();
            } catch (err) {
                reject(err);
            }
        });
        
        // Start processing if not already running
        if (!isProcessingQueue) {
            processEmailQueue();
        }
    });
}

// ============================================================
//  TEMPLATE MANAGEMENT WITH CACHING
// ============================================================
async function loadTemplate(templateKey, data = {}) {
    // Check cache first
    const cacheKey = templateKey;
    const cached = templateCache[cacheKey];
    if (cached && (Date.now() - cached.timestamp) < TEMPLATE_CACHE_TTL) {
        let { subject, body_html } = cached.template;
        for (const [key, value] of Object.entries(data)) {
            const regex = new RegExp(`{{${key}}}`, 'g');
            subject = subject.replace(regex, String(value));
            body_html = body_html.replace(regex, String(value));
        }
        return { subject, body_html };
    }

    // Fetch from database
    const result = await pool.query(
        'SELECT subject, body_html, updated_at FROM email_templates WHERE template_key = $1 AND is_active = true',
        [templateKey]
    );
    if (result.rowCount === 0) {
        throw new Error(`Template "${templateKey}" not found or inactive`);
    }
    let { subject, body_html } = result.rows[0];
    
    // Update cache
    templateCache[cacheKey] = {
        template: { subject, body_html },
        timestamp: Date.now(),
        version: result.rows[0].updated_at
    };
    
    // Replace placeholders
    for (const [key, value] of Object.entries(data)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        subject = subject.replace(regex, String(value));
        body_html = body_html.replace(regex, String(value));
    }
    return { subject, body_html };
}

async function clearTemplateCache(templateKey = null) {
    if (templateKey) {
        delete templateCache[templateKey];
        console.log(`🗑️ Template cache cleared for: ${templateKey}`);
    } else {
        for (const key in templateCache) {
            delete templateCache[key];
        }
        console.log('🗑️ All template caches cleared');
    }
}

async function updateTemplate(templateKey, subject, body_html, is_active = true) {
    const result = await pool.query(
        `UPDATE email_templates 
         SET subject = $1, body_html = $2, is_active = $3, updated_at = NOW() 
         WHERE template_key = $4 
         RETURNING *`,
        [subject, body_html, is_active, templateKey]
    );
    if (result.rowCount === 0) {
        throw new Error(`Template "${templateKey}" not found`);
    }
    await clearTemplateCache(templateKey);
    return result.rows[0];
}

async function isNotificationEnabled(settingKey) {
    const result = await pool.query(
        'SELECT enabled FROM notification_settings WHERE setting_key = $1',
        [settingKey]
    );
    if (result.rowCount === 0) return true;
    return result.rows[0].enabled;
}

async function getNotificationConfig(settingKey) {
    const result = await pool.query(
        'SELECT config FROM notification_settings WHERE setting_key = $1',
        [settingKey]
    );
    if (result.rowCount === 0) return {};
    return result.rows[0].config || {};
}

// ============================================================
//  EMAIL SENDING FUNCTIONS (with queue support)
// ============================================================

async function sendOtpEmail(toEmail, otp) {
    if (!(await isNotificationEnabled('send_otp'))) return;
    return queueEmail(async () => {
        const { subject, body_html } = await loadTemplate('otp', { otp });
        const html = getEmailHtml(body_html, subject);
        await transporter.sendMail({
            from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject,
            html
        });
        console.log(`✅ OTP email sent to ${toEmail}`);
    });
}

async function sendPasswordResetEmail(toEmail, resetLink, name = 'User') {
    if (!(await isNotificationEnabled('send_password_reset'))) return;
    return queueEmail(async () => {
        try {
            let templateKey = 'password_reset_imda';
            let template;
            try {
                template = await loadTemplate(templateKey, { 
                    name: name,
                    reset_link: resetLink,
                    app_url: process.env.APP_URL || 'http://localhost:3000'
                });
            } catch (err) {
                templateKey = 'password_reset';
                template = await loadTemplate(templateKey, { 
                    name: name,
                    reset_link: resetLink,
                    app_url: process.env.APP_URL || 'http://localhost:3000'
                });
            }
            const html = getEmailHtml(template.body_html, template.subject);
            await transporter.sendMail({
                from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
                to: toEmail,
                subject: template.subject,
                html
            });
            console.log(`✅ Password reset email sent to ${toEmail}`);
        } catch (err) {
            console.error('❌ Failed to send password reset email:', err);
            throw err;
        }
    });
}

async function sendWelcomeEmail(toEmail, username, plainPassword, changePasswordLink) {
    if (!(await isNotificationEnabled('send_welcome_email'))) return;
    return queueEmail(async () => {
        try {
            const { subject, body_html } = await loadTemplate('welcome', { 
                name: username,
                username: username,
                password: plainPassword,
                change_password_link: changePasswordLink || `${process.env.APP_URL}/change-password`,
                app_url: process.env.APP_URL || 'http://localhost:3000'
            });
            const html = getEmailHtml(body_html, subject);
            await transporter.sendMail({
                from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
                to: toEmail,
                subject,
                html
            });
            console.log(`✅ Welcome email sent to ${toEmail}`);
        } catch (err) {
            console.error('❌ Failed to send welcome email:', err);
            throw err;
        }
    });
}

async function sendRequestSubmittedEmail(toEmail, requesterName, items, plannedReturn) {
    if (!(await isNotificationEnabled('send_request_submitted'))) return;
    return queueEmail(async () => {
        const keys = items.map(i => `${i.quantity} × ${i.code}`).join(', ');
        const { subject, body_html } = await loadTemplate('request_submitted', {
            name: requesterName,
            keys,
            planned_return: plannedReturn,
            app_url: process.env.APP_URL || 'http://localhost:3000'
        });
        const html = getEmailHtml(body_html, subject);
        await transporter.sendMail({
            from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject,
            html
        });
        console.log(`✅ Request submitted email sent to ${toEmail}`);
    });
}

async function sendRequestApprovedEmail(toEmail, requesterName, items, plannedReturn) {
    if (!(await isNotificationEnabled('send_request_approved'))) return;
    return queueEmail(async () => {
        const keys = items.map(i => `${i.quantity} × ${i.code}`).join(', ');
        const { subject, body_html } = await loadTemplate('request_approved', {
            name: requesterName,
            keys,
            planned_return: plannedReturn,
            app_url: process.env.APP_URL || 'http://localhost:3000'
        });
        const html = getEmailHtml(body_html, subject);
        await transporter.sendMail({
            from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject,
            html
        });
        console.log(`✅ Request approved email sent to ${toEmail}`);
    });
}

async function sendReminderEmail(toEmail, subject, body) {
    return queueEmail(async () => {
        const html = getEmailHtml(body, subject);
        await transporter.sendMail({
            from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject,
            html
        });
        console.log(`✅ Reminder email sent to ${toEmail}`);
    });
}

async function sendAdminRegistrationAlert(adminEmail, userDetails) {
    if (!(await isNotificationEnabled('send_admin_new_registration'))) return;
    return queueEmail(async () => {
        const { name, email, username } = userDetails;
        const { subject, body_html } = await loadTemplate('admin_new_registration', {
            name,
            email,
            username: username || '—',
            app_url: process.env.APP_URL || 'http://localhost:3000'
        });
        const html = getEmailHtml(body_html, subject);
        await transporter.sendMail({
            from: `"BOI Key Management Admin" <${process.env.EMAIL_USER}>`,
            to: adminEmail,
            subject,
            html
        });
        console.log(`✅ Admin registration alert sent to ${adminEmail}`);
    });
}

async function sendAdminNewRequestAlert(adminEmail, requestDetails) {
    if (!(await isNotificationEnabled('send_admin_new_key_request'))) return;
    return queueEmail(async () => {
        const { requester_name, requester_email, items, planned_return, created_at } = requestDetails;
        const keys = items.map(i => `${i.quantity} × ${i.code}`).join(', ');
        const { subject, body_html } = await loadTemplate('admin_new_key_request', {
            requester: requester_name,
            email: requester_email,
            keys,
            planned_return,
            created_at,
            app_url: process.env.APP_URL || 'http://localhost:3000'
        });
        const html = getEmailHtml(body_html, subject);
        await transporter.sendMail({
            from: `"BOI Key Management Admin" <${process.env.EMAIL_USER}>`,
            to: adminEmail,
            subject,
            html
        });
        console.log(`✅ Admin new request alert sent to ${adminEmail}`);
    });
}

async function sendAdminReturnReminder(adminEmail, dueTransactions) {
    if (!(await isNotificationEnabled('send_reminders'))) return;
    return queueEmail(async () => {
        const config = await getNotificationConfig('send_reminders');
        if (!config.admin_summary_enabled) return;
        let rows = '';
        for (const t of dueTransactions) {
            rows += `<tr>
                <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${t.receiver_email}</td>
                <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${t.key_names.join(', ')}</td>
                <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${t.planned_return}</td>
            </tr>`;
        }
        const summaryBody = `
            <p>The following keys are due today or overdue:</p>
            <table style="width:100%;border-collapse:collapse;">
                <thead><tr><th>Borrower</th><th>Keys</th><th>Due Date</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p>Please follow up with the users.</p>
        `;
        const { subject, body_html } = await loadTemplate('admin_daily_summary', { summary: summaryBody });
        const finalBody = body_html.replace('{{summary}}', summaryBody);
        const html = getEmailHtml(finalBody, subject);
        await transporter.sendMail({
            from: `"BOI Key Management Admin" <${process.env.EMAIL_USER}>`,
            to: adminEmail,
            subject,
            html
        });
        console.log(`✅ Admin return reminder sent to ${adminEmail}`);
    });
}

async function sendAccountLockedEmail(toEmail, username, attempts, resetLink) {
    if (!(await isNotificationEnabled('send_account_locked'))) return;
    return queueEmail(async () => {
        try {
            let templateKey = 'account_locked_imda';
            let template;
            try {
                template = await loadTemplate(templateKey, { 
                    name: username,
                    attempts: attempts,
                    reset_link: resetLink || `${process.env.APP_URL}/forgot-password`,
                    app_url: process.env.APP_URL || 'http://localhost:3000'
                });
            } catch (err) {
                templateKey = 'account_locked';
                template = await loadTemplate(templateKey, { 
                    name: username,
                    attempts: attempts,
                    app_url: process.env.APP_URL || 'http://localhost:3000'
                });
            }
            const html = getEmailHtml(template.body_html, template.subject);
            await transporter.sendMail({
                from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
                to: toEmail,
                subject: template.subject,
                html
            });
            console.log(`✅ Account locked email sent to ${toEmail}`);
        } catch (err) {
            console.error('❌ Failed to send account locked email:', err);
            throw err;
        }
    });
}

async function sendFineCreatedEmail(toEmail, username, keyCode, amount) {
    if (!(await isNotificationEnabled('send_fine_created'))) return;
    return queueEmail(async () => {
        const { subject, body_html } = await loadTemplate('fine_created', { 
            name: username, 
            key_code: keyCode, 
            amount: amount,
            app_url: process.env.APP_URL || 'http://localhost:3000'
        });
        const html = getEmailHtml(body_html, subject);
        await transporter.sendMail({
            from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject,
            html
        });
        console.log(`✅ Fine created email sent to ${toEmail}`);
    });
}

async function sendFinePaidEmail(toEmail, username, keyCode, amount) {
    if (!(await isNotificationEnabled('send_fine_paid'))) return;
    return queueEmail(async () => {
        const { subject, body_html } = await loadTemplate('fine_paid', { 
            name: username, 
            key_code: keyCode, 
            amount: amount,
            app_url: process.env.APP_URL || 'http://localhost:3000'
        });
        const html = getEmailHtml(body_html, subject);
        await transporter.sendMail({
            from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject,
            html
        });
        console.log(`✅ Fine paid email sent to ${toEmail}`);
    });
}

async function sendConfirmationEmail(toEmail, subject, body) {
    return queueEmail(async () => {
        const html = getEmailHtml(body, subject);
        await transporter.sendMail({
            from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject,
            html
        });
        console.log(`✅ Confirmation email sent to ${toEmail}`);
    });
}

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ============================================================
//  EXPORTS
// ============================================================
module.exports = {
    sendOtpEmail,
    sendPasswordResetEmail,
    sendWelcomeEmail,
    sendRequestSubmittedEmail,
    sendRequestApprovedEmail,
    sendReminderEmail,
    sendAdminRegistrationAlert,
    sendAdminNewRequestAlert,
    sendAdminReturnReminder,
    sendAccountLockedEmail,
    sendFineCreatedEmail,
    sendFinePaidEmail,
    sendConfirmationEmail,
    generateOtp,
    loadTemplate,
    isNotificationEnabled,
    getNotificationConfig,
    clearTemplateCache,
    updateTemplate,
    // Export queue status for debugging
    getQueueStatus: () => ({
        queueLength: emailQueue.length,
        isProcessing: isProcessingQueue,
        maxQueueSize: MAX_QUEUE_SIZE
    })
};