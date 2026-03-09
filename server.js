require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const Order = require('./models/Order'); // ดึงโมเดล Order มาใช้
const express = require('express');
const axios = require('axios'); 
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // ตัวเข้ารหัสผ่าน
const SibApiV3Sdk = require('sib-api-v3-sdk');
const client = SibApiV3Sdk.ApiClient.instance;
client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
// ใช้ Google Apps Script API แทนเพื่อทะลวงบล็อก Render
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwKLxM7TKxmCwouR1N6dJb7mdDRfWgho-3zrgQUXy-Dxp2f4Enw3riwfjI7dFNiJWG-zQ/exec';

// ตัวแปรเก็บ OTP ชั่วคราว (เลียนแบบ MinnyStore)
let otpStore = {};
const User = require('./models/User'); // ดึง Model มาใช้
const Video = require('./models/Video');

const session = require('express-session');
const app = express();
app.use(session({ secret: 'growedu_secret', resave: false, saveUninitialized: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
// 1. หน้าเลือกชั้น
app.get('/courses', (req, res) => res.render('course-selection'));

// 2. หน้าเลือกบทเรียนตามชั้น
app.get('/courses/:level', (req, res) => {
    res.render('course-topics', { level: req.params.level });
});

// 3. หน้าดึงคลิปจาก DB (แสดงเฉพาะสถานะ approved)
app.get('/video-list/:level/:term/:subject', async (req, res) => {
    try {
        const { level, subject } = req.params;
        // ค้นหาวิดีโอที่ตรงเงื่อนไข และต้องได้รับการอนุมัติ (approved) เท่านั้น
        const videos = await Video.find({ 
            level: level, 
            subject: subject, 
            status: 'approved' 
        }).populate('tutorId'); // ดึงชื่อติวเตอร์มาด้วย

        res.render('video-list', { 
            videos, 
            level, 
            subject 
        });
    } catch (err) {
        res.status(500).send("Error fetching videos");
    }
});

// เพิ่ม Route หน้าอัปโหลด
app.get('/tutor/upload', (req, res) => res.render('tutor_upload'));

// ระบบรับการอัปโหลด (ส่งไปรอตรวจสอบ)
app.post('/tutor/upload', async (req, res) => {
    try {
        const { title, subject, topic, level, driveFileId, price } = req.body;
        const newVideo = new Video({
            tutorId: req.session.userId, // สมมติว่ามีระบบ Session
            title, subject, topic, level, driveFileId, price,
            status: 'pending' // เริ่มต้นเป็นรอตรวจสอบ
        });
        await newVideo.save();
        res.send('<script>alert("ส่งคลิปตรวจสอบแล้ว!"); window.location="/tutor";</script>');
    } catch (err) {
        res.status(500).send("Error uploading");
    }
});

// หน้าสรุปรายได้ติวเตอร์
app.get('/tutor/income', async (req, res) => {
    const user = await User.findById(req.session.userId);
    const videos = await Video.find({ tutorId: req.session.userId });
    res.render('tutor_report', { user, videos });
});

// ตัวอย่างระบบคำนวณเงิน (จะรันเมื่อมีนักเรียนมาซื้อคลิป)
// revenue = price * 0.6; // ติวเตอร์ได้ 60%

// ================= ระบบชำระเงิน (Checkout) =================

// 1. API สร้างรูป QR Code พร้อมเพย์
app.get('/api/qr/:amount', async (req, res) => {
  try {
    const amount = Number(req.params.amount);
    if (!amount || amount <= 0) return res.status(204).end(); 

    // ⚠️ เปลี่ยนเป็นเบอร์พร้อมเพย์ หรือ เลขบัตร ปชช. ของคุณ
    const promptpayId = '0980573163'; 
    
    const payload = generatePayload(promptpayId, { amount });
    const buffer = await QRCode.toBuffer(payload, {
      width: 300,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('QR ERROR:', err.message);
    res.status(500).send('QR GENERATE ERROR');
  }
});

// 2. หน้าเว็บแสดงข้อมูลก่อนจ่ายเงิน
app.get('/checkout/:videoId', async (req, res) => {
    try {
        const video = await Video.findById(req.params.videoId).populate('tutorId');
        res.render('checkout', { video });
    } catch (err) {
        res.status(500).send("ไม่พบคอร์สเรียน");
    }
});

// 3. API รับข้อมูลสลิปที่แนบมา (สถานะ Pending)
app.post('/api/submit-payment', async (req, res) => {
    try {
        const { videoId, amount, slipImage } = req.body;
        const studentId = req.session.userId; // ใช้ session จากตอน login

        if (!studentId) return res.status(401).json({ message: "กรุณาเข้าสู่ระบบก่อน" });
        if (!slipImage) return res.status(400).json({ message: "กรุณาแนบรูปสลิป" });

        const newOrder = new Order({
            studentId,
            videoId,
            amount,
            slipImage, // บันทึกสลิป Base64 ลง DB
            status: 'pending' // รอแอดมินอนุมัติ
        });
        await newOrder.save();

        res.json({ message: "ส่งสลิปเรียบร้อย รอแอดมินตรวจสอบเพื่อปลดล็อกเนื้อหาครับ" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "ระบบขัดข้อง" });
    }
});

// หน้า Admin Approval
app.get('/admin/approval', async (req, res) => {
    try {
        // ดึงคลิปที่สถานะเป็น pending มาตรวจสอบ
        const pendingVideos = await Video.find({ status: 'pending' }).populate('tutorId');
        
        // คำนวณรายได้ทั้งหมดของระบบ (สมมติว่าเอามาจากยอดรวมของคลิปที่มีคนดู/ซื้อไปแล้ว)
        // ในระบบจริง คุณอาจต้องมีคอลเลกชัน Transaction เพื่อเก็บยอดซื้อ
        const allVideos = await Video.find({ status: 'approved' });
        const totalRevenue = allVideos.reduce((sum, v) => sum + (v.views * v.price), 0);

        res.render('admin_approval', { pendingVideos, totalRevenue });
    } catch (err) {
        res.status(500).send("Admin Error");
    }
});

// API สำหรับเปลี่ยนสถานะวิดีโอ
app.post('/admin/update-video-status', async (req, res) => {
    const { videoId, status } = req.body;
    try {
        await Video.findByIdAndUpdate(videoId, { status: status });
        res.json({ message: `อัปเดตสถานะเป็น ${status} เรียบร้อยแล้ว` });
    } catch (err) {
        res.status(500).json({ message: "เกิดข้อผิดพลาด" });
    }
});
// ================= ROUTE หน้าเว็บ =================
// หน้าแรกของเว็บ (Landing Page)
app.get('/', (req, res) => {
    res.render('index'); // เดี๋ยวเราจะสร้างไฟล์ index.ejs กัน
});

// หน้าลืมรหัสผ่าน
app.get('/forgot-password', (req, res) => res.render('forgot-password'));
app.get('/register', (req, res) => res.render('register'));

// --- API ตรวจสอบข้อมูลแบบ Real-time (MinnyStore Style) ---
app.post('/api/check-username', async (req, res) => {
    const { username } = req.body;
    const user = await User.findOne({ username: { $regex: '^' + username + '$', $options: 'i' } });
    if (user) return res.json({ available: false, message: 'ชื่อนี้มีคนใช้แล้ว' });
    res.json({ available: true });
});

app.post('/api/check-email', async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email: { $regex: '^' + email + '$', $options: 'i' } });
    if (user) return res.json({ available: false, message: 'อีเมลนี้ถูกใช้สมัครไปแล้ว' });
    res.json({ available: true });
});

// --- 1. ขอ OTP สำหรับสมัครสมาชิก ---
app.post('/request-register-otp', async (req, res) => {
    const { username, email } = req.body;
    try {
        const existingUser = await User.findOne({ username: { $regex: '^' + username + '$', $options: 'i' } });
        if (existingUser) return res.status(400).json({ message: 'ชื่อผู้ใช้นี้มีคนใช้แล้ว' });

        const existingEmail = await User.findOne({ email: { $regex: '^' + email + '$', $options: 'i' } });
        if (existingEmail) return res.status(400).json({ message: 'อีเมลนี้ถูกใช้สมัครไปแล้ว' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const refCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        otpStore[email] = { otp, expire: Date.now() + 5 * 60000 };

        await axios.post(GOOGLE_SCRIPT_URL, {
            to: email,
            subject: "รหัสยืนยันการสมัครสมาชิก Grow EDU",
            html: `<h2>รหัส OTP ของคุณคือ: <b style="color:#1A73E8;">${otp}</b></h2><p>Ref Code: ${refCode}</p>`
        });
        res.status(200).json({ refCode }); 
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่' });
    }
});

// --- 2. ยืนยัน OTP และบันทึกบัญชีใหม่ ---
app.post('/register', async (req, res) => {
    const { username, email, password, role, otp } = req.body; 
    const record = otpStore[email];

    if (!record || record.otp !== otp || Date.now() > record.expire) {
        return res.status(400).json({ message: 'รหัส OTP ไม่ถูกต้อง หรือหมดอายุแล้ว' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, email, password: hashedPassword, role: role || 'student' });
        await newUser.save();
        delete otpStore[email];
        
        res.status(200).json({ message: 'สมัครสมาชิกสำเร็จ' });
    } catch (err) {
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการสร้างบัญชี' });
    }
});

// --- 3. ขอ OTP สำหรับลืมรหัสผ่าน ---
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: 'ไม่พบอีเมลนี้ในระบบ' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore[email] = { otp, expire: Date.now() + 5 * 60000 };

       await axios.post(GOOGLE_SCRIPT_URL, {
            to: email,
            subject: "คำขอกู้คืนรหัสผ่าน Grow EDU",
            html: `<h2>รหัส OTP สำหรับตั้งรหัสผ่านใหม่คือ: <b style="color:#1A73E8;">${otp}</b></h2>`
        });
        res.status(200).json({ message: 'ส่งรหัส OTP เรียบร้อย' });
    } catch (err) {
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการส่งอีเมล' });
    }
});

// --- 4. ยืนยันเปลี่ยนรหัสผ่านใหม่ ---
app.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    const record = otpStore[email];

    if (!record || record.otp !== otp || Date.now() > record.expire) {
        return res.status(400).json({ message: 'รหัส OTP ไม่ถูกต้อง หรือหมดอายุแล้ว' });
    }

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await User.findOneAndUpdate({ email }, { password: hashedPassword });
        delete otpStore[email];
        res.status(200).json({ message: 'เปลี่ยนรหัสผ่านสำเร็จ!' });
    } catch (err) {
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
    }
});
app.get('/login', (req, res) => res.render('login'));

