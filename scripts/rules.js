// Sets the zone's rules that fold the site and ?i= into the path, so promoted images can be static files (which ignore
// query strings): a URL Rewrite turns /orange+cat into /web/1/orange+cat, and a Redirect sends /orange+cat?i=2 to
// /web/2/orange+cat, which also makes ?i= show up in analytics. Replaces only the rules it made earlier.
//   node scripts/rules.js direct-img.link free.direct-img.link ai.direct-img.link
// With no hostnames it removes them. Needs CLOUDFLARE_API_TOKEN with Zone > Transform Rules and Single Redirect edit.
import { siteOf, folder } from "../src/_utils/keys.js";

const env = process.env, hosts = process.argv.slice(2), ZONE = env.ZONE || "direct-img.link", TAG = "direct-img fold:";
const api = (path, init) => fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" } }).then(r => r.json());
// A bare query: not the homepage, assets/, robots.txt or an already folded path (which a redirect leads to). A literal +
// (%2B) is left to the worker, since a promoted file's + stands for a space.
const FLAT = 'http.request.uri.path ne "/" and not http.request.uri.path contains "." and not http.request.uri.path wildcard "/*/*" and not lower(http.request.uri.path) contains "%2b"';

const bySite = Object.groupBy(hosts, h => folder(siteOf(h)));
const rules = {
  http_request_transform: Object.entries(bySite).map(([f, hs]) => ({
    description: `${TAG} ${f} bare query → /${f}/1/`,
    expression: `http.host in {${hs.map(h => JSON.stringify(h)).join(" ")}} and http.request.uri.query eq "" and ${FLAT}`,
    action: "rewrite",
    action_parameters: { uri: { path: { expression: `concat("/${f}/1", lower(http.request.uri.path))` } } },
  })),
  http_request_dynamic_redirect: Object.entries(bySite).map(([f, hs]) => ({
    description: `${TAG} ${f} ?i= → /${f}/<i>/`,
    expression: `http.host in {${hs.map(h => JSON.stringify(h)).join(" ")}} and http.request.uri.query strict wildcard "i=*" and not http.request.uri.query contains "&" and ${FLAT}`,
    action: "redirect",
    action_parameters: { from_value: { status_code: 302, preserve_query_string: false, target_url: { expression: `concat("https://", http.host, "/${f}/", http.request.uri.args["i"][0], lower(http.request.uri.path))` } } },
  })),
};

const zone = (await api(`/zones?name=${ZONE}`)).result[0].id;
for (const [phase, mine] of Object.entries(rules)) {
  const others = ((await api(`/zones/${zone}/rulesets/phases/${phase}/entrypoint`)).result?.rules || [])
    .filter(r => !r.description?.startsWith(TAG))
    .map(({ id, version, last_updated, ref, ...r }) => r);
  const res = await api(`/zones/${zone}/rulesets/phases/${phase}/entrypoint`, { method: "PUT", body: JSON.stringify({ rules: [...others, ...mine] }) });
  console.log(phase, res.success ? `${mine.length} set, ${others.length} others kept` : JSON.stringify(res.errors));
  if (!res.success) process.exitCode = 1;
}
