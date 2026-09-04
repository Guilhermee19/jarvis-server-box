import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, rename, unlink } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// 512 MB. O aparelho é um Android com cartão SD; passar disso é pedir para
// encher o disco sem perceber.
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

const TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".opus": "audio/opus",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".log": "text/plain",
  ".csv": "text/plain",
  ".json": "text/plain",
  ".zip": "application/zip",
  ".apk": "application/vnd.android.package-archive",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

// O que o navegador pode abrir na própria aba sem virar vetor de XSS.
// HTML, SVG e afins ficam de fora de propósito: baixam em vez de renderizar.
const INLINE = /^(image\/(?!svg)|video\/|audio\/|text\/plain$|application\/pdf$)/;

/** Tipo MIME pela extensão; desconhecido vira download binário. */
export function fileType(name) {
  return TYPES[extname(String(name)).toLowerCase()] || "application/octet-stream";
}

/** Se o navegador pode abrir inline ou se é melhor baixar. */
export function isInline(type) {
  return INLINE.test(type);
}

/**
 * Reduz o nome enviado a um nome de arquivo simples: sem diretório, sem
 * caractere de controle, sem começar com ponto. Retorna null se não sobrar nada.
 */
export function safeName(raw) {
  // Caminho do Windows vira caminho comum antes do basename.
  const flat = String(raw ?? "").replace(/[\u005c]/g, "/");
  const clean = basename(flat)
    .replace(/[\u0000-\u001f\u007f<>:"|?*/]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!clean || clean === "." || clean === "..") return null;
  if (clean.length <= 120) return clean;
  const ext = extname(clean).slice(0, 12);
  return clean.slice(0, 120 - ext.length) + ext;
}

/** Acrescenta -1, -2… enquanto o nome já existir na pasta. */
async function uniqueName(dir, name) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; i < 1000; i++) {
    try {
      await stat(join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem}-${i}${ext}`;
  }
  return `${stem}-${randomUUID().slice(0, 8)}${ext}`;
}

export function filesDir(dir) {
  return dir ?? process.env.SERVERBOX_FILES_DIR ?? join(homedir(), "server-box-files");
}

export function createFiles(opts = {}) {
  const dir = filesDir(opts.dir);
  const maxBytes =
    opts.maxBytes ?? (Number(process.env.SERVERBOX_MAX_UPLOAD) || DEFAULT_MAX_BYTES);
  const ready = mkdir(dir, { recursive: true }).catch(() => {});

  /** Caminho absoluto de um arquivo já validado, ou null se o nome for inválido. */
  const pathOf = raw => {
    const name = safeName(raw);
    return name ? { name, path: join(dir, name) } : null;
  };

  async function list() {
    await ready;
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      // Uploads em andamento gravam .tmp-*; não aparecem até terminar.
      if (!entry.isFile() || entry.name.startsWith(".tmp-")) continue;
      try {
        const info = await stat(join(dir, entry.name));
        files.push({
          name: entry.name,
          size: info.size,
          mtime: info.mtimeMs,
          type: fileType(entry.name),
          inline: isInline(fileType(entry.name)),
        });
      } catch {
        // sumiu entre o readdir e o stat — ignora
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    return { dir, files, total, count: files.length, maxBytes };
  }

  /**
   * Grava o corpo da requisição em disco, em streaming: o aparelho tem pouca
   * RAM, então nada de juntar o arquivo inteiro na memória. Escreve num .tmp-*
   * e só renomeia no fim, para uma queda no meio não deixar arquivo pela metade.
   */
  async function save(req, rawName) {
    await ready;
    const wanted = safeName(rawName);
    if (!wanted) throw Object.assign(new Error("nome de arquivo inválido"), { status: 400 });

    const tmp = join(dir, `.tmp-${randomUUID()}`);
    const out = createWriteStream(tmp);
    let size = 0;
    let tooBig = false;

    try {
      await new Promise((resolve, reject) => {
        req.on("data", chunk => {
          size += chunk.length;
          if (size > maxBytes && !tooBig) {
            tooBig = true;
            req.destroy();
            reject(Object.assign(new Error("arquivo grande demais"), { status: 413 }));
          }
        });
        req.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        req.pipe(out);
      });
    } catch (err) {
      out.destroy();
      await unlink(tmp).catch(() => {});
      throw err;
    }

    if (!size) {
      await unlink(tmp).catch(() => {});
      throw Object.assign(new Error("arquivo vazio"), { status: 400 });
    }

    const name = await uniqueName(dir, wanted);
    await rename(tmp, join(dir, name));
    return { name, size, type: fileType(name), inline: isInline(fileType(name)) };
  }

  async function remove(rawName) {
    await ready;
    const found = pathOf(rawName);
    if (!found) throw Object.assign(new Error("nome de arquivo inválido"), { status: 400 });
    try {
      await unlink(found.path);
    } catch {
      throw Object.assign(new Error("arquivo não encontrado"), { status: 404 });
    }
    return { name: found.name };
  }

  /** Metadados + fábrica de stream, para o servidor montar a resposta (inclusive Range). */
  async function open(rawName) {
    await ready;
    const found = pathOf(rawName);
    if (!found) throw Object.assign(new Error("nome de arquivo inválido"), { status: 400 });
    let info;
    try {
      info = await stat(found.path);
    } catch {
      throw Object.assign(new Error("arquivo não encontrado"), { status: 404 });
    }
    if (!info.isFile()) throw Object.assign(new Error("arquivo não encontrado"), { status: 404 });
    const type = fileType(found.name);
    return {
      name: found.name,
      size: info.size,
      mtime: info.mtimeMs,
      type,
      inline: isInline(type),
      stream: range => createReadStream(found.path, range),
    };
  }

  return { dir, maxBytes, list, save, remove, open };
}
