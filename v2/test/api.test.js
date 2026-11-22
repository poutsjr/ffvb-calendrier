// Tests d'intégration : base PGlite en mémoire, aucun appel réseau (FFVB et Google simulés).
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-test-secret";
process.env.ADMIN_EMAILS = "boss@example.org";
process.env.CRON_SECRET = "cron-secret-for-tests";
process.env.DEV_LOGIN = "1";
process.env.APP_URL = "https://app.test";
process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "client-secret";
delete process.env.DATABASE_URL; delete process.env.VERCEL;

import test from "node:test";
import assert from "node:assert/strict";
import { call, fakeFfvb, fixtureBytes, writeOpts } from "./helpers.js";

const { q, ready } = await import("../lib/db.js");
const { syncClubSeason } = await import("../lib/sync.js");
const { createSession, safeNext } = await import("../lib/auth.js");
const { default: data } = await import("../api/data.js");
const { default: auth } = await import("../api/auth.js");
const { default: admin } = await import("../api/admin.js");
const { default: sync } = await import("../api/sync.js");
const { mockRes } = await import("./helpers.js");

/** Cookie de session valide pour un compte (le compte est créé en base s'il n'existe pas). */
async function sessionFor(email, role) {
  await ready();
  if (role) await q("INSERT INTO users (email, role) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET role = $2", [email, role]);
  const res = mockRes();
  await createSession(res, email, "Test");
  return decodeURIComponent(String(res.getHeader("set-cookie")).split(";")[0].split("=").slice(1).join("="));
}
const adminCookie = () => sessionFor("boss@example.org");      // admin via ADMIN_EMAILS (aucune ligne users nécessaire)
const count = async () => (await q("SELECT count(*)::int AS n FROM matches"))[0].n;

test("base : schéma et réglages de départ", async () => {
  await ready();
  const clubs = await q("SELECT id, is_primary FROM clubs ORDER BY sort");
  assert.deepEqual(clubs.map(c => c.id), ["0622126", "0628929"]);
  assert.equal(clubs[0].is_primary, true);
  assert.equal((await q("SELECT count(*)::int AS n FROM cf_rounds"))[0].n, 29);
  assert.deepEqual((await q("SELECT pattern FROM club_venues WHERE club_id = '0622126' ORDER BY pattern")).map(r => r.pattern),
    ["BIGOTTE", "SALLE RÉGIONALE MARÉCHAL"]);
});

test("synchronisation : remplace, ne vide jamais sur une réponse invalide", async () => {
  const bytes = fixtureBytes();
  const r1 = await syncClubSeason("0622126", "2026/2027", fakeFfvb(bytes));
  assert.deepEqual([r1.ok, r1.rows], [true, 163]);
  assert.equal(await count(), 163);

  // Nouvel export plus court : les matchs disparus de l'export disparaissent de la base
  const lines = new TextDecoder("windows-1252").decode(bytes).split("\n");
  const short = new TextEncoder().encode(lines.slice(0, 6).join("\n") + "\n");
  const r2 = await syncClubSeason("0622126", "2026/2027", fakeFfvb(short));
  assert.equal(r2.rows, 5); assert.equal(await count(), 5);

  // Réponse invalide (page d'erreur) : la base reste intacte et l'erreur est notée
  const r3 = await syncClubSeason("0622126", "2026/2027", fakeFfvb(new TextEncoder().encode("<html>maintenance</html>")));
  assert.equal(r3.ok, false); assert.equal(await count(), 5);
  const [src] = await q("SELECT status, error FROM sources WHERE club_id = '0622126' AND season = '2026/2027'");
  assert.equal(src.status, "error"); assert.ok(src.error);

  // Erreur réseau
  const r4 = await syncClubSeason("0622126", "2026/2027", async () => { throw new Error("réseau coupé"); });
  assert.equal(r4.ok, false); assert.equal(await count(), 5);

  // Retour à un export complet
  await syncClubSeason("0622126", "2026/2027", fakeFfvb(bytes));
  assert.equal(await count(), 163);
  const [ok] = await q("SELECT status, row_count FROM sources WHERE club_id = '0622126'");
  assert.deepEqual([ok.status, ok.row_count], ["ok", 163]);
});

