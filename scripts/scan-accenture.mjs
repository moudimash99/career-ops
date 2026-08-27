// scan-accenture.mjs — zero-LLM scan of Accenture France vacancies
// ---------------------------------------------------------------------------
// Accenture runs its own careers platform rather than a standard ATS, so
// scan.mjs cannot reach it. Its search SPA is backed by a public JSON endpoint
// (api/accenture/elastic/findjobs) which returns unusually rich records —
// including yearsOfExperience, mustHaveSkills and the full description — so a
// meaningful first-pass filter is possible without spending a single token.
//
// The endpoint has no reliable city parameter, so we page through the country
// and filter locally.
//
// Usage:
//   node scripts/scan-accenture.mjs                     # Toulouse + Blagnac
//   node scripts/scan-accenture.mjs --cities Lyon,Nantes
//   node scripts/scan-accenture.mjs --all               # no city filter
//   node scripts/scan-accenture.mjs --json
// ---------------------------------------------------------------------------

const API = "https://www.accenture.com/api/accenture/elastic/findjobs";
const PAGE = 100;

const argv = process.argv.slice(2);
const val = (n) => (argv.indexOf(n) > -1 ? argv[argv.indexOf(n) + 1] : null);
const asJson = argv.includes("--json");
const cities = argv.includes("--all")
  ? null
  : (val("--cities") ?? "Toulouse,Blagnac").split(",").map((c) => c.trim().toLowerCase());

async function fetchPage(startIndex) {
  const form = new FormData();
  const fields = {
    startIndex: String(startIndex),
    maxResultSize: String(PAGE),
    jobKeyword: "",
    jobCountry: "France",
    jobLanguage: "fr-fr",
    countrySite: "fr-fr",
    sortBy: "2",
    searchType: "vectorSearch",
    enableQueryBoost: "true",
    minScore: "0.6",
    getFeedbackJudgmentEnabled: "true",
    useCleanEmbedding: "true",
    score: "true",
    totalHits: "true",
    debugQuery: "false",
    jobFilters: "[]",
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);

  const res = await fetch(API, {
    method: "POST",
    body: form,
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const seen = new Map();
let total = null;

for (let start = 0; total === null || start < total; start += PAGE) {
  let page;
  try {
    page = await fetchPage(start);
  } catch (err) {
    console.error(`✗ page at ${start} failed: ${err.message}`);
    break;
  }
  if (total === null) total = page.totalHits?.total ?? page.totalHits ?? 0;
  const rows = page.data ?? [];
  if (!rows.length) break;
  for (const j of rows) seen.set(j.requisitionId ?? j.guid ?? j.jobDetailUrl, j);
  if (!asJson) process.stderr.write(`  fetched ${seen.size}/${total}\r`);
  if (start + PAGE >= 2000) break; // safety stop
}

const inCity = (j) => {
  if (!cities) return true;
  const hay = `${[].concat(j.location ?? []).join(" ")} ${j.feedCity ?? ""}`.toLowerCase();
  return cities.some((c) => hay.includes(c));
};

const matched = [...seen.values()].filter(inCity).map((j) => ({
  requisitionId: j.requisitionId,
  title: j.title,
  location: j.location || j.feedCity,
  careerLevel: j.careerLevel ?? j.careerLevelCd,
  yearsOfExperience: j.yearsOfExperience,
  remoteType: j.remoteType,
  posted: j.postedDateText,
  businessArea: j.businessArea,
  mustHaveSkills: j.mustHaveSkills,
  goodToHaveSkills: j.goodToHaveSkills,
  url: (j.jobDetailUrl ?? "").replace("{0}", "fr-fr"),
  overview: (j.jobOverview ?? j.staticExtractiveSummary ?? "").slice(0, 400),
}));

if (asJson) {
  console.log(JSON.stringify({ scanned: seen.size, total, matched }, null, 2));
} else {
  console.error("");
  console.log(`\nAccenture France: ${seen.size} vacancies scanned` +
    (cities ? ` · ${matched.length} in ${cities.join("/")}` : ""));
  console.log("=".repeat(76));
  for (const m of matched) {
    console.log(`\n${m.title}`);
    console.log(`  ${m.location} · ${m.careerLevel ?? "?"} · ${m.yearsOfExperience ?? "?"} · ${m.remoteType ?? ""}`);
    if (m.mustHaveSkills?.length) console.log(`  must: ${[].concat(m.mustHaveSkills).join(", ").slice(0, 110)}`);
    console.log(`  ${m.url}`);
  }
  console.log("");
}
