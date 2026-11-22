// Données publiques du calendrier : clubs, réglages, dates réservées et matchs (sans noms d'arbitres).
import { q, ready } from "../lib/db.js";
import { handle, httpError, json } from "../lib/http.js";

export async function buildPayload() {
  await ready();
  const clubs = await q("SELECT id, name, short, color, sort, is_primary AS primary FROM clubs WHERE enabled ORDER BY sort, id");
  const ids = clubs.map(c => c.id);
  const [venues, aliases, cf, sources, matches] = await Promise.all([
    q("SELECT club_id, pattern FROM club_venues ORDER BY club_id, pattern"),
    q("SELECT club_id, raw_name, label FROM team_aliases ORDER BY club_id, raw_name"),
    q("SELECT cat, to_char(day,'YYYY-MM-DD') AS day, to_char(end_day,'YYYY-MM-DD') AS end_day, label, info FROM cf_rounds ORDER BY day, cat"),
    q("SELECT club_id, season, to_char(fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS fetched_at, row_count, status FROM sources ORDER BY club_id, season"),
    q(`SELECT club_id, season, entity, code, jo, to_char(day,'YYYY-MM-DD') AS day, time, a_id, a_name, b_id, b_name,
              set_score, points, total, venue
       FROM matches WHERE club_id = ANY($1::text[]) ORDER BY day, time, code`, [ids])
  ]);
  return {
    clubs: clubs.map(c => ({
      id: c.id, name: c.name, short: c.short, color: c.color, primary: c.primary,
      venues: venues.filter(v => v.club_id === c.id).map(v => v.pattern),
      aliases: Object.fromEntries(aliases.filter(a => a.club_id === c.id).map(a => [a.raw_name, a.label]))
    })),
    cfRounds: cf.map(r => ({ cat: r.cat, day: r.day, end: r.end_day, label: r.label, info: r.info })),
    sources: sources.map(s => ({ club: s.club_id, season: s.season, fetchedAt: s.fetched_at, rows: s.row_count, status: s.status })),
    matches: matches.map(m => ({
      club: m.club_id, season: m.season, entity: m.entity, code: m.code, jo: m.jo, date: m.day, time: m.time,
      aId: m.a_id, aName: m.a_name, bId: m.b_id, bName: m.b_name, set: m.set_score, score: m.points, total: m.total, venue: m.venue
    }))
  };
}

export default handle(async (req, res) => {
  if (req.method !== "GET") throw httpError(405, "méthode non autorisée");
  // Le réseau de diffusion de Vercel garde la réponse 5 minutes (la base n'est interrogée qu'une fois par période) ;
  // les navigateurs, eux, revérifient toujours : ils ne resservent jamais une réponse périmée.
  json(res, 200, await buildPayload(), {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Vercel-CDN-Cache-Control": "max-age=300, stale-while-revalidate=3600"
  });
});
