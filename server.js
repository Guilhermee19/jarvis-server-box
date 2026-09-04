import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { networkInterfaces } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { createMonitor } from "./monitor.js";
import { createDigestStats } from "./digest-stats.mjs";
import { createFiles, filesDir } from "./files.js";
import { ensurePin, isLoopback, pinCookie, pinFromCookie, PIN_RE } from "./auth.js";

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  ...SEC_HEADERS,
};

// Rotas que nunca pedem PIN — usadas por watchdog e monitoramento externo.
const PUBLIC_PATHS = new Set(["/health"]);

// Um PIN de 4 dígitos são 10 mil combinações: sem limite, dá pra varrer tudo
// em minutos. Cinco erros travam o IP por 15 minutos.
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60 * 1000;

function fail(res, err) {
  console.error("[server-box] monitor error:", err);
  res.writeHead(500, JSON_HEADERS);
  res.end(JSON.stringify({ ok: false, error: "não foi possível ler o status" }));
}

/** Erro de rota: usa err.status quando o módulo definiu um, senão 500. */
function failFile(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error("[server-box] files error:", err);
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify({ ok: false, error: err.message || "erro ao acessar o arquivo" }));
}

/**
 * `Range: bytes=a-b` — é o que faz vídeo e áudio darem seek no navegador.
 * Retorna null quando não há range, ou "invalid" quando o pedido não cabe.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return "invalid";
  const [, rawStart, rawEnd] = m;
  let start;
  let end;
  if (rawStart === "") {
    if (rawEnd === "") return "invalid";
    // Sufixo: os últimos N bytes.
    start = Math.max(0, size - Number(rawEnd));
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

/**
 * Entrega um arquivo enviado por upload. Conteúdo de terceiro nunca é confiável:
 * vai com sandbox e sem script, e só abre na aba quando é mídia, PDF ou texto puro
 * — HTML e SVG baixam, para não virarem script rodando na origem do painel.
 */
function serveFile(req, res, info, download) {
  const inline = info.inline && !download;
  const headers = {
    "Content-Type": info.type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(info.name)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ...SEC_HEADERS,
  };

  const range = parseRange(req.headers.range, info.size);
  if (range === "invalid") {
    res.writeHead(416, { "Content-Range": `bytes */${info.size}`, ...JSON_HEADERS });
    res.end(JSON.stringify({ ok: false, error: "faixa inválida" }));
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, info.size - 1);
  headers["Content-Length"] = String(info.size === 0 ? 0 : end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;

  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || info.size === 0) {
    res.end();
    return;
  }
  const stream = info.stream({ start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function bootIps() {
  const ips = { lan: null, tailscale: null };
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("100.")) ips.tailscale = info.address;
      else if (ips.lan === null) ips.lan = info.address;
    }
  }
  return ips;
}

