import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(html, /state === "ok"\s*\?\s*"#[0-9a-f]{6}"/);
  assert.match(html, /\["warn", "error", "offline"\]/);
  assert.match(html, /setStatusFavicon\(state\)/);
  assert.match(html, /setConnection\(\s*"offline",\s*"sem conexão"\s*\)/);
  assert.match(
    html,
    /setState\(\s*\$\("connectionStatus"\),\s*state === "offline"\s*\?\s*"offline"\s*:\s*stale\s*\?\s*"warn"\s*:\s*state,?\s*\)/,
  );
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

test("arquivos: upload, listagem, leitura com Range e remoção", async t => {
  const dir = await mkdtemp(join(tmpdir(), "server-box-files-"));
  const running = await startServer({ port: 0, root: publicRoot, filesDir: dir, maxBytes: 64 });
  t.after(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${running.port}`;

  // Vazia no começo.
  const vazia = await (await fetch(`${base}/api/files`)).json();
  assert.equal(vazia.ok, true);
  assert.deepEqual(vazia.files, []);
  assert.equal(vazia.total, 0);

  // Upload é o corpo cru; o nome vem na query.
  const enviado = await fetch(`${base}/api/files?name=nota.txt`, {
    method: "POST",
    body: "conteudo de teste",
  });
  assert.equal(enviado.status, 200);
  const { file } = await enviado.json();
  assert.equal(file.name, "nota.txt");
  assert.equal(file.size, 17);
  assert.equal(file.inline, true);

  // Mesmo nome não sobrescreve: vira nota-1.txt.
  await fetch(`${base}/api/files?name=nota.txt`, { method: "POST", body: "outro" });
  const lista = await (await fetch(`${base}/api/files`)).json();
  assert.equal(lista.count, 2);
  assert.ok(lista.files.some(f => f.name === "nota-1.txt"));

  // Travessia de caminho vira nome simples.
  const escapou = await fetch(`${base}/api/files?name=${encodeURIComponent("../../fora.txt")}`, {
    method: "POST",
    body: "x",
  });
  assert.equal((await escapou.json()).file.name, "fora.txt");

  // Acima do limite: 413 e nada gravado.
  const grande = await fetch(`${base}/api/files?name=grande.bin`, {
    method: "POST",
    body: "x".repeat(200),
  }).catch(() => ({ status: 413 }));
  assert.equal(grande.status, 413);
  const depois = await (await fetch(`${base}/api/files`)).json();
  assert.ok(!depois.files.some(f => f.name === "grande.bin"));

  // Leitura completa.
  const inteiro = await fetch(`${base}/files/nota.txt`);
  assert.equal(inteiro.status, 200);
  assert.equal(inteiro.headers.get("accept-ranges"), "bytes");
  assert.match(inteiro.headers.get("content-disposition"), /^inline/);
  assert.equal(await inteiro.text(), "conteudo de teste");

  // Range: é o que dá seek em vídeo.
  const parcial = await fetch(`${base}/files/nota.txt`, { headers: { Range: "bytes=0-7" } });
  assert.equal(parcial.status, 206);
  assert.equal(parcial.headers.get("content-range"), "bytes 0-7/17");
  assert.equal(await parcial.text(), "conteudo");

  // ?download força o attachment mesmo em tipo que abriria na aba.
  const baixado = await fetch(`${base}/files/nota.txt?download`);
  assert.match(baixado.headers.get("content-disposition"), /^attachment/);

  assert.equal((await fetch(`${base}/files/nao-existe.txt`)).status, 404);

  const removido = await fetch(`${base}/api/files/nota-1.txt`, { method: "DELETE" });
  assert.equal(removido.status, 200);
  assert.equal((await (await fetch(`${base}/api/files`)).json()).count, 2);
});

test("arquivos ficam atrás do PIN, como o resto do painel", async t => {
  const dir = await mkdtemp(join(tmpdir(), "server-box-files-"));
  const running = await startServer({
    port: 0,
    root: publicRoot,
    filesDir: dir,
    trustLoopback: false,
  });
  t.after(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${running.port}`;

  assert.equal((await fetch(`${base}/api/files`)).status, 401);
  assert.equal((await fetch(`${base}/files/qualquer.txt`)).status, 401);

  const cookie = `j5_pin=${running.pin}`;
  assert.equal((await fetch(`${base}/api/files`, { headers: { cookie } })).status, 200);
});