test("données publiques : forme, cache, aucun arbitre", async () => {
  const r = await call(data);
  assert.equal(r.status, 200);
  assert.match(r.headers["cache-control"], /max-age=0, must-revalidate/);
  assert.match(r.headers["vercel-cdn-cache-control"], /max-age=300/);
  assert.equal(r.json.clubs.length, 2);
  assert.equal(r.json.matches.length, 163);
  assert.deepEqual(r.json.clubs[0].venues, ["BIGOTTE", "SALLE RÉGIONALE MARÉCHAL"]);
  assert.equal(r.json.cfRounds.length, 29);
  assert.ok(r.json.sources.some(s => s.club === "0622126" && s.status === "ok" && /Z$/.test(s.fetchedAt)));
  assert.ok(!/ref1|ref2|arb/i.test(r.raw.body.replace(/FARBE/gi, "")), "aucun champ arbitre dans la réponse");
  assert.equal((await call(data, { method: "POST" })).status, 405);
});

test("tâche quotidienne : protégée par CRON_SECRET", async () => {
  assert.equal((await call(sync)).status, 401);
  assert.equal((await call(sync, { headers: { authorization: "Bearer mauvais" } })).status, 401);
  assert.equal((await call(sync, { headers: { authorization: "Bearer " } })).status, 401);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFfvb(fixtureBytes());
  try {
    const r = await call(sync, { headers: { authorization: "Bearer cron-secret-for-tests" } });
    assert.equal(r.status, 200);
    assert.ok(r.json.results.length >= 2 && r.json.results.every(x => x.ok));
  } finally { globalThis.fetch = realFetch; }
});

test("synchronisation manuelle : admin seulement, protégée CSRF, limitée en fréquence", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFfvb(fixtureBytes());
  try {
    await q("DELETE FROM kv");
    assert.equal((await call(sync, writeOpts(null, {}))).status, 401);
    const reader = await sessionFor("lecteur@example.org", "reader");
    assert.equal((await call(sync, writeOpts(reader, {}))).status, 403);
    const boss = await adminCookie();
    assert.equal((await call(sync, { method: "POST", headers: { cookie: `session=${boss}` }, body: {} })).status, 403, "sans en-tête anti-CSRF");
    assert.equal((await call(sync, writeOpts(boss, {}, { headers: { origin: "https://evil.test" } }))).status, 403, "origine étrangère");
    assert.equal((await call(sync, writeOpts(boss, { club: "../x" }))).status, 400);
    assert.equal((await call(sync, writeOpts(boss, { season: "2026/2030" }))).status, 400);
    const ok = await call(sync, writeOpts(boss, { club: "0622126" }));
    assert.equal(ok.status, 200);
    assert.equal((await call(sync, writeOpts(boss, {}))).status, 429, "deuxième appel immédiat refusé");
  } finally { globalThis.fetch = realFetch; }
});

