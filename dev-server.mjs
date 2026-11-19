// Local test server (not used on Netlify). Run: ADMIN_PASSWORD=test node dev-server.mjs
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { handle } from "./lib/app.mjs";

const DATA = path.resolve(".devdata");
const fileOf = (k) => path.join(DATA, encodeURIComponent(k));
const store = {
  async get(k, { type } = {}) {
    try { const b = await fs.readFile(fileOf(k)); return type === "json" ? JSON.parse(b) : b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
    catch { return null; }
  },
  async set(k, v) { await fs.mkdir(DATA, { recursive: true }); await fs.writeFile(fileOf(k), Buffer.from(v)); },
  async setJSON(k, v) { await fs.mkdir(DATA, { recursive: true }); await fs.writeFile(fileOf(k), JSON.stringify(v)); },
  async delete(k) { await fs.rm(fileOf(k), { force: true }); },
  async list({ prefix }) {
    await fs.mkdir(DATA, { recursive: true });
    return { blobs: (await fs.readdir(DATA)).map(decodeURIComponent).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  },
};
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:8888");
  // Dev only: convert Word locally with LibreOffice instead of CloudConvert
  if (process.env.DEV_SOFFICE && url.pathname === "/api/convert" && req.method === "POST") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fd = await new Request(url, { method: "POST", headers: req.headers, body: Buffer.concat(chunks), duplex: "half" }).formData();
    const file = fd.get("file");
    const { execFileSync } = await import("node:child_process");
    const dir = await fs.mkdtemp("/tmp/conv-");
    const inPath = path.join(dir, "in.docx");
    await fs.writeFile(inPath, Buffer.from(await file.arrayBuffer()));
    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, inPath]);
    res.writeHead(200, { "content-type": "application/pdf" }); res.end(await fs.readFile(path.join(dir, "in.pdf"))); return;
  }
  if (url.pathname.startsWith("/api")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" }), { store, ip: "127.0.0.1" });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const p = path.join("public", url.pathname === "/" ? "index.html" : url.pathname);
  try { const d = await fs.readFile(p); res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); res.end(d); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(8888, () => console.log("http://localhost:8888"));
