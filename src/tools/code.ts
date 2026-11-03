import { readdir, readFile, realpath, stat, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Fault, type Store } from "../store.js";

const MAX_BYTES = 100_000;
const hashContent = (content: string) =>
  createHash("sha256").update(content).digest("hex");
const forbidden = (part: string) =>
  part.startsWith(".") ||
  /^(node_modules|dist|build|coverage|output)$/i.test(part) ||
  /secret|credential/i.test(part);

async function projectFile(root: string, relativePath: string) {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    /[:\0]/.test(relativePath) ||
    relativePath.split(/[\\/]/).some((p) => !p || p === ".." || forbidden(p))
  )
    throw new Fault("Path is not an allowed project file");
  const base = await realpath(root);
  const target = path.resolve(base, relativePath);
  const actual = await realpath(target);
  const compare = (p: string) =>
    process.platform === "win32" ? p.toLowerCase() : p;
  if (
    compare(actual) !== compare(target) ||
    !compare(actual).startsWith(compare(base + path.sep))
  )
    throw new Fault("Symlink or path outside the project");
  const info = await stat(actual);
  if (!info.isFile() || info.size > MAX_BYTES)
    throw new Fault("Only regular files up to 100 KB are supported");
  return actual;
}

export async function listProjectFiles(root: string) {
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= 300) break;
      if (forbidden(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile())
        files.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  }
  await walk(root);
  return files.sort();
}

export async function readProjectFile(
  root: string,
  relativePath: string,
  startLine = 1,
  limit = 60,
) {
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 120
  )
    throw new Fault("Invalid line range");
  const content = await readFile(await projectFile(root, relativePath), "utf8");
  const lines = content.split("\n");
  const selected = lines.slice(startLine - 1, startLine - 1 + limit).join("\n");
  if (selected.length > 12000)
    throw new Fault("Requested lines exceed 12 KB; request fewer lines");
  return {
    path: relativePath,
    hash: hashContent(content),
    startLine,
    endLine: Math.min(lines.length, startLine + limit - 1),
    totalLines: lines.length,
    content: selected,
  };
}

export async function proposeProjectEdit(
  store: Store,
  root: string,
  ownerId: string,
  sessionId: string,
  args: { path: string; old_text: string; new_text: string; hash: string },
) {
  const content = await readFile(await projectFile(root, args.path), "utf8");
  validateReplacement(content, args.hash, args.old_text, args.new_text);
  return store.propose({
    ownerId,
    sessionId,
    path: args.path,
    oldText: args.old_text,
    newText: args.new_text,
    hash: args.hash,
  });
}

function validateReplacement(
  content: string,
  hash: string,
  oldText: string,
  newText: string,
) {
  if (hashContent(content) !== hash)
    throw new Fault("File changed. Read it again and propose a new edit.", 409);
  if (!oldText || content.split(oldText).length !== 2)
    throw new Fault("The old text must match exactly once");
  const next = content.replace(oldText, () => newText);
  if (Buffer.byteLength(next) > MAX_BYTES)
    throw new Fault("Result exceeds 100 KB");
  return next;
}

export async function applyProjectEdit(
  store: Store,
  root: string,
  id: string,
  ownerId: string,
) {
  const edit = await store.edit(id, ownerId);
  if (edit.status !== "pending")
    throw new Fault("This edit was already resolved", 409);
  const token = randomUUID();
  const key = store.key(
    `file-lock:${hashContent(path.resolve(root, edit.path).toLowerCase())}`,
  );
  if (!(await store.redis.set(key, token, { NX: true, PX: 30000 })))
    throw new Fault("Another edit is being applied to this file", 409);
  try {
    const handle = await open(await projectFile(root, edit.path), "r+");
    try {
      const content = await handle.readFile("utf8");
      const next = Buffer.from(
        validateReplacement(content, edit.hash, edit.oldText, edit.newText),
      );
      // Hash and write share one open handle; a replaced path cannot redirect the write.
      let offset = 0;
      while (offset < next.length)
        offset += (
          await handle.write(next, offset, next.length - offset, offset)
        ).bytesWritten;
      await handle.truncate(next.length);
      await handle.sync();
      await store.finishEdit(edit, "applied");
    } finally {
      await handle.close();
    }
  } finally {
    await store.redis.eval(
      'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) end return 0',
      { keys: [key], arguments: [token] },
    );
  }
  return { path: edit.path, status: "applied" };
}
