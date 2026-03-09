const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['student', 'tutor'], required: true }, // แยกประเภทผู้ใช้
    level: { type: String }, // ประถม, ม.ต้น, ม.ปลาย
    subject: { type: String } // วิชาที่สอน (สำหรับติวเตอร์)
});

module.exports = mongoose.model('User', userSchema);