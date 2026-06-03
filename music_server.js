const express = require("express");
const { execFile, spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

// ============================================================
// CONFIG
// ============================================================
const PORT = Number(process.env.PORT || 4200);
const HOST_PASSWORD = process.env.HOST_PASSWORD;
const SKIP_THRESHOLD = Number(process.env.SKIP_THRESHOLD || 3);
const TITLE_TIMEOUT_MS = Number(process.env.TITLE_TIMEOUT_MS || 15000);
const STREAM_URL_TIMEOUT_MS = Number(process.env.STREAM_URL_TIMEOUT_MS || 20000);
const STREAM_URL_CACHE_MS = Number(process.env.STREAM_URL_CACHE_MS || 25 * 60 * 1000);

function resolveYtdlpPath() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;

  const localExe = path.join(__dirname, "yt-dlp.exe");
  const localUnix = path.join(__dirname, "yt-dlp");

  if (process.platform === "win32" && fs.existsSync(localExe)) return localExe;
  if (fs.existsSync(localUnix)) return localUnix;
  if (fs.existsSync(localExe)) return localExe;

  return "yt-dlp";
}

const YTDLP = resolveYtdlpPath();

if (!HOST_PASSWORD) {
  console.error("ERROR: HOST_PASSWORD not set in .env");
  console.error("Create .env file with: HOST_PASSWORD=your_strong_password");
  process.exit(1);
}

// ============================================================
// HELPERS
// ============================================================
function normalizeYouTubeInput(value) {
  let clean = String(value || "").trim();
  if (!clean) return "";

  // Allow people to paste links without https://
  if (/^(www\.)?(m\.)?(youtube\.com|music\.youtube\.com|youtu\.be)\//i.test(clean)) {
    clean = `https://${clean}`;
  }

  return clean;
}

function isYouTubeUrl(str) {
  const clean = normalizeYouTubeInput(str);
  return /^https?:\/\/((www|m)\.)?(youtube\.com|music\.youtube\.com|youtu\.be)\//i.test(clean);
}

function ytdlpSource(query) {
  const clean = normalizeYouTubeInput(query);
  return isYouTubeUrl(clean) ? clean : `ytsearch1:${clean}`;
}

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  return ips.length ? ips : ["localhost"];
}

function getLanIp() {
  return getLanIps()[0];
}

function requireHostPassword(req, res, next) {
  const password = req.query.password || (req.body && req.body.password);
  if (password !== HOST_PASSWORD) {
    return res.status(401).json({ error: "Invalid or missing host password" });
  }
  next();
}

function safeDisplayName(name) {
  return String(name || "Guest").trim().replace(/[\r\n\t]/g, " ").substring(0, 20) || "Guest";
}

function safeTitleFallback(query) {
  return String(query || "Untitled track").trim().substring(0, 180) || "Untitled track";
}

function getTitleWithYtdlp(src, fallbackTitle) {
  return new Promise((resolve) => {
    execFile(
      YTDLP,
      ["--no-playlist", "--get-title", src],
      { timeout: TITLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.warn(`Title lookup failed: ${err.message}`);
          resolve(fallbackTitle);
          return;
        }
        const title = String(stdout || "").trim().split("\n")[0] || fallbackTitle;
        resolve(title.substring(0, 220));
      },
    );
  });
}

function getDirectAudioUrl(src) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ["-f", "bestaudio[ext=m4a]/bestaudio", "--no-playlist", "--get-url", src],
      { timeout: STREAM_URL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const details = String(stderr || err.message || "Could not get direct stream URL").trim();
          reject(new Error(details));
          return;
        }

        const url = String(stdout || "").trim().split("\n").find(Boolean);
        if (!url) {
          reject(new Error("yt-dlp did not return an audio URL"));
          return;
        }

        resolve(url);
      },
    );
  });
}

function getTrackById(id) {
  return queue.find((track) => Number(track.id) === Number(id));
}

function makePublicState(extra = {}) {
  return {
    queue,
    currentIndex,
    skipVotes: skipVotes.size,
    skipThreshold: SKIP_THRESHOLD,
    ...extra,
  };
}

