// Aides de test : faux req/res compatibles avec les fonctions api/.
import { readFileSync } from "node:fs";

export function mockReq({ method = "GET", headers = {}, query = {}, body } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { method, headers: h, query, body };
}

export function mockRes() {
  const headers = {};
  const res = {
    statusCode: 200, headersSent: false, body: "",
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    end(data) { res.body += data || ""; res.headersSent = true; },
    headers
  };
  return res;
}

/** Appelle un gestionnaire et renvoie { status, json, headers, location, cookies }. */
export async function call(handler, opts = {}) {
  const req = mockReq(opts), res = mockRes();
  await handler(req, res);
  let json = null; try { json = res.body ? JSON.parse(res.body) : null; } catch { /* corps non JSON */ }
  const sc = res.headers["set-cookie"];
  const cookies = {};
  for (const c of [].concat(sc || [])) { const [kv] = c.split(";"); const i = kv.indexOf("="); cookies[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); }
  return { status: res.statusCode, json, headers: res.headers, location: res.headers.location, cookies, raw: res };
}

/** Requête d'écriture valide (en-tête anti-CSRF + origine identique) avec le cookie de session donné. */
export const writeOpts = (session, body, extra = {}) => ({
  method: "POST",
  headers: { "x-requested-with": "fetch", host: "app.test", origin: "https://app.test", cookie: session ? `session=${session}` : "", ...(extra.headers || {}) },
  body
});

export const fixtureBytes = () => readFileSync(new URL("./fixtures/harnes_vb_2026.csv", import.meta.url));

/** Faux fetch qui répond à l'export FFVB avec les octets donnés (Windows-1252 comme le vrai site). */
export const fakeFfvb = bytes => async () => new Response(bytes, { status: 200 });
