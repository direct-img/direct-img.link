// { urls } ([] if none found), or { error } if Commons refused, failed or timed out
export async function wikimediaImageSearch(query, env, ua, signal) {
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: 2,
    generator: "search", gsrsearch: `${query} filetype:bitmap haslicense:unrestricted`, gsrnamespace: 6, gsrlimit: 30,
    prop: "imageinfo", iiprop: "url", iiurlwidth: 1920,
  });
  try {
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { signal, headers: { "User-Agent": ua } });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const urls = ((await res.json()).query?.pages || [])
      .sort((a, b) => a.index - b.index)
      .map(p => p.imageinfo?.[0])
      .filter(Boolean)
      .map(ii => ii.thumburl || ii.url);
    return { urls };
  } catch (err) {
    return { error: err.message };
  }
}
