const nodemailer = require('nodemailer');

/**
 * Returns true only when real SMTP settings are present.
 * Placeholder hosts containing "example" are treated as "not configured".
 */
const isSmtpConfigured = () => {
  const host = (process.env.SMTP_HOST || '').trim();
  return Boolean(host) && !host.includes('example');
};

const buildTransporter = () => {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Port 465 uses implicit TLS; 587/25 use STARTTLS (secure: false)
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      : undefined,
  });
};

/**
 * Sends the password-reset OTP email.
 * Resolves with { sent: true, messageId } on success.
 * Throws on failure — caller must handle and tell the user the truth.
 */
const sendOtpEmail = async (email, otp, kind = 'reset') => {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP_NOT_CONFIGURED');
  }

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject =
    kind === 'resend'
      ? 'New Password Reset Verification Code'
      : 'Password Reset Verification Code';
  const intro = kind === 'resend' ? 'Your new verification code' : 'Your verification code';

  const transporter = buildTransporter();
  const info = await transporter.sendMail({
    from,
    to: email,
    subject,
    text: `${intro} is: ${otp}. It expires in 10 minutes. If you did not request a password reset, you can ignore this email.`,
    html: `<p>${intro} is: <strong style="font-size:18px;letter-spacing:2px;">${otp}</strong></p><p>It expires in 10 minutes.</p><p style="color:#94a3b8;font-size:12px;">If you did not request a password reset, you can ignore this email.</p>`,
  });

  console.log(`[SMTP SUCCESS] Sent to ${email}: ${info.messageId}`);
  return { sent: true, messageId: info.messageId };
};

module.exports = { sendOtpEmail, isSmtpConfigured };
