// Serveur de développement local : sert public/ et monte les fonctions api/ comme Vercel le ferait.
//   npm run dev            → http://localhost:3000   (base PGlite en mémoire, ou PGLITE_DIR / DATABASE_URL si définis)
// Si votre réseau impose un proxy et que l appel FFVB échoue, essayez avec NODE_USE_ENV_PROXY=1 (Node 24+).
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pub = join(root, "public");

// .env minimal (sans dépendance)
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && m[2] !== "" && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
process.env.APP_URL ||= `http://localhost:${process.env.PORT || 3000}`;
process.env.SESSION_SECRET ||= "dev-secret-dev-secret-dev-secret-dev-secret";   // local uniquement

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const routes = { "/api/data": "data", "/api/sync": "sync", "/api/admin": "admin" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    let file = null;
    if (url.pathname.startsWith("/api/auth/")) { file = "auth"; req.query = { action: url.pathname.slice("/api/auth/".length) }; }
    else if (routes[url.pathname]) { file = routes[url.pathname]; req.query = {}; }
    if (file) {
      for (const [k, v] of url.searchParams) req.query[k] = v;
      const mod = await import(pathToFileURL(join(root, "api", `${file}.js`)).href);
      return await mod.default(req, res);
    }
    // statiques (protégé contre la sortie de public/)
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (p.endsWith(sep) || p === "/") p = join(p, "index.html");
    const full = join(pub, p);
    if (!full.startsWith(pub) || !existsSync(full) || !statSync(full).isFile()) { res.statusCode = 404; return res.end("introuvable"); }
    res.setHeader("Content-Type", MIME[extname(full)] || "application/octet-stream");
    res.end(readFileSync(full));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.statusCode = 500; res.end("erreur interne"); }
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/  (Ctrl+C pour arrêter)`));
