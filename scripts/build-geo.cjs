#!/usr/bin/env node
// Builds the static geography the Map page fetches. Regenerate with:
//   node scripts/build-geo.cjs
//
// Nothing here depends on data.js — these are reference boundaries and ZIP
// centroids, so the output only changes when the upstream sources do. Rerun it
// when a new market opens in a state that has no counties file yet.
//
// Sources are downloaded rather than vendored:
//   ZIP centroids  US Census 2023 ZCTA Gazetteer (authoritative, current)
//   state/county   public GeoJSON mirrors of Census TIGER
//
// The 2013 "US Zip Codes" gist that the old /va-map used is NOT usable: it
// predates ZIPs like Beaverton 97003 and Bend 97703 and left 15 rows unplaced.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'geo');
const TMP = path.join(OUT, '.src');

const ZCTA_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip';
const STATES_URL = 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';
const COUNTIES_URL = 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';

// Alaska and Hawaii would force an Albers USA composite with insets. No market
// is anywhere near them, so CONUS only keeps the projection to one simple cone.
// Two spellings because the state source names them and the county source FIPS
// them — checking the wrong one silently shipped a 200KB Alaska counties file.
const SKIP_NAMES = new Set(['Alaska', 'Hawaii', 'Puerto Rico']);
const SKIP_ABBR = new Set(['AK', 'HI', 'PR']);

const FIPS = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC',
  '12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY',
  '22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT',
  '31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH',
  '40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT',
  '50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY',
};

function get(url, dest) {
  if (fs.existsSync(dest)) { console.log('  cached', path.basename(dest)); return Promise.resolve(); }
  console.log('  fetching', url.replace(/^https:\/\//, '').slice(0, 70) + '…');
  return new Promise((res, rej) => {
    const go = u => https.get(u, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return go(r.headers.location);
      if (r.statusCode !== 200) return rej(new Error(u + ' → HTTP ' + r.statusCode));
      const f = fs.createWriteStream(dest);
      r.pipe(f);
      f.on('finish', () => f.close(() => res()));
    }).on('error', rej);
    go(url);
  });
}

// Rounding to a fixed precision then dropping repeats is the whole simplifier.
// 3dp is ~110m, far finer than a state-scale render resolves; 2dp (~1.1km) is
// plenty for the national outline.
function simplify(geometry, dp) {
  const rings = [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  polys.forEach(poly => poly.forEach(ring => {
    const out = [];
    ring.forEach(([x, y]) => {
      const p = [+x.toFixed(dp), +y.toFixed(dp)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    });
    if (out.length > 3) rings.push(out);
  }));
  return rings;
}

const kb = s => Math.round(s.length / 1024) + 'KB';

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'counties'), { recursive: true });

  console.log('sources:');
  await get(ZCTA_URL, path.join(TMP, 'zcta.zip'));
  await get(STATES_URL, path.join(TMP, 'us-states.json'));
  await get(COUNTIES_URL, path.join(TMP, 'us-counties.json'));

  // ── ZIP centroids ──────────────────────────────────────────────────────
  const gazTxt = path.join(TMP, '2023_Gaz_zcta_national.txt');
  if (!fs.existsSync(gazTxt)) execFileSync('unzip', ['-o', '-q', path.join(TMP, 'zcta.zip'), '-d', TMP]);
  const zips = {};
  fs.readFileSync(gazTxt, 'utf8').split('\n').slice(1).forEach(line => {
    const c = line.split('\t');
    if (c.length < 7) return;
    const z = c[0].trim(), la = parseFloat(c[5]), ln = parseFloat(c[6]);
    if (z && !isNaN(la) && !isNaN(ln)) zips[z] = [+la.toFixed(4), +ln.toFixed(4)];
  });
  const zipsJson = JSON.stringify(zips);
  fs.writeFileSync(path.join(OUT, 'zips.json'), zipsJson);
  console.log('\ngeo/zips.json         ', Object.keys(zips).length, 'ZCTAs', kb(zipsJson));

  // ── state outlines (national view) ─────────────────────────────────────
  const statesSrc = JSON.parse(fs.readFileSync(path.join(TMP, 'us-states.json'), 'utf8'));
  const states = statesSrc.features
    .filter(f => !SKIP_NAMES.has(f.properties.name))
    .map(f => ({ n: f.properties.name, r: simplify(f.geometry, 2) }))
    .filter(s => s.r.length);
  const statesJson = JSON.stringify(states);
  fs.writeFileSync(path.join(OUT, 'states.json'), statesJson);
  console.log('geo/states.json       ', states.length, 'states', kb(statesJson));

  // ── per-state counties (market view, fetched on demand) ────────────────
  const countiesSrc = JSON.parse(fs.readFileSync(path.join(TMP, 'us-counties.json'), 'utf8'));
  const byState = {};
  countiesSrc.features.forEach(f => {
    const st = FIPS[String(f.id).slice(0, 2)];
    if (!st || SKIP_ABBR.has(st)) return;
    const rings = simplify(f.geometry, 3);
    if (rings.length) (byState[st] = byState[st] || []).push(rings);
  });
  let total = 0;
  Object.entries(byState).forEach(([st, rings]) => {
    const j = JSON.stringify(rings);
    total += j.length;
    fs.writeFileSync(path.join(OUT, 'counties', st + '.json'), j);
  });
  console.log('geo/counties/*.json   ', Object.keys(byState).length, 'files', kb({ length: total }),
              'total · largest', Object.entries(byState)
                .map(([st, r]) => [st, JSON.stringify(r).length])
                .sort((a, b) => b[1] - a[1])[0].join(' '));
  console.log('\nsources cached in geo/.src (gitignored) — delete to re-download');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
