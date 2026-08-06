// services/emailService.js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const templateCache = {};
const TEMPLATE_CACHE_TTL = 60000;

let emailQueue = [];
let isProcessingQueue = false;
const MAX_QUEUE_SIZE = 1000;
const BATCH_SIZE = 10;
const BATCH_DELAY = 100;

let cachedLogoBase64 = null;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'BOI Key Management';
const ENABLE_EMAIL = process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true' && BREVO_API_KEY && BREVO_SENDER_EMAIL;

const APP_URL = process.env.APP_URL || 
                (process.env.NODE_ENV === 'staging' 
                    ? 'https://kms-staging.onrender.com' 
                    : 'http://localhost:3000');

console.log(`📧 Brevo API Key: ${BREVO_API_KEY ? '✓ Set' : '✗ Not Set'}`);
console.log(`📧 Sender Email: ${BREVO_SENDER_EMAIL || '✗ Not Set'}`);
console.log(`📧 App URL: ${APP_URL}`);
console.log(`📧 Email Enabled: ${ENABLE_EMAIL ? '✓ Yes' : '✗ No'}`);

if (!ENABLE_EMAIL) {
    console.log('⚠️ Email notifications disabled. Check BREVO_API_KEY and BREVO_SENDER_EMAIL in .env');
}

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

