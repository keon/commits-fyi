#!/usr/bin/env node
// Fetch GitHub rankings (global, by city, by country, trending) and write to data/.
// Usage:
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --all
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --global --trending
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --city "New York"
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --country "United States"

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const COUNTRIES_DIR = join(DATA_DIR, 'countries');
const CITIES_DIR = join(DATA_DIR, 'cities');

const CITIES = [
  'New York', 'San Francisco', 'Seattle', 'Austin', 'Toronto',
  'London', 'Berlin', 'Paris', 'Amsterdam', 'Tel Aviv',
  'Tokyo', 'Seoul', 'Singapore', 'Bangalore', 'Sydney',
];

const COUNTRIES = [
  'United States', 'United Kingdom', 'Germany', 'France', 'Netherlands',
  'China', 'India', 'Japan', 'South Korea', 'Brazil',
  'Canada', 'Australia',
];

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('Set GH_TOKEN or GITHUB_TOKEN.'); process.exit(1); }

const LOC_USERS = 50;
const LOC_ORGS = 30;
const GLOBAL_USERS = 100;
const GLOBAL_ORGS = 50;
const TOP_REPOS = 50;
const TRENDING_REPOS = 50;
const CONCURRENCY = 8;

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function gh(path, { retry = 3 } = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  for (let attempt = 0; attempt < retry; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'commits-fyi-fetcher',
      },
    });
    if (res.status === 403 || res.status === 429) {
      const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
      const waitMs = Math.max(2000, reset - Date.now() + 1000);
      const remaining = res.headers.get('x-ratelimit-remaining');
      console.warn(`Rate-limited (remaining=${remaining}). Waiting ${Math.round(waitMs/1000)}s…`);
      if (waitMs > 15 * 60 * 1000) throw new Error('Rate-limit reset >15min away, aborting.');
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (res.status >= 500 && attempt < retry - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} ${url}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error(`Failed after ${retry} retries: ${url}`);
}

