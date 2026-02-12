const { URL } = require("url");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");
const { sharedRequire } = require("./require_shared");
const { WebSocketServer } = sharedRequire("ws");
const audio = require("./audio");
const cors = require("./cors");

const activeInputs = new Set();
const activeOutputs = new Set();

function logActiveCounts() {
  console.log(`[audio] active inputs=${activeInputs.size} outputs=${activeOutputs.size}`);
}

function sendJson(req, res, status, payload) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  cors.applyCors(req, res);
  res.end(JSON.stringify(payload));
}

function listInputPayload() {
  return { devices: audio.listInputDevices() };
}

function listOutputPayload() {
  return { devices: audio.listOutputDevices() };
}

function logDeviceLists() {
  const inputs = audio.listInputDevices();
  const outputs = audio.listOutputDevices();
  console.log("[audio] input devices:");
  inputs.forEach((d) => {
    console.log(`[audio] input id=${d.id} sr=${d.sr} ch=${d.ch} name=${JSON.stringify(d.name)}`);
  });
  console.log("[audio] output devices:");
  outputs.forEach((d) => {
    console.log(`[audio] output id=${d.id} sr=${d.sr} ch=${d.ch} name=${JSON.stringify(d.name)}`);
  });
}

function handleListRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.has("refresh")) {
    audio.refreshDevices();
    logDeviceLists();
  }
  if (url.pathname === "/source/list") {
    sendJson(req, res, 200, listInputPayload());
    return true;
  }
  if (url.pathname === "/sink/list") {
    sendJson(req, res, 200, listOutputPayload());
    return true;
  }
  return false;
}

function parseRadioParams(url) {
  const target = url.searchParams.get("url");
  const sr = parseInt(url.searchParams.get("sr"), 10);
  if (!target) return { error: "Missing url" };
  if (!Number.isFinite(sr) || sr <= 0) return { error: "Missing sr" };
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return { error: "Bad url" };
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return { error: "Bad url" };
  }
  return { targetUrl, sampleRate: sr };
}

function createRadioStream(req, res, targetUrl, sampleRate) {
  console.log(`[radio] open url=${targetUrl.toString()} sr=${sampleRate}`);
  cors.applyCors(req, res);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
  });

  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    //"-re",
    "-i",
    targetUrl.toString(),
    "-vn",
    "-ac",
    "2",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "pipe:1",
  ];

  const ffmpeg = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", (data) => {
    const text = String(data || "").trim();
    if (text) console.log(`[radio] ffmpeg: ${text}`);
  });

  const cleanup = () => {
    console.log("[radio] close");
    try {
      ffmpeg.kill("SIGKILL");
    } catch {}
  };
  res.on("close", cleanup);
  res.on("finish", cleanup);
  ffmpeg.on("exit", (code, signal) => {
    console.log(`[radio] ffmpeg exit code=${code} signal=${signal || ""}`);
    res.end();
  });
  ffmpeg.on("error", (err) => {
    console.log(`[radio] ffmpeg error ${err && err.message ? err.message : err}`);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.end("ffmpeg error");
    } else {
      res.end();
    }
  });
}

function handleRadioRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/radio") return false;
  const parsed = parseRadioParams(url);
  if (parsed.error) {
    console.log(`[radio] bad request: ${parsed.error}`);
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    cors.applyCors(req, res);
    res.end(parsed.error);
    return true;
  }
  createRadioStream(req, res, parsed.targetUrl, parsed.sampleRate);
  return true;
}

function registerListRoutes(app) {
  app.get("/source/list", (req, res) => {
    if ("refresh" in req.query) {
      audio.refreshDevices();
      logDeviceLists();
    }
    sendJson(req, res, 200, listInputPayload());
  });
  app.get("/sink/list", (req, res) => {
    if ("refresh" in req.query) {
      audio.refreshDevices();
      logDeviceLists();
    }
    sendJson(req, res, 200, listOutputPayload());
  });
}

function registerRadioRoutes(app) {
  app.get("/radio", (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parsed = parseRadioParams(url);
    if (parsed.error) {
      console.log(`[radio] bad request: ${parsed.error}`);
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      cors.applyCors(req, res);
      res.end(parsed.error);
      return;
    }
    createRadioStream(req, res, parsed.targetUrl, parsed.sampleRate);
  });
}

function parseStreamParams(url) {
  const sr = parseInt(url.searchParams.get("sr"), 10);
  const ch = parseInt(url.searchParams.get("ch"), 10);
  if (!Number.isFinite(sr) || sr <= 0) return null;
  if (!Number.isFinite(ch) || ch <= 0) return null;
  return { sampleRate: sr, channels: ch };
}

function sendQuality(ws, quality) {
  if (ws.readyState === ws.OPEN) {
    const value = Math.max(0, Math.min(2, quality | 0));
    ws.send(Buffer.from([value]));
  }
}

function sendAvailable(ws, available) {
  if (ws.readyState === ws.OPEN) {
    const value = Math.max(0, Math.min(255, available | 0));
    ws.send(Buffer.from([value]));
  }
}

