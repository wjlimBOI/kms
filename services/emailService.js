// services/emailService.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------- Cache logo as base64 ----------
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

// ---------- Professional HTML wrapper ----------
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

// ---------- Transporter ----------
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ============================================================
//  DATABASE HELPERS FOR TEMPLATES & SETTINGS
// ============================================================

async function loadTemplate(templateKey, data = {}) {
    const result = await pool.query(
        'SELECT subject, body_html FROM email_templates WHERE template_key = $1 AND is_active = true',
        [templateKey]
    );
    if (result.rowCount === 0) {
        throw new Error(`Template "${templateKey}" not found or inactive`);
    }
    let { subject, body_html } = result.rows[0];
    // Replace placeholders {{key}}
    for (const [key, value] of Object.entries(data)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        subject = subject.replace(regex, String(value));
        body_html = body_html.replace(regex, String(value));
    }
    return { subject, body_html };
}

async function isNotificationEnabled(settingKey) {
    const result = await pool.query(
        'SELECT enabled FROM notification_settings WHERE setting_key = $1',
        [settingKey]
    );
    if (result.rowCount === 0) return true; // default enabled
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
//  EMAIL SENDING FUNCTIONS (refactored)
// ============================================================

// ----- OTP email -----
async function sendOtpEmail(toEmail, otp) {
    if (!(await isNotificationEnabled('send_otp'))) return;
    const { subject, body_html } = await loadTemplate('otp', { otp });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Password reset email -----
async function sendPasswordResetEmail(toEmail, resetLink) {
    if (!(await isNotificationEnabled('send_password_reset'))) return;
    const { subject, body_html } = await loadTemplate('password_reset', { reset_link: resetLink });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Welcome / account creation email -----
async function sendPasswordEmail(toEmail, username, plainPassword) {
    if (!(await isNotificationEnabled('send_welcome_email'))) return;
    const { subject, body_html } = await loadTemplate('welcome', { name: username, password: plainPassword });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Request submitted (to requester) -----
async function sendRequestSubmittedEmail(toEmail, requesterName, items, plannedReturn) {
    if (!(await isNotificationEnabled('send_request_submitted'))) return;
    // Build a human‑readable list of keys
    const keys = items.map(i => `${i.quantity} × ${i.code}`).join(', ');
    const { subject, body_html } = await loadTemplate('request_submitted', {
        name: requesterName,
        keys,
        planned_return: plannedReturn
    });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Request approved (to requester) -----
async function sendRequestApprovedEmail(toEmail, requesterName, items, plannedReturn) {
    if (!(await isNotificationEnabled('send_request_approved'))) return;
    const keys = items.map(i => `${i.quantity} × ${i.code}`).join(', ');
    const { subject, body_html } = await loadTemplate('request_approved', {
        name: requesterName,
        keys,
        planned_return: plannedReturn
    });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Reminder emails (called from reminderService) -----
async function sendReminderEmail(toEmail, subject, body) {
    // No setting check here – called by reminderService which already checks
    // We'll keep the signature as before, but we can fetch the template
    // For flexibility, we'll accept plain body and subject.
    const html = getEmailHtml(body, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Admin alert: new registration request -----
async function sendAdminRegistrationAlert(adminEmail, userDetails) {
    if (!(await isNotificationEnabled('send_admin_new_registration'))) return;
    const { name, email, username } = userDetails;
    const { subject, body_html } = await loadTemplate('admin_new_registration', {
        name,
        email,
        username: username || '—'
    });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management Admin" <${process.env.EMAIL_USER}>`,
        to: adminEmail,
        subject,
        html
    });
}

// ----- Admin alert: new key request -----
async function sendAdminNewRequestAlert(adminEmail, requestDetails) {
    if (!(await isNotificationEnabled('send_admin_new_key_request'))) return;
    const { requester_name, requester_email, items, planned_return, created_at } = requestDetails;
    const keys = items.map(i => `${i.quantity} × ${i.code}`).join(', ');
    const { subject, body_html } = await loadTemplate('admin_new_key_request', {
        requester: requester_name,
        email: requester_email,
        keys,
        planned_return,
        created_at
    });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management Admin" <${process.env.EMAIL_USER}>`,
        to: adminEmail,
        subject,
        html
    });
}

// ----- Admin daily summary (due/overdue returns) -----
async function sendAdminReturnReminder(adminEmail, dueTransactions) {
    if (!(await isNotificationEnabled('send_reminders'))) return;
    const config = await getNotificationConfig('send_reminders');
    if (!config.admin_summary_enabled) return;
    // Build a summary table
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
    // The template body_html should contain a placeholder {{summary}}.
    // We'll replace it manually.
    const finalBody = body_html.replace('{{summary}}', summaryBody);
    const html = getEmailHtml(finalBody, subject);
    await transporter.sendMail({
        from: `"BOI Key Management Admin" <${process.env.EMAIL_USER}>`,
        to: adminEmail,
        subject,
        html
    });
}

// ----- Account locked email -----
async function sendAccountLockedEmail(toEmail, username, attempts) {
    if (!(await isNotificationEnabled('send_account_locked'))) return;
    const { subject, body_html } = await loadTemplate('account_locked', { name: username, attempts });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Fine created email -----
async function sendFineCreatedEmail(toEmail, username, keyCode, amount) {
    if (!(await isNotificationEnabled('send_fine_created'))) return;
    const { subject, body_html } = await loadTemplate('fine_created', { name: username, key_code: keyCode, amount });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Fine paid email -----
async function sendFinePaidEmail(toEmail, username, keyCode, amount) {
    if (!(await isNotificationEnabled('send_fine_paid'))) return;
    const { subject, body_html } = await loadTemplate('fine_paid', { name: username, key_code: keyCode, amount });
    const html = getEmailHtml(body_html, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- Generic confirmation (for backward compatibility) -----
async function sendConfirmationEmail(toEmail, subject, body) {
    // This is a legacy function – we'll just use a simple HTML wrapper
    const html = getEmailHtml(body, subject);
    await transporter.sendMail({
        from: `"BOI Key Management" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject,
        html
    });
}

// ----- OTP generator -----
function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ============================================================
//  EXPORTS
// ============================================================
module.exports = {
    sendOtpEmail,
    sendPasswordResetEmail,
    sendPasswordEmail,
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
    // Expose helpers for admin UI (optional)
    loadTemplate,
    isNotificationEnabled,
    getNotificationConfig
};