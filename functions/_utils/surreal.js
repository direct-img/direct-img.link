// Uppercase so it can't collide with query cache keys, which are always lowercased
const TOKEN_KEY = "SURREAL_TOKEN";
// SurrealDB re-checks a password against its deliberately slow hash on every request (~47ms), but a token in ~1ms. A
// token lasts 60 min, so it's kept in this isolate's memory and in KV until 10 min before it expires.
let cached = null;

// A token from memory, then KV, then a new /signin (fresh skips memory and KV). null if signing in fails.
async function getToken(env, fresh) {
  if (!fresh && cached?.until > Date.now()) return cached.token;
  let token = !fresh && await env.DIRECT_IMG_CACHE.get(TOKEN_KEY), signedIn = !token;
  if (signedIn) {
    const res = await fetch(`${env.SURREAL_URL}/signin`, {
      method: "POST",
      headers: { "Accept": "application/json" },
      body: JSON.stringify({ user: env.SURREAL_USER, pass: env.SURREAL_PASS }),
    });
    token = res.ok && (await res.json()).token;
    if (!token) return null;
  }
  const ttl = Math.floor(JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp - Date.now() / 1000) - 600;
  if (signedIn && ttl >= 60) await env.DIRECT_IMG_CACHE.put(TOKEN_KEY, token, { expirationTtl: ttl }).catch(() => {});
  cached = ttl > 0 ? { token, until: Date.now() + ttl * 1000 } : null;
  return token;
}

// Runs SurrealQL in direct_img/rate_limit and resolves to the Response, or null if SurrealDB isn't configured. Uses the
// password only if no token can be had, so it still works, just slower.
export function surreal(env) {
  if (!env.SURREAL_URL || !env.SURREAL_USER || !env.SURREAL_PASS) return null;
  const send = (token, body) => fetch(`${env.SURREAL_URL}/sql`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Authorization": token ? `Bearer ${token}` : `Basic ${btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`)}`,
      "surreal-ns": "direct_img",
      "surreal-db": "rate_limit",
    },
    body
  });
  return async body => {
    const token = await getToken(env).catch(() => null), res = await send(token, body);
    // A refused token (expired early or revoked) means the query never ran, so it's safe to retry with a new one
    return res.status === 401 && token ? send(await getToken(env, true).catch(() => null), body) : res;
  };
}
