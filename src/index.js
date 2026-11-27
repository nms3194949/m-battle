// M Battle — Cloudflare Worker + Durable Object 對戰房間
// 靜態網頁由 assets（public/）提供；/ws/<房號> 升級成 WebSocket，交給同名的 Room 物件。
import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
const MAX_PLAYERS = 6;        // 每房上限（之後做 6 人混戰直接沿用）
const MAX_MSG = 8192;         // 單則訊息上限（字元）
const MAX_PRESENCE = 1800;    // 每人狀態上限（Hibernation 附件上限 2KB）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ws/")) {
      const name = decodeURIComponent(url.pathname.slice(4));
      if (!ROOM_RE.test(name)) return new Response("bad room", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(name));
      return stub.fetch(request);
    }
    if (url.pathname === "/health") return new Response("ok");
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 心跳不喚醒物件，省費用
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const open = this.ctx.getWebSockets().filter((w) => w.readyState === 1).length;
    this.ctx.acceptWebSocket(server);
    if (open >= MAX_PLAYERS) {
      server.send(JSON.stringify({ t: "full" }));
      server.close(4001, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    server.serializeAttachment({ id, presence: {} });
    server.send(JSON.stringify({ t: "hello", peer: id, peers: this.list(server) }));
    this.broadcast({ t: "join", peer: id, presence: {} }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  list(except) {
    const out = [];
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      const a = w.deserializeAttachment();
      if (a && a.id) out.push({ peer: a.id, presence: a.presence || {} });
    }
    return out;
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      try { w.send(s); } catch (_) {}
    }
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(msg); } catch (_) { return; }
    const a = ws.deserializeAttachment();
    if (!a || !m || typeof m !== "object") return;

    if (m.t === "pres" && m.p && typeof m.p === "object" && !Array.isArray(m.p)) {
      const next = { ...a.presence };
      for (const [k, v] of Object.entries(m.p)) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(k)) continue;
        if (v === null) delete next[k]; else next[k] = v;
      }
      if (JSON.stringify(next).length > MAX_PRESENCE) return;
      a.presence = next;
      ws.serializeAttachment(a);
      this.broadcast({ t: "pres", peer: a.id, presence: next });
    } else if (m.t === "emit" && typeof m.topic === "string" && TOPIC_RE.test(m.topic)) {
      // 包含自己（前端靠 sameTab 判斷回音）
      this.broadcast({ t: "msg", peer: a.id, topic: m.topic, data: m.data ?? null });
    }
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment();
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch (_) {}
    if (a && a.id) this.broadcast({ t: "leave", peer: a.id }, ws);
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.id) this.broadcast({ t: "leave", peer: a.id }, ws);
  }
}
