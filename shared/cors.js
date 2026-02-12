const { URL } = require("url");

const EXACT_ALLOWED_ORIGINS = new Set([
  "https://dsprototyp.se",
  "https://www.dsprototyp.se",
  "https://stg.github.io",
]);

const LOCALHOST_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (EXACT_ALLOWED_ORIGINS.has(origin)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (LOCALHOST_HOSTS.has(url.hostname)) return true;
  return false;
}

function applyCors(req, res) {
  const origin = req && req.headers ? req.headers.origin : null;
  if (!origin) return;
  if (!isAllowedOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Vary", "Origin");
}

function handlePreflight(req, res) {
  if (!req || !res || req.method !== "OPTIONS") return false;
  const origin = req.headers ? req.headers.origin : null;
  if (!origin || !isAllowedOrigin(origin)) return false;
  res.statusCode = 204;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqHeaders || "*");
  res.setHeader("Vary", "Origin");
  res.end();
  return true;
}

module.exports = {
  applyCors,
  isAllowedOrigin,
  handlePreflight,
};