// ระบบเข้าสู่ระบบ (เช็คจาก DB จริง)
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // ค้นหาแบบไม่สนตัวพิมพ์เล็ก/ใหญ่ (Case Insensitive)
        const user = await User.findOne({ 
            $or: [
                { username: { $regex: '^' + username + '$', $options: 'i' } }, 
                { email: { $regex: '^' + username + '$', $options: 'i' } }
            ] 
        });
        
        if (!user) return res.send('<script>alert("ไม่พบชื่อผู้ใช้นี้!"); window.location="/login";</script>');

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.send('<script>alert("รหัสผ่านผิด!"); window.location="/login";</script>');

        // สร้าง Session เพื่อยืนยันตัวตน (ฝังบัตร)
        req.session.userId = user._id;
        req.session.username = user.username.toLowerCase(); // ปรับเป็นพิมพ์เล็กเพื่อเช็คสิทธิ์ง่ายๆ

        // ตรวจสอบ Master Admin
        if (req.session.username === 'admin') {
            return res.redirect('/admin/approval');
        }

        if (user.role === 'tutor') {
            res.redirect('/tutor');
        } else {
            res.redirect('/student');
        }
    } catch (err) {
        console.error(err);
        res.send('เกิดข้อผิดพลาด');
    }
});

app.get('/student', (req, res) => res.render('student_dashboard'));
app.get('/tutor', (req, res) => res.render('tutor_dashboard'));
app.get('/courses', (req, res) => res.render('courses'));
app.get('/tutors', (req, res) => res.render('tutors'));
// =======================================================

