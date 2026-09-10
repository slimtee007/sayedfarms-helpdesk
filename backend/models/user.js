// Add these fields to your existing Mongoose schema
resetPasswordOtp: {
    type: String,
    required: false
},
resetPasswordExpires: {
    type: Date,
    required: false
}