async function pmap(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) {
        console.warn(`item ${idx} failed: ${e.message}`);
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Build a query object with both API + UI URLs (for show-the-query display).
function queryObj(label, apiPath, uiUrl) {
  return {
    label,
    api_url: apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`,
    ui_url: uiUrl,
  };
}

async function searchUsers(qStr, count, { userTypeForUi = 'Users' } = {}) {
  const perPage = Math.min(100, count);
  const out = [];
  const encoded = encodeURIComponent(qStr);
  let page = 1;
  while (out.length < count) {
    const data = await gh(`/search/users?q=${encoded}&sort=followers&order=desc&per_page=${perPage}&page=${page}`);
    if (!data.items?.length) break;
    out.push(...data.items);
    if (data.items.length < perPage) break;
    page++;
  }
  return out.slice(0, count);
}

async function searchRepos(qStr, count, { sort = 'stars' } = {}) {
  const perPage = Math.min(100, count);
  const out = [];
  const encoded = encodeURIComponent(qStr);
  let page = 1;
  while (out.length < count) {
    const data = await gh(`/search/repositories?q=${encoded}&sort=${sort}&order=desc&per_page=${perPage}&page=${page}`);
    if (!data.items?.length) break;
    out.push(...data.items);
    if (data.items.length < perPage) break;
    page++;
  }
  return out.slice(0, count);
}

async function fetchAccountDetails(login) {
  return gh(`/users/${encodeURIComponent(login)}`);
}

async function fetchTopRepos(login) {
  return (await gh(`/users/${encodeURIComponent(login)}/repos?per_page=100&type=owner&sort=updated`)) || [];
}

function compactAccount(a, totalStars) {
  return {
    login: a.login,
    name: a.name || null,
    avatar_url: a.avatar_url,
    html_url: a.html_url,
    followers: a.followers || 0,
    following: a.following || 0,
    public_repos: a.public_repos || 0,
    location: a.location || null,
    bio: a.bio || null,
    company: a.company || null,
    total_stars: totalStars,
  };
}

function compactRepo(r) {
  return {
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description ? r.description.slice(0, 200) : null,
    stargazers_count: r.stargazers_count || 0,
    forks_count: r.forks_count || 0,
    watchers_count: r.watchers_count || 0,
    language: r.language || null,
    owner_login: r.owner?.login,
    owner_avatar_url: r.owner?.avatar_url,
    owner_type: r.owner?.type,
    created_at: r.created_at,
    pushed_at: r.pushed_at,
  };
}

async function hydrateAndRank(searchResults) {
  const hydrated = await pmap(searchResults, CONCURRENCY, async (a) => {
    const d = await fetchAccountDetails(a.login);
    return { ...a, ...d };
  });
  const enriched = await pmap(hydrated.filter(Boolean), CONCURRENCY, async (a) => {
    const repos = await fetchTopRepos(a.login);
    const ownRepos = repos.filter(r => !r.fork);
    const totalStars = ownRepos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
    return { acct: a, repos: ownRepos, totalStars };
  });
  return enriched.filter(Boolean);
}

function aggregateRepos(enriched, limit) {
  const m = new Map();
  for (const { repos } of enriched) {
    for (const r of repos) {
      if (r.fork) continue;
      if (!m.has(r.full_name)) m.set(r.full_name, compactRepo(r));
    }
  }
  return Array.from(m.values())
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, limit);
}

// ----- Builders -----

async function buildLocation(name, kind, outDir) {
  const slug = slugify(name);
  console.log(`\n=== ${kind}: ${name} (${slug}) ===`);
  const userQ = `location:"${name}" type:user`;
  const orgQ  = `location:"${name}" type:org`;

  console.log('Searching users…');
  const userSearch = await searchUsers(userQ, LOC_USERS);
  console.log(`  found ${userSearch.length}`);
  console.log('Searching orgs…');
  const orgSearch = await searchUsers(orgQ, LOC_ORGS);
  console.log(`  found ${orgSearch.length}`);

  console.log(`Hydrating ${userSearch.length + orgSearch.length} accounts + repos…`);
  const enriched = await hydrateAndRank([...userSearch, ...orgSearch]);

  const users = enriched
    .filter(x => x.acct.type === 'User')
    .map(x => compactAccount(x.acct, x.totalStars))
    .sort((a, b) => b.total_stars - a.total_stars);

  const orgs = enriched
    .filter(x => x.acct.type === 'Organization')
    .map(x => compactAccount(x.acct, x.totalStars))
    .sort((a, b) => b.total_stars - a.total_stars);

  const repos = aggregateRepos(enriched, TOP_REPOS);

  const totals = {
    user_followers: users.reduce((s, u) => s + u.followers, 0),
    org_followers: orgs.reduce((s, o) => s + o.followers, 0),
    user_stars: users.reduce((s, u) => s + u.total_stars, 0),
    org_stars: orgs.reduce((s, o) => s + o.total_stars, 0),
  };

  const queries = [
    queryObj(
      `Top ${LOC_USERS} users in ${name}`,
      `/search/users?q=${encodeURIComponent(userQ)}&sort=followers&order=desc&per_page=${LOC_USERS}`,
      `https://github.com/search?q=${encodeURIComponent(userQ)}&type=users&s=followers&o=desc`,
    ),
    queryObj(
      `Top ${LOC_ORGS} orgs in ${name}`,
      `/search/users?q=${encodeURIComponent(orgQ)}&sort=followers&order=desc&per_page=${LOC_ORGS}`,
      `https://github.com/search?q=${encodeURIComponent(orgQ)}&type=users&s=followers&o=desc`,
    ),
    queryObj(
      'Per-account repo list (to sum stars and surface top repos)',
      '/users/{login}/repos?per_page=100&type=owner',
      null,
    ),
  ];

  const payload = {
    kind, name, slug,
    generated_at: new Date().toISOString(),
    counts: { users: users.length, orgs: orgs.length, repos: repos.length },
    totals, queries,
    users, orgs, repos,
  };

  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${slug}.json`);
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outPath}`);
  return { kind, name, slug, generated_at: payload.generated_at, counts: payload.counts };
}

