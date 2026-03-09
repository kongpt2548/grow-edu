require('dotenv').config();
const express = require('express');
const axios = require('axios'); 
const SibApiV3Sdk = require('sib-api-v3-sdk'); 
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // ตัวเข้ารหัสผ่าน
const SibApiV3Sdk = require('sib-api-v3-sdk');
const client = SibApiV3Sdk.ApiClient.instance;
client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const brevoApi = new SibApiV3Sdk.TransactionalEmailsApi();

// ตัวแปรเก็บ OTP ชั่วคราว (เลียนแบบ MinnyStore)
let otpStore = {};
const User = require('./models/User'); // ดึง Model มาใช้

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// ================= ROUTE หน้าเว็บ =================
// หน้าแรกของเว็บ (Landing Page)
app.get('/', (req, res) => {
    res.render('index'); // เดี๋ยวเราจะสร้างไฟล์ index.ejs กัน
});

// หน้าลืมรหัสผ่าน
app.get('/forgot-password', (req, res) => res.render('forgot-password'));
app.get('/register', (req, res) => res.render('register'));
// --- 1. ระบบเช็คชื่อ/อีเมลซ้ำ และส่ง OTP ---
app.post('/send-otp', async (req, res) => {
    const { username, email } = req.body;
    try {
        // เช็คชื่อผู้ใช้ซ้ำ
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ message: 'ชื่อผู้ใช้นี้มีคนใช้แล้ว' });

        // เช็คอีเมลซ้ำ
        const existingEmail = await User.findOne({ email });
        if (existingEmail) return res.status(400).json({ message: 'อีเมลนี้ถูกใช้สมัครไปแล้ว' });

        // สร้างรหัส OTP 6 หลัก
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore[email] = { otp, expire: Date.now() + 5 * 60000 }; // เก็บไว้ 5 นาที

        // ส่งอีเมลด้วย Brevo
        let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = "รหัสยืนยัน (OTP) - Grow EDU";
        sendSmtpEmail.htmlContent = `<html><body style="font-family:sans-serif;">
            <h2 style="color:#1A73E8;">ยืนยันตัวตน Grow EDU</h2>
            <p>รหัส OTP ของคุณคือ: <b style="font-size:24px; color:black;">${otp}</b></p>
            <p>รหัสนี้จะหมดอายุภายใน 5 นาที</p>
        </body></html>`;
        sendSmtpEmail.sender = { "name": "Grow EDU", "email": "noreply@growedu.com" };
        sendSmtpEmail.to = [{ "email": email }];

        await brevoApi.sendTransacEmail(sendSmtpEmail);
        res.json({ message: 'ส่ง OTP เรียบร้อย' });
    } catch (err) {
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการส่งเมล' });
    }
});

// --- 2. ระบบ Reset Password (ลืมรหัสผ่าน) ---
app.post('/forgot-password-otp', async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'ไม่พบอีเมลนี้ในระบบ' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { otp, expire: Date.now() + 5 * 60000 };

    let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "กู้คืนรหัสผ่าน - Grow EDU";
    sendSmtpEmail.htmlContent = `<h3>รหัส OTP สำหรับตั้งรหัสผ่านใหม่คือ: ${otp}</h3>`;
    sendSmtpEmail.sender = { "name": "Grow EDU", "email": "support@growedu.com" };
    sendSmtpEmail.to = [{ "email": email }];

    await brevoApi.sendTransacEmail(sendSmtpEmail);
    res.json({ message: 'ส่งรหัสเข้าเมลแล้ว' });
});

app.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    const record = otpStore[email];

    if (!record || record.otp !== otp || Date.now() > record.expire) {
        return res.status(400).json({ message: 'OTP ไม่ถูกต้องหรือหมดอายุ' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate({ email }, { password: hashedPassword });
    delete otpStore[email];
    res.json({ message: 'เปลี่ยนรหัสผ่านใหม่สำเร็จ!' });
});

// --- 1. ขอ OTP สำหรับสมัครสมาชิก ---
app.post('/request-register-otp', async (req, res) => {
    const { username, email } = req.body;
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ message: 'ชื่อผู้ใช้นี้มีคนใช้แล้ว' });

        const existingEmail = await User.findOne({ email });
        if (existingEmail) return res.status(400).json({ message: 'อีเมลนี้ถูกใช้สมัครไปแล้ว' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const refCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        otpStore[email] = { otp, expire: Date.now() + 5 * 60000 };

        let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = "รหัสยืนยันการสมัครสมาชิก Grow EDU";
        sendSmtpEmail.htmlContent = `<h2>รหัส OTP ของคุณคือ: <b style="color:#1A73E8;">${otp}</b></h2><p>Ref Code: ${refCode}</p>`;
        sendSmtpEmail.sender = { "name": "Grow EDU", "email": "noreply@growedu.com" };
        sendSmtpEmail.to = [{ "email": email }];

        await brevoApi.sendTransacEmail(sendSmtpEmail);
        res.json({ refCode }); // ส่ง refCode กลับไปโชว์ที่หน้าเว็บ
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่' });
    }
});

// --- 2. ยืนยัน OTP และบันทึกบัญชีใหม่ ---
app.post('/register', async (req, res) => {
    // ตัด pin ออกตามที่คุณสั่ง แต่รับค่ามาเผื่อหน้าเว็บส่งมาจะได้ไม่พัง
    const { username, email, password, role, otp } = req.body; 
    const record = otpStore[email];

    if (!record || record.otp !== otp || Date.now() > record.expire) {
        return res.status(400).json({ message: 'รหัส OTP ไม่ถูกต้อง หรือหมดอายุแล้ว' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        // บันทึก email ลง DB ด้วย (อย่าลืมเพิ่มฟิลด์ email ใน models/User.js นะครับ)
        const newUser = new User({ username, email, password: hashedPassword, role: role || 'student' });
        await newUser.save();
        delete otpStore[email]; // ลบ OTP ทิ้งหลังใช้เสร็จ
        
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

        let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = "คำขอกู้คืนรหัสผ่าน Grow EDU";
        sendSmtpEmail.htmlContent = `<h2>รหัส OTP สำหรับตั้งรหัสผ่านใหม่คือ: <b style="color:#1A73E8;">${otp}</b></h2>`;
        sendSmtpEmail.sender = { "name": "Grow EDU", "email": "support@growedu.com" };
        sendSmtpEmail.to = [{ "email": email }];

        await brevoApi.sendTransacEmail(sendSmtpEmail);
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
        
        // หาชื่อผู้ใช้ในฐานข้อมูล
        const user = await User.findOne({ username });
        if (!user) return res.send('<script>alert("ไม่พบชื่อผู้ใช้นี้!"); window.location="/login";</script>');

        // เช็ครหัสผ่าน
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.send('<script>alert("รหัสผ่านผิด!"); window.location="/login";</script>');

        // ถ้ารหัสถูก ให้เด้งไปหน้าตาม Role
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

// =======================================================

// เชื่อมต่อ MongoDB
const uri = process.env.MONGO_URI;
mongoose.connect(uri)
  .then(() => console.log('✅ เชื่อมต่อ MongoDB (Grow EDU) สำเร็จแล้ว!'))
  .catch(err => console.error('❌ เชื่อมต่อไม่สำเร็จ:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 เซิร์ฟเวอร์รันที่พอร์ต ${PORT}`));