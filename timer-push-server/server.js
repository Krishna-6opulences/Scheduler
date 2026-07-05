// Tiny push-notification backend for the study scheduler.
//
// What it does:
//   - Frontend calls POST /schedule whenever a 50-min work block starts,
//     sending the push subscription + how long the work/break blocks are.
//   - This server stores that in sessions.json and checks every 15s
//     whether it's time to fire a push ("break time!" / "back to work!").
//   - Because this runs on a server (not in your phone's browser tab),
//     the notification arrives even if your PC is asleep or the tab is closed.
//
// IMPORTANT CAVEAT (free hosting): most free web-service tiers (Render, etc.)
// spin the server down after ~15 min of no incoming HTTP traffic. If that
// happens mid-timer, the scheduled push won't fire on time. Fix: use a free
// uptime pinger (e.g. UptimeRobot) hitting GET / every 5 minutes to keep it awake.
// See README.md for exact steps.

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

// health check - also what your uptime pinger should hit
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'timer-push-server' });
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
  // (so switching tasks doesn't leave stale notifications queued)
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

// Frontend calls this on manual skip/pause-cancel/task removal, so a stale
// push doesn't arrive later for a session you already ended yourself.
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
    // 410/404 means the subscription is dead (user uninstalled, revoked perms, etc.)
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
      if (status === 'dead') s.breakSent = true; // don't bother trying again
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
