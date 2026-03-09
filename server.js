require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const Order = require('./models/Order'); // ดึงโมเดล Order มาใช้
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
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
// ================= ROUTE ฝั่งนักเรียน (การเรียน) =================

// 1. หน้าเลือกชั้นเรียน
app.get('/courses', (req, res) => res.render('course-selection'));

// 2. หน้าเลือกวิชา (ตามระดับชั้น)
app.get('/courses/:level', (req, res) => {
    res.render('course-topics', { level: req.params.level });
});

// 3. หน้าแสดงรายการคลิปตามวิชา
app.get('/courses/:level/:subject', async (req, res) => {
    try {
        const { level, subject } = req.params;
        // ดึงเฉพาะคลิปที่แอดมินอนุมัติแล้ว (approved) มาโชว์ให้นักเรียนซื้อ
        const videos = await Video.find({ level, subject, status: 'approved' }).populate('tutorId');
        res.render('video-list', { level, subject, videos });
    } catch (err) {
        res.status(500).send("Error fetching videos");
    }
});

// ================= ROUTE นักเรียน =================
app.get('/student', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
        // 1. ดึงออเดอร์ "ทั้งหมด" ของนักเรียนคนนี้ (เรียงจากใหม่ไปเก่า)
        const allOrders = await Order.find({ studentId: req.session.userId })
            .populate({ path: 'videoId', populate: { path: 'tutorId' } })
            .sort({ createdAt: -1 });

        // 2. กรองเฉพาะอันที่ "อนุมัติแล้ว" เพื่อเอาไปโชว์ในกล่องเข้าเรียน
        const activeCourses = allOrders.filter(order => order.status === 'approved');

        // ส่งข้อมูลทั้ง 2 ก้อนไปที่หน้าเว็บ
        res.render('student_dashboard', { activeCourses, allOrders });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Error loading dashboard"); 
    }
});

// ================= ROUTE ฝั่งติวเตอร์ =================

// 1. หน้า Dashboard ติวเตอร์ (ดึงข้อมูลจริง)
app.get('/tutor', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
        const tutorId = req.session.userId;
        
        // ดึงคลิปของติวเตอร์คนนี้
        const myVideos = await Video.find({ tutorId });
        const videoIds = myVideos.map(v => v._id);

        // ดึงออเดอร์ที่มีคนซื้อคลิปของติวเตอร์คนนี้ และแอดมินอนุมัติสลิปแล้ว
        const orders = await Order.find({ videoId: { $in: videoIds }, status: 'approved' });

        // คำนวณนักเรียนทั้งหมด (คนซื้อ) และรายได้ (60%)
        const totalStudents = orders.length;
        const totalRevenue = orders.reduce((sum, order) => sum + (order.amount * 0.6), 0);

        res.render('tutor_dashboard', { totalStudents, totalRevenue });
    } catch (err) {
        res.status(500).send("Error loading dashboard");
    }
});

// 2. หน้าฟอร์มอัปโหลดคลิป
app.get('/tutor/upload', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.render('tutor_upload');
});

// 3. ระบบรับข้อมูลอัปโหลดคลิป (แบบ API + SweetAlert)
app.post('/tutor/upload', async (req, res) => {
    try {
        if (!req.session.userId) return res.status(401).json({ message: "กรุณาเข้าสู่ระบบ" });
        
        let { title, subject, level, driveFileId, price } = req.body;

        // 🌟 ดักจับและสกัดเอาแค่ ID (กรณีที่ติวเตอร์วางมาทั้งลิงก์)
        if (driveFileId.includes('drive.google.com')) {
            const match = driveFileId.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                driveFileId = match[1]; // เอาแค่รหัส ID มาใช้
            }
        }
        
        const newVideo = new Video({
            tutorId: req.session.userId,
            title, 
            subject, 
            topic: title,
            level, 
            driveFileId, 
            price,
            status: 'pending'
        });
        await newVideo.save();
        
        // ส่งข้อความกลับไปให้หน้าเว็บโชว์กล่องสวยๆ
        res.json({ success: true, message: "ส่งคลิปให้แอดมินตรวจสอบเรียบร้อย!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด ข้อมูลไม่ครบถ้วน" });
    }
});

// 4. หน้ารายได้และประวัติคลิปของติวเตอร์
app.get('/tutor/income', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
        const myVideos = await Video.find({ tutorId: req.session.userId }).sort({ createdAt: -1 });
        const orders = await Order.find({ videoId: { $in: myVideos.map(v => v._id) }, status: 'approved' });
        
        const totalRevenue = orders.reduce((sum, order) => sum + (order.amount * 0.6), 0);
        // สังเกตว่าเราใช้ render('tutor_report') ให้ตรงกับชื่อไฟล์ที่คุณมี
        res.render('tutor_report', { videos: myVideos, totalRevenue });
    } catch (err) {
        res.status(500).send("Error loading income");
    }
});

// ตัวอย่างระบบคำนวณเงิน (จะรันเมื่อมีนักเรียนมาซื้อคลิป)
// revenue = price * 0.6; // ติวเตอร์ได้ 60%

