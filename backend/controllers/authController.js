const User = require('../models/User');
const sendOtpEmail = require('../utils/sendEmail');
const bcrypt = require('bcryptjs');

// Step 1: Generate 6-digit OTP and send via email
exports.requestPasswordResetOtp = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(404).json({ message: 'No employee account found with this email address.' });
        }

        // Generate random 6-digit code
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        user.resetPasswordOtp = otp;
        user.resetPasswordExpires = Date.now() + 10 * 60 * 1000; // valid for 10 minutes
        await user.save();

        // Attempt to send email, with local terminal fallback if SMTP fails
        try {
            await sendOtpEmail(email, otp);
            return res.status(200).json({ message: 'Verification OTP sent to your email address.' });
        } catch (emailError) {
            console.warn('SMTP Send Failed. [DEV FALLBACK MODE]');
            console.log(`\n========================================`);
            console.log(` OTP CODE FOR ${email}: ${otp}`);
            console.log(`========================================\n`);
            
            return res.status(200).json({ message: 'OTP generated successfully (Check terminal console).' });
        }
    } catch (error) {
        console.error('Request OTP error:', error);
        res.status(500).json({ message: 'Internal server error while sending OTP.' });
    }
};

// Step 2: Verify OTP and update password
exports.verifyOtpAndResetPassword = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Check if OTP matches and hasn't expired
        if (user.resetPasswordOtp !== otp || user.resetPasswordExpires < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired OTP code.' });
        }

        // Hash the new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);

        // Clear out the OTP fields so they can't be reused
        user.resetPasswordOtp = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();

        res.status(200).json({ message: 'Password updated successfully! Please sign in with your new password.' });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ message: 'Internal server error while resetting password.' });
    }
};