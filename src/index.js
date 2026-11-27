// M Battle — Cloudflare Worker
// - 靜態網頁：public/（assets）
// - /ws/<房號>：對戰房間（Room Durable Object，WebSocket Hibernation）
// - /api/*：錄影紀錄庫、額度計數、管理後台（Archive Durable Object，SQLite）
import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
const MAX_PLAYERS = 6;        // 對戰房上限
const MAX_LOBBY = 200;        // 配對大廳（mm- 開頭）上限
const MAX_MSG = 8192;
const MAX_PRESENCE = 1800;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const archive = (env) => env.ARCHIVE.get(env.ARCHIVE.idFromName("main"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";

    if (url.pathname.startsWith("/ws/")) {
      const name = decodeURIComponent(url.pathname.slice(4));
      if (!ROOM_RE.test(name)) return new Response("bad room", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      // 額度閘門：關閉線上或超過今日上限就拒絕
      const gate = await archive(env).fetch("https://a/gate", { method: "POST", body: JSON.stringify({ lobby: name.startsWith("mm-") }) });
      if (gate.status !== 200) return new Response("online closed", { status: 503 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(name));
      const fwd = new Request(request);
      fwd.headers.set("x-room", name);
      return stub.fetch(fwd);
    }

    if (url.pathname.startsWith("/api/")) {
      const fwd = new Request("https://a" + url.pathname + url.search, { method: request.method, headers: { "x-ip": ip, "x-admin": request.headers.get("x-admin") || "", "content-type": "application/json" }, body: request.method === "GET" ? undefined : await request.text() });
      return archive(env).fetch(fwd);
    }

    if (url.pathname === "/health") return new Response("ok");
    return env.ASSETS.fetch(request);
  },
};

/* ======================= 對戰房間 ======================= */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const name = request.headers.get("x-room") || "";
    const cap = name.startsWith("mm-") ? MAX_LOBBY : MAX_PLAYERS;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const open = this.ctx.getWebSockets().filter((w) => w.readyState === 1).length;
    this.ctx.acceptWebSocket(server);
    if (open >= cap) {
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

/* ======================= 紀錄庫＋額度＋管理 ======================= */
// 預設設定（可在 /admin.html 修改）
const DEFAULTS = {
  online: true,          // 開放線上對戰（好友房、快速配對）
  recording: true,       // 接收玩家上傳的錄影
  ghosts: true,          // 單人／補位使用錄影對手
  maxPerTier: 300,       // 每個等級最多保留幾筆
  maxDays: 30,           // 超過幾天自動刪除
  uidPerDay: 30,         // 同一玩家每天最多上傳幾筆
  ipPerDay: 80,          // 同一 IP 每天最多上傳幾筆
  maxPps: 4.5,           // 每秒放置方塊上限（超過視為外掛／AI）
  maxApm: 160,           // 每分鐘攻擊上限（超過不收）
  connCap: 3500,         // 每天線上連線上限（約對應免費額度；0＝不限）
  warnPct: 70,           // 用量達幾 % 時通知
};
const TIERS = [0, 10, 20, 30, 45, 60, 80, 100]; // 每分鐘攻擊（APM）分級門檻

const today = () => new Date().toISOString().slice(0, 10); // UTC 日期（Cloudflare 免費額度也是 UTC 重置）
const tierOf = (apm) => { let t = 0; for (let i = 0; i < TIERS.length; i++) if (apm >= TIERS[i]) t = i; return t; };
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

export class Archive extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS replays(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, name TEXT, tag TEXT, apm REAL, lines INTEGER, tier INTEGER, created INTEGER, ip TEXT, data TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS rp_tier ON replays(tier, created)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)`);
  }

  get(k, d) { const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray()[0]; return r ? JSON.parse(r.v) : d; }
  put(k, v) { this.sql.exec("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, JSON.stringify(v)); }
  cfg() { return { ...DEFAULTS, ...this.get("cfg", {}) }; }
  bump(name, by = 1) { const k = "c:" + today() + ":" + name; const v = this.get(k, 0) + by; this.put(k, v); return v; }
  count(name, day = today()) { return this.get("c:" + day + ":" + name, 0); }

  async notify(text) {
    const alerts = this.get("alerts", []);
    alerts.unshift({ t: Date.now(), text });
    this.put("alerts", alerts.slice(0, 50));
    if (this.env.LINE_TOKEN && this.env.LINE_TO) {
      try {
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + this.env.LINE_TOKEN },
          body: JSON.stringify({ to: this.env.LINE_TO, messages: [{ type: "text", text: "【M Battle】" + text }] }),
        });
      } catch (_) {}
    }
  }

  async usageCheck() {
    const c = this.cfg();
    if (!c.connCap) return;
    const used = this.count("conn"), pct = Math.round((used / c.connCap) * 100), d = today();
    if (pct >= c.warnPct && !this.get("warned:" + d, false)) { this.put("warned:" + d, true); await this.notify(`今日線上連線已達 ${pct}%（${used}/${c.connCap}）。可到管理後台調整或暫停線上。`); }
    if (used >= c.connCap && !this.get("capped:" + d, false)) { this.put("capped:" + d, true); await this.notify(`今日線上連線已滿（${used}），新的線上連線會被擋下，單人模式不受影響。台灣時間早上 8 點（UTC 0 點）自動重置。`); }
  }

  pruneOld() {
    const c = this.cfg();
    this.sql.exec("DELETE FROM replays WHERE created < ?", Date.now() - c.maxDays * 86400000);
    for (let t = 0; t < TIERS.length; t++) {
      this.sql.exec("DELETE FROM replays WHERE tier=? AND id NOT IN (SELECT id FROM replays WHERE tier=? ORDER BY created DESC LIMIT ?)", t, t, c.maxPerTier);
    }
  }

  async fetch(request) {
    const url = new URL(request.url), p = url.pathname, ip = request.headers.get("x-ip") || "";
    const c = this.cfg();

    // ---- 額度閘門（每條 WebSocket 連線前呼叫）
    if (p === "/gate") {
      if (!c.online) return new Response("closed", { status: 503 });
      const body = await request.json().catch(() => ({}));
      if (c.connCap && this.count("conn") >= c.connCap) { await this.usageCheck(); return new Response("cap", { status: 503 }); }
      this.bump(body.lobby ? "lobby" : "conn");
      if (!body.lobby) await this.usageCheck();
      return new Response("ok");
    }

    // ---- 公開狀態
    if (p === "/api/status") {
      const capped = c.connCap && this.count("conn") >= c.connCap;
      const online = c.online && !capped;
      return json({ online, recording: c.recording, ghosts: c.ghosts, msg: !c.online ? "線上對戰暫停中，先玩單人吧。" : capped ? "今日線上額度已滿，台灣時間早上 8 點重置；單人模式照常可玩。" : "" });
    }

    // ---- 上傳錄影
    if (p === "/api/replay" && request.method === "POST") {
      if (!c.recording) return json({ ok: false, why: "off" });
      const b = await request.json().catch(() => null);
      if (!b || typeof b.rec !== "string" || !/^[0-9a-z]{6,24}$/.test(b.uid || "")) return json({ ok: false, why: "bad" }, 400);
      if (this.get("bans", []).includes(b.uid)) return json({ ok: false, why: "ban" });
      const rec = b.rec.split(";").filter(Boolean).map((s) => s.split(",").map(Number));
      if (rec.length < 20 || rec.length > 1200 || b.rec.length > 20000) return json({ ok: false, why: "len" }, 400);
      if (!rec.every((r) => r.length === 4 && r.every(Number.isFinite) && r[1] >= 0 && r[1] <= 6 && r[2] >= 0 && r[2] <= 3 && r[3] >= -2 && r[3] <= 9)) return json({ ok: false, why: "bad" }, 400);
      for (let i = 1; i < rec.length; i++) if (rec[i][0] < rec[i - 1][0]) return json({ ok: false, why: "bad" }, 400);
      const dur = Math.max(1, rec[rec.length - 1][0]) / 1000;
      const pps = rec.length / dur, apm = (Math.max(0, Number(b.sent) || 0) / dur) * 60;
      if (pps > c.maxPps || apm > c.maxApm || dur < 20) { this.bump("rej"); return json({ ok: false, why: "filtered" }); }
      if (this.count("u:" + b.uid) >= c.uidPerDay || this.count("ip:" + ip) >= c.ipPerDay) { this.bump("rej"); return json({ ok: false, why: "rate" }); }
      this.bump("u:" + b.uid); this.bump("ip:" + ip); this.bump("upl");
      this.sql.exec("INSERT INTO replays(uid,name,tag,apm,lines,tier,created,ip,data) VALUES(?,?,?,?,?,?,?,?,?)",
        b.uid, clean(b.name, 12) || "玩家", clean(b.tag, 4), Math.round(apm * 10) / 10, Math.max(0, b.lines | 0), tierOf(apm), Date.now(), ip, b.rec);
      if (this.count("upl") % 20 === 1) this.pruneOld();
      return json({ ok: true, tier: tierOf(apm) });
    }

    // ---- 取錄影對手
    if (p === "/api/ghosts") {
      if (!c.ghosts) return json({ list: [] });
      const n = Math.max(1, Math.min(5, Number(url.searchParams.get("n")) || 1));
      const apm = Math.max(0, Number(url.searchParams.get("apm")) || 20), uid = url.searchParams.get("uid") || "";
      const t = tierOf(apm);
      let rows = this.sql.exec("SELECT id,name,tag,apm,data FROM replays WHERE tier BETWEEN ? AND ? AND uid<>? ORDER BY RANDOM() LIMIT ?", Math.max(0, t - 1), t + 1, uid, n).toArray();
      if (rows.length < n) rows = rows.concat(this.sql.exec("SELECT id,name,tag,apm,data FROM replays WHERE uid<>? AND id NOT IN (" + (rows.map((r) => r.id).join(",") || "0") + ") ORDER BY RANDOM() LIMIT ?", uid, n - rows.length).toArray());
      // 別人的紀錄不夠時，用自己的紀錄補（測試初期或冷門等級）
      if (rows.length < n) rows = rows.concat(this.sql.exec("SELECT id,name,tag,apm,data FROM replays WHERE id NOT IN (" + (rows.map((r) => r.id).join(",") || "0") + ") ORDER BY RANDOM() LIMIT ?", n - rows.length).toArray());
      this.bump("ghost", rows.length);
      return json({ list: rows.map((r) => ({ id: r.id, name: r.name, tag: r.tag, apm: r.apm, rec: r.data })) });
    }

    // ---- 管理後台
    if (p.startsWith("/api/admin/")) {
      if (!this.env.ADMIN_KEY || request.headers.get("x-admin") !== this.env.ADMIN_KEY) return json({ ok: false, why: "auth" }, 401);
      const a = p.slice(11);
      if (a === "stats") {
        const days = [];
        for (let i = 0; i < 7; i++) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); days.push({ d, conn: this.count("conn", d), lobby: this.count("lobby", d), upl: this.count("upl", d), rej: this.count("rej", d), ghost: this.count("ghost", d) }); }
        const tiers = this.sql.exec("SELECT tier, COUNT(*) n FROM replays GROUP BY tier").toArray();
        const total = this.sql.exec("SELECT COUNT(*) n, COALESCE(SUM(LENGTH(data)),0) bytes FROM replays").toArray()[0];
        const recent = this.sql.exec("SELECT id,uid,name,tag,apm,lines,tier,created,ip FROM replays ORDER BY id DESC LIMIT 40").toArray();
        const top = this.sql.exec("SELECT uid,name,tag,COUNT(*) n,MAX(apm) apm FROM replays GROUP BY uid ORDER BY n DESC LIMIT 15").toArray();
        return json({ ok: true, cfg: c, days, tiers, total, recent, top, tierEdges: TIERS, alerts: this.get("alerts", []), bans: this.get("bans", []).length, line: !!(this.env.LINE_TOKEN && this.env.LINE_TO) });
      }
      if (a === "config" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const next = { ...this.get("cfg", {}) };
        for (const k of Object.keys(DEFAULTS)) if (k in b) next[k] = typeof DEFAULTS[k] === "boolean" ? !!b[k] : Math.max(0, Number(b[k]) || 0);
        this.put("cfg", next);
        this.pruneOld();
        return json({ ok: true, cfg: this.cfg() });
      }
      if (a === "purge" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        if (b.all) this.sql.exec("DELETE FROM replays");
        else if (b.id) this.sql.exec("DELETE FROM replays WHERE id=?", Number(b.id));
        else if (b.uid) this.sql.exec("DELETE FROM replays WHERE uid=?", String(b.uid));
        else if (b.ip) this.sql.exec("DELETE FROM replays WHERE ip=?", String(b.ip));
        else if (b.name) { const [nm, tg] = String(b.name).split("#"); this.sql.exec("DELETE FROM replays WHERE name=? AND (?='' OR tag=?)", nm, tg || "", tg || ""); }
        return json({ ok: true });
      }
      if (a === "ban" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const bans = new Set(this.get("bans", []));
        if (b.uid) { bans.add(String(b.uid)); this.sql.exec("DELETE FROM replays WHERE uid=?", String(b.uid)); }
        this.put("bans", [...bans].slice(-500));
        return json({ ok: true });
      }
      if (a === "notify" && request.method === "POST") { await this.notify("測試通知：管理後台通知設定正常。"); return json({ ok: true, line: !!(this.env.LINE_TOKEN && this.env.LINE_TO) }); }
      if (a === "resetToday" && request.method === "POST") { for (const k of ["conn", "lobby"]) this.put("c:" + today() + ":" + k, 0); this.put("capped:" + today(), false); this.put("warned:" + today(), false); return json({ ok: true }); }
      return json({ ok: false, why: "unknown" }, 404);
    }
    return json({ ok: false }, 404);
  }
}
