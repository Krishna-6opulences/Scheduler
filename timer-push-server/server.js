// MongoDB-backed push-notification and task sync backend for the study scheduler.
//
// What it does:
//   - Connects to MongoDB via process.env.MONGODB_URI.
//   - Replaces sessions.json file-based storage with MongoDB to persist subscriptions across server restarts.
//   - Adds task sync endpoints to save and retrieve tasks per user session.

const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';
const MONGODB_URI = process.env.MONGODB_URI;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars. Generate with: npx web-push generate-vapid-keys');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// MongoDB connection
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));
} else {
  console.warn('WARNING: MONGODB_URI env var is not set. Database features will be unavailable.');
}

// Schemas & Models
const SessionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  subscription: { type: Object, required: true },
  taskLabel: { type: String, default: 'your process' },
  workFireAt: { type: Number, required: true },
  breakFireAt: { type: Number, required: true },
  workSent: { type: Boolean, default: false },
  breakSent: { type: Boolean, default: false },
});
const Session = mongoose.model('Session', SessionSchema);

const UserTasksSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  tasks: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now }
});
const UserTasks = mongoose.model('UserTasks', UserTasksSchema);

// health check - also what your uptime pinger should hit
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'timer-push-server', dbConnected: mongoose.connection.readyState === 1 });
});

// GET /tasks/:userId - fetch user tasks
app.get('/tasks/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const record = await UserTasks.findOne({ userId: userId.toLowerCase().trim() });
    if (!record) {
      return res.json({ tasks: null });
    }
    res.json({ tasks: record.tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /tasks/:userId - save/sync user tasks
app.post('/tasks/:userId', async (req, res) => {
  const { userId } = req.params;
  const { tasks } = req.body;
  try {
    const record = await UserTasks.findOneAndUpdate(
      { userId: userId.toLowerCase().trim() },
      { tasks, updatedAt: Date.now() },
      { new: true, upsert: true }
    );
    res.json({ ok: true, tasks: record.tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Frontend calls this the moment a work block starts.
// body: { subscription, taskLabel, workSeconds, breakSeconds }
app.post('/schedule', async (req, res) => {
  const { subscription, taskLabel, workSeconds, breakSeconds } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'missing subscription' });
  }
  const now = Date.now();
  const workMs = (workSeconds || 50 * 60) * 1000;
  const breakMs = (breakSeconds || 10 * 60) * 1000;

  try {
    // cancel any previous pending session for this same subscription
    await Session.deleteMany({ 'subscription.endpoint': subscription.endpoint });

    await Session.create({
      id: now + '-' + Math.random().toString(36).slice(2, 8),
      subscription,
      taskLabel: taskLabel || 'your process',
      workFireAt: now + workMs,
      breakFireAt: now + workMs + breakMs,
      workSent: false,
      breakSent: false,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Frontend calls this on manual skip/cancel
app.post('/cancel', async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });
  try {
    await Session.deleteMany({ 'subscription.endpoint': endpoint });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    console.error('push send failed:', err.statusCode || err.message);
    return err.statusCode === 410 || err.statusCode === 404 ? 'dead' : 'error';
  }
  return 'ok';
}

// runs every 15 seconds, checks for due notifications
cron.schedule('*/15 * * * * *', async () => {
  if (mongoose.connection.readyState !== 1) return; // DB not connected
  try {
    const sessions = await Session.find({});
    if (sessions.length === 0) return;
    const now = Date.now();

    for (const s of sessions) {
      if (!s.workSent && now >= s.workFireAt) {
        const status = await sendPush(s.subscription, {
          title: 'Break time — 50 min done',
          body: `${s.taskLabel} is finished. Take your 10 min break.`,
        });
        s.workSent = true;
        if (status === 'dead') s.breakSent = true;
        await s.save();
      } else if (!s.breakSent && now >= s.breakFireAt) {
        const status = await sendPush(s.subscription, {
          title: 'Break over',
          body: 'Back to the queue — start your next process.',
        });
        s.breakSent = true;
        await s.save();
      }
    }

    // Clean up finished sessions
    await Session.deleteMany({ workSent: true, breakSent: true });
  } catch (err) {
    console.error('Cron job error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`push server listening on ${PORT}`));
