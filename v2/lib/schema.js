// Schéma de la base et réglages de départ. Tout est idempotent (CREATE IF NOT EXISTS, seed si vide).
//
// Identité d'un match : saison + entité (la poule) + n° de match. Les noms d'arbitres ne sont volontairement PAS stockés.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS clubs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     short TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#067f7a',
     sort INT NOT NULL DEFAULT 0,
     enabled BOOLEAN NOT NULL DEFAULT TRUE,
     is_primary BOOLEAN NOT NULL DEFAULT FALSE
   )`,
  `CREATE TABLE IF NOT EXISTS club_venues (
     club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
     pattern TEXT NOT NULL,
     PRIMARY KEY (club_id, pattern)
   )`,
  `CREATE TABLE IF NOT EXISTS team_aliases (
     club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
     raw_name TEXT NOT NULL,
     label TEXT NOT NULL,
     PRIMARY KEY (club_id, raw_name)
   )`,
  `CREATE TABLE IF NOT EXISTS cf_rounds (
     id SERIAL PRIMARY KEY,
     cat TEXT NOT NULL,
     day DATE NOT NULL,
     end_day DATE,
     label TEXT NOT NULL,
     info BOOLEAN NOT NULL DEFAULT FALSE
   )`,
  `CREATE TABLE IF NOT EXISTS sync_seasons (season TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS matches (
     club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
     season TEXT NOT NULL,
     mid TEXT NOT NULL,
     entity TEXT NOT NULL,
     code TEXT NOT NULL,
     jo TEXT NOT NULL,
     day DATE NOT NULL,
     time TEXT NOT NULL,
     a_id TEXT NOT NULL,
     a_name TEXT NOT NULL,
     b_id TEXT NOT NULL,
     b_name TEXT NOT NULL,
     set_score TEXT NOT NULL,
     points TEXT NOT NULL,
     total TEXT NOT NULL,
     venue TEXT NOT NULL,
     PRIMARY KEY (club_id, season, mid)
   )`,
  `CREATE INDEX IF NOT EXISTS matches_day ON matches (day)`,
  `CREATE TABLE IF NOT EXISTS sources (
     club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
     season TEXT NOT NULL,
     fetched_at TIMESTAMPTZ,
     row_count INT NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending',
     error TEXT,
     PRIMARY KEY (club_id, season)
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY,
     name TEXT,
     role TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('admin', 'editor', 'reader')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_login TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS audit (
     id BIGSERIAL PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT now(),
     email TEXT,
     action TEXT NOT NULL,
     detail TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
];

// Réglages de départ (modifiables ensuite depuis la page d'administration).
const VENUES = ["SALLE RÉGIONALE MARÉCHAL", "BIGOTTE"];   // BIGOTTE : « Salle André Bigotte », « Complexe André Bigotte », « Salle RBigotte »
const CLUBS = [
  { id: "0622126", name: "HARNES VB", short: "Harnes VB", color: "#067f7a", sort: 0, primary: true },
  { id: "0628929", name: "VOLLEY CLUB HARNES", short: "VC Harnes", color: "#e8820c", sort: 1, primary: false }
];
// Tours de Coupe de France (saison 2026-2027) : [catégorie, date, date de fin, libellé, simple échéance]
const CF = [
  ["M18", "2026-09-16", null, "Fin des engagements", true], ["M18", "2026-09-26", null, "1er tour"], ["M18", "2026-10-18", null, "2e tour"],
  ["M18", "2026-11-15", null, "3e tour"], ["M18", "2026-12-13", null, "4e tour"], ["M18", "2027-01-24", null, "5e tour"],
  ["M18", "2027-02-07", null, "6e tour"], ["M18", "2027-03-14", null, "7e tour"], ["M18", "2027-04-11", null, "8e tour"],
  ["M18", "2027-05-02", null, "9e tour"], ["M18", "2027-06-04", "2027-06-06", "Finales"],
  ["M21", "2026-10-18", null, "1er tour"], ["M21", "2026-11-15", null, "2e tour"], ["M21", "2026-12-13", null, "3e tour"],
  ["M21", "2027-01-24", null, "4e tour"], ["M21", "2027-02-07", null, "5e tour"], ["M21", "2027-03-14", null, "6e tour"],
  ["M21", "2027-04-11", null, "7e tour"], ["M21", "2027-05-02", null, "8e tour"], ["M21", "2027-05-28", "2027-05-30", "Finales"],
  ["M15", "2026-10-04", null, "1er tour"], ["M15", "2026-10-25", null, "2e tour"], ["M15", "2026-11-08", null, "3e tour"],
  ["M15", "2026-12-06", null, "4e tour"], ["M15", "2027-01-31", null, "5e tour"], ["M15", "2027-02-21", null, "6e tour"],
  ["M15", "2027-03-07", null, "7e tour"], ["M15", "2027-03-28", null, "8e tour"], ["M15", "2027-05-28", "2027-05-30", "Finales"]
];

export async function seed(q) {
  const [{ n }] = await q("SELECT count(*)::int AS n FROM clubs");
  if (n === 0) {
    for (const c of CLUBS) {
      await q("INSERT INTO clubs (id, name, short, color, sort, is_primary) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [c.id, c.name, c.short, c.color, c.sort, c.primary]);
      for (const v of VENUES) await q("INSERT INTO club_venues (club_id, pattern) VALUES ($1,$2) ON CONFLICT DO NOTHING", [c.id, v]);
    }
  }
  const [{ m }] = await q("SELECT count(*)::int AS m FROM cf_rounds");
  if (m === 0) {
    for (const [cat, day, end, label, info] of CF)
      await q("INSERT INTO cf_rounds (cat, day, end_day, label, info) VALUES ($1,$2,$3,$4,$5)", [cat, day, end, label, !!info]);
  }
}