// ============================================================
// SHARED STATE
// ============================================================
let queue = [];
let currentIndex = -1;
let nextId = 1;
let hostClients = [];
let skipVotes = new Set();

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use(express.static(__dirname));

// ============================================================
// BROADCAST
// ============================================================
function broadcastToHost(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  hostClients = hostClients.filter((client) => {
    try {
      client.write(payload);
      return true;
    } catch (_) {
      return false;
    }
  });
}

function broadcastState() {
  broadcastToHost("state", makePublicState());
}

function playIndex(index) {
  if (index < 0 || index >= queue.length) {
    currentIndex = -1;
    skipVotes.clear();
    broadcastState();
    return;
  }

  currentIndex = index;
  skipVotes.clear();
  broadcastToHost("play", makePublicState({ track: queue[currentIndex], index: currentIndex }));
}

function advanceToNext() {
  if (currentIndex + 1 >= queue.length) {
    currentIndex = -1;
    skipVotes.clear();
    broadcastState();
    return { done: true };
  }

  playIndex(currentIndex + 1);
  return { done: false };
}

// ============================================================
// ROUTES
// ============================================================
app.get("/health", (req, res) => {
  res.json({ ok: true, queueLength: queue.length, currentIndex, ytdlp: YTDLP });
});

app.get("/urls", (req, res) => {
  const ips = getLanIps();
  res.json({
    guestUrls: ips.map((ip) => `http://${ip}:${PORT}`),
    hostUrls: ips.map((ip) => `http://${ip}:${PORT}?host=true&password=${encodeURIComponent(HOST_PASSWORD)}`),
  });
});

app.get("/host-events", requireHostPassword, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  hostClients.push(res);
  console.log(`Host connected (${hostClients.length} active)`);

  res.write(`event: state\ndata: ${JSON.stringify(makePublicState())}\n\n`);

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (_) {}
  }, 20000);

  req.on("close", () => {
    hostClients = hostClients.filter((client) => client !== res);
    clearInterval(ping);
    console.log(`Host disconnected (${hostClients.length} active)`);
  });
});

app.get("/queue", (req, res) => {
  const wantsHost = req.query.host === "true";
  const hasValidPassword = req.query.password === HOST_PASSWORD;
  res.json(makePublicState({ isHost: wantsHost && hasValidPassword }));
});

app.post("/queue", async (req, res) => {
  try {
    const query = String((req.body && req.body.query) || "").trim();
    if (!query) return res.status(400).json({ error: "No query provided" });

    const addedBy = safeDisplayName(req.body && req.body.name);
    const src = ytdlpSource(query);
    const isUrl = isYouTubeUrl(query);
    const title = await getTitleWithYtdlp(src, safeTitleFallback(query));

    const track = { id: nextId++, query, source: src, title, addedBy, isUrl, streamUrl: "", streamUrlTime: 0 };
    queue.push(track);

    console.log(`Queued: "${title}" by ${addedBy}`);

    if (currentIndex === -1) {
      playIndex(queue.length - 1);
    } else {
      broadcastToHost("queued", makePublicState({ track }));
    }

    res.json({ ok: true, track, queue, currentIndex });
  } catch (err) {
    console.error("Queue add failed:", err);
    res.status(500).json({ error: err.message || "Could not add track" });
  }
});

app.post("/next", requireHostPassword, (req, res) => {
  const result = advanceToNext();
  res.json({ ok: true, ...result, ...makePublicState() });
});

app.post("/play/:index", requireHostPassword, (req, res) => {
  const index = Number.parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
    return res.status(400).json({ error: "Invalid index" });
  }

  playIndex(index);
  res.json({ ok: true, ...makePublicState({ track: queue[currentIndex], index: currentIndex }) });
});

app.delete("/queue/:id", requireHostPassword, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const idx = queue.findIndex((track) => track.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  queue.splice(idx, 1);

  if (queue.length === 0) {
    currentIndex = -1;
  } else if (idx < currentIndex) {
    currentIndex -= 1;
  } else if (idx === currentIndex) {
    currentIndex = Math.min(currentIndex, queue.length - 1);
    const state = makePublicState({ track: queue[currentIndex], index: currentIndex });
    broadcastToHost("play", state);
    return res.json({ ok: true, ...state });
  }

  broadcastState();
  res.json({ ok: true, ...makePublicState() });
});

