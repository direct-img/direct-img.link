const API = "https://api.openverse.org/v1";
// Uppercase so it can't collide with query cache keys, which are always lowercased
const TOKEN_KEY = "OPENVERSE_TOKEN";

// Tokens expire (~12h); client ID/secret are permanent, so fetch a new token whenever the cached one is gone.
// Production has OPENVERSE_CLIENT_ID/SECRET set, so its requests are authenticated.
async function getToken(env) {
  if (!env.OPENVERSE_CLIENT_ID || !env.OPENVERSE_CLIENT_SECRET) return null;
  const cached = await env.DIRECT_IMG_CACHE.get(TOKEN_KEY);
  if (cached) return cached;
  const res = await fetch(`${API}/auth_tokens/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.OPENVERSE_CLIENT_ID, client_secret: env.OPENVERSE_CLIENT_SECRET }),
  });
  if (!res.ok) return null;
  const { access_token, expires_in } = await res.json();
  await env.DIRECT_IMG_CACHE.put(TOKEN_KEY, access_token, { expirationTtl: Math.max(60, expires_in - 600) });
  return access_token;
}

// { urls } ([] if none found), or { error } if Openverse refused, failed or timed out, so an outage isn't cached as no results
export async function openverseImageSearch(query, env, ua, signal) {
  const url = `${API}/images/?${new URLSearchParams({ q: query, license: "cc0,pdm", extension: "jpg,png,gif,webp", page_size: 20 })}`;
  const search = token => fetch(url, { signal, headers: { "User-Agent": ua, ...(token && { Authorization: `Bearer ${token}` }) } });
  try {
    const token = await getToken(env).catch(() => null);
    let res = await search(token);
    if (res.status === 401 && token) {
      await env.DIRECT_IMG_CACHE.delete(TOKEN_KEY);
      res = await search();
    }
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = await res.json();
    return { urls: data.results?.map(r => r.url).filter(Boolean) || [] };
  } catch (err) {
    return { error: err.message };
  }
}