test("sessions : connexion de test, révocation, aucune connexion de test sur Vercel", async () => {
  assert.equal((await call(auth, { query: { action: "me" } })).json.user, null);
  const login = await call(auth, { query: { action: "login", dev: "boss@example.org" } });
  assert.equal(login.status, 302);
  assert.ok(login.cookies.session);
  const me = await call(auth, { query: { action: "me" }, headers: { cookie: `session=${login.cookies.session}` } });
  assert.deepEqual([me.json.user.email, me.json.user.role], ["boss@example.org", "admin"]);

  // Cookie falsifié ou signé avec un autre secret
  assert.equal((await call(auth, { query: { action: "me" }, headers: { cookie: "session=abc.def.ghi" } })).json.user, null);

  // Compte supprimé : la session ne vaut plus rien
  const tmp = await sessionFor("temp@example.org", "reader");
  assert.equal((await call(auth, { query: { action: "me" }, headers: { cookie: `session=${tmp}` } })).json.user.role, "reader");
  await q("DELETE FROM users WHERE email = 'temp@example.org'");
  assert.equal((await call(auth, { query: { action: "me" }, headers: { cookie: `session=${tmp}` } })).json.user, null);

  // Sur Vercel, ?dev=… ne doit JAMAIS ouvrir de session : on est redirigé vers Google
  process.env.VERCEL = "1";
  try {
    const r = await call(auth, { query: { action: "login", dev: "boss@example.org" } });
    assert.ok(!r.cookies.session);
    assert.match(r.location, /^https:\/\/accounts\.google\.com\//);
  } finally { delete process.env.VERCEL; }
});

test("Google : paramètres de la redirection et refus d'un état invalide", async () => {
  const r = await call(auth, { query: { action: "login" } });
  assert.equal(r.status, 302);
  const u = new URL(r.location);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.test/api/auth/callback");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("scope"), "openid email profile");
  assert.ok(u.searchParams.get("state") && u.searchParams.get("nonce"));
  assert.ok(r.cookies.oauth);
  assert.match(String(r.raw.getHeader("set-cookie")), /HttpOnly/);

  const state = u.searchParams.get("state");
  const cb = q => call(auth, { query: { action: "callback", ...q }, headers: { cookie: `oauth=${encodeURIComponent(r.cookies.oauth)}` } });
  assert.equal((await cb({ state: "autre", code: "x" })).status, 400);
  assert.equal((await cb({ state, error: "access_denied" })).status, 400);
  assert.equal((await call(auth, { query: { action: "callback", state, code: "x" } })).status, 400, "sans cookie d'état");
});

test("connexion : seuls les comptes autorisés entrent, un inconnu ne laisse aucune trace", async () => {
  const { loginAllowed } = await import("../lib/auth.js");
  await ready();
  const rows = async e => (await q("SELECT email, role FROM users WHERE email = $1", [e]));
  assert.equal(await loginAllowed("inconnu@example.org", "Visiteur"), false);
  assert.equal((await rows("inconnu@example.org")).length, 0, "aucune adresse de visiteur n'est conservée");
  await q("INSERT INTO users (email, role) VALUES ('autorise@example.org', 'editor') ON CONFLICT DO NOTHING");
  assert.equal(await loginAllowed("autorise@example.org", "Autorisé"), true);
  assert.equal((await rows("autorise@example.org"))[0].role, "editor", "le rôle attribué n'est pas modifié par la connexion");
  await q("DELETE FROM users WHERE email = 'boss@example.org'");
  assert.equal(await loginAllowed("boss@example.org", "Boss"), true);
  assert.equal((await rows("boss@example.org"))[0].role, "admin", "ADMIN_EMAILS : toujours admin");
  await q("UPDATE users SET role = 'reader' WHERE email = 'boss@example.org'");
  assert.equal(await loginAllowed("boss@example.org", ""), true);
  assert.equal((await rows("boss@example.org"))[0].role, "admin", "rétabli admin à la connexion");
});

test("redirection après connexion : chemins relatifs uniquement", () => {
  for (const ok of ["/", "/admin.html", "/admin.html?x=1"]) assert.equal(safeNext(ok), ok);
  for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "javascript:alert(1)", "/a\r\nSet-Cookie: x=1", undefined, 5])
    assert.equal(safeNext(bad), "/", String(bad));
});

