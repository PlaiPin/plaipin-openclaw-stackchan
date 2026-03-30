#!/usr/bin/env node
/**
 * OpenClaw REST-to-WebSocket Proxy
 *
 * Translates HTTP POST /v1/chat/completions (OpenAI-shaped)
 * into OpenClaw WebSocket protocol messages.
 *
 * Environment variables:
 *   OPENCLAW_GATEWAY_TOKEN  - Auth token for the OpenClaw gateway
 *   OPENCLAW_WS_URL         - Gateway WebSocket URL (default: ws://localhost:18789)
 *   PROXY_PORT              - HTTP listen port (default: 18790)
 */

const http = require("http");
const crypto = require("crypto");

let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  console.error("Missing 'ws' package. Run: npm install ws");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const WS_URL = process.env.OPENCLAW_WS_URL || "ws://localhost:18789";
const PORT = parseInt(process.env.PROXY_PORT || "18790", 10);
const RESPONSE_TIMEOUT_MS = 60_000;

// Telegram config
const TG_BOT_TOKEN = process.env.OPENCLAW_TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.OPENCLAW_TG_CHAT_ID || "";
const https = require("https");

// Queue of Telegram messages processed and waiting for ESP32 to pick up
const pendingForRobot = [];
let tgOffset = 0;
let tgPolling = false;

// ---------------------------------------------------------------------------
// WebSocket connection state
// ---------------------------------------------------------------------------
let ws = null;
let sessionKey = null;
let reqCounter = 0;
let reconnectTimer = null;

// Pending chat requests: idempotencyKey → { resolve, reject, timer }
const pending = new Map();

function nextReqId() {
  return `proxy-${++reqCounter}-${Date.now()}`;
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Send user's STT input to Telegram so both sides of the conversation are visible
function sendToTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const body = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text: `🎙️ *Stack-chan heard:*\n${text}`,
    parse_mode: "Markdown",
  });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${TG_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  req.on("error", (e) => log("Telegram send error:", e.message));
  req.end(body);
}

// ---------------------------------------------------------------------------
// WebSocket management
// ---------------------------------------------------------------------------
function connectGateway() {
  if (ws) {
    try { ws.close(); } catch {}
  }

  log("Connecting to gateway:", WS_URL);
  ws = new WebSocket(WS_URL, { origin: "http://localhost:18789" });

  ws.on("open", () => {
    log("WebSocket opened, sending connect handshake");
    ws.send(JSON.stringify({
      type: "req",
      id: nextReqId(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "webchat",
          displayName: "OpenClaw REST Proxy",
          version: "1.0.0",
          platform: "web",
          mode: "webchat",
        },
        auth: { token: GATEWAY_TOKEN },
        scopes: ["operator.write"],
      },
    }));
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Handle connect response
    if (data.type === "res") {
      if (data.ok && data.payload?.type === "hello-ok") {
        sessionKey =
          data.payload.snapshot?.sessionDefaults?.mainSessionKey || "main";
        log("Connected! sessionKey:", sessionKey);
      } else if (!data.ok && data.error) {
        log("Gateway error:", data.error.message);
      }
      return;
    }

    // Handle chat events
    if (data.type === "event" && data.event === "chat") {
      const payload = data.payload;
      if (!payload) return;

      const runId = payload.runId || "unknown";

      if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
        const content = extractText(payload.message);
        log(`Chat ${payload.state} [${runId}]:`, content.slice(0, 120));

        // Resolve all pending requests (there should typically be one)
        // Match by checking all pending — OpenClaw doesn't echo back our idempotencyKey
        // in the event, so we resolve the oldest pending request.
        for (const [key, req] of pending) {
          clearTimeout(req.timer);
          if (payload.state === "error" || payload.state === "aborted") {
            req.reject(new Error(content || `Chat ${payload.state}`));
          } else {
            req.resolve(content);
          }
          pending.delete(key);
          break; // resolve one at a time
        }
      } else if (payload.state === "delta") {
        // We could accumulate deltas, but we wait for final
      }
    }
  });

  ws.on("close", (code, reason) => {
    log("WebSocket closed:", code, reason?.toString());
    sessionKey = null;
    // Reject all pending requests
    for (const [key, req] of pending) {
      clearTimeout(req.timer);
      req.reject(new Error("WebSocket disconnected"));
      pending.delete(key);
    }
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    log("WebSocket error:", err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectGateway();
  }, 3000);
}

function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN && sessionKey;
}

