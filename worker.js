
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "GreenLife Farm Mabar"
      });
    }

    if (url.pathname === "/create" && request.method === "POST") {
      const code = "KBN-" + Math.floor(100000 + Math.random() * 900000);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

      const init = await stub.fetch("https://room/init", {
        method: "POST"
      });

      if (!init.ok) {
        return Response.json({ error: "Gagal membuat ruang" }, { status: 503 });
      }

      return Response.json({ code });
    }

    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      const name = (url.searchParams.get("name") || "Petani").trim().slice(0, 18);
      const playerId = (url.searchParams.get("id") || "").slice(0, 32);

      if (!/^KBN-\d{6}$/.test(room) || !playerId) {
        return new Response("Kode atau ID tidak valid", { status: 400 });
      }

      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));

      return stub.fetch(new Request(
        "https://room/connect?name=" + encodeURIComponent(name) +
        "&id=" + encodeURIComponent(playerId),
        request
      ));
    }

    return new Response("GreenLife Farm Mabar");
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  sockets() {
    return this.ctx.getWebSockets();
  }

  players() {
    return this.sockets().map(ws => {
      try {
        return ws.deserializeAttachment();
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    for (const ws of this.sockets()) {
      try {
        ws.send(message);
      } catch (_) {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      return new Response("ok");
    }

    if (url.pathname !== "/connect" ||
        request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    if (this.sockets().length >= 5) {
      return new Response("Desa penuh (maksimal 5 pemain)", { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const name = (url.searchParams.get("name") || "Petani").slice(0, 18);
    const id = url.searchParams.get("id");
    const isHost = this.players().length === 0;

    server.serializeAttachment({
      id, name, isHost,
      x: 0, y: 0, z: 0, ry: 0
    });

    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({
      type: "welcome",
      players: this.players()
    }));

    this.broadcast({
      type: "players",
      players: this.players()
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    let data;

    try {
      data = JSON.parse(message);
    } catch (_) {
      return;
    }

    if (!data || !["move", "world", "proposal"].includes(data.type)) return;

    const player = ws.deserializeAttachment();
    if (!player) return;

    if (data.type === "world") {
      if (!player.isHost || !data.state || data.state.v !== 1) return;
      if (JSON.stringify(data.state).length > 28000) return;

      this.broadcast({ type: "world", state: data.state });
      return;
    }

    if (data.type === "proposal") {
      if (player.isHost || !data.state || data.state.v !== 1) return;
      if (JSON.stringify(data.state).length > 28000) return;

      for (const target of this.sockets()) {
        try {
          if (target.deserializeAttachment()?.isHost) {
            target.send(JSON.stringify({
              type: "proposal",
              state: data.state
            }));
          }
        } catch (_) {}
      }
      return;
    }

    player.x = Number.isFinite(data.x) ? Math.max(-10000, Math.min(10000, data.x)) : player.x;
    player.y = Number.isFinite(data.y) ? Math.max(-100, Math.min(1000, data.y)) : player.y;
    player.z = Number.isFinite(data.z) ? Math.max(-10000, Math.min(10000, data.z)) : player.z;
    player.ry = Number.isFinite(data.ry) ? data.ry : player.ry;

    ws.serializeAttachment(player);

    this.broadcast({
      type: "players",
      players: this.players()
    });
  }

  async webSocketClose(ws) {
    let player = null;

    try {
      player = ws.deserializeAttachment();
    } catch (_) {}

    if (player?.isHost) {
      for (const other of this.sockets()) {
        try {
          other.send(JSON.stringify({ type: "host_left" }));
          other.close(1000, "Host left");
        } catch (_) {}
      }
    } else {
      this.broadcast({
        type: "players",
        players: this.players()
      });
    }
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
                              }
          
