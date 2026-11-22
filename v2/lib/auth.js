// Sessions et rôles. La connexion se fait uniquement via Google (OpenID Connect, flux « code » + PKCE).
// Le cookie de session ne contient que l'adresse e-mail (JWT signé) : le rôle est relu en base à chaque requête,
// donc retirer ou changer un rôle prend effet immédiatement.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { q, ready } from "./db.js";
import { httpError, parseCookies, setCookie } from "./http.js";

export const ROLES = ["admin", "editor", "reader"];
const SESSION_DAYS = 7;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export const normEmail = e => String(e || "").trim().toLowerCase();
export const adminEmails = () => new Set(String(process.env.ADMIN_EMAILS || "").split(",").map(normEmail).filter(Boolean));
export const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(e) && e.length <= 254;

function secretKey() {
  const s = process.env.SESSION_SECRET || "";
  if (s.length < 32) throw new Error("SESSION_SECRET manquant ou trop court (32 caractères minimum)");
  return new TextEncoder().encode(s);
}

export async function createSession(res, email, name) {
  const token = await new SignJWT({ name: name || "" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(email).setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`).sign(secretKey());
  setCookie(res, "session", token, { maxAge: SESSION_DAYS * 86400 });
}
export const clearSession = res => setCookie(res, "session", "", { maxAge: 0 });

/** Utilisateur connecté (ou null) avec son rôle courant. */
export async function getUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  let payload;
  try { payload = (await jwtVerify(token, secretKey(), { algorithms: ["HS256"] })).payload; } catch { return null; }
  const email = normEmail(payload.sub);
  if (!email) return null;
  await ready();
  const [row] = await q("SELECT email, name, role FROM users WHERE email = $1", [email]);
  const isEnvAdmin = adminEmails().has(email);
  if (!row && !isEnvAdmin) return null;                 // compte supprimé : la session ne vaut plus rien
  return { email, name: (row && row.name) || payload.name || "", role: isEnvAdmin ? "admin" : row.role };
}

export async function requireRole(req, ...roles) {
  const user = await getUser(req);
  if (!user) throw httpError(401, "connexion requise");
  if (!roles.includes(user.role)) throw httpError(403, "droits insuffisants");
  return user;
}

export async function audit(email, action, detail = "") {
  await q("INSERT INTO audit (email, action, detail) VALUES ($1,$2,$3)", [email, action, String(detail).slice(0, 500)]);
}

/**
 * Connexion Google : n'est acceptée que pour un compte AUTORISÉ (administrateur déclaré dans ADMIN_EMAILS, ou compte ajouté
 * par un admin). Un compte inconnu est refusé SANS rien enregistrer : aucune adresse de visiteur n'est conservée.
 */
export async function loginAllowed(email, name) {
  await ready();
  const envAdmin = adminEmails().has(email);
  const rows = await q(
    `UPDATE users SET name = COALESCE(NULLIF($2, ''), name), last_login = now(), role = CASE WHEN $3 THEN 'admin' ELSE role END
     WHERE email = $1 RETURNING email`, [email, name || "", envAdmin]);
  if (rows.length) return true;
  if (!envAdmin) return false;
  await q("INSERT INTO users (email, name, role, last_login) VALUES ($1,$2,'admin', now()) ON CONFLICT (email) DO NOTHING", [email, name || ""]);
  return true;
}

/** Création directe d'un compte : réservée à la connexion de TEST locale (jamais utilisée en production). */
export async function upsertUser(email, name) {
  await ready();
  const role = adminEmails().has(email) ? "admin" : "reader";
  await q(
    `INSERT INTO users (email, name, role, last_login) VALUES ($1,$2,$3, now())
     ON CONFLICT (email) DO UPDATE SET name = COALESCE(NULLIF($2, ''), users.name), last_login = now(),
       role = CASE WHEN $3 = 'admin' THEN 'admin' ELSE users.role END`,
    [email, name || "", role]
  );
}

// ---------- Google OpenID Connect ----------
const b64url = buf => Buffer.from(buf).toString("base64url");

export function googleConfig() {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, APP_URL } = process.env;
  if (!id || !secret || !APP_URL) throw httpError(503, "connexion Google non configurée");
  return { id, secret, redirect: `${APP_URL.replace(/\/$/, "")}/api/auth/callback` };
}

/** Redirection interne sûre : chemin relatif uniquement (pas d'URL externe, pas de « // »). */
export const safeNext = n => (typeof n === "string" && /^\/(?!\/)[^\r\n\\]*$/.test(n)) ? n : "/";

export function startGoogle(res, next) {
  const cfg = googleConfig();
  const state = randomBytes(16).toString("hex"), nonce = randomBytes(16).toString("hex");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  setCookie(res, "oauth", JSON.stringify({ state, nonce, verifier, next: safeNext(next) }), { maxAge: 600, path: "/api/auth" });
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: cfg.id, redirect_uri: cfg.redirect, response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account"
  }).toString();
  return url.toString();
}

/** Termine la connexion Google : vérifie l'état, échange le code, contrôle l'id_token. Renvoie {email, name, next}. */
export async function finishGoogle(req, res, query, fetchImpl = fetch) {
  const cfg = googleConfig();
  let saved;
  try { saved = JSON.parse(parseCookies(req).oauth || ""); } catch { saved = null; }
  setCookie(res, "oauth", "", { maxAge: 0, path: "/api/auth" });
  if (!saved || !query.state || !safeEqual(String(query.state), String(saved.state))) throw httpError(400, "état de connexion invalide");
  if (query.error || !query.code) throw httpError(400, "connexion refusée");
  const tokenRes = await fetchImpl(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(query.code), client_id: cfg.id, client_secret: cfg.secret, redirect_uri: cfg.redirect,
      grant_type: "authorization_code", code_verifier: saved.verifier
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!tokenRes.ok) throw httpError(400, "échange du code refusé");
  const { id_token } = await tokenRes.json();
  const { payload } = await jwtVerify(id_token, jwks, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: cfg.id });
  if (payload.nonce !== saved.nonce) throw httpError(400, "nonce invalide");
  if (payload.email_verified !== true || !payload.email) throw httpError(403, "adresse e-mail Google non vérifiée");
  return { email: normEmail(payload.email), name: String(payload.name || ""), next: safeNext(saved.next) };
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export { safeEqual };
