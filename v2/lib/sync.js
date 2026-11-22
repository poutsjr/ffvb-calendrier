// Synchronisation des matchs FFVB vers la base.
import { q, ready } from "./db.js";
import { currentSeason, fetchExport, matchId, parseExport, validSeason } from "./ffvb.js";

const pause = ms => new Promise(r => setTimeout(r, ms));

/** Saisons à synchroniser : la saison en cours + celles ajoutées par un admin (ex. 2025/2026). */
export async function seasonsToSync() {
  await ready();
  const extra = (await q("SELECT season FROM sync_seasons ORDER BY season")).map(r => r.season).filter(validSeason);
  return [...new Set([currentSeason(), ...extra])];
}

/**
 * Remplace, en une seule instruction atomique, les matchs d'un club pour une saison par ceux de l'export.
 * L'export FFVB est complet pour un club + une saison : un match disparu de l'export disparaît de la base.
 * Si l'export est vide ou illisible, la base n'est PAS modifiée (l'erreur est notée dans « sources »).
 */
export async function syncClubSeason(clubId, season, fetchImpl = fetch) {
  await ready();
  try {
    const records = parseExport(await fetchExport(clubId, season, fetchImpl));
    const rows = records.map(r => ({
      mid: matchId(r), entity: r.entity, code: r.code, jo: r.jo, day: r.date, time: r.time,
      a_id: r.aId, a_name: r.aName, b_id: r.bId, b_name: r.bName,
      set_score: r.set, points: r.score, total: r.total, venue: r.venue
    }));
    // Une seule instruction (donc atomique) : les matchs de l'export sont insérés ou mis à jour, ceux qui n'y sont plus sont supprimés.
    // (Un DELETE + INSERT dans la même instruction ne se voient pas : d'où ce schéma upsert + « NOT IN ».)
    await q(
      `WITH payload AS (
         SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(mid text, entity text, code text, jo text, day text, time text, a_id text, a_name text,
                                                         b_id text, b_name text, set_score text, points text, total text, venue text)
       ), ins AS (
         INSERT INTO matches (club_id, season, mid, entity, code, jo, day, time, a_id, a_name, b_id, b_name, set_score, points, total, venue)
         SELECT $1, $2, mid, entity, code, jo, day::date, time, a_id, a_name, b_id, b_name, set_score, points, total, venue FROM payload
         ON CONFLICT (club_id, season, mid) DO UPDATE SET entity = EXCLUDED.entity, code = EXCLUDED.code, jo = EXCLUDED.jo, day = EXCLUDED.day,
           time = EXCLUDED.time, a_id = EXCLUDED.a_id, a_name = EXCLUDED.a_name, b_id = EXCLUDED.b_id, b_name = EXCLUDED.b_name,
           set_score = EXCLUDED.set_score, points = EXCLUDED.points, total = EXCLUDED.total, venue = EXCLUDED.venue
         RETURNING 1
       )
       DELETE FROM matches WHERE club_id = $1 AND season = $2 AND mid NOT IN (SELECT mid FROM payload)`,
      [clubId, season, JSON.stringify(rows)]
    );
    await q(
      `INSERT INTO sources (club_id, season, fetched_at, row_count, status, error) VALUES ($1,$2, now(), $3, 'ok', NULL)
       ON CONFLICT (club_id, season) DO UPDATE SET fetched_at = now(), row_count = $3, status = 'ok', error = NULL`,
      [clubId, season, rows.length]
    );
    return { club: clubId, season, ok: true, rows: rows.length };
  } catch (err) {
    const msg = String(err && err.message || err).slice(0, 300);
    await q(
      `INSERT INTO sources (club_id, season, row_count, status, error) VALUES ($1,$2, 0, 'error', $3)
       ON CONFLICT (club_id, season) DO UPDATE SET status = 'error', error = $3`,
      [clubId, season, msg]
    );
    return { club: clubId, season, ok: false, error: msg };
  }
}

/** Synchronise tous les clubs actifs pour toutes les saisons à suivre (séquentiel, poli envers la FFVB). */
export async function syncAll(fetchImpl = fetch, { only } = {}) {
  await ready();
  const clubs = (await q("SELECT id FROM clubs WHERE enabled ORDER BY sort, id")).map(r => r.id);
  const seasons = await seasonsToSync();
  const results = [];
  for (const club of clubs) {
    if (only && only.club && only.club !== club) continue;
    for (const season of seasons) {
      if (only && only.season && only.season !== season) continue;
      if (results.length) await pause(600);
      results.push(await syncClubSeason(club, season, fetchImpl));
    }
  }
  return results;
}
