// { urls }, or { error } if Bing failed. Bing finds something for nearly any query (even gibberish), so a page without
// results almost always means it's blocking us (e.g. with a CAPTCHA) or changed its page format.
export async function bingImageSearchFallback(query) {
  try {
    // SafeSearch off, like Brave. The cookie is what actually sets it; adlt= alone is ignored.
    const res = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&adlt=off`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cookie": "SRCHHPGUSR=ADLT=OFF"
      }
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const html = await res.text();

    // Bing encodes the image payload inside HTML entity attributes and script tags
    const urls = [...html.matchAll(/&quot;murl&quot;:&quot;(https:[^&"]+)&quot;/g), ...html.matchAll(/"murl":"(https:[^"]+)"/g)]
      .map(m => m[1].replace(/\\\//g, '/'));
    return urls.length ? { urls: [...new Set(urls)] } : { error: `No results in page (${html.length} bytes, ${res.url})` };
  } catch (err) {
    return { error: err.message };
  }
}
