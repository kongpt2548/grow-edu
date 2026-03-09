require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // ตัวเข้ารหัสผ่าน
const User = require('./models/User'); // ดึง Model มาใช้

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// ================= ROUTE หน้าเว็บ =================
//หน้าแรกสุดเด้งไปหน้าสมัครสมาชิกทันที
app.get('/', (req, res) => {
    res.redirect('/register');
});
app.get('/register', (req, res) => res.render('register'));

// ระบบสมัครสมาชิก (บันทึกลง DB จริง)
app.post('/register', async (req, res) => {
    try {
        const { username, password, role } = req.body;
        
        // เช็คว่าชื่อซ้ำไหม
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.send('<script>alert("ชื่อนี้มีคนใช้แล้วครับ!"); window.location="/register";</script>');

        // เข้ารหัสผ่าน และบันทึกลงฐานข้อมูล
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword, role });
        await newUser.save();

        res.redirect('/login'); // สมัครเสร็จเด้งไปหน้า Login
    } catch (err) {
        console.error(err);
        res.send('เกิดข้อผิดพลาด');
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