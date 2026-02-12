const { sharedRequire } = require("./require_shared");

const portAudio = sharedRequire("naudiodon-wasapi-exclusive");

const FRAMES_PER_BUFFER = 128;
const MAX_QUEUE = 8;
const OUTPUT_RING_CAPACITY = 256;
let lastDeviceList = null;

function buildDeviceLists() {
  const hostAPIs = portAudio.getHostAPIs();
  const devices = portAudio.getDevices();
  const devicesByApi = devices.reduce((acc, d) => {
    const key = d.hostAPIName || "Unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(d);
    return acc;
  }, {});

  const dsDevices = devicesByApi["Windows DirectSound"] || [];
  const wasapiDevices = devicesByApi["Windows WASAPI"] || [];
  const deviceMap = new Map();

  function upsertDevice(name, patch) {
    const current = deviceMap.get(name) || {
      name,
      dsDeviceId: null,
      wasapiDeviceId: null,
      in: null,
      out: null,
      sr: null,
    };
    deviceMap.set(name, { ...current, ...patch });
  }

  dsDevices.forEach((d) => {
    upsertDevice(d.name, {
      dsDeviceId: d.id,
      in: d.maxInputChannels,
      out: d.maxOutputChannels,
      sr: d.defaultSampleRate,
    });
  });

  wasapiDevices.forEach((d) => {
    upsertDevice(d.name, {
      wasapiDeviceId: d.id,
      in: d.maxInputChannels,
      out: d.maxOutputChannels,
      sr: d.defaultSampleRate,
    });
  });

  const findDeviceById = (id) => devices.find((d) => d.id === id);
  const findHostApiByName = (name) =>
    (hostAPIs?.HostAPIs || []).find((h) => h.name === name);

  const dsHost = findHostApiByName("Windows DirectSound");
  const wasapiHost = findHostApiByName("Windows WASAPI");

  const defaultInput = {
    name: "Default",
    dsDeviceId: dsHost && dsHost.defaultInput >= 0 ? dsHost.defaultInput : null,
    wasapiDeviceId:
      wasapiHost && wasapiHost.defaultInput >= 0 ? wasapiHost.defaultInput : null,
    in: 0,
    out: 0,
    sr: null,
  };
  const defaultOutput = {
    name: "Default",
    dsDeviceId: dsHost && dsHost.defaultOutput >= 0 ? dsHost.defaultOutput : null,
    wasapiDeviceId:
      wasapiHost && wasapiHost.defaultOutput >= 0 ? wasapiHost.defaultOutput : null,
    in: 0,
    out: 0,
    sr: null,
  };

  const defaultInputDevice =
    (defaultInput.wasapiDeviceId !== null &&
      findDeviceById(defaultInput.wasapiDeviceId)) ||
    (defaultInput.dsDeviceId !== null && findDeviceById(defaultInput.dsDeviceId));
  defaultInput.sr = defaultInputDevice ? defaultInputDevice.defaultSampleRate : null;
  defaultInput.in = defaultInputDevice ? defaultInputDevice.maxInputChannels : 0;
  defaultInput.out = 0;

  const defaultOutputDevice =
    (defaultOutput.wasapiDeviceId !== null &&
      findDeviceById(defaultOutput.wasapiDeviceId)) ||
    (defaultOutput.dsDeviceId !== null && findDeviceById(defaultOutput.dsDeviceId));
  defaultOutput.sr = defaultOutputDevice ? defaultOutputDevice.defaultSampleRate : null;
  defaultOutput.in = 0;
  defaultOutput.out = defaultOutputDevice ? defaultOutputDevice.maxOutputChannels : 0;

  const devicesList = Array.from(deviceMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const inputs = [
    defaultInput,
    ...devicesList.filter((d) => (d.in || 0) > 0),
  ].map((d, index) => ({ index, ...d }));

  const outputs = [
    defaultOutput,
    ...devicesList.filter((d) => (d.out || 0) > 0),
  ].map((d, index) => ({ index, ...d }));

  lastDeviceList = { inputs, outputs };
  return lastDeviceList;
}

function refreshDevices() {
  return buildDeviceLists();
}

function listInputDevices() {
  if (!lastDeviceList) buildDeviceLists();
  if (!lastDeviceList) return [];
  return lastDeviceList.inputs.map((d) => ({
    id: d.index,
    name: d.name,
    ch: d.in || 0,
    sr: d.sr,
  }));
}

function listOutputDevices() {
  if (!lastDeviceList) buildDeviceLists();
  if (!lastDeviceList) return [];
  return lastDeviceList.outputs.map((d) => ({
    id: d.index,
    name: d.name,
    ch: d.out || 0,
    sr: d.sr,
  }));
}

function bufferToFloat32(buf, format) {
  switch (format) {
    case portAudio.SampleFormatFloat32:
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    case portAudio.SampleFormat32Bit: {
      const view = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const out = new Float32Array(view.length);
      for (let i = 0; i < view.length; i++) out[i] = view[i] / 2147483648;
      return out;
    }
    case portAudio.SampleFormat16Bit: {
      const view = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      const out = new Float32Array(view.length);
      for (let i = 0; i < view.length; i++) out[i] = view[i] / 32768;
      return out;
    }
    default:
      throw new Error(`Unsupported input format: ${format}`);
  }
}

function float32ToBuffer(f32, format) {
  switch (format) {
    case portAudio.SampleFormatFloat32:
      if (Buffer.isBuffer(f32)) return f32;
      return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    case portAudio.SampleFormat32Bit: {
      const out = Buffer.allocUnsafe(f32.length * 4);
      for (let i = 0; i < f32.length; i++) {
        let v = Math.max(-1, Math.min(1, f32[i]));
        const s = Math.round(v * 2147483647);
        out.writeInt32LE(s, i * 4);
      }
      return out;
    }
    case portAudio.SampleFormat16Bit: {
      const out = Buffer.allocUnsafe(f32.length * 2);
      for (let i = 0; i < f32.length; i++) {
        let v = Math.max(-1, Math.min(1, f32[i]));
        const s = Math.round(v * 32767);
        out.writeInt16LE(s, i * 2);
      }
      return out;
    }
    default:
      throw new Error(`Unsupported output format: ${format}`);
  }
}

function tryOpen(entry, direction, rate, channels, deviceId, useExclusiveMode, sampleFormat, backend) {
  if (deviceId === null || deviceId === undefined) return null;
  try {
    const opts =
      direction === "in"
        ? {
            inOptions: {
              channelCount: channels,
              sampleFormat,
              sampleRate: rate,
              deviceId,
              closeOnError: true,
              useExclusiveMode,
              framesPerBuffer: FRAMES_PER_BUFFER,
              maxQueue: MAX_QUEUE,
            },
          }
        : {
            outOptions: {
              channelCount: channels,
              sampleFormat,
              sampleRate: rate,
              deviceId,
              closeOnError: true,
              useExclusiveMode,
              framesPerBuffer: FRAMES_PER_BUFFER,
              maxQueue: MAX_QUEUE,
            },
          };
    return {
      io: new portAudio.AudioIO(opts),
      sampleFormat,
      deviceId,
      useExclusiveMode,
      backend,
      entry,
    };
  } catch {
    return null;
  }
}

function openWithFallback(listIndex, direction, rate, channels) {
  if (!lastDeviceList) buildDeviceLists();
  const list = direction === "in" ? lastDeviceList?.inputs : lastDeviceList?.outputs;
  const entry = list && list[listIndex];
  if (!entry) return null;

  const formats = [
    portAudio.SampleFormatFloat32,
    portAudio.SampleFormat32Bit,
    portAudio.SampleFormat16Bit,
  ];

  for (const fmt of formats) {
    const io = tryOpen(entry, direction, rate, channels, entry.wasapiDeviceId, true, fmt, "wasapi");
    if (io) return io;
  }
  for (const fmt of formats) {
    const io = tryOpen(entry, direction, rate, channels, entry.wasapiDeviceId, false, fmt, "wasapi");
    if (io) return io;
  }
  for (const fmt of formats) {
    const io = tryOpen(entry, direction, rate, channels, entry.dsDeviceId, false, fmt, "ds");
    if (io) return io;
  }
  return null;
}

function getQuality(info) {
  if (!info) return 0;
  if (info.backend === "wasapi") {
    return info.useExclusiveMode ? 2 : 1;
  }
  return 0;
}

async function closeStream(stream) {
  if (!stream) return;
  try {
    await stream.io.quit("ABORT");
  } catch {
    // ignore
  }
}

async function openInput(listIndex, sampleRate, channels) {
  const info = openWithFallback(listIndex, "in", sampleRate, channels);
  if (info) {
    const name = info.entry && info.entry.name ? info.entry.name : "Unknown";
    const quality = getQuality(info);
    console.log(`[audio] open input name="${name}" sr=${sampleRate} ch=${channels} quality=${quality}`);
  }
  if (!info) return null;

  let onData = null;
  info.io.on("data", (buf) => {
    if (!onData) return;
    const f32 =
      info.sampleFormat === portAudio.SampleFormatFloat32
        ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
        : bufferToFloat32(buf, info.sampleFormat);
    onData(f32);
  });

  info.io.start();

  return {
    getQuality: () => getQuality(info),
    onData: (fn) => {
      onData = fn;
    },
    framesPerBuffer: FRAMES_PER_BUFFER,
    close: async () => {
      await closeStream(info);
    },
  };
}

async function openOutput(listIndex, sampleRate, channels) {
  const info = openWithFallback(listIndex, "out", sampleRate, channels);
  if (!info) return null;
  const name = info.entry && info.entry.name ? info.entry.name : "Unknown";
  const quality = getQuality(info);
  console.log(`[audio] open output name="${name}" sr=${sampleRate} ch=${channels} quality=${quality}`);

  info.io.start();

  const chunkFrames = FRAMES_PER_BUFFER;
  const chunkSamples = chunkFrames * channels;
  const silenceChunk = new Float32Array(chunkSamples);
  const ring = new Array(OUTPUT_RING_CAPACITY);
  let ringHead = 0;
  let ringTail = 0;
  let ringCount = 0;
  let staging = new Float32Array(0);
  let onDrain = null;
  let backpressure = false;
  let closed = false;
  let closing = false;
  let prefillActive = true;
  let prefillCount = 0;
  let prefillLogged = false;
  let closeTimer = 0;
  let resolveClose = null;
  let closePromise = null;

  const availableSlots = () => {
    const stagingSlot = staging.length > 0 ? 1 : 0;
    return Math.max(0, OUTPUT_RING_CAPACITY - ringCount - stagingSlot);
  };

  const enqueueChunk = (chunk) => {
    ring[ringTail] = chunk;
    ringTail = (ringTail + 1) % OUTPUT_RING_CAPACITY;
    ringCount += 1;
  };

  const dequeueChunk = () => {
    if (ringCount === 0) return null;
    const chunk = ring[ringHead];
    ring[ringHead] = null;
    ringHead = (ringHead + 1) % OUTPUT_RING_CAPACITY;
    ringCount -= 1;
    return chunk;
  };

  const finishClose = async () => {
    if (closed) return;
    closed = true;
    try {
      info.io.removeListener("drain", handleDrain);
    } catch {
      // ignore
    }
    ringHead = 0;
    ringTail = 0;
    ringCount = 0;
    staging = new Float32Array(0);
    await closeStream(info);
    if (resolveClose) resolveClose();
  };

  const scheduleForcedClose = (ms) => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      finishClose().catch(() => {});
    }, ms);
  };

  const flushOutput = () => {
    if (closed) return;
    let chunksWritten = 0;
    while (true) {
      let chunk = dequeueChunk();
      if (!chunk) {
        if (closing) {
          if (ringCount === 0 && staging.length === 0) {
            scheduleForcedClose(30);
          }
          return;
        }
        chunk = silenceChunk;
      }
      if (prefillActive && chunk === silenceChunk) {
        prefillCount += 1;
      }
      const outBuf =
        info.sampleFormat === portAudio.SampleFormatFloat32
          ? float32ToBuffer(chunk, portAudio.SampleFormatFloat32)
          : float32ToBuffer(chunk, info.sampleFormat);
      const ok = info.io.write(outBuf);
      if (!ok) {
        backpressure = true;
        if (prefillActive && !prefillLogged) {
          prefillLogged = true;
          prefillActive = false;
          console.log(`[audio] initial output prefill buffers: ${prefillCount}`);
        }
        if (onDrain && chunksWritten != 0) onDrain(chunksWritten);//availableSlots());
        return;
      }
      chunksWritten += 1;
    }
  };

  const handleDrain = () => {
    if (closed) return;
    backpressure = false;
    flushOutput();
    if (onDrain) onDrain(availableSlots());
  };
  info.io.on("drain", handleDrain);

  // Prefill with silence to trigger drain events and prime the output queue.
  flushOutput();

  return {
    getQuality: () => getQuality(info),
    available: () => availableSlots(),
    write: (f32) => {
      if (closing) return false;
      if (!f32 || f32.length === 0) return true;
      if (availableSlots() === 0) return false;

      const combined = new Float32Array(staging.length + f32.length);
      combined.set(staging, 0);
      combined.set(f32, staging.length);
      staging = combined;

      while (staging.length >= chunkSamples && ringCount < OUTPUT_RING_CAPACITY) {
        const chunk = staging.subarray(0, chunkSamples);
        const full = new Float32Array(chunkSamples);
        full.set(chunk);
        enqueueChunk(full);
        if (staging.length === chunkSamples) {
          staging = new Float32Array(0);
        } else {
          const remaining = staging.subarray(chunkSamples);
          const next = new Float32Array(remaining.length);
          next.set(remaining);
          staging = next;
        }
      }

      if (!backpressure) flushOutput();
      return availableSlots() > 0;
    },
    onDrain: (fn) => {
      onDrain = typeof fn === "function" ? fn : null;
    },
    framesPerBuffer: FRAMES_PER_BUFFER,
    close: async () => {
      await finishClose();
    },
    closeDrain: async (timeoutMs) => {
      if (closed) return;
      if (closePromise) return closePromise;
      closing = true;
      if (staging.length > 0 && ringCount < OUTPUT_RING_CAPACITY) {
        const padded = new Float32Array(chunkSamples);
        padded.set(staging.subarray(0, chunkSamples));
        enqueueChunk(padded);
        staging = new Float32Array(0);
      }
      flushOutput();
      const framesPending = ringCount + (staging.length > 0 ? 1 : 0);
      const perChunkMs = (chunkFrames / sampleRate) * 1000;
      const waitMs = Math.min(2000, Math.max(60, framesPending * perChunkMs + 60));
      scheduleForcedClose(Number.isFinite(timeoutMs) ? timeoutMs : waitMs);
      closePromise = new Promise((resolve) => {
        resolveClose = resolve;
      });
      return closePromise;
    },
  };
}

module.exports = {
  refreshDevices,
  listInputDevices,
  listOutputDevices,
  openInput,
  openOutput,
};