// ================= ระบบชำระเงิน (Checkout) =================
app.get('/api/qr/:amount', async (req, res) => {
    try {
        const amount = Number(req.params.amount);
        if (!amount || amount <= 0) return res.status(204).end(); 
        
        // ⚠️ เปลี่ยนเป็นเบอร์พร้อมเพย์ของคุณตรงนี้
        const promptpayId = '0980573163'; 
        
        const payload = generatePayload(promptpayId, { amount });
        const buffer = await QRCode.toBuffer(payload, {
            width: 300,
            color: { dark: '#000000', light: '#ffffff' }
        });
        res.set('Content-Type', 'image/png');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('QR ERROR');
    }
});

app.get('/checkout/:videoId', async (req, res) => {
    try {
        const video = await Video.findById(req.params.videoId).populate('tutorId');
        res.render('checkout', { video });
    } catch (err) {
        res.status(500).send("ไม่พบคอร์ส");
    }
});

app.post('/api/submit-payment', async (req, res) => {
    try {
        const { videoId, amount, slipImage } = req.body;
        // ต้องมี req.session.userId จากตอน Login
        if (!req.session.userId) return res.status(401).json({ message: "กรุณาเข้าสู่ระบบ" });

        const newOrder = new Order({
            studentId: req.session.userId,
            videoId,
            amount,
            slipImage,
            status: 'pending'
        });
        await newOrder.save();
        res.json({ message: "ส่งสลิปเรียบร้อย รอแอดมินตรวจสอบครับ" });
    } catch (err) {
        res.status(500).json({ message: "ระบบขัดข้อง" });
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

// ระบบเข้าสู่ระบบ (แบบ API รองรับ SweetAlert)
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await User.findOne({ 
            $or: [
                { username: { $regex: '^' + username + '$', $options: 'i' } }, 
                { email: { $regex: '^' + username + '$', $options: 'i' } }
            ] 
        });
        
        // 🌟 เปลี่ยนมาส่ง JSON กลับไปบอกหน้าเว็บว่ามี Error อะไร
        if (!user) return res.status(400).json({ success: false, message: 'ไม่พบชื่อผู้ใช้นี้ในระบบ!' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง!' });

        req.session.userId = user._id;
        req.session.username = user.username.toLowerCase();

        // กำหนดทางไปต่อ
        let redirectUrl = '/student';
        if (req.session.username === 'admin') redirectUrl = '/admin/approval';
        else if (user.role === 'tutor') redirectUrl = '/tutor';

        // 🌟 ส่ง JSON กลับไปบอกว่าล็อกอินสำเร็จ พร้อมเป้าหมายที่จะให้เด้งไป
        res.json({ success: true, redirect: redirectUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดของระบบ' });
    }
});
// =======================================================

// ================= ROUTE ฝั่ง ADMIN =================

// --- ส่วนของ ADMIN: หน้า Dashboard หลัก ---
app.get('/admin/approval', async (req, res) => {
    if (req.session.username !== 'admin') {
        return res.send('<script>alert("ไม่มีสิทธิ์เข้าถึง! เฉพาะ Master Admin เท่านั้น"); window.location="/login";</script>');
    }

    try {
        // 1. ดึงข้อมูลคลิปที่รอตรวจ
        const pendingVideos = await Video.find({ status: 'pending' }).populate('tutorId');
        
        // 2. ดึงข้อมูลสลิปโอนเงินที่รอตรวจ (ดึงชื่อนักเรียน และ ชื่อคลิป มาด้วย)
        const pendingOrders = await Order.find({ status: 'pending' })
                                        .populate('studentId', 'username')
                                        .populate('videoId', 'title price');

        // 3. คำนวณรายได้รวมทั้งหมด (จากออเดอร์ที่แอดมินอนุมัติสลิปแล้ว)
        const approvedOrders = await Order.find({ status: 'approved' });
        const totalRevenue = approvedOrders.reduce((sum, order) => sum + order.amount, 0);

        res.render('admin_approval', { pendingVideos, pendingOrders, totalRevenue });
    } catch (err) {
        console.error(err);
        res.status(500).send("Admin Error");
    }
});

// --- API สำหรับเปลี่ยนสถานะ "วิดีโอ" ---
app.post('/admin/update-video-status', async (req, res) => {
    const { videoId, status } = req.body;
    try {
        await Video.findByIdAndUpdate(videoId, { status: status });
        res.json({ message: `อัปเดตสถานะคลิปเป็น ${status} เรียบร้อยแล้ว` });
    } catch (err) {
        res.status(500).json({ message: "Update Error" });
    }
});

// --- API สำหรับเปลี่ยนสถานะ "สลิปโอนเงิน" (มาใหม่!) ---
app.post('/admin/update-order-status', async (req, res) => {
    const { orderId, status } = req.body;
    try {
        await Order.findByIdAndUpdate(orderId, { status: status });
        res.json({ message: `อัปเดตสถานะการชำระเงินเป็น ${status} เรียบร้อยแล้ว` });
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