// ---------------------------------------------------------------------------
// Send a chat message and wait for the final response
// ---------------------------------------------------------------------------
function sendChat(message) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      return reject(new Error("Not connected to gateway"));
    }

    const idempotencyKey = crypto.randomUUID();

    const timer = setTimeout(() => {
      pending.delete(idempotencyKey);
      reject(new Error("Timeout waiting for response"));
    }, RESPONSE_TIMEOUT_MS);

    pending.set(idempotencyKey, { resolve, reject, timer });

    ws.send(JSON.stringify({
      type: "req",
      id: nextReqId(),
      method: "chat.send",
      params: {
        sessionKey,
        message,
        idempotencyKey,
      },
    }));

    log("Sent chat.send:", message.slice(0, 120));
  });
}

// ---------------------------------------------------------------------------
// Text extraction (mirrors openclaw.ts logic)
// ---------------------------------------------------------------------------
function extractText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  const content = message.content;
  if (typeof content === "string") return deduplicate(content);
  if (Array.isArray(content)) {
    // Take only the last text block (gateway may include accumulated + final)
    const textBlocks = content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      return deduplicate(textBlocks[textBlocks.length - 1].text || "");
    }
  }
  return "";
}

// Detect and fix doubled responses (gateway sometimes sends text twice)
function deduplicate(text) {
  if (text.length < 20) return text;
  const half = Math.floor(text.length / 2);
  // Check if second half is a repeat of the first half (with some whitespace tolerance)
  const first = text.slice(0, half).trim();
  const second = text.slice(half).trim();
  if (first === second) {
    log("Deduplicated response (was doubled)");
    return first;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Telegram polling (receive messages typed in Telegram)
// ---------------------------------------------------------------------------
function pollTelegram() {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  if (tgPolling) return;
  tgPolling = true;

  const url = `/bot${TG_BOT_TOKEN}/getUpdates?offset=${tgOffset}&timeout=30&allowed_updates=["message"]`;
  const req = https.request({
    hostname: "api.telegram.org",
    path: url,
    method: "GET",
  }, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", async () => {
      tgPolling = false;
      try {
        const data = JSON.parse(body);
        if (data.ok && data.result) {
          for (const update of data.result) {
            tgOffset = update.update_id + 1;
            const msg = update.message;
            if (!msg || !msg.text) continue;
            // Only process messages from the configured chat
            if (String(msg.chat.id) !== TG_CHAT_ID) continue;

            const userText = msg.text;
            log("Telegram message:", userText.slice(0, 120));

            if (!isConnected()) {
              sendToTelegram("(Stack-chan is offline)");
              continue;
            }

            try {
              const aiResponse = await sendChat(userText);
              log("Telegram AI response:", aiResponse.slice(0, 120));
              sendToTelegram(aiResponse);
              pendingForRobot.push({ userText, aiResponse });
            } catch (err) {
              log("Telegram chat error:", err.message);
              sendToTelegram(`(Error: ${err.message})`);
            }
          }
        }
      } catch (e) {
        log("Telegram poll parse error:", e.message);
      }
      // Poll again immediately
      setImmediate(pollTelegram);
    });
  });
  req.on("error", (e) => {
    tgPolling = false;
    log("Telegram poll error:", e.message);
    setTimeout(pollTelegram, 5000);
  });
  req.end();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    const status = isConnected() ? "ok" : "disconnected";
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status, sessionKey }));
  }

  // Pending Telegram messages for ESP32 to pick up
  if (req.method === "GET" && req.url === "/v1/pending") {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (GATEWAY_TOKEN && token !== GATEWAY_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
    }
    if (pendingForRobot.length > 0) {
      const item = pendingForRobot.shift();
      log("Pending pickup:", item.userText.slice(0, 60));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ pending: true, userText: item.userText, aiResponse: item.aiResponse }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ pending: false }));
  }

  // Only accept POST /v1/chat/completions
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Not found" } }));
  }

  // Validate bearer token
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (GATEWAY_TOKEN && token !== GATEWAY_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
  }

  // Check gateway connection
  if (!isConnected()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: { message: "Gateway not connected. Try again shortly." },
    }));
  }

  // Read body
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
  }

  // Extract last user message
  const messages = parsed.messages || [];
  let userMessage = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content) {
      userMessage = messages[i].content;
      break;
    }
  }

  if (!userMessage) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: { message: "No user message found" },
    }));
  }

  log("Request:", userMessage.slice(0, 200));
  sendToTelegram(userMessage);

  try {
    const content = await sendChat(userMessage);

    const response = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: parsed.model || "openclaw:main",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    log("Response:", content.slice(0, 200));

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(response));
  } catch (err) {
    log("Error:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: { message: err.message },
    }));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  log(`OpenClaw REST proxy listening on http://0.0.0.0:${PORT}`);
  log(`Gateway WebSocket: ${WS_URL}`);
  connectGateway();
  pollTelegram();
});
