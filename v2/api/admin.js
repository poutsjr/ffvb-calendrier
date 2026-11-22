// Administration des réglages partagés.
//  GET  /api/admin           : configuration complète (éditeur ou admin ; utilisateurs et journal : admin seulement)
//  POST /api/admin {action}  : modifications (éditeur : salles, équipes, Coupe de France ; admin : tout)
import { adminEmails, audit, getUser, normEmail, requireRole, ROLES, validEmail } from "../lib/auth.js";
import { q, ready } from "../lib/db.js";
import { validClubId, validSeason } from "../lib/ffvb.js";
import { assertSameOrigin, handle, httpError, json, readJson } from "../lib/http.js";

const MAX_CLUBS = 6, MAX_VENUES = 20, MAX_ALIASES = 200, MAX_CF = 120, MAX_SEASONS = 8;

const text = (v, max, what) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > max) throw httpError(400, `${what} invalide (1 à ${max} caractères)`);
  return s;
};
const color = v => { if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) throw httpError(400, "couleur invalide (#rrggbb)"); return String(v).toLowerCase(); };
const day = (v, what) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw httpError(400, `${what} invalide (AAAA-MM-JJ)`);
  return v;
};
const clubId = v => { if (!validClubId(v)) throw httpError(400, "n° de club invalide"); return v; };
const arr = (v, max, what) => { if (!Array.isArray(v) || v.length > max) throw httpError(400, `${what} : ${max} éléments maximum`); return v; };

async function view(user) {
  await ready();
  const out = {
    me: { email: user.email, name: user.name, role: user.role },
    clubs: await q("SELECT id, name, short, color, sort, enabled, is_primary AS primary FROM clubs ORDER BY sort, id"),
    venues: await q("SELECT club_id, pattern FROM club_venues ORDER BY club_id, pattern"),
    aliases: await q("SELECT club_id, raw_name, label FROM team_aliases ORDER BY club_id, raw_name"),
    cfRounds: await q("SELECT cat, to_char(day,'YYYY-MM-DD') AS day, to_char(end_day,'YYYY-MM-DD') AS end_day, label, info FROM cf_rounds ORDER BY day, cat"),
    syncSeasons: (await q("SELECT season FROM sync_seasons ORDER BY season")).map(r => r.season),
    sources: await q("SELECT club_id, season, to_char(fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS fetched_at, row_count, status, error FROM sources ORDER BY club_id, season")
  };
  if (user.role === "admin") {
    out.users = await q("SELECT email, name, role, to_char(last_login AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_login FROM users ORDER BY role, email");
    out.envAdmins = [...adminEmails()];
    out.audit = await q("SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS at, email, action, detail FROM audit ORDER BY id DESC LIMIT 60");
  }
  return out;
}

