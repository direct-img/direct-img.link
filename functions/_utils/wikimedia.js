export async function wikimediaImageSearch(query, env, ua) {
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: 2,
    generator: "search", gsrsearch: `${query} filetype:bitmap haslicense:unrestricted`, gsrnamespace: 6, gsrlimit: 30,
    prop: "imageinfo", iiprop: "url", iiurlwidth: 1920,
  });
  try {
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "User-Agent": ua } });
    if (!res.ok) return null;
    const pages = (await res.json()).query?.pages || [];
    return pages
      .sort((a, b) => a.index - b.index)
      .map(p => p.imageinfo?.[0])
      .filter(Boolean)
      .map(ii => ii.thumburl || ii.url);
  } catch {
    return null;
  }
}