// ============================================================
// FIX: EMAIL WRAPPER - Consistent colors across all email clients
// ============================================================
function wrapEmailContent(contentHtml, subject) {
    const logoBase64 = getLogoBase64();
    const cleanBase = APP_URL.replace(/\/$/, '');
    const currentYear = new Date().getFullYear();

    // Clean contentHtml to prevent duplicate headers
    // If contentHtml contains <html> or <body> tags, extract only the inner content
    let cleanContent = contentHtml;
    if (contentHtml.includes('<html') || contentHtml.includes('<body')) {
        // Extract content between body tags if present
        const bodyMatch = contentHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) {
            cleanContent = bodyMatch[1];
        } else {
            // Remove html, head, body tags
            cleanContent = contentHtml
                .replace(/<html[^>]*>/gi, '')
                .replace(/<\/html>/gi, '')
                .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
                .replace(/<body[^>]*>/gi, '')
                .replace(/<\/body>/gi, '')
                .trim();
        }
    }

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${subject}</title>
  <style>
    /* Base styles for all email clients */
    body, .email-body {
      margin: 0;
      padding: 0;
      background-color: #f4f7fc;
      font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
    }
    .email-container {
      max-width: 600px;
      width: 100%;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 24px;
      overflow: hidden;
      border: 1px solid #e0e7ef;
    }
    .email-header {
      background-color: #0f2b3d;
      padding: 30px 24px;
      text-align: center;
    }
    .email-header h1 {
      color: #ffffff;
      font-size: 26px;
      font-weight: 600;
      margin: 0;
    }
    .email-header p {
      color: #e2e8f0;
      font-size: 15px;
      margin: 8px 0 0;
    }
    .email-body-content {
      padding: 30px 28px;
      background-color: #ffffff;
      color: #1e293b;
    }
    .email-footer {
      background-color: #f8fafc;
      border-top: 1px solid #e2e8f0;
      padding: 20px 28px;
      text-align: center;
    }
    .email-footer p {
      margin: 0 0 6px;
      font-size: 12px;
      color: #64748b;
    }
    .email-footer a {
      color: #0d9488;
      text-decoration: none;
      font-size: 12px;
    }

    /* Dark mode support for email clients that support it (Apple Mail, Outlook.com, etc.) */
    @media (prefers-color-scheme: dark) {
      body, .email-body {
        background-color: #1a202c;
      }
      .email-container {
        background-color: #2d3748;
        border-color: #4a5568;
      }
      .email-header {
        background-color: #1a365d;
      }
      .email-header h1 {
        color: #f7fafc;
      }
      .email-header p {
        color: #a0aec0;
      }
      .email-body-content {
        background-color: #2d3748;
        color: #e2e8f0;
      }
      .email-body-content p,
      .email-body-content li,
      .email-body-content td {
        color: #e2e8f0;
      }
      .email-body-content a {
        color: #63b3ed;
      }
      .email-body-content h2,
      .email-body-content h3,
      .email-body-content h4 {
        color: #f7fafc;
      }
      .email-body-content table {
        border-color: #4a5568;
      }
      .email-body-content td {
        border-bottom-color: #4a5568 !important;
      }
      .email-body-content .callout {
        background-color: #2d3748 !important;
        border-color: #4a5568 !important;
      }
      .email-footer {
        background-color: #2d3748;
        border-top-color: #4a5568;
      }
      .email-footer p {
        color: #a0aec0;
      }
      .email-footer a {
        color: #63b3ed;
      }
    }

    /* Mobile responsive */
    @media only screen and (max-width: 600px) {
      .email-container {
        border-radius: 0;
        border: none;
        margin: 0;
      }
      .email-header {
        padding: 20px 16px;
      }
      .email-body-content {
        padding: 20px 16px;
      }
      .email-footer {
        padding: 16px;
      }
      .email-header h1 {
        font-size: 20px;
      }
      .email-header img {
        max-width: 140px !important;
      }
    }
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f4f7fc;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
  <center style="width:100%;table-layout:fixed;background-color:#f4f7fc;padding:20px 0;">
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-container" style="max-width:600px;width:100%;background-color:#ffffff;margin:0 auto;border:1px solid #e0e7ef;border-radius:24px;overflow:hidden;">
      <tr>
        <td class="email-header" style="background-color:#0f2b3d;padding:30px 24px;text-align:center;">
          ${logoBase64 ? `<img src="${logoBase64}" alt="Beauty One International" width="180" style="display:block;max-width:180px;width:100%;height:auto;margin:0 auto 16px auto;border:0;" />` : ''}
          <h1 style="color:#ffffff;font-size:26px;font-weight:600;margin:0;">Key Management System</h1>
          <p style="color:#e2e8f0;font-size:15px;margin:8px 0 0;">Beauty One International</p>
        </td>
      </tr>
      <tr>
        <td class="email-body-content" style="padding:30px 28px;background-color:#ffffff;color:#1e293b;">
          ${cleanContent}
        </td>
      </tr>
      <tr>
        <td class="email-footer" style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 28px;text-align:center;">
          <p style="margin:0 0 6px;font-size:12px;color:#64748b;">
            &copy; ${currentYear} Beauty One International Pte Ltd. All rights reserved.
          </p>
          <p style="margin:0;font-size:12px;color:#64748b;">
            This is an automated message &mdash; please do not reply.
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
// BREVO EMAIL SENDER
// ============================================================

async function sendEmailViaBrevo(toEmail, subject, htmlContent) {
    if (!ENABLE_EMAIL) {
        console.log(`📧 Email not sent (disabled): ${subject} -> ${toEmail}`);
        return { message: 'Email disabled' };
    }

    if (!toEmail) {
        console.error('❌ No recipient email provided');
        throw new Error('No recipient email provided');
    }

    console.log(`📧 Sending email to ${toEmail}: ${subject}`);

    try {
        const payload = {
            sender: {
                name: BREVO_SENDER_NAME,
                email: BREVO_SENDER_EMAIL
            },
            to: [{ email: toEmail }],
            subject: subject,
            htmlContent: htmlContent
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': BREVO_API_KEY
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const result = await response.json();

        if (!response.ok) {
            console.error('❌ Brevo API error:', result);
            const errorMsg = result.message || JSON.stringify(result) || 'Unknown error';
            throw new Error(`Brevo API Error (${response.status}): ${errorMsg}`);
        }

        console.log(`✅ Email sent to ${toEmail}: ${subject}`);
        return result;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error('❌ Email send timeout:', subject, '->', toEmail);
            throw new Error('Email send timeout after 30 seconds');
        }
        console.error('❌ Brevo API request failed:', err.message);
        throw new Error(`Email send failed: ${err.message}`);
    }
}

