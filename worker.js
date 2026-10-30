
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
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);

      const init = await stub.fetch("https://room/init", {
        method: "POST"
      });

      if (!init.ok) {
        return Response.json(
          { error: "Gagal membuat ruang." },
          { status: 503 }
        );
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

      const id = env.ROOMS.idFromName(room);

      return env.ROOMS.get(id).fetch(
        new Request(
          "https://room/connect?name=" +
          encodeURIComponent(name) +
          "&id=" +
          encodeURIComponent(playerId),
          request
        )
      );
    }

    return new Response("GreenLife Farm Mabar Worker");
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
    return this.sockets()
      .map(ws => {
        try {
          return ws.deserializeAttachment();
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  broadcast(payload) {
    const msg = JSON.stringify(payload);

    for (const ws of this.sockets()) {
      try {
        ws.send(msg);
      } catch (_) {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      return new Response("ok");
    }

    if (
      url.pathname !== "/connect" ||
      request.headers.get("Upgrade") !== "websocket"
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const name = (url.searchParams.get("name") || "Petani").slice(0, 18);
    const id = url.searchParams.get("id");

    if (this.sockets().length >= 5) {
      return new Response(
        "Desa penuh (maksimal 5 pemain termasuk host)",
        { status: 409 }
      );
    }

    const isHost = this.players().length === 0;

    server.serializeAttachment({
      id,
      name,
      isHost,
      x: 0,
      y: 0,
      z: 0,
      ry: 0
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

    if (!data || !["move", "world", "proposal"].includes(data.type)) {
      return;
    }

    const p = ws.deserializeAttachment();
    if (!p) return;

    if (data.type === "world") {
      if (!p.isHost || !data.state || data.state.v !== 1) return;

      const raw = JSON.stringify(data.state);
      if (raw.length > 28000) return;

      this.broadcast({
        type: "world",
        state: data.state
      });

      return;
    }

    if (data.type === "proposal") {
      if (p.isHost || !data.state || data.state.v !== 1) return;

      const raw = JSON.stringify(data.state);
      if (raw.length > 28000) return;

      for (const target of this.sockets()) {
        try {
          const recipient = target.deserializeAttachment();

          if (recipient && recipient.isHost) {
            target.send(JSON.stringify({
              type: "proposal",
              state: data.state
            }));
          }
        } catch (_) {}
      }

      return;
    }

    p.x = Number.isFinite(data.x)
      ? Math.max(-10000, Math.min(10000, data.x))
      : p.x;

    p.y = Number.isFinite(data.y)
      ? Math.max(-100, Math.min(1000, data.y))
      : p.y;

    p.z = Number.isFinite(data.z)
      ? Math.max(-10000, Math.min(10000, data.z))
      : p.z;

    p.ry = Number.isFinite(data.ry) ? data.ry : p.ry;

    ws.serializeAttachment(p);

    this.broadcast({
      type: "players",
      players: this.players()
    });
  }

  async webSocketClose(ws) {
    let p = null;

    try {
      p = ws.deserializeAttachment();
    } catch (_) {}

    try {
      ws.close();
    } catch (_) {}

    if (p && p.isHost) {
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
