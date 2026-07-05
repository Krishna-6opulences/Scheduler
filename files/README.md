# today.sched — push notification setup

Two folders:
- `timer-pwa/` — the scheduler app itself (frontend). Gets hosted as a static site.
- `timer-push-server/` — a tiny backend that sends the actual phone notifications.

Why two pieces: a phone notification while your PC is asleep or the tab is
closed can only come from something that's running independently of your
tab — that's what the backend is for. The frontend just tells it "start a
50-min timer for this task," and the backend pings your phone when it's done.

---

## 1. Generate your own VAPID keys

Don't reuse any keys from example output — generate your own:

```bash
npx web-push generate-vapid-keys
```

You'll get a `Public Key` and `Private Key`. Save both.

## 2. Deploy the backend (`timer-push-server/`)

Any host that keeps a Node process running works. Render's free tier is the
easiest to set up:

1. Push `timer-push-server/` to a GitHub repo.
2. Go to render.com → New → Web Service → connect that repo.
3. Build command: `npm install`. Start command: `node server.js`.
4. Add environment variables:
   - `VAPID_PUBLIC_KEY` = (from step 1)
   - `VAPID_PRIVATE_KEY` = (from step 1)
   - `VAPID_SUBJECT` = `mailto:youremail@example.com`
5. Deploy. You'll get a URL like `https://your-app.onrender.com`.

**Caveat:** Render's free tier sleeps after ~15 min with no incoming HTTP
requests, which would delay a scheduled push if it happens while asleep.
Fix: create a free account at uptimerobot.com and add a monitor that pings
`https://your-app.onrender.com/` (the health-check route) every 5 minutes.
That keeps it awake indefinitely, for free.

## 3. Configure the frontend (`timer-pwa/`)

Open `timer-pwa/index.html`, find near the top of the `<script>` block:

```js
const BACKEND_URL = 'https://YOUR-BACKEND-URL.onrender.com';
const VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY';
```

Replace both with your real backend URL and your **public** VAPID key
(never put the private key in the frontend).

## 4. Host the frontend

Any static host works — GitHub Pages is free and simple:

1. Push `timer-pwa/` (index.html, manifest.json, service-worker.js, icons)
   to a GitHub repo.
2. Repo Settings → Pages → deploy from that branch/folder.
3. You'll get a URL like `https://yourname.github.io/timer-pwa/`.

PWAs and push both require HTTPS — GitHub Pages gives you that automatically.

## 5. Turn on notifications on your phone

- **Android (Chrome):** just open the hosted URL, tap "enable notifications"
  in the app. Works even as a normal browser tab, though installing it
  (menu → "Add to Home screen") is a nicer experience.
- **iPhone (Safari):** iOS only allows push for PWAs added to the home
  screen (iOS 16.4+). Open the URL in Safari → Share → "Add to Home
  Screen" → then open it from the home screen icon → tap "enable
  notifications" from there.

## 6. Test it

Tap a process to mark it "running." Lock your phone or close the tab.
After 50 minutes you should get a "Break time" notification, and 10 minutes
after that, "Break over."

To test faster without waiting 50 minutes, temporarily edit `WORK_SECONDS`
and `BREAK_SECONDS` near the top of the frontend script (e.g. `30` and `15`),
push the change, and try a real cycle end to end. Revert once confirmed.
