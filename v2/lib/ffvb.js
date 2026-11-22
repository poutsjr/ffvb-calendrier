// Récupération et lecture de l'export CSV de la FFVB (ffvbbeach.org).
export const FFVB_EXPORT = "https://www.ffvbbeach.org/ffvbapp/resu/vbspo_calendrier_export_club.php";

/** Saison d'une date AAAA-MM-JJ : de juillet à juin → « 2026/2027 ». */
export function seasonOf(date) {
  const y = +date.slice(0, 4), m = +date.slice(5, 7) - 1;
  const a = m < 6 ? y - 1 : y;
  return `${a}/${a + 1}`;
}
export const currentSeason = (now = new Date()) => seasonOf(now.toISOString().slice(0, 10));

export const validClubId = s => typeof s === "string" && /^[0-9A-Za-z]{4,10}$/.test(s);
export const validSeason = s => {
  if (typeof s !== "string" || !/^\d{4}\/\d{4}$/.test(s)) return false;
  const [a, b] = s.split("/").map(Number);
  return b === a + 1 && a >= 2000 && a <= 2100;
};

/** Identité d'un match : entité + n° de match (la saison s'ajoute au niveau de la source). */
export const matchId = r => r.code ? `${r.entity}|${r.code}` : [r.entity, r.date, r.aId || r.aName, r.bId || r.bName].join("|");

/** Appelle l'export officiel (POST, comme le bouton Excel du site) et renvoie le texte décodé. */
export async function fetchExport(clubId, season, fetchImpl = fetch) {
  if (!validClubId(clubId) || !validSeason(season)) throw new Error("club ou saison invalide");
  const body = new URLSearchParams({ cnclub: clubId, cal_saison: season, typ_edition: "E", type: "RES" });
  const res = await fetchImpl(FFVB_EXPORT, {
    method: "POST", body, redirect: "error",
    headers: { "User-Agent": "ffvb-calendrier" },
    signal: AbortSignal.timeout(25_000)
  });
  if (!res.ok) throw new Error(`FFVB HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 5_000_000) throw new Error("réponse FFVB trop volumineuse");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

function parseRows(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [";", "\t", ","].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}

/** Lit le CSV FFVB. Les colonnes Arb1/Arb2 (noms d'arbitres) sont ignorées. Les doublons d'export sont écartés. */
export function parseExport(text) {
  const rows = parseRows(text);
  if (rows.length < 2) throw new Error("export vide");
  const norm = s => s.normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const h = rows[0].map(norm);
  const cols = { jo: "jo", code: "match", date: "date", time: "heure", aId: "eqano", aName: "eqanom", bId: "eqbno", bName: "eqbnom",
    set: "set", score: "score", total: "total", venue: "salle" };
  const idx = {};
  for (const [k, n] of Object.entries(cols)) idx[k] = h.indexOf(n);
  const missing = ["date", "aId", "aName", "bId", "bName"].filter(k => idx[k] < 0);
  if (missing.length) throw new Error("colonnes introuvables : " + missing.join(", "));
  const g = (r, k) => idx[k] >= 0 ? (r[idx[k]] || "").trim() : "";
  const out = [], seen = new Set();
  for (const r of rows.slice(1)) {
    let date = g(r, "date");
    const fr = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (fr) date = `${fr[3]}-${fr[2]}-${fr[1]}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) continue;
    const tm = g(r, "time").match(/^(\d{1,2}):(\d{2})/);
    let time = tm ? `${String(+tm[1]).padStart(2, "0")}:${tm[2]}` : "";
    if (time === "00:00") time = "";
    const rec = { entity: (r[0] || "").trim(), jo: g(r, "jo"), code: g(r, "code"), date, time,
      aId: g(r, "aId"), aName: g(r, "aName"), bId: g(r, "bId"), bName: g(r, "bName"),
      set: g(r, "set"), score: g(r, "score"), total: g(r, "total"), venue: g(r, "venue") };
    const key = matchId(rec);
    if (seen.has(key)) continue;
    seen.add(key); out.push(rec);
  }
  if (!out.length) throw new Error("aucun match exploitable dans l'export");
  return out;
}