/** Comparação de tempo constante; falsa também quando os tamanhos diferem. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function loginPage(erro = "") {
  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis Server Box</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0b0b0c; color:#e7e7e9;
         font:16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  form { width:min(320px, 88vw); display:grid; gap:14px; }
  h1 { font-size:18px; margin:0 0 4px; font-weight:600; }
  p { margin:0; color:#8b8b93; font-size:14px; }
  input { font:inherit; letter-spacing:.5em; text-align:center; padding:14px;
          border-radius:10px; border:1px solid #2a2a2e; background:#141416;
          color:inherit; }
  input:focus { outline:2px solid #3b82f6; outline-offset:1px; }
  button { font:inherit; font-weight:600; padding:12px; border:0;
           border-radius:10px; background:#3b82f6; color:#fff; cursor:pointer; }
  .erro { color:#f87171; font-size:14px; }
</style>
<form method="POST" action="/login">
  <div>
    <h1>Jarvis Server Box</h1>
    <p>Digite o PIN de 4 dígitos.</p>
  </div>
  <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"
         autocomplete="off" autofocus aria-label="PIN">
  ${erro ? `<p class="erro">${erro}</p>` : ""}
  <button type="submit">Entrar</button>
</form>
</html>`;
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("body grande demais")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startServer(opts = {}) {
  const root = opts.root ?? join(import.meta.dirname, "public");
  const port = opts.port ?? (Number(process.env.PORT) || 8080);
  const monitor = createMonitor();
  const digestStats = createDigestStats({ newsDir: opts.newsDir });
  const files = createFiles({ dir: opts.filesDir, maxBytes: opts.maxBytes });

  // Desligar exige intenção explícita: opts.requirePin === false (testes) ou
  // SERVERBOX_PIN=off no ambiente.
  const requirePin = opts.requirePin ?? process.env.SERVERBOX_PIN !== "off";
  const pin = requirePin ? await ensurePin(opts.pinRoot) : null;
  // Só os testes desligam isso, para conseguirem exercitar o caminho do PIN.
  const trustLoopback = opts.trustLoopback ?? true;

  const failures = new Map();

  const lockedUntil = ip => {
    const f = failures.get(ip);
    if (!f) return 0;
    if (Date.now() > f.until) { failures.delete(ip); return 0; }
    return f.count >= MAX_TRIES ? f.until : 0;
  };

  const registerFailure = ip => {
    const f = failures.get(ip) ?? { count: 0, until: 0 };
    f.count += 1;
    f.until = Date.now() + LOCK_MS;
    failures.set(ip, f);
  };

  const authorized = req => {
    if (!pin) return true;
    // Loopback é o próprio aparelho: quem já está no Termux não precisa de PIN.
    if (trustLoopback && isLoopback(req.socket.remoteAddress)) return true;
    const given = pinFromCookie(req.headers.cookie);
    return typeof given === "string" && safeEqual(given, pin);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const ip = req.socket.remoteAddress || "";
    const ok = body => { res.writeHead(200, JSON_HEADERS); res.end(JSON.stringify({ ok: true, ...body })); };

    const sendLogin = (status, erro) => {
      const html = loginPage(erro);
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...SEC_HEADERS,
      });
      res.end(html);
    };

    if (url.pathname === "/login" && req.method === "POST") {
      const until = lockedUntil(ip);
      if (until) {
        const min = Math.ceil((until - Date.now()) / 60000);
        sendLogin(429, `Tentativas demais. Tente de novo em ${min} min.`);
        return;
      }
      readBody(req)
        .then(body => {
          const given = new URLSearchParams(body).get("pin") ?? "";
          if (PIN_RE.test(given) && safeEqual(given, pin)) {
            failures.delete(ip);
            res.writeHead(302, { Location: "/", "Set-Cookie": pinCookie(pin), ...SEC_HEADERS });
            res.end();
            return;
          }
          registerFailure(ip);
          sendLogin(401, "PIN incorreto.");
        })
        .catch(() => sendLogin(400, "Requisição inválida."));
      return;
    }

    if (!PUBLIC_PATHS.has(url.pathname) && !authorized(req)) {
      if (url.pathname.startsWith("/api/")) {
        res.writeHead(401, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "não autorizado" }));
        return;
      }
      sendLogin(401);
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true, service: "server-box" }));
      return;
    }

    if (url.pathname === "/api/monitor") {
      Promise.resolve()
        .then(() => monitor.get())
        .then(d => ok(d))
        .catch(err => fail(res, err));
      return;
    }

    if (url.pathname === "/api/digest-stats") {
      Promise.resolve()
        .then(() => digestStats.get())
        .then(d => ok(d))
        .catch(err => fail(res, err));
      return;
    }

    // Arquivos: o painel vira também uma gaveta acessível de qualquer lugar
    // (Tailscale + PIN). Upload é o corpo cru da requisição — sem multipart,
    // sem dependência, e o arquivo vai direto para o disco em streaming.
    if (url.pathname === "/api/files" && (req.method === "GET" || req.method === "HEAD")) {
      files.list().then(ok).catch(err => failFile(res, err));
      return;
    }

    if (url.pathname === "/api/files" && req.method === "POST") {
      files
        .save(req, url.searchParams.get("name"))
        .then(file => ok({ file }))
        .catch(err => failFile(res, err));
      return;
    }

    if (url.pathname.startsWith("/api/files/") && req.method === "DELETE") {
      files
        .remove(decodeURIComponent(url.pathname.slice("/api/files/".length)))
        .then(removed => ok(removed))
        .catch(err => failFile(res, err));
      return;
    }

    if (url.pathname.startsWith("/files/") && (req.method === "GET" || req.method === "HEAD")) {
      files
        .open(decodeURIComponent(url.pathname.slice("/files/".length)))
        .then(info => serveFile(req, res, info, url.searchParams.has("download")))
        .catch(err => failFile(res, err));
      return;
    }

    // static (único html: status.html)
    const file = url.pathname === "/" ? "/status.html" : url.pathname;
    const p = join(root, file);
    if (!resolve(p).startsWith(resolve(root))) {
      res.writeHead(403, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "acesso negado" }));
      return;
    }
    readFile(p).then(b => {
      res.writeHead(200, {
        "Content-Type": `${MIME[extname(p)] || "text/plain"}; charset=utf-8`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        ...SEC_HEADERS,
      });
      res.end(b);
    }).catch(() => { res.writeHead(404); res.end("not found"); });
  });

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, () => { server.off("error", rej); res(); });
  });

  const close = () => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });

  return { port: server.address().port, close, pin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
    .then(({ port, pin }) => {
      const ips = bootIps();
      console.log(`server-box ouvindo em http://0.0.0.0:${port}`);
      if (ips.lan) console.log(`  LAN:        http://${ips.lan}:${port}`);
      if (ips.tailscale) console.log(`  Tailscale:  http://${ips.tailscale}:${port}  (qualquer dispositivo, fora de casa)`);
      console.log(`  Arquivos:   ${filesDir()}`);
      if (pin) console.log(`  PIN:        ${pin}  (guardado em .j5-pin; loopback não precisa)`);
      else console.log("  PIN:        desligado (SERVERBOX_PIN=off)");
    })
    .catch(err => { console.error(err); process.exitCode = 1; });
}
