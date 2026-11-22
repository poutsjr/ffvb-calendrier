// Connexion Google et session. Routes (via vercel.json) : /api/auth/login, /callback, /logout, /me
import { audit, clearSession, createSession, finishGoogle, getUser, loginAllowed, normEmail, safeNext, startGoogle, upsertUser, validEmail } from "../lib/auth.js";
import { assertSameOrigin, handle, httpError, json, redirect } from "../lib/http.js";
import { q, ready } from "../lib/db.js";

export default handle(async (req, res) => {
  const action = String(req.query && req.query.action || "");

  if (action === "me" && req.method === "GET") {
    const user = await getUser(req);
    return json(res, 200, { user: user ? { email: user.email, name: user.name, role: user.role } : null }, { "Cache-Control": "no-store" });
  }

  if (action === "login" && req.method === "GET") {
    // Connexion de développement : jamais active sur Vercel, ni sans DEV_LOGIN=1 explicite.
    if (process.env.DEV_LOGIN === "1" && !process.env.VERCEL && req.query.dev) {
      const email = normEmail(req.query.dev);
      if (!validEmail(email)) throw httpError(400, "adresse invalide");
      await upsertUser(email, "Compte de test");
      const role = ["admin", "editor", "reader"].includes(req.query.role) ? req.query.role : null;
      if (role) { await ready(); await q("UPDATE users SET role = $2 WHERE email = $1", [email, role]); }
      await createSession(res, email, "Compte de test");
      return redirect(res, safeNext(req.query.next));
    }
    return redirect(res, startGoogle(res, req.query.next));
  }

  if (action === "callback" && req.method === "GET") {
    const { email, name, next } = await finishGoogle(req, res, req.query);
    if (!(await loginAllowed(email, name))) return redirect(res, "/?auth=denied");   // compte non autorisé : ni session, ni trace en base
    await createSession(res, email, name);
    await audit(email, "connexion", "Google");
    return redirect(res, next);
  }

  if (action === "logout" && req.method === "POST") {
    assertSameOrigin(req);
    clearSession(res);
    return json(res, 200, { ok: true });
  }

  throw httpError(404, "route inconnue");
});
