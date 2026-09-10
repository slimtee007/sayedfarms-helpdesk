const nodemailer = require('nodemailer');

const sendEmail = async (email, otp) => {
  try {
    // 1. Configure SMTP transporter from .env variables
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10),
      secure: false, // Must be false for port 587 (uses STARTTLS)
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // 2. Define message options
    const mailOptions = {
      from: process.env.SMTP_USER, // Sender address MUST match SMTP_USER for Office 365
      to: email,
      subject: 'Password Reset Verification Code',
      text: `Your OTP verification code is: ${otp}`,
      html: `<p>Your OTP verification code is: <strong>${otp}</strong></p>`,
    };

    // 3. Send email via SMTP
    const info = await transporter.sendMail(mailOptions);
    console.log(`[SMTP SUCCESS] Sent to ${email}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`[SMTP ERROR] Failed to send email to ${email}:`, error);
    throw error; // Throw so your controller catches it and returns a 500 status to frontend
  }
};

module.exports = sendEmail;