const ACTIONS = {
  // ----- éditeur ou admin -----
  async setVenues(b, user) {
    const id = clubId(b.clubId);
    const patterns = [...new Set(arr(b.patterns, MAX_VENUES, "salles").map(p => text(p, 80, "motif de salle")))];
    await q(`WITH p AS (SELECT jsonb_array_elements_text($2::jsonb) AS pattern),
                  ins AS (INSERT INTO club_venues (club_id, pattern) SELECT $1, pattern FROM p ON CONFLICT DO NOTHING RETURNING 1)
             DELETE FROM club_venues WHERE club_id = $1 AND pattern NOT IN (SELECT pattern FROM p)`,
      [id, JSON.stringify(patterns)]);
    await audit(user.email, "salles", `${id}: ${patterns.join(" | ")}`);
  },
  async setAliases(b, user) {
    const id = clubId(b.clubId);
    const seen = new Map();
    for (const a of arr(b.aliases, MAX_ALIASES, "équipes")) seen.set(text(a && a.raw, 80, "nom d'équipe"), text(a && a.label, 40, "libellé"));
    const rows = [...seen].map(([raw_name, label]) => ({ raw_name, label }));
    await q(`WITH p AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(raw_name text, label text)),
                  ins AS (INSERT INTO team_aliases (club_id, raw_name, label) SELECT $1, raw_name, label FROM p
                          ON CONFLICT (club_id, raw_name) DO UPDATE SET label = EXCLUDED.label RETURNING 1)
             DELETE FROM team_aliases WHERE club_id = $1 AND raw_name NOT IN (SELECT raw_name FROM p)`,
      [id, JSON.stringify(rows)]);
    await audit(user.email, "équipes", `${id}: ${rows.length} correspondance(s)`);
  },
  async setCfRounds(b, user) {
    const rows = arr(b.rounds, MAX_CF, "tours").map(r => {
      const cat = String(r && r.cat);
      if (!/^M(11|13|15|18|21)$/.test(cat)) throw httpError(400, "catégorie invalide (M11, M13, M15, M18, M21)");
      const d = day(r.day, "date"), end = r.end ? day(r.end, "date de fin") : null;
      if (end && end < d) throw httpError(400, "date de fin avant la date de début");
      return { cat, day: d, end_day: end, label: text(r.label, 60, "libellé"), info: !!r.info };
    });
    await q(`WITH del AS (DELETE FROM cf_rounds)
             INSERT INTO cf_rounds (cat, day, end_day, label, info)
             SELECT x.cat, x.day::date, x.end_day::date, x.label, x.info
             FROM jsonb_to_recordset($1::jsonb) AS x(cat text, day text, end_day text, label text, info boolean)`,
      [JSON.stringify(rows)]);
    await audit(user.email, "coupe de france", `${rows.length} date(s)`);
  },

  // ----- admin seulement -----
  async saveClub(b, user) {
    const id = clubId(b.id);
    const res = await q("UPDATE clubs SET name = $2, short = $3, color = $4, sort = $5, enabled = $6 WHERE id = $1 RETURNING id",
      [id, text(b.name, 80, "nom"), text(b.short, 30, "nom court"), color(b.color), Math.trunc(Number(b.sort) || 0), !!b.enabled]);
    if (!res.length) throw httpError(404, "club inconnu");
    await audit(user.email, "club", `${id} ${b.enabled ? "actif" : "inactif"}`);
  },
  async addClub(b, user) {
    const id = clubId(b.id);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM clubs");
    if (n >= MAX_CLUBS) throw httpError(400, `${MAX_CLUBS} clubs au maximum`);
    const res = await q("INSERT INTO clubs (id, name, short, color, sort) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
      [id, text(b.name, 80, "nom"), text(b.short, 30, "nom court"), color(b.color || "#6b7a8a"), n]);
    if (!res.length) throw httpError(409, "ce club existe déjà");
    await audit(user.email, "club ajouté", id);
  },
  async deleteClub(b, user) {
    const id = clubId(b.id);
    const [c] = await q("SELECT is_primary AS p FROM clubs WHERE id = $1", [id]);
    if (!c) throw httpError(404, "club inconnu");
    if (c.p) throw httpError(400, "le club de référence ne peut pas être supprimé");
    await q("DELETE FROM clubs WHERE id = $1", [id]);          // supprime aussi ses matchs et ses salles (ON DELETE CASCADE)
    await audit(user.email, "club supprimé", id);
  },
  async setSyncSeasons(b, user) {
    const seasons = [...new Set(arr(b.seasons, MAX_SEASONS, "saisons"))];
    for (const s of seasons) if (!validSeason(s)) throw httpError(400, `saison invalide : ${s}`);
    await q(`WITH p AS (SELECT jsonb_array_elements_text($1::jsonb) AS season),
                  ins AS (INSERT INTO sync_seasons (season) SELECT season FROM p ON CONFLICT DO NOTHING RETURNING 1)
             DELETE FROM sync_seasons WHERE season NOT IN (SELECT season FROM p)`,
      [JSON.stringify(seasons)]);
    await audit(user.email, "saisons suivies", seasons.join(", "));
  },
  async setUser(b, user) {
    const email = normEmail(b.email);
    if (!validEmail(email)) throw httpError(400, "adresse e-mail invalide");
    if (!ROLES.includes(b.role)) throw httpError(400, "rôle invalide");
    if (adminEmails().has(email) && b.role !== "admin") throw httpError(400, "cet administrateur est défini dans ADMIN_EMAILS (variable d'environnement)");
    if (email === user.email && b.role !== "admin") await assertAnotherAdmin(email);
    await q(`INSERT INTO users (email, role) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET role = $2`, [email, b.role]);
    await audit(user.email, "utilisateur", `${email} → ${b.role}`);
  },
  async deleteUser(b, user) {
    const email = normEmail(b.email);
    if (email === user.email) throw httpError(400, "vous ne pouvez pas supprimer votre propre compte");
    if (adminEmails().has(email)) throw httpError(400, "cet administrateur est défini dans ADMIN_EMAILS");
    await q("DELETE FROM users WHERE email = $1", [email]);
    await audit(user.email, "utilisateur supprimé", email);
  }
};
const ADMIN_ONLY = new Set(["saveClub", "addClub", "deleteClub", "setSyncSeasons", "setUser", "deleteUser"]);

/** Évite de se retirer soi-même le rôle admin s'il n'y en a pas d'autre (ADMIN_EMAILS compte comme admin). */
async function assertAnotherAdmin(self) {
  const others = (await q("SELECT email FROM users WHERE role = 'admin' AND email <> $1", [self])).length
    + [...adminEmails()].filter(e => e !== self).length;
  if (!others) throw httpError(400, "il doit rester au moins un administrateur");
}

export default handle(async (req, res) => {
  if (req.method === "GET") {
    const user = await requireRole(req, "admin", "editor");
    return json(res, 200, await view(user));
  }
  if (req.method === "POST") {
    assertSameOrigin(req);
    const body = await readJson(req);
    const action = String(body.action || "");
    const fn = ACTIONS[action];
    if (!fn) throw httpError(400, "action inconnue");
    const user = await requireRole(req, ...(ADMIN_ONLY.has(action) ? ["admin"] : ["admin", "editor"]));
    await ready();
    await fn(body, user);
    return json(res, 200, { ok: true });
  }
  throw httpError(405, "méthode non autorisée");
});
