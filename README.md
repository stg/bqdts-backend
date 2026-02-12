# Biquad Design and Test Suite (BQDTS, Vibe) Backend

Backend for the BQDTS app.

BQDTS is a professional tool for designing biquad filters and evaluating their performance for system correction using sweep and noise analysis. A calibration microphone is recommended. UMIK-1 works well.

BQDTS can generate biquad coefficients for any Direct Form II DSP, and it can perform live reconfiguration of supported DSP systems, including DS prototyp Bluetooth (A2DP) connected devices.

Access BQDTS here:

- https://dsprototyp.se/bqdts

This repo provides the Node backend that exposes exclusive audio input/output over HTTP + WebSocket.

BQDTS can be used without a backend, but analysis-grade input and output cannot be guaranteed without the backend providing exclusive access to system audio devices.

## Why this backend?

Browsers can't provide full device access or exclusive-mode WASAPI control on their own,
so this small Node backend bridges the gap:

- Lists input/output devices (DirectSound + WASAPI)
- Streams audio input and output over WebSocket (float32 interleaved)
- Transcodes radio/stream URLs to raw PCM via `ffmpeg`

It's intended for localhost use on a user's machine, not as a public server.

## Requirements (Simple)

- Windows (WASAPI / DirectSound)
- Node.js 18+ (current LTS is fine)
- `ffmpeg` installed and on your PATH (required for `/radio`)
  - https://ffmpeg.org/download.html

## Quick Start (Step by Step)

1. Install Node.js (LTS): https://nodejs.org
2. Install ffmpeg and make sure `ffmpeg` works in a terminal.
3. Open a terminal in this folder and run:

```bash
npm install
```

4. Start the backend:

```bash
node browser/proxy.js
```

You should see:

```
Proxy listening on http://127.0.0.1:9000
```

That means it is running.

## Install (Manual)

```bash
npm install
```

## Run (Manual)

```bash
node browser/proxy.js
```

Server listens on `http://127.0.0.1:9000`.

## Example (HTML)

Serve the example page:

```bash
cd example
python -m http.server 8000
```

Open `http://localhost:8000/example.htm` in your browser, then:

1. Click **Refresh** to load devices.
2. Select an **Output Device** and click **Connect Output**.
3. Enter a radio stream URL and click **Start Radio**.

## Endpoints

- `GET /source/list` - list input devices
- `GET /sink/list` - list output devices
- `WS /source/<id>?sr=<sr>&ch=<ch>` - stream input audio (float32)
- `WS /sink/<id>?sr=<sr>&ch=<ch>` - stream output audio (float32)
- `GET /radio?url=<streamUrl>&sr=<samplerate>` - transcode to float32 PCM

See `shared/audio_server.md` for protocol details.

## Notes

- This backend is intended for localhost usage only.
- CORS is restricted to allowed origins in `shared/cors.js`.