test("administration : droits par rôle", async () => {
  const boss = await adminCookie();
  const editor = await sessionFor("editeur@example.org", "editor");
  const reader = await sessionFor("lecteur2@example.org", "reader");

  assert.equal((await call(admin)).status, 401);
  assert.equal((await call(admin, { headers: { cookie: `session=${reader}` } })).status, 403);

  const ev = await call(admin, { headers: { cookie: `session=${editor}` } });
  assert.equal(ev.status, 200);
  assert.ok(!("users" in ev.json) && !("audit" in ev.json), "l'éditeur ne voit ni les utilisateurs ni le journal");

  const av = await call(admin, { headers: { cookie: `session=${boss}` } });
  assert.ok(av.json.users.length >= 1 && Array.isArray(av.json.audit));
  assert.deepEqual(av.json.envAdmins, ["boss@example.org"]);

  // Éditeur : salles OK, gestion des clubs / utilisateurs refusée
  assert.equal((await call(admin, writeOpts(editor, { action: "setVenues", clubId: "0622126", patterns: ["SALLE RÉGIONALE MARÉCHAL", "BIGOTTE", "SALLE DU COLLÈGE (HARNES)"] }))).status, 200);
  assert.equal((await call(admin, writeOpts(editor, { action: "setUser", email: "x@example.org", role: "admin" }))).status, 403);
  assert.equal((await call(admin, writeOpts(editor, { action: "deleteClub", id: "0628929" }))).status, 403);
  assert.equal((await call(admin, writeOpts(reader, { action: "setVenues", clubId: "0622126", patterns: [] }))).status, 403);
  assert.equal((await call(admin, writeOpts(null, { action: "setVenues", clubId: "0622126", patterns: [] }))).status, 401);

  const pub = (await call(data)).json;
  assert.deepEqual(pub.clubs[0].venues, ["BIGOTTE", "SALLE DU COLLÈGE (HARNES)", "SALLE RÉGIONALE MARÉCHAL"], "les salles déjà présentes sont conservées");
  // Enregistrer deux fois la même liste ne perd rien et ne plante pas ; une liste plus courte retire ce qui n'y est plus
  const same = { action: "setVenues", clubId: "0622126", patterns: ["SALLE RÉGIONALE MARÉCHAL", "BIGOTTE"] };
  assert.equal((await call(admin, writeOpts(editor, same))).status, 200);
  assert.equal((await call(admin, writeOpts(editor, same))).status, 200);
  assert.deepEqual((await call(data)).json.clubs[0].venues, ["BIGOTTE", "SALLE RÉGIONALE MARÉCHAL"]);
  assert.equal((await call(admin, writeOpts(editor, { action: "setVenues", clubId: "0622126", patterns: [] }))).status, 200);
  assert.deepEqual((await call(data)).json.clubs[0].venues, []);
  assert.equal((await call(admin, writeOpts(editor, same))).status, 200);
  // Équipes : mise à jour d'un libellé existant + suppression des autres
  const al = a => call(admin, writeOpts(editor, { action: "setAliases", clubId: "0622126", aliases: a }));
  assert.equal((await al([{ raw: "HARNES X", label: "Équipe 1" }, { raw: "HARNES Y", label: "Équipe 2" }])).status, 200);
  assert.equal((await al([{ raw: "HARNES X", label: "Équipe 5" }])).status, 200);
  assert.deepEqual((await call(data)).json.clubs[0].aliases, { "HARNES X": "Équipe 5" });
});

