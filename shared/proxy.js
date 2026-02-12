const http = require("http");
const https = require("https");
const { URL } = require("url");
const cors = require("./cors");

function sendText(req, res, status, msg) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  cors.applyCors(req, res);
  res.end(msg);
}

function normalizeUrlParam(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function proxyRequest(target, req, res) {
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    sendText(req, res, 400, "Bad url");
    return;
  }
  const mod = targetUrl.protocol === "https:" ? https : http;
  const upstream = mod.get(targetUrl, (up) => {
    res.statusCode = up.statusCode || 502;
    cors.applyCors(req, res);
    up.pipe(res);
  });
  upstream.on("error", () => sendText(req, res, 502, "Upstream error"));
}

function handleProxyRequest(req, res) {
  let reqUrl;
  try {
    reqUrl = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    sendText(req, res, 400, "Bad request");
    return true;
  }
  if (reqUrl.pathname !== "/proxy") return false;
  const target = reqUrl.searchParams.get("url");
  if (!target) {
    sendText(req, res, 200, "ok");
    return true;
  }
  proxyRequest(target, req, res);
  return true;
}

function registerProxyRoutes(app) {
  app.use("/proxy", (req, res) => {
    const target = normalizeUrlParam(req.query.url);
    if (!target) return sendText(req, res, 200, "ok");
    proxyRequest(target, req, res);
  });
}

module.exports = {
  handleProxyRequest,
  registerProxyRoutes
};
