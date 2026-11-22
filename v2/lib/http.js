// Petits utilitaires HTTP communs aux fonctions (compatibles Vercel et serveur local).
export function json(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

export function redirect(res, location, status = 302) {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
}

/** Corps JSON (déjà analysé par Vercel, sinon lu depuis le flux), limité en taille. */
export async function readJson(req, limit = 200_000) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, "corps trop volumineux"); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw httpError(400, "JSON invalide"); }
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const secureCookies = () => !!process.env.VERCEL || String(process.env.APP_URL || "").startsWith("https://");

export function setCookie(res, name, value, { maxAge, path = "/" } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secureCookies()) c += "; Secure";
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, c) : c);
}

/**
 * Protection CSRF des requêtes qui modifient l'état : en-tête personnalisé (impossible à envoyer depuis un autre site
 * sans autorisation CORS) ET, s'il est présent, en-tête Origin identique à notre hôte. Le cookie est en plus SameSite=Lax.
 */
export function assertSameOrigin(req) {
  if (req.headers["x-requested-with"] !== "fetch") throw httpError(403, "requête refusée (en-tête manquant)");
  const origin = req.headers.origin;
  if (origin) {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    let oh = ""; try { oh = new URL(origin).host; } catch { /* ignoré */ }
    if (oh !== host) throw httpError(403, "origine refusée");
  }
}

/** Gestion d'erreur commune : renvoie un JSON propre sans fuite de détails internes. */
export function handle(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      const status = err && err.status || 500;
      if (status >= 500) console.error("[erreur]", err);
      if (!res.headersSent) json(res, status, { error: status >= 500 ? "erreur interne" : err.message });
    }
  };
}
