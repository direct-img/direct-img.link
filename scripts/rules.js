// Sets the zone's rules for static images, replacing only the ones it made earlier:
// - URL Rewrite Rules give each image request a static file path under its hostname, named after its ?i= and ?src=
//   (free.direct-img.link/Orange+Cat?i=2 → /free.direct-img.link/orange%2Bcat/i2-), so a promoted image is served
//   without running the worker and the visitor's URL doesn't change. +s become %2B and the params skip = and &, since
//   the static file server redirects to those encodings otherwise.
// - A WAF custom rule logs every image request with its query string (analytics has no query string), which is how
//   scripts/promote.js tells ?i= and ?src= apart. It's a skip that skips nothing: it's kept last in its ruleset.
//   node scripts/rules.js direct-img.link free.direct-img.link ai.direct-img.link
// With no hostnames it removes them. Needs CLOUDFLARE_API_TOKEN with Zone > Transform Rules and Zone WAF edit.
import { MAX_PLUSES } from "../src/_utils/keys.js";

const env = process.env, hosts = process.argv.slice(2), ZONE = env.ZONE || "direct-img.link", TAG = "direct-img fold:";
// Conditions use the raw (original) path, since the WAF rule runs after the rewrites and would see theirs
const PATH = "http.request.uri.path", RAW = "raw.http.request.uri.path", ARG = n => `http.request.uri.args["${n}"][0]`;
const api = (path, init) => fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" } }).then(r => r.json());
// An image request: not the homepage, assets/, robots.txt, probes like /wp-admin/x.php or an already rewritten path
const IMAGE = `http.host in {${hosts.map(h => JSON.stringify(h)).join(" ")}} and ${RAW} ne "/" and not ${RAW} contains "." and not ${RAW} wildcard "/*/*"`;
// Folded only with no params but i and src (others get bad.webp from the worker), and without a literal + (%2B), since
// a static file's %2B stands for a space
const FOLDABLE = `${IMAGE} and (http.request.uri.query eq "" or all(http.request.uri.args.names[*] in {"i" "src"})) and not lower(${RAW}) contains "%2b"`;
const pluses = n => `"${"*+".repeat(n)}*"`;

const rules = {
  // A rule can't see an earlier one's rewrite, and the free plan has no regex_replace and allows one wildcard_replace
  // per rule, so each rule handles an exact number of +s; a query with more always runs the worker. A missing param is
  // empty, so a bare query is i-.
  http_request_transform: hosts.length ? Array.from({ length: MAX_PLUSES + 1 }, (_, n) => ({
    description: `${TAG} query with ${n} +`,
    expression: `${FOLDABLE} and ${n ? `${RAW} wildcard ${pluses(n)}` : `not ${RAW} contains "+"`} and not ${RAW} wildcard ${pluses(n + 1)}`,
    action: "rewrite",
    action_parameters: { uri: { path: { expression: `concat("/", http.host, ${n ? `wildcard_replace(lower(${PATH}), ${pluses(n)}, "${Array.from({ length: n }, (_, k) => `\${${k + 1}}%2B`).join("")}\${${n + 1}}")` : `lower(${PATH})`}, "/i", ${ARG("i")}, "-", ${ARG("src")})` } } },
  })) : [],
  http_request_firewall_custom: hosts.length ? [{
    description: `${TAG} log image requests`,
    expression: IMAGE,
    action: "skip",
    action_parameters: { ruleset: "current" },
    logging: { enabled: true },
  }] : [],
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
