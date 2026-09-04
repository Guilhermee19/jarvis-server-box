import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.js";

const publicRoot = fileURLToPath(new URL("../public", import.meta.url));

test("run.sh inicia o servidor a partir da própria pasta", async () => {
  const runScript = await readFile(new URL("../run.sh", import.meta.url), "utf8");
  assert.match(runScript, /cd \"\$\(dirname \"\$0\"\)\"/);
  assert.match(runScript, /exec node server\.js/);
});

test("loopback abre o painel sem pedir PIN", async t => {
  const running = await startServer({ port: 0, root: publicRoot });
  t.after(() => running.close());

  const base = `http://127.0.0.1:${running.port}`;
  const response = await fetch(`${base}/api/monitor`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.j5.device);
  assert.ok(body.j5.bat);
  assert.ok(body.status);
  assert.ok(Array.isArray(body.services));
  assert.ok(body.history_stats);

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /id="deviceLabel"/);
  assert.doesNotMatch(html, /Samsung Galaxy J5 Prime · pocket VPS/);
  assert.match(html, /id="digestTab"[^>]*hidden/);
  assert.match(html, /id="operationHelp"/);
  assert.match(html, /Nenhum cron configurado/);
  assert.match(html, /function setDigestVisibility\(visible\)/);
  assert.doesNotMatch(html, /id="systemDetailsToggle"/);
  assert.match(html, /id="systemDetails"[^>]*aria-label="Detalhes do host"[^>]*>/);
  assert.doesNotMatch(html, /id="systemDetails"[^>]*\bhidden\b/);
  assert.match(html, /id="operationList"/);
  assert.match(html, /id="statusFavicon"/);
  assert.match(html, /function setStatusFavicon\(state\)/);
  assert.match(html, /state === "ok" \? "#30d158"/);
  assert.match(html, /\["warn", "error", "offline"\]/);
  assert.match(html, /setStatusFavicon\(state\)/);
  assert.match(html, /setConnection\("offline", "sem conexão"\)/);
  assert.match(html, /setState\(\$\("connectionStatus"\), state === "offline" \? "offline" : stale \? "warn" : state\)/);
  assert.doesNotMatch(html, /id="cronTitle"/);
  assert.doesNotMatch(html, /id="serviceTitle"/);
});

test("fora do loopback, o PIN protege painel e API", async t => {
  const running = await startServer({ port: 0, root: publicRoot, trustLoopback: false });
  t.after(() => running.close());

  const base = `http://127.0.0.1:${running.port}`;
  assert.match(running.pin, /^\d{4}$/);

  // Sem cookie: a API responde 401 e o painel devolve a tela de PIN.
  const api = await fetch(`${base}/api/monitor`);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).ok, false);

  const gate = await fetch(`${base}/`);
  assert.equal(gate.status, 401);
  assert.match(await gate.text(), /name="pin"/);

  // /health fica aberto de propósito, para watchdog e monitoramento.
  assert.equal((await fetch(`${base}/health`)).status, 200);

  // PIN errado não entra.
  const negado = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin: String((Number(running.pin) + 1) % 10000).padStart(4, "0") }),
  });
  assert.equal(negado.status, 401);

  // PIN certo devolve o cookie, e o cookie abre a API.
  const aceito = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin: running.pin }),
  });
  assert.equal(aceito.status, 302);
  const cookie = aceito.headers.get("set-cookie");
  assert.match(cookie, /j5_pin=\d{4}/);
  assert.match(cookie, /HttpOnly/);

  const autorizado = await fetch(`${base}/api/monitor`, {
    headers: { cookie: cookie.split(";")[0] },
  });
  assert.equal(autorizado.status, 200);
  assert.equal((await autorizado.json()).ok, true);
});

test("PIN desligado por opção mantém tudo aberto", async t => {
  const running = await startServer({ port: 0, root: publicRoot, requirePin: false, trustLoopback: false });
  t.after(() => running.close());

  assert.equal(running.pin, null);
  assert.equal((await fetch(`http://127.0.0.1:${running.port}/api/monitor`)).status, 200);
});