// --- ส่วนของ ADMIN: หน้าอนุมัติคลิป ---
app.get('/admin/approval', async (req, res) => {
    // ล็อกประตูกันคนพิมพ์ URL เข้ามาตรงๆ (ต้องเป็น user ที่ชื่อ admin เท่านั้น!)
    if (req.session.username !== 'admin') {
        return res.send('<script>alert("ไม่มีสิทธิ์เข้าถึง! เฉพาะ Master Admin เท่านั้น"); window.location="/login";</script>');
    }

    try {
        const pendingVideos = await Video.find({ status: 'pending' }).populate('tutorId');
        const allVideos = await Video.find({ status: 'approved' });
        const totalRevenue = allVideos.reduce((sum, v) => sum + (v.views * v.price), 0);
        res.render('admin_approval', { pendingVideos, totalRevenue });
    } catch (err) {
        res.status(500).send("Admin Error");
    }
});

// --- ส่วนของ ADMIN: กดปุ่ม อนุมัติ/ปฏิเสธ ---
app.post('/admin/update-video-status', async (req, res) => {
    const { videoId, status } = req.body;
    try {
        await Video.findByIdAndUpdate(videoId, { status: status });
        res.json({ message: `อัปเดตสถานะเป็น ${status} เรียบร้อยแล้ว` });
    } catch (err) {
        res.status(500).json({ message: "Update Error" });
    }
});

// --- ส่วนของ TUTOR: รับข้อมูลการอัปโหลดคลิป ---
app.post('/tutor/upload', async (req, res) => {
    try {
        const { title, subject, topic, level, driveFileId, price, tutorId } = req.body;
        const newVideo = new Video({
            tutorId, 
            title, subject, topic, level, driveFileId, price,
            status: 'pending' // ต้องรอแอดมินอนุมัติก่อน
        });
        await newVideo.save();
        res.send('<script>alert("ส่งคลิปตรวจสอบแล้ว!"); window.location="/tutor";</script>');
    } catch (err) {
        res.status(500).send("Upload Error");
    }
});

// เชื่อมต่อ MongoDB
const uri = process.env.MONGO_URI;
mongoose.connect(uri)
  .then(() => console.log('✅ เชื่อมต่อ MongoDB (Grow EDU) สำเร็จแล้ว!'))
  .catch(err => console.error('❌ เชื่อมต่อไม่สำเร็จ:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 เซิร์ฟเวอร์รันที่พอร์ต ${PORT}`));