// ============================================================
// EMAIL QUEUE SYSTEM
// ============================================================

async function processEmailQueue() {
    if (isProcessingQueue || emailQueue.length === 0) return;
    isProcessingQueue = true;

    console.log(`📧 Processing ${emailQueue.length} emails in queue...`);

    try {
        let processed = 0;
        let failed = 0;

        while (emailQueue.length > 0) {
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

            await Promise.allSettled(batchPromises);

            if (emailQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
        }

        console.log(`📧 Queue processed: ${processed} sent, ${failed} failed`);
    } catch (err) {
        console.error('❌ Queue processing error:', err.message);
    } finally {
        isProcessingQueue = false;

        if (emailQueue.length > 0) {
            processEmailQueue();
        }
    }
}

function queueEmail(sendFn) {
    if (!ENABLE_EMAIL) {
        return Promise.resolve({ message: 'Email disabled' });
    }

    return new Promise((resolve, reject) => {
        if (emailQueue.length >= MAX_QUEUE_SIZE) {
            console.warn('⚠️ Email queue full, dropping email');
            reject(new Error('Email queue is full'));
            return;
        }

        emailQueue.push(async () => {
            try {
                const result = await sendFn();
                resolve(result);
            } catch (err) {
                reject(err);
            }
        });

        if (!isProcessingQueue) {
            processEmailQueue();
        }
    });
}

// ============================================================
// TEMPLATE MANAGEMENT
// ============================================================

async function loadTemplate(templateKey, data = {}) {
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

    const result = await pool.query(
        'SELECT subject, body_html, updated_at FROM email_templates WHERE template_key = $1 AND is_active = true',
        [templateKey]
    );
    if (result.rowCount === 0) {
        throw new Error(`Template "${templateKey}" not found or inactive`);
    }
    let { subject, body_html } = result.rows[0];

    templateCache[cacheKey] = {
        template: { subject, body_html },
        timestamp: Date.now(),
        version: result.rows[0].updated_at
    };

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
    try {
        const result = await pool.query(
            'SELECT enabled FROM notification_settings WHERE setting_key = $1',
            [settingKey]
        );
        if (result.rowCount === 0) return true;
        return result.rows[0].enabled;
    } catch (err) {
        console.warn(`⚠️ Failed to check notification setting ${settingKey}:`, err.message);
        return true;
    }
}

async function getNotificationConfig(settingKey) {
    try {
        const result = await pool.query(
            'SELECT config FROM notification_settings WHERE setting_key = $1',
            [settingKey]
        );
        if (result.rowCount === 0) return {};
        return result.rows[0].config || {};
    } catch (err) {
        console.warn(`⚠️ Failed to get notification config ${settingKey}:`, err.message);
        return {};
    }
}

// ============================================================
// EMAIL SENDING FUNCTIONS
// ============================================================

function buildEmailHtml(bodyHtml, subject) {
    // Clean the content to prevent duplicate headers
    let cleanContent = bodyHtml || '';
    
    // If the content contains full HTML, extract only the body content
    if (cleanContent.includes('<html') || cleanContent.includes('<body')) {
        const bodyMatch = cleanContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) {
            cleanContent = bodyMatch[1];
        } else {
            cleanContent = cleanContent
                .replace(/<html[^>]*>/gi, '')
                .replace(/<\/html>/gi, '')
                .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
                .replace(/<body[^>]*>/gi, '')
                .replace(/<\/body>/gi, '')
                .trim();
        }
    }
    
    return wrapEmailContent(cleanContent, subject);
}

