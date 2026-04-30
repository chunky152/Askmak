const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const db = require('./config/db');
const errorHandler = require('./middleware/error');
const { guestMiddleware } = require('./middleware/guest');
const { requireAdminPage } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const uploadRoutes = require('./routes/upload');
const escalationRoutes = require('./routes/escalation');
const feedbackRoutes = require('./routes/feedback');
const memoriesRoutes = require('./routes/memories');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');

const cron = require('./services/cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? 'https://askmak.mak.ac.ug'
        : ['http://localhost:' + PORT, 'http://127.0.0.1:' + PORT],
    credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET));

const publicDir = path.join(__dirname, '..', 'frontend', 'public');

app.get('/admin.html', requireAdminPage, (req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
});

app.use(express.static(publicDir));

app.use(guestMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/escalations', escalationRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/memories', memoriesRoutes);
app.use('/api', healthRoutes);
app.use('/api/admin', adminRoutes);

app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(errorHandler);

async function start() {
    try {
        await db.query('SELECT 1');
        console.log('Database connected');
    } catch (err) {
        console.warn('Database not available:', err.message);
    }

    if (!process.env.OPENAI_API_KEY || !String(process.env.OPENAI_API_KEY).trim()) {
        console.warn('OPENAI_API_KEY is not set: chat completions and embedding API calls will fail until you add it to .env');
    }

    cron.start();

    app.listen(PORT, '127.0.0.1', () => {
        console.log(`AskMak server running at http://localhost:${PORT}/`);
    });
}

start();
