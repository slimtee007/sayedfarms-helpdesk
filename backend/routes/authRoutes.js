const express = require('express');
const router = express.Router();
const { requestPasswordResetOtp, verifyOtpAndResetPassword } = require('../controllers/authController');

// Route 1: User requests an OTP to be sent to their email
router.post('/forgot-password', requestPasswordResetOtp);

// Route 2: User submits the OTP along with their new password
router.post('/reset-password', verifyOtpAndResetPassword);

module.exports = router;