async function sendOtpEmail(toEmail, otp) {
    if (!(await isNotificationEnabled('send_otp'))) return;
    return queueEmail(async () => {
        const { subject, body_html } = await loadTemplate('otp', { otp });
        const html = buildEmailHtml(body_html, subject);
        return sendEmailViaBrevo(toEmail, subject, html);
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
                    app_url: APP_URL
                });
            } catch (err) {
                console.log(`📧 Falling back to password_reset template`);
                templateKey = 'password_reset';
                template = await loadTemplate(templateKey, {
                    name: name,
                    reset_link: resetLink,
                    app_url: APP_URL
                });
            }
            const html = buildEmailHtml(template.body_html, template.subject);
            return sendEmailViaBrevo(toEmail, template.subject, html);
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
                change_password_link: changePasswordLink || `${APP_URL}/change-password`,
                app_url: APP_URL
            });
            const html = buildEmailHtml(body_html, subject);
            return sendEmailViaBrevo(toEmail, subject, html);
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
            app_url: APP_URL
        });
        const html = buildEmailHtml(body_html, subject);
        return sendEmailViaBrevo(toEmail, subject, html);
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
            app_url: APP_URL
        });
        const html = buildEmailHtml(body_html, subject);
        return sendEmailViaBrevo(toEmail, subject, html);
    });
}

async function sendReminderEmail(toEmail, subject, body) {
    return queueEmail(async () => {
        const html = buildEmailHtml(body, subject);
        return sendEmailViaBrevo(toEmail, subject, html);
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
            app_url: APP_URL
        });
        const html = buildEmailHtml(body_html, subject);
        return sendEmailViaBrevo(adminEmail, subject, html);
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
            app_url: APP_URL
        });
        const html = buildEmailHtml(body_html, subject);
        return sendEmailViaBrevo(adminEmail, subject, html);
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
        const html = buildEmailHtml(finalBody, subject);
        return sendEmailViaBrevo(adminEmail, subject, html);
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
                    reset_link: resetLink || `${APP_URL}/forgot-password`,
                    app_url: APP_URL
                });
            } catch (err) {
                console.log(`📧 Falling back to account_locked template`);
                templateKey = 'account_locked';
                template = await loadTemplate(templateKey, {
                    name: username,
                    attempts: attempts,
                    app_url: APP_URL
                });
            }
            const html = buildEmailHtml(template.body_html, template.subject);
            return sendEmailViaBrevo(toEmail, template.subject, html);
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
            app_url: APP_URL
        });
        const html = buildEmailHtml(body_html, subject);
        return sendEmailViaBrevo(toEmail, subject, html);
    });
}

async function sendFinePaidEmail(toEmail, username, keyCode, amount) {
    if (!(await isNotificationEnabled('send_fine_paid'))) return;
    return queueEmail(async () => {
        const { subject, body_html } = await loadTemplate('fine_paid', {
            name: username,
            key_code: keyCode,
            amount: amount,
            app_url: APP_URL
        });
        const html = buildEmailHtml(body_html, subject);
        return sendEmailViaBrevo(toEmail, subject, html);
    });
}

async function sendConfirmationEmail(toEmail, subject, body) {
    return queueEmail(async () => {
        const html = buildEmailHtml(body, subject);
        return sendEmailViaBrevo(toEmail, subject, html);
    });
}

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendManualWelcomeEmail(toEmail, username, plainPassword, changePasswordLink) {
    return queueEmail(async () => {
        try {
            const { subject, body_html } = await loadTemplate('welcome', {
                name: username,
                username: username,
                password: plainPassword,
                change_password_link: changePasswordLink || `${APP_URL}/change-password`,
                app_url: APP_URL
            });
            const html = buildEmailHtml(body_html, subject);
            return sendEmailViaBrevo(toEmail, subject, html);
        } catch (err) {
            console.error('❌ Failed to send manual welcome email:', err);
            throw err;
        }
    });
}

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
    sendManualWelcomeEmail,
    generateOtp,
    loadTemplate,
    isNotificationEnabled,
    getNotificationConfig,
    clearTemplateCache,
    updateTemplate,
    getQueueStatus: () => ({
        queueLength: emailQueue.length,
        isProcessing: isProcessingQueue,
        maxQueueSize: MAX_QUEUE_SIZE,
        enabled: ENABLE_EMAIL,
        senderEmail: BREVO_SENDER_EMAIL,
        appUrl: APP_URL
    })
};