async function buildGlobal() {
  console.log('\n=== global ===');
  const userQ = 'followers:>1000';
  const orgQ = 'followers:>500 type:org';
  const repoQ = 'stars:>1000';

  console.log('Searching top users globally…');
  const userSearch = await searchUsers(userQ, GLOBAL_USERS);
  console.log(`  found ${userSearch.length}`);
  console.log('Searching top orgs globally…');
  const orgSearch = await searchUsers(orgQ, GLOBAL_ORGS);
  console.log(`  found ${orgSearch.length}`);
  console.log('Searching top repos globally…');
  const repoSearch = await searchRepos(repoQ, TOP_REPOS);
  console.log(`  found ${repoSearch.length}`);

  console.log('Hydrating accounts…');
  const enriched = await hydrateAndRank([...userSearch, ...orgSearch]);

  const users = enriched
    .filter(x => x.acct.type === 'User')
    .map(x => compactAccount(x.acct, x.totalStars))
    .sort((a, b) => b.total_stars - a.total_stars);

  const orgs = enriched
    .filter(x => x.acct.type === 'Organization')
    .map(x => compactAccount(x.acct, x.totalStars))
    .sort((a, b) => b.total_stars - a.total_stars);

  const repos = repoSearch.map(compactRepo);

  const totals = {
    user_followers: users.reduce((s, u) => s + u.followers, 0),
    org_followers: orgs.reduce((s, o) => s + o.followers, 0),
    user_stars: users.reduce((s, u) => s + u.total_stars, 0),
    org_stars: orgs.reduce((s, o) => s + o.total_stars, 0),
    top_repo_stars: repos.reduce((s, r) => s + r.stargazers_count, 0),
  };

  const queries = [
    queryObj(`Top ${GLOBAL_USERS} users by followers`,
      `/search/users?q=${encodeURIComponent(userQ)}&sort=followers&order=desc&per_page=${GLOBAL_USERS}`,
      `https://github.com/search?q=${encodeURIComponent(userQ)}&type=users&s=followers&o=desc`),
    queryObj(`Top ${GLOBAL_ORGS} orgs by followers`,
      `/search/users?q=${encodeURIComponent(orgQ)}&sort=followers&order=desc&per_page=${GLOBAL_ORGS}`,
      `https://github.com/search?q=${encodeURIComponent(orgQ)}&type=users&s=followers&o=desc`),
    queryObj(`Top ${TOP_REPOS} repos by stars`,
      `/search/repositories?q=${encodeURIComponent(repoQ)}&sort=stars&order=desc&per_page=${TOP_REPOS}`,
      `https://github.com/search?q=${encodeURIComponent(repoQ)}&type=repositories&s=stars&o=desc`),
    queryObj('Per-account repo list (to sum stars)',
      '/users/{login}/repos?per_page=100&type=owner', null),
  ];

  const payload = {
    kind: 'global', name: 'Global', slug: 'global',
    generated_at: new Date().toISOString(),
    counts: { users: users.length, orgs: orgs.length, repos: repos.length },
    totals, queries,
    users, orgs, repos,
  };

  await writeFile(join(DATA_DIR, 'global.json'), JSON.stringify(payload, null, 2));
  console.log('Wrote data/global.json');
}

