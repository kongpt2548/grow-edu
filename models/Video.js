const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    title: { type: String, required: true },
    subject: { type: String, required: true }, // วิชา
    topic: { type: String, required: true },   // เรื่อง
    level: { type: String, required: true },   // ระดับชั้น
    driveFileId: { type: String, required: true }, // ID ไฟล์ใน Google Drive
    price: { type: Number, required: true },
    views: { type: Number, default: 0 }, // จำนวนคนดู
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, // ระบบรอตรวจสอบ
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Video', videoSchema);