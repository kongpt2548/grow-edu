const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video' },
    amount: Number,
    slipImage: String, // เก็บรูปสลิปเป็น Base64
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', orderSchema);