app.post("/skip-vote", (req, res) => {
  if (currentIndex < 0 || currentIndex >= queue.length) {
    return res.json({ ok: true, noTrack: true, skipVotes: 0, skipThreshold: SKIP_THRESHOLD });
  }

  const voterName = safeDisplayName(req.body && req.body.name);
  const voter = `${req.ip}:${voterName}`.substring(0, 80);

  if (skipVotes.has(voter)) {
    return res.json({
      ok: true,
      alreadyVoted: true,
      skipVotes: skipVotes.size,
      skipThreshold: SKIP_THRESHOLD,
    });
  }

  skipVotes.add(voter);
  broadcastToHost("skip-vote", {
    skipVotes: skipVotes.size,
    skipThreshold: SKIP_THRESHOLD,
  });

  if (skipVotes.size >= SKIP_THRESHOLD) {
    console.log("Skip threshold reached");
    const result = advanceToNext();
    return res.json({
      ok: true,
      advanced: true,
      ...result,
      ...makePublicState(),
    });
  }

  res.json({ ok: true, skipVotes: skipVotes.size, skipThreshold: SKIP_THRESHOLD });
});

app.get("/direct/:id", requireHostPassword, async (req, res) => {
  try {
    const track = getTrackById(req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const now = Date.now();
    if (track.streamUrl && track.streamUrlTime && now - track.streamUrlTime < STREAM_URL_CACHE_MS) {
      return res.json({ ok: true, id: track.id, url: track.streamUrl, cached: true });
    }

    const url = await getDirectAudioUrl(track.source || ytdlpSource(track.query));
    track.streamUrl = url;
    track.streamUrlTime = now;

    res.json({ ok: true, id: track.id, url, cached: false });
  } catch (err) {
    console.error("Direct URL lookup failed:", err.message || err);
    res.status(500).json({ error: err.message || "Could not prepare audio URL" });
  }
});

app.get("/stream/:id", (req, res) => {
  const track = getTrackById(req.params.id);
  if (!track) return res.status(404).send("Track not found");
  streamSourceToResponse(track.source || ytdlpSource(track.query), track.query || track.title || "track", res, req);
});

function streamSourceToResponse(src, label, res, req) {
  console.log(`Streaming fallback: ${label}`);

  res.setHeader("Content-Type", "audio/mp4");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-store");

  const pipe = spawn(
    YTDLP,
    ["-f", "bestaudio[ext=m4a]/bestaudio", "--no-playlist", "-o", "-", src],
    { windowsHide: true },
  );

  pipe.stdout.pipe(res);

  pipe.stderr.on("data", (data) => {
    process.stdout.write(data);
  });

  pipe.on("error", (err) => {
    console.error("yt-dlp stream error:", err.message);
    if (!res.headersSent) res.status(500).send("Could not start stream");
    else res.end();
  });

  pipe.on("close", () => {
    if (!res.destroyed) res.end();
  });

  req.on("close", () => {
    if (!pipe.killed) pipe.kill("SIGKILL");
  });
}

app.get("/stream", (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).send("No query");
  streamSourceToResponse(ytdlpSource(query), query, res, req);
});

// ============================================================
// START
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  const ips = getLanIps();
  console.log("\n145 MUSIC SERVER");
  console.log("─────────────────────────────────────────────────────");
  ips.forEach((ip, i) => {
    console.log(`Guest URL ${i + 1}: http://${ip}:${PORT}`);
    console.log(`Host URL  ${i + 1}: http://${ip}:${PORT}?host=true&password=${encodeURIComponent(HOST_PASSWORD)}`);
  });
  console.log("─────────────────────────────────────────────────────");
  console.log(`yt-dlp path: ${YTDLP}`);
  console.log("Guests must use a Guest URL above, not localhost, from their phones/computers.");
  console.log("Only use the Host URL with password on the playback machine.");
});
