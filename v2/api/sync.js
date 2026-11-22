// Synchronisation FFVB.
//  GET  : tâche quotidienne Vercel (en-tête Authorization: Bearer CRON_SECRET)
//  POST : déclenchement manuel par un administrateur connecté (au plus une fois toutes les 2 minutes)
import { audit, requireRole, safeEqual } from "../lib/auth.js";
import { q, ready } from "../lib/db.js";
import { validClubId, validSeason } from "../lib/ffvb.js";
import { assertSameOrigin, handle, httpError, json, readJson } from "../lib/http.js";
import { syncAll } from "../lib/sync.js";

export default handle(async (req, res) => {
  if (req.method === "GET") {
    const secret = process.env.CRON_SECRET || "";
    const given = String(req.headers.authorization || "");
    if (!secret || !safeEqual(given, `Bearer ${secret}`)) throw httpError(401, "non autorisé");
    return json(res, 200, { results: await syncAll() });
  }

  if (req.method === "POST") {
    assertSameOrigin(req);
    const user = await requireRole(req, "admin");
    const body = await readJson(req);
    const only = {};
    if (body.club !== undefined) { if (!validClubId(body.club)) throw httpError(400, "club invalide"); only.club = body.club; }
    if (body.season !== undefined) { if (!validSeason(body.season)) throw httpError(400, "saison invalide"); only.season = body.season; }
    await ready();
    const [last] = await q("SELECT v FROM kv WHERE k = 'last_manual_sync'");
    if (last && Date.now() - Number(last.v) < 120_000) throw httpError(429, "synchronisation déjà lancée récemment, réessayez dans 2 minutes");
    await q("INSERT INTO kv (k, v) VALUES ('last_manual_sync', $1) ON CONFLICT (k) DO UPDATE SET v = $1", [String(Date.now())]);
    const results = await syncAll(fetch, { only });
    await audit(user.email, "synchronisation", JSON.stringify(results.map(r => `${r.club} ${r.season} ${r.ok ? r.rows : "erreur"}`)));
    return json(res, 200, { results });
  }

  throw httpError(405, "méthode non autorisée");
});
