import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, rename, rm, unlink } from "node:fs/promises";
import { join, extname, basename, resolve, sep } from "node:path";
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
 * Reduz um pedaço de caminho a um nome de arquivo simples: sem diretório, sem
 * caractere de controle, sem começar com ponto. Retorna null se não sobrar nada
 * — é assim que "." e ".." morrem antes de virarem travessia de diretório.
 */
export function safeName(raw) {
  // O caminho do Windows (barra invertida) vira caminho comum.
  const flat = String(raw ?? "").replace(/[\u005c]/g, "/");
  const clean = basename(flat)
    .replace(/[\u0000-\u001f\u007f<>:"|?*/]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!clean) return null;
  if (clean.length <= 120) return clean;
  const ext = extname(clean).slice(0, 12);
  return clean.slice(0, 120 - ext.length) + ext;
}

/**
 * Caminho relativo dentro do cofre, sempre com "/" e sempre limpo: cada
 * segmento passa pelo safeName e o que não sobrevive é descartado.
 */
export function safePath(raw) {
  return String(raw ?? "")
    .replace(/[\u005c]/g, "/")
    .split("/")
    .map(safeName)
    .filter(Boolean)
    .slice(0, 12)
    .join("/");
}

/** Pasta que contém o caminho dado, ou null quando já está na raiz. */
export function parentPath(rel) {
  if (!rel) return null;
  const cut = rel.lastIndexOf("/");
  return cut === -1 ? "" : rel.slice(0, cut);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
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
  const root = resolve(dir);

  /**
   * Caminho absoluto para um caminho relativo já higienizado. O resolve final
   * é a última trava: nada pode terminar fora da raiz do cofre.
   */
  const absolute = rel => {
    const clean = safePath(rel);
    const full = clean ? join(root, clean) : root;
    if (resolve(full) !== root && !resolve(full).startsWith(root + sep)) {
      throw fail(400, "caminho inválido");
    }
    return { rel: clean, full };
  };

  async function list(rel) {
    await ready;
    const here = absolute(rel);
    let entries;
    try {
      entries = await readdir(here.full, { withFileTypes: true });
    } catch {
      throw fail(404, "pasta não encontrada");
    }

    const folders = [];
    const files = [];
    for (const entry of entries) {
      // Uploads em andamento gravam .tmp-*; não aparecem até terminar.
      if (entry.name.startsWith(".tmp-")) continue;
      const childRel = here.rel ? `${here.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        let items = 0;
        try {
          items = (await readdir(join(here.full, entry.name))).length;
        } catch {
          // pasta sem permissão de leitura — mostra vazia
        }
        folders.push({ name: entry.name, path: childRel, items });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(join(here.full, entry.name));
        const type = fileType(entry.name);
        files.push({
          name: entry.name,
          path: childRel,
          size: info.size,
          mtime: info.mtimeMs,
          type,
          inline: isInline(type),
        });
      } catch {
        // sumiu entre o readdir e o stat — ignora
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    files.sort((a, b) => b.mtime - a.mtime);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    return {
      dir,
      path: here.rel,
      parent: parentPath(here.rel),
      folders,
      files,
      total,
      count: files.length,
      maxBytes,
    };
  }

  async function mkfolder(rel) {
    await ready;
    const here = absolute(rel);
    if (!here.rel) throw fail(400, "nome de pasta inválido");
    await mkdir(here.full, { recursive: true });
    return { path: here.rel, name: basename(here.rel) };
  }

  /**
   * Grava o corpo da requisição em disco, em streaming: o aparelho tem pouca
   * RAM, então nada de juntar o arquivo inteiro na memória. Escreve num .tmp-*
   * e só renomeia no fim, para uma queda no meio não deixar arquivo pela metade.
   */
  async function save(req, rel, rawName) {
    await ready;
    const wanted = safeName(rawName);
    if (!wanted) throw fail(400, "nome de arquivo inválido");
    const here = absolute(rel);
    await mkdir(here.full, { recursive: true });

    const tmp = join(here.full, `.tmp-${randomUUID()}`);
    const out = createWriteStream(tmp);
    let size = 0;
    let tooBig = false;

    try {
      await new Promise((done, reject) => {
        req.on("data", chunk => {
          size += chunk.length;
          if (size > maxBytes && !tooBig) {
            tooBig = true;
            req.destroy();
            reject(fail(413, "arquivo grande demais"));
          }
        });
        req.on("error", reject);
        out.on("error", reject);
        out.on("finish", done);
        req.pipe(out);
      });
    } catch (err) {
      out.destroy();
      await unlink(tmp).catch(() => {});
      throw err;
    }

    if (!size) {
      await unlink(tmp).catch(() => {});
      throw fail(400, "arquivo vazio");
    }

    const name = await uniqueName(here.full, wanted);
    await rename(tmp, join(here.full, name));
    const type = fileType(name);
    return {
      name,
      path: here.rel ? `${here.rel}/${name}` : name,
      size,
      type,
      inline: isInline(type),
    };
  }

  /** Apaga arquivo ou pasta (com o que houver dentro). A raiz nunca sai. */
  async function remove(rel) {
    await ready;
    const here = absolute(rel);
    if (!here.rel) throw fail(400, "caminho inválido");
    try {
      await stat(here.full);
    } catch {
      throw fail(404, "arquivo não encontrado");
    }
    await rm(here.full, { recursive: true, force: true });
    return { path: here.rel, name: basename(here.rel) };
  }

  /** Metadados + fábrica de stream, para o servidor montar a resposta (Range inclusive). */
  async function open(rel) {
    await ready;
    const here = absolute(rel);
    if (!here.rel) throw fail(400, "caminho inválido");
    let info;
    try {
      info = await stat(here.full);
    } catch {
      throw fail(404, "arquivo não encontrado");
    }
    if (!info.isFile()) throw fail(404, "arquivo não encontrado");
    const name = basename(here.rel);
    const type = fileType(name);
    return {
      name,
      path: here.rel,
      size: info.size,
      mtime: info.mtimeMs,
      type,
      inline: isInline(type),
      stream: range => createReadStream(here.full, range),
    };
  }

  return { dir, maxBytes, list, save, remove, open, mkfolder };
}
