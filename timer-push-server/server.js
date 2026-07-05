// File-backed push-notification and task sync backend for the study scheduler.
// Stored in local JSON files (tasks.json, sessions.json).

const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const TASKS_FILE = path.join(__dirname, 'tasks.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars. Generate with: npx web-push generate-vapid-keys');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function loadAllTasks() {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveAllTasks(allTasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(allTasks, null, 2));
}

// health check - also what your uptime pinger should hit
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'timer-push-server', type: 'file-backed' });
});

// GET /tasks/:userId - fetch user tasks
app.get('/tasks/:userId', (req, res) => {
  const { userId } = req.params;
  const cleanId = userId.toLowerCase().trim();
  const allTasks = loadAllTasks();
  res.json({ tasks: allTasks[cleanId] || null });
});

// POST /tasks/:userId - save/sync user tasks
app.post('/tasks/:userId', (req, res) => {
  const { userId } = req.params;
  const { tasks } = req.body;
  const cleanId = userId.toLowerCase().trim();
  const allTasks = loadAllTasks();
  allTasks[cleanId] = tasks;
  saveAllTasks(allTasks);
  res.json({ ok: true, tasks });
});

// Frontend calls this the moment a work block starts.
// body: { subscription, taskLabel, workSeconds, breakSeconds }
app.post('/schedule', (req, res) => {
  const { subscription, taskLabel, workSeconds, breakSeconds } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'missing subscription' });
  }
  const now = Date.now();
  const workMs = (workSeconds || 50 * 60) * 1000;
  const breakMs = (breakSeconds || 10 * 60) * 1000;

  const sessions = loadSessions();

  // cancel any previous pending session for this same subscription
  const filtered = sessions.filter(s => s.subscription.endpoint !== subscription.endpoint);

  filtered.push({
    id: now + '-' + Math.random().toString(36).slice(2, 8),
    subscription,
    taskLabel: taskLabel || 'your process',
    workFireAt: now + workMs,
    breakFireAt: now + workMs + breakMs,
    workSent: false,
    breakSent: false,
  });

  saveSessions(filtered);
  res.json({ ok: true });
});

// Frontend calls this on manual skip/cancel
app.post('/cancel', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });
  const sessions = loadSessions().filter(s => s.subscription.endpoint !== endpoint);
  saveSessions(sessions);
  res.json({ ok: true });
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
  let sessions = loadSessions();
  if (sessions.length === 0) return;
  const now = Date.now();
  let changed = false;

  for (const s of sessions) {
    if (!s.workSent && now >= s.workFireAt) {
      const status = await sendPush(s.subscription, {
        title: 'Break time — 50 min done',
        body: `${s.taskLabel} is finished. Take your 10 min break.`,
      });
      s.workSent = true;
      if (status === 'dead') s.breakSent = true;
      changed = true;
    } else if (!s.breakSent && now >= s.breakFireAt) {
      const status = await sendPush(s.subscription, {
        title: 'Break over',
        body: 'Back to the queue — start your next process.',
      });
      s.breakSent = true;
      changed = true;
    }
  }

  sessions = sessions.filter(s => !(s.workSent && s.breakSent));
  if (changed) saveSessions(sessions);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`push server listening on ${PORT}`));
