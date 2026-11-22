// Accès base de données.
//  - production (Vercel) : Postgres Neon via DATABASE_URL (pilote HTTP, adapté aux fonctions serverless)
//  - développement local sans DATABASE_URL : PGlite (Postgres en WebAssembly, en mémoire ou dans PGLITE_DIR)
import { neon } from "@neondatabase/serverless";
import { SCHEMA, seed } from "./schema.js";

let driver;
let readyPromise;

async function openDriver() {
  if (process.env.DATABASE_URL) {
    const sql = neon(process.env.DATABASE_URL);
    return { query: (text, params = []) => sql.query(text, params) };
  }
  if (process.env.VERCEL) throw new Error("DATABASE_URL manquant : ajoutez la base Neon dans Vercel.");
  const { PGlite } = await import("@electric-sql/pglite");   // dépendance de développement uniquement
  const db = new PGlite(process.env.PGLITE_DIR || undefined);
  return { query: async (text, params = []) => (await db.query(text, params)).rows };
}

/** Exécute une requête paramétrée ($1, $2…) et renvoie les lignes. */
export async function q(text, params = []) {
  driver ||= await openDriver();
  return driver.query(text, params);
}

/** Crée les tables si besoin et injecte les réglages de départ (une seule fois par instance). */
export function ready() {
  readyPromise ||= (async () => {
    for (const stmt of SCHEMA) await q(stmt);
    await seed(q);
  })().catch(err => { readyPromise = undefined; throw err; });
  return readyPromise;
}

/** Pour les tests : repart d'une base vide. */
export function resetForTests() { driver = undefined; readyPromise = undefined; }