test("administration : protection CSRF et validation des entrées", async () => {
  const boss = await adminCookie();
  const post = body => call(admin, writeOpts(boss, body));
  assert.equal((await call(admin, { method: "POST", headers: { cookie: `session=${boss}` }, body: { action: "setVenues" } })).status, 403);
  assert.equal((await call(admin, writeOpts(boss, { action: "setVenues" }, { headers: { origin: "https://evil.test" } }))).status, 403);
  assert.equal((await post({ action: "inconnue" })).status, 400);
  assert.equal((await post({ action: "setVenues", clubId: "0622126; DROP TABLE clubs", patterns: [] })).status, 400);
  assert.equal((await post({ action: "setVenues", clubId: "0622126", patterns: Array.from({ length: 21 }, (_, i) => "S" + i) })).status, 400);
  assert.equal((await post({ action: "setVenues", clubId: "0622126", patterns: ["x".repeat(81)] })).status, 400);
  assert.equal((await post({ action: "setCfRounds", rounds: [{ cat: "M99", day: "2026-10-18", label: "x" }] })).status, 400);
  assert.equal((await post({ action: "setCfRounds", rounds: [{ cat: "M18", day: "2026-13-45", label: "x" }] })).status, 400);
  assert.equal((await post({ action: "setCfRounds", rounds: [{ cat: "M18", day: "2026-10-18", end: "2026-10-01", label: "x" }] })).status, 400);
  assert.equal((await post({ action: "addClub", id: "../x", name: "A", short: "A" })).status, 400);
  assert.equal((await post({ action: "addClub", id: "0622126", name: "A", short: "A" })).status, 409);
  assert.equal((await post({ action: "saveClub", id: "0622126", name: "HARNES VB", short: "Harnes VB", color: "rouge", sort: 0, enabled: true })).status, 400);
  assert.equal((await post({ action: "deleteClub", id: "0622126" })).status, 400, "le club de référence est protégé");
  assert.equal((await post({ action: "setSyncSeasons", seasons: ["2025/2026", "2026/2030"] })).status, 400);

  // Une chaîne piégée est stockée telle quelle (requêtes paramétrées) et relue à l'identique
  const trap = "'); DROP TABLE matches; --";
  assert.equal((await post({ action: "setAliases", clubId: "0622126", aliases: [{ raw: trap, label: "Équipe 1" }] })).status, 200);
  assert.equal((await q("SELECT count(*)::int AS n FROM matches"))[0].n > 0, true);
  assert.equal((await q("SELECT raw_name FROM team_aliases WHERE club_id = '0622126'"))[0].raw_name, trap);

  // Dates de Coupe de France : remplacement complet et relecture
  assert.equal((await post({ action: "setCfRounds", rounds: [{ cat: "M18", day: "2026-10-18", label: "2e tour" }, { cat: "M21", day: "2027-05-28", end: "2027-05-30", label: "Finales" }] })).status, 200);
  assert.equal((await call(data)).json.cfRounds.length, 2);
  assert.equal((await post({ action: "setSyncSeasons", seasons: ["2025/2026"] })).status, 200);
});

test("administration : gestion des comptes sans se verrouiller", async () => {
  const boss = await adminCookie();
  const post = (cookie, body) => call(admin, writeOpts(cookie, body));
  assert.equal((await post(boss, { action: "setUser", email: "second@example.org", role: "admin" })).status, 200);
  assert.equal((await post(boss, { action: "setUser", email: "pas-un-mail", role: "admin" })).status, 400);
  assert.equal((await post(boss, { action: "setUser", email: "x@example.org", role: "superuser" })).status, 400);
  // Un admin défini par ADMIN_EMAILS ne peut être ni rétrogradé ni supprimé
  assert.equal((await post(boss, { action: "setUser", email: "boss@example.org", role: "reader" })).status, 400);
  assert.equal((await post(boss, { action: "deleteUser", email: "boss@example.org" })).status, 400);
  // On ne supprime pas son propre compte
  const second = await sessionFor("second@example.org");
  assert.equal((await post(second, { action: "deleteUser", email: "second@example.org" })).status, 400);
  // Un admin peut se rétrograder tant qu'un autre admin existe (ici : boss, via ADMIN_EMAILS)
  assert.equal((await post(second, { action: "setUser", email: "second@example.org", role: "editor" })).status, 200);
  // Révocation immédiate : le compte supprimé perd l'accès
  assert.equal((await post(boss, { action: "deleteUser", email: "second@example.org" })).status, 200);
  assert.equal((await call(admin, { headers: { cookie: `session=${second}` } })).status, 401);
  // Journal tenu
  const av = await call(admin, { headers: { cookie: `session=${boss}` } });
  assert.ok(av.json.audit.some(a => a.action === "utilisateur" && a.email === "boss@example.org"));
});
