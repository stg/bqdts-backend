const http = require("http");
const audioServer = require("../shared/audio_server");
const proxy = require("../shared/proxy");
const cors = require("../shared/cors");

const PORT = 9000;

const server = http.createServer((req, res) => {
  if (cors.handlePreflight(req, res)) return;
  if (audioServer.handleListRequest(req, res)) return;
  if (audioServer.handleRadioRequest(req, res)) return;
  if (proxy.handleProxyRequest(req, res)) return;
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  cors.applyCors(req, res);
  res.end("Not found");
});

audioServer.attachAudioWebSockets(server);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Proxy listening on http://127.0.0.1:${PORT}`);
});



