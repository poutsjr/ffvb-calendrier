import test from "node:test";
import assert from "node:assert/strict";
import { fetchExport, matchId, parseExport, seasonOf, validClubId, validSeason } from "../lib/ffvb.js";
import { fakeFfvb, fixtureBytes } from "./helpers.js";

const decoded = () => new TextDecoder("windows-1252").decode(fixtureBytes());

test("saison : de juillet à juin", () => {
  assert.equal(seasonOf("2026-09-01"), "2026/2027");
  assert.equal(seasonOf("2027-06-30"), "2026/2027");
  assert.equal(seasonOf("2027-07-01"), "2027/2028");
  assert.equal(seasonOf("2026-01-15"), "2025/2026");
});

test("validation des identifiants", () => {
  assert.ok(validClubId("0622126")); assert.ok(validClubId("02A5803"));
  for (const bad of ["", "12", "../etc", "0622126; DROP", "a b c d", null, 5, "x".repeat(11)]) assert.ok(!validClubId(bad), String(bad));
  assert.ok(validSeason("2026/2027"));
  for (const bad of ["2026/2028", "2026-2027", "26/27", "2026/2027x", "1999/2000", null]) assert.ok(!validSeason(bad), String(bad));
});

test("lecture de l'export : 163 matchs, accents corrects, aucun arbitre", () => {
  const recs = parseExport(decoded());
  assert.equal(recs.length, 163);                                   // 165 lignes dans le fichier, 2 doublons d'export
  assert.ok(recs.some(r => r.venue === "SALLE RÉGIONALE MARÉCHAL")); // Windows-1252 décodé
  for (const r of recs) {
    assert.ok(!("ref1" in r) && !("ref2" in r), "les arbitres ne doivent pas être lus");
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.time === "" || /^\d{2}:\d{2}$/.test(r.time));       // 00:00 devient ""
  }
  const ids = new Set(recs.map(matchId));
  assert.equal(ids.size, recs.length, "identité unique : entité + n° de match");
});

test("même n° dans deux entités = deux matchs distincts", () => {
  const csv = "Entité;Jo;Match;Date;Heure;EQA_no;EQA_nom;EQB_no;EQB_nom;Set;Score;Total;Salle;Arb1;Arb2;\n" +
    "LIFL;01;JFO002;2026-09-26;15:00;0628929;A;0595712;B;;;;S1;;;\n" +
    "ACJEUNES;01;JFO002;2026-10-18;00:00;0628929;A;0590024;C;;;;S2;;;\n" +
    "ACJEUNES;01;JFO002;2026-10-18;00:00;0628929;A;0590024;C;;;;S2;;;\n";   // doublon exact
  assert.equal(parseExport(csv).length, 2);
});

test("réponses invalides refusées", () => {
  assert.throws(() => parseExport("<html><body>Erreur</body></html>"), /export|colonnes/);
  assert.throws(() => parseExport(""), /vide/);
  const noRows = "Entité;Jo;Match;Date;Heure;EQA_no;EQA_nom;EQB_no;EQB_nom;Set;Score;Total;Salle;Arb1;Arb2;\n";
  assert.throws(() => parseExport(noRows), /vide|aucun/);
  const badDate = noRows + "AALNV;01;X1;pas-une-date;20:00;1;A;2;B;;;;S;;;\n";
  assert.throws(() => parseExport(badDate), /aucun/);
});

test("fetchExport décode le Windows-1252 et refuse les entrées invalides", async () => {
  const text = await fetchExport("0622126", "2026/2027", fakeFfvb(fixtureBytes()));
  assert.ok(text.includes("MARÉCHAL"));
  await assert.rejects(() => fetchExport("../x", "2026/2027", fakeFfvb(fixtureBytes())), /invalide/);
  await assert.rejects(() => fetchExport("0622126", "2026/2030", fakeFfvb(fixtureBytes())), /invalide/);
  await assert.rejects(() => fetchExport("0622126", "2026/2027", async () => new Response("x", { status: 500 })), /HTTP 500/);
  await assert.rejects(() => fetchExport("0622126", "2026/2027", async () => new Response(new Uint8Array(5_000_001), { status: 200 })), /volumineuse/);
});