async function buildTrending() {
  console.log('\n=== trending (past 24h) ===');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const createdQ = `created:>${since}`;
  const pushedQ  = `pushed:>${since} stars:>100`;

  console.log(`New repos created since ${since}…`);
  const newRepos = await searchRepos(createdQ, TRENDING_REPOS);
  console.log(`  found ${newRepos.length}`);

  console.log(`Active repos pushed since ${since} (>100 stars)…`);
  const activeRepos = await searchRepos(pushedQ, TRENDING_REPOS);
  console.log(`  found ${activeRepos.length}`);

  const payload = {
    kind: 'trending', name: 'Trending', slug: 'trending',
    generated_at: new Date().toISOString(),
    window: { since, until: new Date().toISOString() },
    counts: { new: newRepos.length, active: activeRepos.length },
    queries: [
      queryObj(`Most-starred repos created since ${since}`,
        `/search/repositories?q=${encodeURIComponent(createdQ)}&sort=stars&order=desc&per_page=${TRENDING_REPOS}`,
        `https://github.com/search?q=${encodeURIComponent(createdQ)}&type=repositories&s=stars&o=desc`),
      queryObj(`Most-starred repos pushed since ${since} (stars:>100)`,
        `/search/repositories?q=${encodeURIComponent(pushedQ)}&sort=stars&order=desc&per_page=${TRENDING_REPOS}`,
        `https://github.com/search?q=${encodeURIComponent(pushedQ)}&type=repositories&s=stars&o=desc`),
    ],
    new_repos: newRepos.map(compactRepo),
    active_repos: activeRepos.map(compactRepo),
  };

  await writeFile(join(DATA_DIR, 'trending.json'), JSON.stringify(payload, null, 2));
  console.log('Wrote data/trending.json');
}

async function rebuildIndex() {
  const index = { generated_at: new Date().toISOString(), global: null, trending: null, cities: [], countries: [] };

  const tryRead = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

  const g = await tryRead(join(DATA_DIR, 'global.json'));
  if (g) index.global = { generated_at: g.generated_at, counts: g.counts };

  const t = await tryRead(join(DATA_DIR, 'trending.json'));
  if (t) index.trending = { generated_at: t.generated_at, counts: t.counts, window: t.window };

  for (const city of CITIES) {
    const slug = slugify(city);
    const d = await tryRead(join(CITIES_DIR, `${slug}.json`));
    if (d) index.cities.push({ name: city, slug, generated_at: d.generated_at, counts: d.counts });
  }
  for (const country of COUNTRIES) {
    const slug = slugify(country);
    const d = await tryRead(join(COUNTRIES_DIR, `${slug}.json`));
    if (d) index.countries.push({ name: country, slug, generated_at: d.generated_at, counts: d.counts });
  }

  index.cities.sort((a, b) => a.name.localeCompare(b.name));
  index.countries.sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Wrote data/index.json (${index.cities.length} cities, ${index.countries.length} countries)`);
}

// ----- CLI -----

function parseArgs(argv) {
  const args = { cities: [], countries: [], global: false, trending: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--global') args.global = true;
    else if (a === '--trending') args.trending = true;
    else if (a === '--city') args.cities.push(argv[++i]);
    else if (a === '--country') args.countries.push(argv[++i]);
    else { console.error('Unknown arg:', a); process.exit(2); }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv.length ? argv : ['--all']);

  if (args.all) {
    args.global = true;
    args.trending = true;
    args.cities = CITIES.slice();
    args.countries = COUNTRIES.slice();
  }

  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

  if (args.global)   { try { await buildGlobal(); }   catch (e) { console.error('global FAILED:', e.message); } }
  if (args.trending) { try { await buildTrending(); } catch (e) { console.error('trending FAILED:', e.message); } }

  for (const city of args.cities) {
    try { await buildLocation(city, 'city', CITIES_DIR); }
    catch (e) { console.error(`city ${city} FAILED:`, e.message); }
  }
  for (const country of args.countries) {
    try { await buildLocation(country, 'country', COUNTRIES_DIR); }
    catch (e) { console.error(`country ${country} FAILED:`, e.message); }
  }

  await rebuildIndex();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