function attachAudioWebSockets(server) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/(source|sink)\/(\d+)$/);
    if (!match) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, {
        direction: match[1],
        index: parseInt(match[2], 10),
        params: parseStreamParams(url),
      });
    });
  });

  wss.on("connection", async (ws, _req, info) => {
    const { direction, index, params } = info || {};
    if (!params || !Number.isFinite(index)) {
      ws._serverClosing = true;
      ws.close(1008, "Missing params");
      return;
    }

    if (direction === "source") {
      let input = null;
      try {
        input = await audio.openInput(index, params.sampleRate, params.channels);
      } catch (err) {
        console.log("[audio] source open failed", err && err.message ? err.message : err);
        ws._serverClosing = true;
        ws.close(1011, "Open failed");
        return;
      }
      if (!input) {
        ws._serverClosing = true;
        ws.close(1011, "Open failed");
        return;
      }

      console.log(`[audio] source open id=${index} sr=${params.sampleRate} ch=${params.channels}`);
      activeInputs.add(input);
      logActiveCounts();
      sendQuality(ws, input.getQuality());

      const framesPerChunk = input.framesPerBuffer || 128;
      const chunkSamples = framesPerChunk * params.channels;
      let staging = new Float32Array(0);
      let queue = [];
      let sendTimer = 0;
      let lastOnData = 0;
      let rateHz = Number.isFinite(params.sampleRate) && params.sampleRate > 0 ? params.sampleRate : 48000;
      let inputDataCount = 0;
      let closed = false;
      const maxBufferedSeconds = 3;
      const bytesPerSecond = params.sampleRate * params.channels * 4;
      const maxBufferedBytes = Math.max(1, Math.floor(maxBufferedSeconds * bytesPerSecond));

      const scheduleSend = () => {
        if (closed) return;
        const chunkMs = Math.max(1, Math.round((framesPerChunk / rateHz) * 1000));
        sendTimer = setTimeout(() => {
          if (closed) return;
          if (queue.length > 0 && ws.readyState === ws.OPEN) {
            const next = queue.shift();
            const buf = Buffer.from(next.buffer, next.byteOffset, next.byteLength);
            ws.send(buf);
          }
          scheduleSend();
        }, chunkMs);
      };

      const onData = (f32) => {
        if (ws.readyState !== ws.OPEN) return;
        inputDataCount += 1;
        const frames = Math.floor(f32.length / params.channels);
        const now = performance.now();
        if (lastOnData) {
          const dt = (now - lastOnData) / 1000;
          if (dt > 0) {
            const instRate = frames / dt;
            const queuedFrames = queue.length * framesPerChunk + Math.floor(staging.length / params.channels);
            const drainRate = queuedFrames / dt;
            const targetRate = Math.max(instRate, drainRate);
            const maxUp = rateHz * 0.5;
            const maxDown = rateHz * 0.25;
            const delta = Math.max(-maxDown, Math.min(maxUp, targetRate - rateHz));
            rateHz = Math.max(1, rateHz + delta);
          }
        }
        lastOnData = now;

        const combined = new Float32Array(staging.length + f32.length);
        combined.set(staging, 0);
        combined.set(f32, staging.length);
        staging = combined;
        while (staging.length >= chunkSamples) {
          const chunk = staging.subarray(0, chunkSamples);
          const full = new Float32Array(chunkSamples);
          full.set(chunk);
          queue.push(full);
          if (staging.length === chunkSamples) {
            staging = new Float32Array(0);
          } else {
            const rest = staging.subarray(chunkSamples);
            const next = new Float32Array(rest.length);
            next.set(rest);
            staging = next;
          }
        }
        if (ws.bufferedAmount > maxBufferedBytes) {
          const dropped = queue.length;
          queue = [];
          staging = new Float32Array(0);
          console.log(`[audio] source ws buffered drop queued=${dropped} buffered=${ws.bufferedAmount}`);
        }
        if (!sendTimer) scheduleSend();
      };

      input.onData(onData);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (sendTimer) {
          clearTimeout(sendTimer);
          sendTimer = 0;
        }
        queue = [];
        staging = new Float32Array(0);
        console.log("[audio] source close");
        input.close().catch(() => {});
        if (activeInputs.delete(input)) {
          logActiveCounts();
        }
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
      return;
    }

    if (direction === "sink") {
      let output = null;
      try {
        output = await audio.openOutput(index, params.sampleRate, params.channels);
      } catch (err) {
        console.log("[audio] sink open failed", err && err.message ? err.message : err);
        ws._serverClosing = true;
        ws.close(1011, "Open failed");
        return;
      }
      if (!output) {
        ws._serverClosing = true;
        ws.close(1011, "Open failed");
        return;
      }

      console.log(`[audio] sink open id=${index} sr=${params.sampleRate} ch=${params.channels}`);
      activeOutputs.add(output);
      logActiveCounts();
      sendQuality(ws, output.getQuality());

      output.onDrain((available) => {
        if (typeof available === "number") {
          sendAvailable(ws, available);
        }
      });

      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length % 4 !== 0) return;
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        output.write(f32);
      });

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        console.log("[audio] sink close");
        if (typeof output.closeDrain === "function") {
          output.closeDrain().catch(() => {});
        } else {
          output.close().catch(() => {});
        }
        if (activeOutputs.delete(output)) {
          logActiveCounts();
        }
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    }
  });

  return wss;
}

module.exports = {
  handleListRequest,
  handleRadioRequest,
  registerListRoutes,
  registerRadioRoutes,
  attachAudioWebSockets,
};
