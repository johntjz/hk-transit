// ============================================================================
// File: hardcode.js (johntjz/Hk-Fleet — Normalization, Geo, Road/BBI & Traffic Corridor Engine)
// ============================================================================

var _hcTransitDataMod = null;
var _hcFareLoadMod = null;
if (typeof MTR_STATION_DIRECTORY === 'undefined' && typeof require === 'function') {
  try {
    _hcTransitDataMod = require('./transit-data.js');
    if (_hcTransitDataMod && typeof globalThis !== 'undefined') Object.assign(globalThis, _hcTransitDataMod);
  } catch (e) {}
}

// ============================================================================
// SHARED NORMALIZATION, LRT RESOLVER & FERRY KEY HELPERS (Zero Drift)
// ============================================================================

function normName(s, stripPierSuffix = true) {
  let out = String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .toLowerCase()
    .replace(/\s*[\(（][^\)）]*[\)）]\s*/g, ' ')
    .replace(/\s+at\s+.*$/i, '')
    .split(',')[0]
    .replace(/\bcentral\s*(?:ferry\s*)?pier\s*(?:no\.?\s*)?\d+\b/gi, 'central')
    .replace(/\b(bus terminus|public transport interchange|pti|bbi|mtr station|light rail stop|light rail|mtr|railway station|train station|station|stop|halt)\b/gi, '')
    .replace(/(巴士總站|公共運輸交匯處|轉車站|港鐵站|輕鐵站|鐵路站|輕鐵|港鐵|車站|站)/g, '');
  if (stripPierSuffix) {
    out = out
      .replace(/\b(ferry pier|public pier|ferry terminal|promenade landing steps|landing steps|new development ferry pier|pier\s*no\.?\s*\d+|pier)\b/gi, '')
      .replace(/(新發展碼頭|海濱長廊登岸梯級|渡輪碼頭|公眾碼頭|客運碼頭|登岸梯級|碼頭|[一二三四五六七八九十\d]+號碼頭)/g, '');
  }
  return out.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

const normKey = normName;

function _haversineKm(lat1, lon1, lat2, lon2) {
  const n1 = Number(lat1), m1 = Number(lon1), n2 = Number(lat2), m2 = Number(lon2);
  if (!Number.isFinite(n1) || !Number.isFinite(m1) || !Number.isFinite(n2) || !Number.isFinite(m2)) return 999;
  const R = 6371;
  const dLat = (n2 - n1) * Math.PI / 180;
  const dLon = (m2 - m1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(n1 * Math.PI / 180) * Math.cos(n2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(Math.max(0, a)), Math.sqrt(Math.max(0, 1 - a)));
}

const _hcLrtDir = (typeof LRT_STATION_DIRECTORY !== 'undefined' && LRT_STATION_DIRECTORY) ? LRT_STATION_DIRECTORY : ((typeof window !== 'undefined' && window.LRT_STATION_DIRECTORY) || {});
const LRT_ID_BY_NORM_NAME = new Map();
for (const [id, info] of Object.entries(_hcLrtDir)) {
  const cleanEn = info.en.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanTc = info.tc.replace(/[^\u4e00-\u9fa50-9]/g, '');
  if (cleanEn) LRT_ID_BY_NORM_NAME.set(cleanEn, id);
  if (cleanTc) LRT_ID_BY_NORM_NAME.set(cleanTc, id);
  if (info.code) LRT_ID_BY_NORM_NAME.set(info.code.toLowerCase(), id);
  LRT_ID_BY_NORM_NAME.set(normName(info.en, false), id);
  LRT_ID_BY_NORM_NAME.set(normName(info.tc, false), id);
  if (info.altEn) {
    LRT_ID_BY_NORM_NAME.set(info.altEn.toLowerCase().replace(/[^a-z0-9]/g, ''), id);
    LRT_ID_BY_NORM_NAME.set(normName(info.altEn, false), id);
  }
  if (info.altTc) {
    LRT_ID_BY_NORM_NAME.set(info.altTc.replace(/[^\u4e00-\u9fa50-9]/g, ''), id);
    LRT_ID_BY_NORM_NAME.set(normName(info.altTc, false), id);
  }
}

const _hcMtrDir = (typeof MTR_STATION_DIRECTORY !== 'undefined' && MTR_STATION_DIRECTORY) ? MTR_STATION_DIRECTORY : ((typeof window !== 'undefined' && window.MTR_STATION_DIRECTORY) || {});
const MTR_CODE_BY_NORM_NAME = new Map();
for (const [code, info] of Object.entries(_hcMtrDir)) {
  MTR_CODE_BY_NORM_NAME.set(code.toLowerCase(), code);
  MTR_CODE_BY_NORM_NAME.set(normName(info.en, false), code);
  MTR_CODE_BY_NORM_NAME.set(normName(info.tc, false), code);
  MTR_CODE_BY_NORM_NAME.set(info.en.toLowerCase().replace(/[^a-z0-9]/g, ''), code);
  MTR_CODE_BY_NORM_NAME.set(info.tc.replace(/[^\u4e00-\u9fa50-9]/g, ''), code);
}
[
  ['hongkonguniversity', 'HKU'], ['universityofhongkong', 'HKU'],
  ['asiaworldexpo', 'AWE'], ['lohaspark', 'LHP'],
  ['mongkok', 'MOK'], ['mongkokeast', 'MKK'],
  ['tsimshatsui', 'TST'], ['easttsimshatsui', 'ETS'],
  ['disneyland', 'DIS'], ['exhibition', 'EXC']
].forEach(([alias, code]) => { if (!MTR_CODE_BY_NORM_NAME.has(alias)) MTR_CODE_BY_NORM_NAME.set(alias, code); });

function resolveMtrStationCode(rawCodeOrName) {
  const s = String(rawCodeOrName || '').trim();
  if (!s) return '';
  const up = s.toUpperCase();
  const mtrDir = (typeof MTR_STATION_DIRECTORY !== 'undefined' && MTR_STATION_DIRECTORY) ? MTR_STATION_DIRECTORY : _hcMtrDir;
  if (mtrDir[up]) return up;
  const cleaned = normName(s, false);
  if (cleaned && MTR_CODE_BY_NORM_NAME.has(cleaned)) return MTR_CODE_BY_NORM_NAME.get(cleaned);
  const alnum = s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  if (alnum && MTR_CODE_BY_NORM_NAME.has(alnum)) return MTR_CODE_BY_NORM_NAME.get(alnum);
  return '';
}

function resolveLrtNumericId(code, nameEn = '', nameTc = '') {
  const numStr = String(parseInt(String(code || '').replace(/\D/g, ''), 10) || '');
  const lrtDir = (typeof LRT_STATION_DIRECTORY !== 'undefined' && LRT_STATION_DIRECTORY) ? LRT_STATION_DIRECTORY : _hcLrtDir;
  if (numStr && lrtDir[numStr]) return numStr;
  const cLow = String(code || '').trim().toLowerCase();
  if (cLow && LRT_ID_BY_NORM_NAME.has(cLow)) return LRT_ID_BY_NORM_NAME.get(cLow);
  const kEn = String(nameEn || '').toLowerCase().replace(/\b(light rail stop|light rail|stop|station)\b/gi, '').replace(/[^a-z0-9]/g, '');
  if (kEn && LRT_ID_BY_NORM_NAME.has(kEn)) return LRT_ID_BY_NORM_NAME.get(kEn);
  const kTc = String(nameTc || '').replace(/(輕鐵站|輕鐵|車站|站)/g, '').replace(/[^\u4e00-\u9fa50-9]/g, '');
  if (kTc && LRT_ID_BY_NORM_NAME.has(kTc)) return LRT_ID_BY_NORM_NAME.get(kTc);
  return numStr || '';
}

function resolveFerryLiveEtaKey(origEn, destEn) {
  const o = normName(origEn, true), d = normName(destEn, true);
  if (o.includes('central') && d.includes('cheungchau')) return 'SF_CECC';
  if (o.includes('cheungchau') && d.includes('central')) return 'SF_CCCE';
  if (o.includes('central') && d.includes('muiwo')) return 'SF_CEMW';
  if (o.includes('muiwo') && d.includes('central')) return 'SF_MWCE';
  if (o.includes('northpoint') && d.includes('hunghom')) return 'SF_NPHH';
  if (o.includes('hunghom') && d.includes('northpoint')) return 'SF_HHNP';
  if (o.includes('northpoint') && d.includes('kowlooncity')) return 'SF_NPKC';
  if (o.includes('kowlooncity') && d.includes('northpoint')) return 'SF_KCNP';
  if (o.includes('pengchau') && d.includes('muiwo')) return 'SF_PCMW';
  if (o.includes('muiwo') && d.includes('pengchau')) return 'SF_MWPC';
  if (o.includes('cheungchau') && d.includes('muiwo')) return 'SF_CCMW';
  if (o.includes('muiwo') && d.includes('cheungchau')) return 'SF_MWCC';
  if (o.includes('central') && d.includes('sokkwuwan')) return 'HKKF_1_O';
  if (o.includes('sokkwuwan') && d.includes('central')) return 'HKKF_1_I';
  if (o.includes('central') && d.includes('yungshuewan')) return 'HKKF_2_O';
  if (o.includes('yungshuewan') && d.includes('central')) return 'HKKF_2_I';
  if (o.includes('central') && d.includes('pengchau')) return 'HKKF_3_O';
  if (o.includes('pengchau') && d.includes('central')) return 'HKKF_3_I';
  if (o.includes('pengchau') && d.includes('heilingchau')) return 'HKKF_4_O';
  if (o.includes('heilingchau') && d.includes('pengchau')) return 'HKKF_4_I';
  if (o.includes('central') && d.includes('hunghom')) return 'FF_CHH';
  if (o.includes('hunghom') && d.includes('central')) return 'FF_HHC';
  if (o.includes('northpoint') && d.includes('kwuntong')) return 'FF_NPKT';
  if (o.includes('kwuntong') && d.includes('northpoint')) return 'FF_KTNP';
  if (o.includes('tuenmun') && (d.includes('taio') || d.includes('tungchung') || d.includes('shalowan'))) return 'FF_TMTO';
  if ((o.includes('taio') || o.includes('tungchung') || o.includes('shalowan')) && d.includes('tuenmun')) return 'FF_TOTM';
  return null;
}

function mergeOperatingWindows(rawWindows) {
  if (!Array.isArray(rawWindows) || !rawWindows.length) return [];
  const valid = rawWindows
    .filter(w => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]))
    .map(([s, e]) => [Math.max(0, Math.min(1439, Math.round(s))), Math.max(0, Math.min(1439, Math.round(e)))])
    .filter(([s, e]) => e >= s)
    .sort((a, b) => a[0] - b[0]);
  if (!valid.length) return [];
  const merged = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = valid[i];
    if (cur[0] <= prev[1] + 45) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function deriveFerryActiveWindowsFromSched(sched) {
  if (!sched) return [[330, 1439], [0, 30]];
  const allMins = [];
  ['wk', 'sat', 'hol'].forEach(k => {
    (sched[k] || []).forEach(item => {
      const m = Array.isArray(item) ? Number(item[0]) : Number(item);
      if (Number.isFinite(m) && m >= 0 && m < 1440) allMins.push(m);
    });
  });
  if (!allMins.length) return [[330, 1439], [0, 30]];
  const sorted = [...new Set(allMins)].sort((a, b) => a - b);
  const rawWins = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - prev <= 150) {
      prev = sorted[i];
    } else {
      rawWins.push([Math.max(0, start - 15), Math.min(1439, prev + 35)]);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  rawWins.push([Math.max(0, start - 15), Math.min(1439, prev + 35)]);
  return mergeOperatingWindows(rawWins);
}

function getMajorBbiHubMatch(stopObj) {
  if (!stopObj) return null;
  const txt = `${stopObj.stopName_e || ''} ${stopObj.name_tc || ''}`;
  const la = parseFloat(stopObj.lat ?? stopObj.latitude);
  const lo = parseFloat(stopObj.lon ?? stopObj.longitude);
  for (const hub of MAJOR_BBI_HUBS) {
    if (hub.re.test(txt)) return hub;
    if (Number.isFinite(la) && Number.isFinite(lo) && _haversineKm(la, lo, hub.lat, hub.lon) <= hub.radiusKm) {
      return hub;
    }
  }
  return null;
}

function resolveRelevantCorridorForTrip(fromLat, fromLon, toLat, toLon) {
  const fLa = Number(fromLat), fLo = Number(fromLon), tLa = Number(toLat), tLo = Number(toLon);
  if (!Number.isFinite(fLa) || !Number.isFinite(tLa)) return null;
  const dKm = _haversineKm(fLa, fLo, tLa, tLo);
  if (dKm < 2.5) return null;

  const isHkA = fLa < 22.293 && fLo >= 114.110 && fLo <= 114.265;
  const isHkB = tLa < 22.293 && tLo >= 114.110 && tLo <= 114.265;
  if (isHkA !== isHkB) return HK_STRATEGIC_CORRIDORS.find(c => c.id === 'HARBOUR_TUNS');

  const isLanA = fLo < 114.055 && fLa < 22.345;
  const isLanB = tLo < 114.055 && tLa < 22.345;
  if (isLanA !== isLanB) return HK_STRATEGIC_CORRIDORS.find(c => c.id === 'LANTAU_TM');

  const samplePts = [
    [(fLa + tLa) / 2, (fLo + tLo) / 2],
    [fLa * 0.7 + tLa * 0.3, fLo * 0.7 + tLo * 0.3],
    [fLa * 0.3 + tLa * 0.7, fLo * 0.3 + tLo * 0.7]
  ];
  let bestCor = null, bestDist = Infinity;
  for (const cor of HK_STRATEGIC_CORRIDORS) {
    for (const [sLa, sLo] of samplePts) {
      const d = _haversineKm(sLa, sLo, cor.lat, cor.lon);
      if (d <= cor.radiusKm && d < bestDist) {
        bestDist = d;
        bestCor = cor;
      }
    }
  }
  return bestCor;
}

function computeBearingDeg(lat1, lon1, lat2, lon2) {
  const la1 = Number(lat1) * Math.PI / 180;
  const la2 = Number(lat2) * Math.PI / 180;
  const dLon = (Number(lon2) - Number(lon1)) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function angularDiffDeg(a, b) {
  const diff = Math.abs((((Number(a) || 0) - (Number(b) || 0) + 540) % 360) - 180);
  return diff;
}

// Perpendicular distance (km) from point P to segment A->B using local equirectangular projection, plus projection parameter t.
function pointToSegmentDistanceKm(pLat, pLon, aLat, aLon, bLat, bLon) {
  const latRef = ((aLat + bLat) * 0.5) * Math.PI / 180;
  const kx = 111.32 * Math.cos(latRef);
  const ky = 110.574;
  const ax = aLon * kx, ay = aLat * ky;
  const bx = bLon * kx, by = bLat * ky;
  const px = pLon * kx, py = pLat * ky;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) {
    return { distKm: Math.hypot(px - ax, py - ay), t: 0 };
  }
  const rawT = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return { distKm: Math.hypot(px - projX, py - projY), t: rawT };
}

function isExpresswayOrTunnelDetector(det) {
  const road = `${det?.id || ''} ${det?.roadEn || ''} ${det?.roadTc || ''} ${det?.desc || ''}`;
  if (/castle\s*peak\s*r(?:oa)?d|\bcpr\b|tdscpr|fan\s*kam\s*r(?:oa)?d|lam\s*kam\s*r(?:oa)?d|青山公路|粉錦公路|林錦公路|清水灣道/i.test(road) &&
      !/tuen\s*mun\s*r(?:oa)?d|\btmr\b|yuen\s*long\s*hwy|\bylh\b|tsing\s*long|\btlh\b|tai\s*lam\s*tunnel|north\s*lantau|tolo|fanling\s*hwy|san\s*tin\s*hwy|屯門公路|元朗公路|青朗公路|大欖隧道|北大嶼山公路|吐露港公路|粉嶺公路|新田公路/i.test(road)) {
    return false;
  }
  return /highway|expressway|bypass|tunnel|bridge|corridor|trunk\s*road|tsing\s*ma|ting\s*kau|lantau\s*link|north\s*lantau|tuen\s*mun\s*r(?:oa)?d|\btmr\b|tolo|fanling|san\s*tin|yuen\s*long\s*hwy|\bylh\b|tsing\s*long|\btlh\b|kong\s*sham|penny's\s*bay|tsing\s*sha|west\s*kowloon|island\s*eastern|tseung\s*kwan\s*o|route\s*\d|公路|幹線|繞道|隧道|大橋|走廊|青馬|汀九|北大嶼山|吐露港|元朗公路|屯門公路|青朗/i.test(road);
}

// Parallel local arterial / Light Rail / frontage-lane detectors (e.g. Castle Peak Rd / TDSCPRHSK10004)
// must NEVER leak onto expressway/highway bus spans (e.g. E36 along Tuen Mun Road & Yuen Long Highway).
function isOffCorridorLocalArterialDetector(det) {
  const idStr = `${det?.id || ''} ${det?.camKey || ''}`.toUpperCase();
  const road = `${det?.roadEn || ''} ${det?.roadTc || ''}`;
  if (/(?:^|\b)(?:TDS)?CPR[A-Z0-9]*/.test(idStr)) return true;
  if (/castle\s*peak\s*r(?:oa)?d|\bcpr\s*[-/]|light\s*rail|\blrt\s*stop|frontage\s*r(?:oa)?d|service\s*r(?:oa)?d|青山公路|輕鐵|輔助道路/i.test(road)) {
    return true;
  }
  return false;
}

const _HC_EN_TC_ROAD_SYNONYMS = [
  ['castle peak road', '青山公路'],
  ['tsing long highway', '青朗公路'],
  ['tuen mun road', '屯門公路'],
  ['yuen long highway', '元朗公路'],
  ['kam ho road', '錦河路'],
  ['pat heung road', '八鄉路'],
  ['hoi wing road', '海榮路'],
  ['siu lun street', '兆麟街'],
  ['ping ha road', '屏廈路'],
  ['pui to road', '杯渡路'],
  ['wong chu road', '皇珠路'],
  ['south lantau road', '嶼南道'],
  ['tung chung road', '東涌道'],
  ['north lantau highway', '北大嶼山公路'],
  ['shun long road', '順朗路'],
  ['yu tung road', '裕東路'],
  ['tai lam tunnel', '大欖隧道']
];

function _normalizeRoadStemHardcode(raw) {
  let s = String(raw || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.split(/\s+near\s+|\s+opposite\s+|\s+opp\.?\s+|\s+outside\s+|\s+at\s+|\s*[-–—]\s*(?:northbound|southbound|eastbound|westbound|nb|sb|eb|wb|ping\s*shan|yuen\s*long|castle\s*peak\s*bay|sam\s*shing|hung\s*shui\s*kiu|lam\s*tei|san\s*hui|so\s*kwun\s*wat|ting\s*kau|tsuen\s*wan|kwai\s*chung|tam\s*mi|mai\s*po|san\s*tin|chau\s*tau|lingnan|tai\s*lam|s\.\s*l\.|section)/i)[0];
  s = s.replace(/\b(?:northbound|southbound|eastbound|westbound|nb|sb|eb|wb)\b/gi, ' ');
  s = s.replace(/\brd\.?\b/g, 'road')
    .replace(/\bst\.?\b/g, 'street')
    .replace(/\bhwy\.?\b/g, 'highway')
    .replace(/\bexpwy\.?\b/g, 'expressway')
    .replace(/\bave\.?\b/g, 'avenue')
    .replace(/\bblvd\.?\b/g, 'boulevard')
    .replace(/\bdr\.?\b/g, 'drive')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function _extractExplicitRoadStemsHardcode(textEn = '', textTc = '') {
  const enStems = new Set();
  const tcStems = new Set();
  const enSrc = String(textEn || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:bus\s*terminus|terminus|b\/t|pti|interchange|playground|station|estate|court|garden|plaza|centre|center|hospital|village|tsuen|pier|market|school|park|block\s*\d+)\b/gi, ', ');

  const enParts = enSrc.split(/[,;/|→]+/);
  const roadTypeRe = /([a-z][a-z'\s]{1,36}?\b(?:road|rd\.?|street|st\.?|highway|hwy\.?|expressway|expwy\.?|bypass|tunnel|bridge|corridor|avenue|ave\.?|drive|dr\.?|lane|way|boulevard|blvd\.?|praya|circuit|terrace|path))/gi;
  for (let i = 0; i < enParts.length; i++) {
    const part = enParts[i].trim();
    if (!part) continue;
    let m;
    roadTypeRe.lastIndex = 0;
    while ((m = roadTypeRe.exec(part)) !== null) {
      const stem = _normalizeRoadStemHardcode(m[1]);
      if (stem && stem.length >= 5 && !/^(?:the|new|old|main|bus|local|corridor|road|street|highway)$/i.test(stem)) {
        enStems.add(stem);
      }
    }
  }

  const tcSrc = String(textTc || '').replace(/[（(][^）)]*[）)]/g, ' ');
  const tcRe = /([\u4e00-\u9fa5]{2,10}?(?:公路|大道|幹線|繞道|隧道|大橋|走廊|馬路|道|路|街))/g;
  let tm;
  while ((tm = tcRe.exec(tcSrc)) !== null) {
    const tcStem = tm[1].replace(/[－\-–—].*$/, '').trim();
    if (tcStem.length >= 3) tcStems.add(tcStem);
  }

  for (let i = 0; i < _HC_EN_TC_ROAD_SYNONYMS.length; i++) {
    const [enK, tcK] = _HC_EN_TC_ROAD_SYNONYMS[i];
    for (const s of enStems) {
      if (s === enK || s.includes(enK) || enK.includes(s)) tcStems.add(tcK);
    }
    for (const s of tcStems) {
      if (s === tcK || s.includes(tcK) || tcK.includes(s)) enStems.add(enK);
    }
  }

  return { en: Array.from(enStems), tc: Array.from(tcStems) };
}

function areRoadNamesCompatibleHardcode(spanTextEn = '', spanTextTc = '', detRoadEn = '', detRoadTc = '', opts = {}) {
  // On genuine long highway/BBI spans (> 1.25 km), intermediate trunk roads (e.g. Wong Chu Rd, TM-CLK Link,
  // Tuen Mun Rd) connect endpoints — allow unless both stops explicitly name the same non-highway local road.
  if (opts.isHighwaySpan && !opts.bothStopsSameLocalRoad) {
    return true;
  }
  const spanStems = _extractExplicitRoadStemsHardcode(spanTextEn, spanTextTc);
  const detStems = _extractExplicitRoadStemsHardcode(detRoadEn, detRoadTc);
  const spanHasRoad = spanStems.en.length > 0 || spanStems.tc.length > 0;
  const detHasRoad = detStems.en.length > 0 || detStems.tc.length > 0;
  if (!spanHasRoad || !detHasRoad) return true;

  for (let i = 0; i < spanStems.en.length; i++) {
    const a = spanStems.en[i];
    for (let j = 0; j < detStems.en.length; j++) {
      const b = detStems.en[j];
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  for (let i = 0; i < spanStems.tc.length; i++) {
    const a = spanStems.tc[i];
    for (let j = 0; j < detStems.tc.length; j++) {
      const b = detStems.tc[j];
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

// Parse pasted Hong Kong GPS coordinates in DMS (e.g. 22°26'24.1"N 114°03'42.6"E), DDM, or decimal (22.4400, 114.0618).
function parseHkGpsCoordinates(raw) {
  const txt = String(raw || '').trim();
  if (!txt || txt.length < 7 || txt.length > 96) return null;

  let lat = NaN;
  let lon = NaN;

  // 1. DMS: 22°26'24.1"N 114°03'42.6"E (flexible symbols °/d, '/′, "/″, optional comma)
  const dmsRe = /^\s*([NS])?\s*(\d{1,2})\s*[°dº]\s*(\d{1,2})\s*['′’m]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″”s])?\s*([NS])?\s*[,;\s]+\s*([EW])?\s*(\d{1,3})\s*[°dº]\s*(\d{1,2})\s*['′’m]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″”s])?\s*([EW])?\s*$/i;
  const mDms = txt.match(dmsRe);
  if (mDms) {
    const latH = (mDms[1] || mDms[5] || 'N').toUpperCase();
    const lonH = (mDms[6] || mDms[10] || 'E').toUpperCase();
    const d1 = Number(mDms[2]), m1 = Number(mDms[3]), s1 = Number(mDms[4]);
    const d2 = Number(mDms[7]), m2 = Number(mDms[8]), s2 = Number(mDms[9]);
    if (m1 < 60 && s1 < 60 && m2 < 60 && s2 < 60) {
      lat = (d1 + m1 / 60 + s1 / 3600) * (latH === 'S' ? -1 : 1);
      lon = (d2 + m2 / 60 + s2 / 3600) * (lonH === 'W' ? -1 : 1);
    }
  }

  // 2. DDM: 22°26.402'N 114°03.710'E
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const ddmRe = /^\s*([NS])?\s*(\d{1,2})\s*[°dº]\s*(\d{1,2}(?:\.\d+)?)\s*['′’m]?\s*([NS])?\s*[,;\s]+\s*([EW])?\s*(\d{1,3})\s*[°dº]\s*(\d{1,2}(?:\.\d+)?)\s*['′’m]?\s*([EW])?\s*$/i;
    const mDdm = txt.match(ddmRe);
    if (mDdm) {
      const latH = (mDdm[1] || mDdm[4] || 'N').toUpperCase();
      const lonH = (mDdm[5] || mDdm[8] || 'E').toUpperCase();
      const d1 = Number(mDdm[2]), m1 = Number(mDdm[3]);
      const d2 = Number(mDdm[6]), m2 = Number(mDdm[7]);
      if (m1 < 60 && m2 < 60) {
        lat = (d1 + m1 / 60) * (latH === 'S' ? -1 : 1);
        lon = (d2 + m2 / 60) * (lonH === 'W' ? -1 : 1);
      }
    }
  }

  // 3. Decimal: 22.440028, 114.061833 or 22.4400N 114.0618E
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const decRe = /^\s*([+-]?\d{1,2}\.\d{3,})\s*°?\s*([NS])?\s*[,;\s]+\s*([+-]?\d{1,3}\.\d{3,})\s*°?\s*([EW])?\s*$/i;
    const mDec = txt.match(decRe);
    if (mDec) {
      lat = Number(mDec[1]) * (String(mDec[2] || '').toUpperCase() === 'S' ? -1 : 1);
      lon = Number(mDec[3]) * (String(mDec[4] || '').toUpperCase() === 'W' ? -1 : 1);
    }
  }

  // Hong Kong bounding box check (reject unrelated numeric text or overseas coords)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 22.10 || lat > 22.60 || lon < 113.80 || lon > 114.50) return null;

  const latFixed = Number(lat.toFixed(6));
  const lonFixed = Number(lon.toFixed(6));
  const formatted = `${latFixed.toFixed(4)}, ${lonFixed.toFixed(4)}`;
  return {
    lat: latFixed,
    lon: lonFixed,
    formatted,
    labelEn: `GPS Pin (${formatted})`,
    labelTc: `GPS 座標 (${formatted})`
  };
}

function _extractExplicitBoundCode(group) {
  const rId = String(group?.routeIds?.[0] || '');
  const k = String(group?.key || '');
  if (rId.includes('_I') || k.endsWith('_I') || /_I_\d+$/.test(k)) return 'I';
  if (rId.includes('_O') || k.endsWith('_O') || /_O_\d+$/.test(k)) return 'O';
  const tdB = String(group?.tdBound || '').toUpperCase();
  if (tdB === 'I' || tdB === 'O') return tdB;
  return '';
}

function _stripStopPlatformSuffix(name) {
  return String(name || '')
    .replace(/\s*\([A-Z]{1,4}\d{2,4}\)\s*/g, '')
    .replace(/\s*\(Platform\s*[^)]+\)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _stopNameTokensOverlap(a, b) {
  const cleanA = _stripStopPlatformSuffix(a).toLowerCase().replace(/\([^)]*\)/g, ' ');
  const cleanB = _stripStopPlatformSuffix(b).toLowerCase().replace(/\([^)]*\)/g, ' ');
  const normA = cleanA.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  const normB = cleanB.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  if (!normA || !normB) return false;
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) return true;
  const ignore = new Set(['bus', 'terminus', 'station', 'ferry', 'pier', 'road', 'street', 'court', 'estate', 'public', 'transport', 'interchange', 'centre', 'center', 'plaza', 'from', 'via']);
  const tokA = cleanA.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length >= 2 && !ignore.has(w));
  const tokB = new Set(cleanB.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length >= 2 && !ignore.has(w)));
  let hits = 0;
  for (const w of tokA) {
    if (tokB.has(w)) hits++;
  }
  return hits >= 1;
}

// Find the opposite-direction route group for Swap Direction & Smart Return Trip.
// Handles both explicit _O/_I operators (KMB/CTB/LWB/GMB/MTR/Ferry) and destination-keyed operators (e.g. NLB 3M, 1, 2, 4, 11, 23).
function findOppositeDirectionGroup(group, routesList = []) {
  if (!group || !Array.isArray(routesList) || !routesList.length) return null;
  const curMode = group.mode || 'BUS';
  const sameRoute = routesList.filter(g =>
    g &&
    g.routeNo === group.routeNo &&
    g.company === group.company &&
    (g.mode || 'BUS') === curMode &&
    g.key !== group.key
  );
  if (!sameRoute.length) return null;

  const curBound = _extractExplicitBoundCode(group);
  const curKeyBase = String(group.key || '').replace(/_(O|I)(_\d+)?$/, '');

  // 1. Explicit _O / _I bound match (KMB, CTB, LWB, GMB, MTR, Ferry)
  if (curBound) {
    const diffBound = sameRoute.filter(g => {
      const b = _extractExplicitBoundCode(g);
      return b && b !== curBound;
    });
    if (diffBound.length) {
      return (
        diffBound.find(g => String(g.key || '').replace(/_(O|I)(_\d+)?$/, '') === curKeyBase && /_1$/.test(g.routeIds?.[0] || '')) ||
        diffBound.find(g => String(g.key || '').replace(/_(O|I)(_\d+)?$/, '') === curKeyBase) ||
        diffBound.find(g => /_1$/.test(g.routeIds?.[0] || '')) ||
        diffBound[0]
      );
    }
  }

  // 2. Destination-based opposite match (NLB and any route whose routeIds don't encode _O/_I)
  const curDestNorm = normName(_stripStopPlatformSuffix(group.dest_e || group.dest_tc || ''));
  const curOrigStr = group.orig_e || group.orig_tc || '';
  const curDestStr = group.dest_e || group.dest_tc || '';

  const diffDest = sameRoute.filter(g => {
    const dNorm = normName(_stripStopPlatformSuffix(g.dest_e || g.dest_tc || ''));
    return dNorm && curDestNorm ? dNorm !== curDestNorm : true;
  });
  if (!diffDest.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const cand of diffDest) {
    let score = 0;
    const candDestStr = cand.dest_e || cand.dest_tc || '';
    const candOrigStr = cand.orig_e || cand.orig_tc || '';
    if (_stopNameTokensOverlap(candDestStr, curOrigStr)) score += 100;
    if (_stopNameTokensOverlap(candOrigStr, curDestStr)) score += 60;
    if (!/\(special|short|peak/i.test(candDestStr) && !/\(from\s+/i.test(candOrigStr)) score += 15;
    if (/_1$/.test(cand.routeIds?.[0] || '')) score += 10;
    if (Array.isArray(cand.routeIds) && cand.routeIds.length > 0) score += Math.min(5, cand.routeIds.length);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

function _sanitizeDirectionTyposHardcode(raw) {
  return String(raw || '')
    .replace(/\bSouththbound\b/gi, 'Southbound')
    .replace(/\bNorththbound\b/gi, 'Northbound')
    .replace(/\bEastthbound\b/gi, 'Eastbound')
    .replace(/\bWestthbound\b/gi, 'Westbound');
}

function isDividedHighwaySnapRoadHardcode(roadEn = '', roadTc = '', id = '') {
  const txt = `${roadEn || ''} ${roadTc || ''} ${id || ''}`;
  return Boolean(
    /\b(?:tuen\s*mun\s*r(?:oa)?d|tmr|yuen\s*long\s*h(?:igh)?w(?:a)?y|ylh|north\s*lantau\s*h(?:igh)?w(?:a)?y|nlh|tuen\s*mun[\s–-]*chek\s*lap\s*kok|tm[\s-]*clk(?:l)?|shun\s*long\s*r(?:oa)?d|lantau\s*link|tds91038)\b|屯門公路|元朗公路|北大嶼山公路|屯門至?赤鱲角|順朗路|青嶼幹線/i.test(txt)
  );
}

function isRoundaboutOrInterchangeDetectorHardcode(roadEn = '', roadTc = '', id = '', lat = NaN, lon = NaN) {
  const txt = `${roadEn || ''} ${roadTc || ''} ${id || ''}`;
  if (/\b(?:roundabout|interchange|rotary|au\s*tau|pok\s*oi|long\s*tin|hung\s*tin|lung\s*mun\s*r(?:oa)?d|tm[\s-]*clk[\s-]*roundabout|tai\s*lam\s*tunnel\s*approach)\b|迴旋處|交匯處|凹頭|博愛|朗天路|洪天路|龍門路/i.test(txt)) {
    return true;
  }
  const la = Number(lat), lo = Number(lon);
  if (Number.isFinite(la) && Number.isFinite(lo)) {
    const hubs = [
      [22.4445, 114.0415], // Au Tau Interchange / Pok Oi Roundabout
      [22.4355, 114.0108], // Long Tin Rd / YLH roundabout
      [22.4422, 114.0005], // Hung Tin Rd / YLH interchange
      [22.3745, 113.9565]  // TM-CLKL / Lung Mun Rd roundabout
    ];
    for (let i = 0; i < hubs.length; i++) {
      if (_haversineKm(la, lo, hubs[i][0], hubs[i][1]) <= 0.28) return true;
    }
  }
  return false;
}

function isRoundaboutBottleneckHardcode(det) {
  if (!det) return false;
  const rawSpd = Number(det.spd ?? det.speedKmh);
  const hasSpd = Number.isFinite(rawSpd) && rawSpd > 0;
  const spd = hasSpd ? Math.abs(rawSpd) : NaN;
  const occ = Math.abs(Number(det.occ ?? det.maxOcc ?? 0) || 0);
  if (!isRoundaboutOrInterchangeDetectorHardcode(det.roadEn || '', det.roadTc || '', det.id || det.detId || '', det.lat, det.lon)) {
    return false;
  }
  return Boolean((hasSpd && spd < 18) || occ >= 70);
}

function capBusApiTierHardcode(rawTier, speedKmh, opts = {}) {
  const rawSpd = Number(speedKmh);
  const hasSpd = speedKmh !== null && speedKmh !== undefined && Number.isFinite(rawSpd) && rawSpd > 0;
  const spd = hasSpd ? Math.abs(rawSpd) : NaN;
  if (opts.isTerminusApproach) return 'SMOOTH';
  if (opts.isScheduledFallback) {
    return (hasSpd && spd < 18) ? 'MODERATE' : 'SMOOTH';
  }
  if (opts.isVerifiedMultiBusStall && hasSpd && spd < 8) {
    return 'CONGESTED';
  }
  // Bus API inferred segments without a live TD detector or verified multi-bus stall
  // strictly cap at Clear (Green, >= 18 km/h) or Slow (Amber, < 18 km/h) — NEVER Red (Jammed).
  if (hasSpd) {
    return spd >= 18 ? 'SMOOTH' : 'MODERATE';
  }
  const t = String(rawTier || '').toUpperCase();
  if (t === 'CONGESTED' || t === 'JAMMED' || t === 'MODERATE' || t === 'SLOW') return 'MODERATE';
  return 'SMOOTH';
}

function _isOffRouteHighwayLeakHardcode(roadEn = '', roadTc = '', id = '', routeCtx = null, seg = null) {
  const idStr = String(id || '').toUpperCase();
  const txt = `${roadEn || ''} ${roadTc || ''} ${idStr}`;
  const routeNo = String(routeCtx?.routeNo || '').trim().toUpperCase();
  const bs = seg?.betweenStops || null;
  const spanText = `${bs?.fromNameEn || ''} ${bs?.toNameEn || ''} ${bs?.fromNameTc || ''} ${bs?.toNameTc || ''}`;
  const stopsText = Array.isArray(routeCtx?.stops)
    ? routeCtx.stops.map((s) => `${s?.stopName_e || ''} ${s?.name_tc || ''}`).join(' ')
    : '';
  const combinedCtx = `${spanText} ${stopsText}`;
  const isE36Explicit = /^E36[A-Z]?$/.test(routeNo);
  const isE36ByStops = Boolean(
    /pat\s*heung|kam\s*ho|grand\s*mayfair|yuen\s*long\s*park|八鄉|錦河|柏瓏|元朗公園/i.test(combinedCtx) &&
    /airport|tung\s*chung|tm[\s-]*clk|chek\s*lap\s*kok|機場|東涌|屯門赤鱲角/i.test(combinedCtx)
  );
  if (isE36Explicit || isE36ByStops) {
    // Block far off-route Kong Sham Western Hwy / Shenzhen Bay / Brilliant Garden / Fung Tei leaks,
    // while allowing E36's actual divided-highway Tuen Mun Rd Siu Hong detector (TDS91038).
    if (/TDS91037|TDS91040/i.test(idStr)) return true;
    if (/kong\s*sham\s*western|shenzhen\s*bay|港深西部公路|深圳灣/i.test(txt)) return true;
    if (/brilliant\s*garden|fung\s*tei|寶怡|鳳地/i.test(txt)) return true;
  }
  // Block HZMB Hong Kong Link Road / elevated viaducts from bleeding onto parallel ground roads (e.g. South Perimeter Rd)
  const isViaductOrHzmb = /\b(?:hzmb|hong\s*kong\s*link\s*r(?:oa)?d|viaduct)\b|港珠澳大橋香港連接路|高架/i.test(txt);
  if (isViaductOrHzmb && !/hzmb|hong\s*kong\s*link|bridge\s*port|port|港珠澳|大橋口岸/i.test(spanText)) {
    return true;
  }
  return false;
}

function _estimateDetectorDelayMins(det) {
  if (!det) return 0;
  const rawSpd = Number(det.spd);
  const hasSpd = det.spd !== null && det.spd !== undefined && Number.isFinite(rawSpd) && rawSpd > 0;
  const spd = hasSpd ? Math.abs(rawSpd) : NaN;
  const occ = Math.abs(Number(det.occ) || 0);
  const tier = String(det.tier || 'SMOOTH').toUpperCase();
  // >= 40 km/h on expressways/trunk roads is ALWAYS Flowing (0 delay), never Slow
  if (hasSpd && spd >= 40) return 0;
  if ((hasSpd && spd < 15) || occ >= 75) {
    if (hasSpd && spd < 10) return 18;
    return 15;
  }
  if (tier === 'SLOW' || tier === 'JAMMED' || (hasSpd && spd < 40)) {
    if ((hasSpd && spd <= 24) || occ >= 65) return 9;
    if ((hasSpd && spd <= 28) || occ >= 55) return 8;
    return 4;
  }
  return 0;
}

function _shortRoadNameForVerdict(det, isZh = false) {
  const raw = _sanitizeDirectionTyposHardcode(isZh ? (det?.roadTc || det?.roadEn || '') : (det?.roadEn || det?.roadTc || ''));
  if (!raw) return isZh ? '主要幹道' : 'corridor';
  if (isZh) {
    return String(raw)
      .replace(/\s*[-–—]\s*(北行|南行|東行|西行).*$/i, '')
      .replace(/\s*近.*$/, '')
      .replace(/\s*\(\d+\)\s*$/, '')
      .trim() || raw;
  }
  let cleaned = String(raw)
    .replace(/\bYLH\s*\/.*$/i, 'Yuen Long Highway')
    .replace(/\bTMR\s*\/.*$/i, 'Tuen Mun Road')
    .replace(/\s*[-–—]\s*(North|South|East|West)bound.*$/i, '')
    .replace(/\s+near\s+.*$/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();
  if (!cleaned) cleaned = raw;
  return _sanitizeDirectionTyposHardcode(cleaned);
}

function summarizeDetectorBucket(hits) {
  if (!hits || !hits.length) return null;
  const validHits = hits.filter((h) => {
    const raw = Number(h?.det?.spd);
    return h?.det && (h.det.spd === null || h.det.spd === undefined || (Number.isFinite(raw) && raw > 0));
  });
  if (!validHits.length) return null;
  let spdSum = 0;
  let minSpd = Infinity;
  let worstSpd = Infinity;
  let maxOcc = 0;
  let maxDelay = -1;
  let worstDet = validHits[0].det;
  let worstHit = validHits[0];
  let jamCount = 0;
  let slowCount = 0;
  let worstRbHit = null;
  let worstRbSpd = Infinity;
  let worstRbOcc = -1;

  // Rank all valid corridor detectors across the full inter-stop leg by highest delay -> lowest speed -> highest occupancy
  for (const h of validHits) {
    const d = h.det;
    const rawSpd = Number(d.spd);
    const hasSpd = d.spd !== null && d.spd !== undefined && Number.isFinite(rawSpd) && rawSpd > 0;
    const effSpd = hasSpd ? Math.abs(rawSpd) : 50;
    const occ = Math.abs(Number(d.occ) || 0);
    const delay = _estimateDetectorDelayMins(d);
    spdSum += effSpd;
    if (effSpd < minSpd) minSpd = effSpd;

    if (isRoundaboutBottleneckHardcode(d)) {
      if (effSpd < worstRbSpd || (effSpd === worstRbSpd && occ > worstRbOcc)) {
        worstRbSpd = effSpd;
        worstRbOcc = occ;
        worstRbHit = h;
      }
    }

    const worseThanBest =
      (delay > maxDelay) ||
      (delay === maxDelay && effSpd < worstSpd) ||
      (delay === maxDelay && effSpd === worstSpd && occ > Math.abs(Number(worstDet?.occ) || 0));

    if (worseThanBest) {
      maxDelay = delay;
      worstSpd = effSpd;
      worstDet = d;
      worstHit = h;
    }
    if (occ > maxOcc) maxOcc = occ;
    if (effSpd >= 40) {
      // Expressways / trunk roads at >= 40 km/h are ALWAYS Flowing (SMOOTH), never Slow
    } else if (effSpd < 15 || occ >= 75) {
      // Strict TD Red reservation: speed < 15 km/h or occupancy >= 75%
      jamCount++;
    } else if (d.tier === 'SLOW' || d.tier === 'JAMMED' || effSpd < 40) {
      slowCount++;
    }
  }

  // Never let a downstream free-flow highway detector overwrite a jammed roundabout/interchange bottleneck
  const hasRoundaboutBottleneck = Boolean(worstRbHit);
  if (hasRoundaboutBottleneck && (!Number.isFinite(worstSpd) || worstSpd >= 18)) {
    worstHit = worstRbHit;
    worstDet = worstRbHit.det;
    worstSpd = worstRbSpd;
    maxDelay = Math.max(maxDelay, _estimateDetectorDelayMins(worstDet));
  }

  const avgSpd = Math.abs(Math.round(spdSum / validHits.length));
  const effMinSpd = Math.abs(Number.isFinite(Number(worstDet?.spd)) && Number(worstDet.spd) > 0
    ? Math.round(Number(worstDet.spd))
    : (Number.isFinite(minSpd) ? Math.round(minSpd) : avgSpd));
  const worstOcc = Math.abs(Number(worstDet?.occ) || 0);
  let status = 'SMOOTH';
  if (jamCount > 0 && (effMinSpd < 15 || worstOcc >= 75 || maxOcc >= 75)) {
    status = 'JAMMED';
  } else if (hasRoundaboutBottleneck || slowCount > 0 || avgSpd < 40) {
    status = 'SLOW';
  }

  const repHit = status === 'SMOOTH' ? validHits[0] : worstHit;
  return {
    count: validHits.length,
    avgSpd,
    minSpd: effMinSpd,
    maxOcc: Math.abs(Math.round(maxOcc)),
    estDelayMins: Math.max(0, Math.abs(maxDelay)),
    status,
    roundaboutBottleneck: hasRoundaboutBottleneck,
    worstDet,
    representativeDet: repHit.det,
    aheadKm: Math.abs(Number((repHit.aheadKm || 0).toFixed(1))),
    betweenStops: repHit.betweenStops || null
  };
}

// Synthesize clear "Bus vs. MTR" decision guidance directly from live TD corridor telemetry.
function synthesizeTrafficDecision(same, opp = null, isZh = false) {
  if (!same && !opp) return null;

  if (same) {
    const spd = Number(same.status === 'SMOOTH' ? same.avgSpd : same.minSpd) || 0;
    const occ = Number(same.worstDet?.occ ?? same.maxOcc ?? 0);
    const densityEn = occ >= 70 ? 'Bumper-to-bumper' : (occ >= 38 ? 'Heavy flow' : (occ >= 18 ? 'Moderate flow' : 'Light flow'));
    const densityTc = occ >= 70 ? '車龍緩慢' : (occ >= 38 ? '車流擠迫' : (occ >= 18 ? '車流適中' : '車流稀疏'));
    const roadShortEn = _shortRoadNameForVerdict(same.worstDet || same.representativeDet, false);
    const roadShortTc = _shortRoadNameForVerdict(same.worstDet || same.representativeDet, true);
    const estDelay = Number.isFinite(same.estDelayMins) ? same.estDelayMins : _estimateDetectorDelayMins({ spd, occ, tier: same.status });

    // Tier 1: Severe jam (+13m+ or < 15 km/h) -> Switch to MTR
    const isSevereJam = (same.status === 'JAMMED' && (spd < 15 || occ >= 75 || estDelay >= 13)) || (same.status !== 'SMOOTH' && spd > 0 && spd < 15);
    if (isSevereJam) {
      const dispMins = Math.max(13, estDelay || 15);
      const delayEn = `+${dispMins}m`;
      const delayTc = `+${dispMins} 分鐘`;
      return {
        tone: 'jammed',
        modeRec: 'SWITCH_MTR',
        estDelayMins: dispMins,
        verdictEn: `Switch to MTR · Jammed on ${roadShortEn} (${delayEn})`,
        verdictTc: `改乘港鐵 · ${roadShortTc}嚴重擠塞 (${delayTc})`,
        actionEn: `Jammed (${spd} km/h) — MTR avoids highway gridlock`,
        actionTc: `路面嚴重擠塞 (${spd} km/h)，建議改乘港鐵更快捷穩定`,
        delayLabelEn: delayEn,
        delayLabelTc: delayTc,
        densityEn,
        densityTc
      };
    }

    // Tier 2: Moderate delay (+6–12m) -> Bus delayed · MTR may be faster
    const isModerateDelay = same.status === 'JAMMED' || (same.status === 'SLOW' && (spd <= 28 || occ >= 55 || estDelay >= 6));
    if (isModerateDelay) {
      const dispMins = Math.max(6, Math.min(12, estDelay || (same.status === 'JAMMED' ? 10 : 8)));
      const delayEn = `+${dispMins}m`;
      const delayTc = `+${dispMins} 分鐘`;
      return {
        tone: same.status === 'JAMMED' ? 'jammed' : 'slow',
        modeRec: 'MTR_FASTER',
        estDelayMins: dispMins,
        verdictEn: `Bus delayed (${delayEn}) · MTR may be faster`,
        verdictTc: `巴士延誤 (${delayTc}) · 港鐵或較快`,
        actionEn: `Congestion on ${roadShortEn} (${spd} km/h) — compare MTR option`,
        actionTc: `${roadShortTc}車流緩慢 (${spd} km/h)，建議比較港鐵車程`,
        delayLabelEn: delayEn,
        delayLabelTc: delayTc,
        densityEn,
        densityTc
      };
    }

    // Tier 3: Minor slowdown (+2–5m) -> Take Bus · Corridor moving (+2–5m)
    if (same.status === 'SLOW') {
      const delayEn = '+2–5m';
      const delayTc = '+2–5 分鐘';
      return {
        tone: 'slow',
        modeRec: 'TAKE_BUS',
        estDelayMins: 4,
        verdictEn: `Take Bus · Corridor moving (${delayEn})`,
        verdictTc: `可乘巴士 · 路段尚算暢順 (${delayTc})`,
        actionEn: `Minor slowdown on ${roadShortEn} (${spd} km/h) — bus still moving steadily`,
        actionTc: `${roadShortTc}稍為車多 (${spd} km/h)，整體維持穩定移動`,
        delayLabelEn: delayEn,
        delayLabelTc: delayTc,
        densityEn,
        densityTc
      };
    }

    // Tier 4: Clear (+0m) -> Take Bus · Corridor clear
    const oppJam = opp && opp.status === 'JAMMED';
    return {
      tone: 'smooth',
      modeRec: 'TAKE_BUS',
      estDelayMins: 0,
      verdictEn: oppJam ? 'Take Bus · Your side clear (No delay)' : 'Take Bus · Corridor clear (No delay)',
      verdictTc: oppJam ? '可乘巴士 · 你方向暢通 (無延誤)' : '可乘巴士 · 前路暢通 (無延誤)',
      actionEn: oppJam ? 'Jam is only on the opposite carriageway — no delay on your side' : 'Normal travel time expected',
      actionTc: oppJam ? '擠塞僅在對面行車線，你方向不受影響' : '路面順暢，按正常車程出行',
      delayLabelEn: 'No delay',
      delayLabelTc: '無延誤',
      densityEn,
      densityTc
    };
  }

  // Opposite carriageway only
  const oppJam = opp.status === 'JAMMED';
  return {
    tone: 'smooth',
    modeRec: 'TAKE_BUS',
    estDelayMins: 0,
    verdictEn: oppJam ? `Take Bus · Opposite bound jammed (${opp.minSpd} km/h)` : `Take Bus · Nearby road clear (${Math.abs(Math.round(Number(opp.avgSpd) || 0))} km/h)`,
    verdictTc: oppJam ? `可乘巴士 · 僅對面線擠塞 (${opp.minSpd} km/h)` : `可乘巴士 · 鄰近路面暢通 (約 ${opp.avgSpd} km/h)`,
    actionEn: oppJam ? 'Opposite carriageway congested; monitor return leg' : 'Nearby road flowing normally',
    actionTc: oppJam ? '對面線擠塞，回程時請留意' : '鄰近路段交通暢順',
    delayLabelEn: 'No delay',
    delayLabelTc: '無延誤',
    densityEn: 'Nearby road',
    densityTc: '鄰近路段'
  };
}

function _extractRoadCoreHardcode(text) {
  return String(text || '')
    .split(/\s+near\s+|\s+-\s+|\s*\/\s*|\s*\(/i)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function _isOppositeCardinalHardcode(a, b) {
  return (a === 'EB' && b === 'WB') || (a === 'WB' && b === 'EB') || (a === 'NB' && b === 'SB') || (a === 'SB' && b === 'NB');
}

function extractCardinalDirectionMeta(source, isZh = false) {
  const obj = (source && typeof source === 'object') ? source : { desc: String(source || '') };
  const primaryText = `${obj.desc || ''} ${obj.roadEn || ''} ${obj.roadTc || ''}`;
  const dirText = String(obj.dir || '');
  let code = '';

  const parseExplicit = (txt) => {
    if (!txt) return '';
    if (/\b(?:eastbound|east[\s-]*bound|\(eb\)|eb)\b|東行/i.test(txt)) return 'EB';
    if (/\b(?:westbound|west[\s-]*bound|\(wb\)|wb)\b|西行/i.test(txt)) return 'WB';
    if (/\b(?:northbound|north[\s-]*bound|\(nb\)|nb)\b|北行/i.test(txt)) return 'NB';
    if (/\b(?:southbound|south[\s-]*bound|\(sb\)|sb)\b|南行/i.test(txt)) return 'SB';
    return '';
  };

  code = parseExplicit(primaryText) || parseExplicit(dirText);
  if (!code && dirText) {
    if (/^\s*east\s*$/i.test(dirText)) code = 'EB';
    else if (/^\s*west\s*$/i.test(dirText)) code = 'WB';
    else if (/^\s*north\s*$/i.test(dirText)) code = 'NB';
    else if (/^\s*south\s*$/i.test(dirText)) code = 'SB';
  }
  if (!code && obj.rot !== null && obj.rot !== undefined && Number.isFinite(Number(obj.rot))) {
    const deg = ((Number(obj.rot) % 360) + 360) % 360;
    if (deg >= 45 && deg < 135) code = 'EB';
    else if (deg >= 135 && deg < 225) code = 'SB';
    else if (deg >= 225 && deg < 315) code = 'WB';
    else code = 'NB';
  }
  if (!code && dirText) {
    if (/\beast\b/i.test(dirText)) code = 'EB';
    else if (/\bwest\b/i.test(dirText)) code = 'WB';
    else if (/\bnorth\b/i.test(dirText)) code = 'NB';
    else if (/\bsouth\b/i.test(dirText)) code = 'SB';
  }

  const MAP = {
    EB: { code: 'EB', labelEn: 'Eastbound', labelTc: '東行', arrowGlyph: '→', badgeBg: '#0EA5E9' },
    WB: { code: 'WB', labelEn: 'Westbound', labelTc: '西行', arrowGlyph: '←', badgeBg: '#8B5CF6' },
    NB: { code: 'NB', labelEn: 'Northbound', labelTc: '北行', arrowGlyph: '↑', badgeBg: '#2563EB' },
    SB: { code: 'SB', labelEn: 'Southbound', labelTc: '南行', arrowGlyph: '↓', badgeBg: '#EA580C' }
  };
  const info = MAP[code];
  if (!info) {
    return { code: '', labelEn: '', labelTc: '', fullLabel: '', arrowGlyph: '', badgeBg: '#475569' };
  }
  return {
    ...info,
    fullLabel: isZh ? info.labelTc : info.labelEn
  };
}

function findNearestMatchingDetectorForCamera(cam, detectors = [], opts = {}) {
  if (!cam || !Array.isArray(detectors) || !detectors.length) return null;
  const camKey = String(cam.key || '').trim();
  const cLat = Number(cam.lat);
  const cLon = Number(cam.lon);
  const hasCoords = Number.isFinite(cLat) && Number.isFinite(cLon);

  const routeCtx = opts?.routeCtx || (opts?.routeNo ? { routeNo: String(opts.routeNo), stops: opts?.stops || [] } : null);
  const routeCoords = Array.isArray(opts?.routeCoords) && opts.routeCoords.length >= 2 ? opts.routeCoords : null;
  const rampRe = /\b(?:slip\s*r(?:oa)?d|off[\s-]*ramp|on[\s-]*ramp|ramp|link\s*r(?:oa)?d)\b|支路|引道|連接路/i;
  const camDescAll = `${cam.desc || ''} ${cam.descTc || ''}`;
  const camIsRamp = rampRe.test(camDescAll);
  const camIsDividedHwy = isDividedHighwaySnapRoadHardcode(cam.desc || '', cam.descTc || '', camKey);
  const camDir = extractCardinalDirectionMeta(cam, false).code;
  const camRoad = _extractRoadCoreHardcode(cam.desc || '');
  const cardinalToDeg = { NB: 0, EB: 90, SB: 180, WB: 270 };
  const rawCamBrg = Number(cam.bearingDeg);
  const camBrg = (cam.bearingDeg !== null && cam.bearingDeg !== undefined && Number.isFinite(rawCamBrg))
    ? rawCamBrg
    : (camDir && cardinalToDeg[camDir] !== undefined ? cardinalToDeg[camDir] : NaN);

  const _passesRouteCorridorCheck = (d, maxDistKm) => {
    if (!routeCoords) return true;
    const dLat = Number(d.lat), dLon = Number(d.lon);
    if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) return false;
    let bestKm = Infinity;
    let bestBrg = NaN;
    for (let s = 0; s < routeCoords.length - 1; s++) {
      const a = routeCoords[s], b = routeCoords[s + 1];
      if (!a || !b) continue;
      const la1 = Number(a[0]), lo1 = Number(a[1]), la2 = Number(b[0]), lo2 = Number(b[1]);
      if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
      const proj = pointToSegmentDistanceKm(dLat, dLon, la1, lo1, la2, lo2);
      if (proj.distKm < bestKm) {
        bestKm = proj.distKm;
        bestBrg = computeBearingDeg(la1, lo1, la2, lo2);
      }
    }
    if (bestKm > maxDistKm) return false;
    const dRot = Number(d.rot);
    if (Number.isFinite(dRot) && Number.isFinite(bestBrg) && angularDiffDeg(dRot, bestBrg) > 45) {
      return false;
    }
    return true;
  };

  // 1. Exact detector-ID match (camera IS the detector, e.g. TDS90061 with its own live speed)
  if (camKey) {
    const exactById = detectors.find((d) =>
      d && d.id === camKey &&
      d.spd !== null && d.spd !== undefined && Number.isFinite(Number(d.spd)) && Number(d.spd) > 0
    );
    if (exactById) {
      if (routeCtx && _isOffRouteHighwayLeakHardcode(exactById.roadEn || '', exactById.roadTc || '', exactById.id || '', routeCtx, null)) {
        return null;
      }
      const isDivHwyExact = camIsDividedHwy || isDividedHighwaySnapRoadHardcode(exactById.roadEn || '', exactById.roadTc || '', exactById.id || '');
      const exactMaxKm = isDivHwyExact ? 0.085 : 0.045;
      if (_passesRouteCorridorCheck(exactById, exactMaxKm)) {
        return exactById;
      }
      return null;
    }
  }
  if (!hasCoords) return null;

  // 2. Strict spatial + directional + road-name match aligned with road polyline snap rules:
  //    <= 0.085 km (85 m) on divided highways (Tuen Mun Rd, Yuen Long Hwy, North Lantau Hwy, TM-CLKL),
  //    <= 0.045 km (45 m) on non-highway / local roads, requiring angularDiffDeg <= 45 and compatible road names.
  let bestDet = null;
  let bestScore = Infinity;

  for (let i = 0; i < detectors.length; i++) {
    const d = detectors[i];
    if (!d || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
    const rawSpd = Number(d.spd);
    if (d.spd === null || d.spd === undefined || !Number.isFinite(rawSpd) || rawSpd <= 0) continue;

    if (_isOffRouteHighwayLeakHardcode(d.roadEn || '', d.roadTc || '', d.id || '', routeCtx, null)) continue;

    const detDescAll = `${d.roadEn || ''} ${d.roadTc || ''}`;
    const detIsRamp = rampRe.test(detDescAll);
    if (camIsRamp !== detIsRamp) continue;

    const isDividedHwy = camIsDividedHwy || isDividedHighwaySnapRoadHardcode(d.roadEn || '', d.roadTc || '', d.id || '');
    const maxDistKm = isDividedHwy ? 0.085 : 0.045;
    const dKm = _haversineKm(cLat, cLon, Number(d.lat), Number(d.lon));
    if (dKm > maxDistKm) continue;

    const detDir = extractCardinalDirectionMeta(d, false).code;
    if (camDir && detDir && _isOppositeCardinalHardcode(camDir, detDir)) continue;

    const rawDetBrg = Number(d.rot);
    const detBrg = (d.rot !== null && d.rot !== undefined && Number.isFinite(rawDetBrg))
      ? rawDetBrg
      : (detDir && cardinalToDeg[detDir] !== undefined ? cardinalToDeg[detDir] : NaN);
    if (Number.isFinite(camBrg) && Number.isFinite(detBrg) && angularDiffDeg(camBrg, detBrg) > 45) {
      continue;
    }

    const detRoad = _extractRoadCoreHardcode(d.roadEn || d.roadTc || '');
    const sameRoad = Boolean(camRoad && detRoad && (camRoad === detRoad || camRoad.includes(detRoad) || detRoad.includes(camRoad)));
    const roadCompat = areRoadNamesCompatibleHardcode(
      cam.desc || '',
      cam.descTc || '',
      d.roadEn || '',
      d.roadTc || '',
      {
        isHighwaySpan: isDividedHwy,
        detIsHighway: isExpresswayOrTunnelDetector(d),
        bothStopsSameLocalRoad: !isDividedHwy
      }
    );
    if (camRoad && detRoad && !sameRoad && !roadCompat) continue;
    if (!roadCompat) continue;
    if (!_passesRouteCorridorCheck(d, maxDistKm)) continue;

    const preBoundBonus = (camKey && d.camKey === camKey) ? -0.01 : 0;
    const dirPenalty = (camDir && detDir && camDir === detDir) ? 0 : (camDir ? 0.015 : 0.005);
    const roadPenalty = sameRoad ? 0 : 0.02;
    const score = dKm + dirPenalty + roadPenalty + preBoundBonus;
    if (score < bestScore) {
      bestScore = score;
      bestDet = d;
    }
  }

  return bestDet;
}

function _isSegmentRoadCompatibleWithFeature(seg, roadEn = '', roadTc = '', featId = '') {
  const bs = seg?.betweenStops;
  const spanEn = `${bs?.fromNameEn || ''} ${bs?.toNameEn || ''}`.trim();
  const spanTc = `${bs?.fromNameTc || ''} ${bs?.toNameTc || ''}`.trim();
  const spanKm = Number(seg?.parentHopKm || seg?.hopKm || 0);
  const isHighwaySpan = (spanKm >= 1.25) || Boolean(seg?.isBbiSeg);
  const detIsHighway = isExpresswayOrTunnelDetector({ id: featId, roadEn, roadTc, desc: roadEn });
  const spanNamesHighway = isExpresswayOrTunnelDetector({ roadEn: spanEn, roadTc: spanTc });

  // Never allow expressway/highway/tunnel detectors or cameras to leak onto non-highway side streets
  // unless the stop itself explicitly names that highway/tunnel.
  if (!isHighwaySpan && detIsHighway && !spanNamesHighway) {
    return false;
  }

  const fromStems = _extractExplicitRoadStemsHardcode(bs?.fromNameEn || '', bs?.fromNameTc || '');
  const toStems = _extractExplicitRoadStemsHardcode(bs?.toNameEn || '', bs?.toNameTc || '');
  const bothStopsSameLocalRoad = Boolean(
    !spanNamesHighway &&
    fromStems.en.length > 0 &&
    toStems.en.length > 0 &&
    fromStems.en.some((a) => toStems.en.some((b) => a === b || a.includes(b) || b.includes(a)))
  );

  return areRoadNamesCompatibleHardcode(spanEn, spanTc, roadEn, roadTc, {
    isHighwaySpan,
    detIsHighway,
    bothStopsSameLocalRoad
  });
}

function _isLocalRoadSpanNonHighwayHardcode(seg) {
  const bs = seg?.betweenStops;
  if (!bs) return false;
  const spanEn = `${bs.fromNameEn || ''} ${bs.toNameEn || ''}`;
  const spanTc = `${bs.fromNameTc || ''} ${bs.toNameTc || ''}`;
  if (seg.isBbiSeg || isExpresswayOrTunnelDetector({ roadEn: spanEn, roadTc: spanTc })) return false;
  if (/south\s*perimeter\s*r(?:oa)?d|chek\s*lap\s*kok\s*south|chun\s*wan\s*r(?:oa)?d|cathay\s*(?:pacific\s*cargo|city)|hactl|air\s*mail\s*centre|南環路|赤鱲角南路|駿運|國泰城/i.test(`${spanEn} ${spanTc}`)) {
    return true;
  }
  const fromStems = _extractExplicitRoadStemsHardcode(bs.fromNameEn || '', bs.fromNameTc || '');
  const toStems = _extractExplicitRoadStemsHardcode(bs.toNameEn || '', bs.toNameTc || '');
  const hasExplicitLocalRoad = (fromStems.en.length > 0 || toStems.en.length > 0 || fromStems.tc.length > 0 || toStems.tc.length > 0);
  const spanKm = Number(seg.parentHopKm || seg.hopKm || 0);
  return Boolean(hasExplicitLocalRoad && spanKm < 2.2);
}

function _matchDetectorsAlongSegments(segments, detectors, routeCtx = null) {
  if (!segments.length || !Array.isArray(detectors) || !detectors.length) {
    return { sameHits: [], oppHits: [] };
  }

  const isRoadSnapped = segments.some(s => Boolean(s.isRoadSnapped));
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  let maxSegHopKm = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    minLat = Math.min(minLat, s.la1, s.la2);
    maxLat = Math.max(maxLat, s.la1, s.la2);
    minLon = Math.min(minLon, s.lo1, s.lo2);
    maxLon = Math.max(maxLon, s.lo1, s.lo2);
    const effHop = Number(s.parentHopKm || s.hopKm || 0);
    if (effHop > maxSegHopKm) maxSegHopKm = effHop;
  }

  const hasHighwaySpan = segments.some(s => {
    const spanKm = Number(s.parentHopKm || s.hopKm || 0);
    return Boolean(s.isBbiSeg || (spanKm >= 1.25 && !_isLocalRoadSpanNonHighwayHardcode(s)));
  });
  // Strict corridor lock when road-snapped polyline geometry is available.
  const latPad = isRoadSnapped ? 0.0020 : (maxSegHopKm >= 2.0 ? 0.018 : 0.0035);
  const lonPad = isRoadSnapped ? 0.0022 : (maxSegHopKm >= 2.0 ? 0.020 : 0.0040);
  const sameHits = [];
  const oppHits = [];

  for (let i = 0; i < detectors.length; i++) {
    const det = detectors[i];
    if (!det || !Number.isFinite(det.lat) || !Number.isFinite(det.lon)) continue;
    const rawSpd = Number(det.spd);
    if (det.spd !== null && det.spd !== undefined && (!Number.isFinite(rawSpd) || rawSpd <= 0)) continue;
    if (det.lat < minLat - latPad || det.lat > maxLat + latPad || det.lon < minLon - lonPad || det.lon > maxLon + lonPad) {
      continue;
    }

    const isExpDet = isExpresswayOrTunnelDetector(det);
    const isRoundaboutDet = isRoundaboutOrInterchangeDetectorHardcode(det.roadEn || '', det.roadTc || '', det.id || '', det.lat, det.lon);
    const isDividedHwyDet = isDividedHighwaySnapRoadHardcode(det.roadEn || '', det.roadTc || '', det.id || '');
    const isLocalArterial = isOffCorridorLocalArterialDetector(det) && !isRoundaboutDet;
    if (isExpDet && !hasHighwaySpan && !isRoundaboutDet) continue;

    let bestSeg = null;
    let bestDistKm = Infinity;
    let bestAheadKm = 0;
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j];
      if (_isOffRouteHighwayLeakHardcode(det.roadEn || '', det.roadTc || '', det.id || '', routeCtx, seg)) continue;
      const spanKm = Number(seg.parentHopKm || seg.hopKm || 0);
      const isHighwaySeg = Boolean(seg.isBbiSeg || (spanKm >= 1.25 && !_isLocalRoadSpanNonHighwayHardcode(seg)));
      // Expressway/tunnel detectors may ONLY match highway spans or BBI/tunnel stops — never local side streets (e.g. Kam Ho Rd / S1 / NLB 3M)
      if (isExpDet && !isHighwaySeg && !isRoundaboutDet) continue;
      // Road-corridor consistency: never snap parallel local/LRT arterial detectors onto a highway/BBI span
      if (isLocalArterial && (spanKm >= 2.0 || seg.isBbiSeg)) continue;
      // Require road-name compatibility whenever explicit road names are present
      if (!_isSegmentRoadCompatibleWithFeature(seg, det.roadEn || '', det.roadTc || '', det.id || '')) continue;

      const proj = pointToSegmentDistanceKm(det.lat, det.lon, seg.la1, seg.lo1, seg.la2, seg.lo2);
      // Strictly reject detectors behind boarding stop or past a highway fork/turn-off endpoint
      const minT = (j === 0 || seg.segIdx === 0) ? -0.02 : (seg.isRoadSnapped ? -0.10 : -0.08);
      const maxT = (j === segments.length - 1) ? 1.02 : (seg.isRoadSnapped ? 1.10 : (seg.hopKm >= 2.0 ? 1.04 : 1.10));
      if (proj.t < minT || proj.t > maxT) continue;

      const unsnappedHwyFallback = (!seg.isRoadSnapped && isHighwaySeg && seg.hopKm >= 2.0)
        ? Math.min(1.6, Math.max(0.35, seg.hopKm * 0.18))
        : 0;
      let maxCorridorRadius;
      if (isRoundaboutDet) {
        maxCorridorRadius = Math.max(0.120, unsnappedHwyFallback);
      } else if (isDividedHwyDet && isHighwaySeg) {
        // Divided highways (Tuen Mun Rd, Yuen Long Hwy, North Lantau Hwy, TM-CLKL): relax lateral snap to <= 85 m
        maxCorridorRadius = Math.max(0.085, unsnappedHwyFallback);
      } else if (!isHighwaySeg) {
        // Non-highway side streets: strict <= 45 m lateral cap to block adjacent expressway leakage
        maxCorridorRadius = 0.045;
      } else if (seg.isRoadSnapped) {
        // Highway road-snapped polyline corridor: strict <= 60 m perpendicular distance
        maxCorridorRadius = 0.060;
      } else if (seg.hopKm >= 2.0) {
        // Fallback before async road polyline loads (still subject to off-route leak & road-name checks)
        maxCorridorRadius = unsnappedHwyFallback;
      } else {
        maxCorridorRadius = 0.060;
      }

      if (proj.distKm <= maxCorridorRadius && proj.distKm < bestDistKm) {
        bestDistKm = proj.distKm;
        bestSeg = seg;
        bestAheadKm = seg.cumKm + Math.max(0, Math.min(1, proj.t)) * seg.hopKm;
      }
    }

    if (!bestSeg) continue;
    const ang = angularDiffDeg(bestSeg.brg, det.rot);
    const sameMaxAng = isRoundaboutDet
      ? 65
      : (isDividedHwyDet ? 45 : (bestSeg.isRoadSnapped ? 42 : (bestSeg.hopKm >= 3.0 ? 55 : 45)));
    const oppMinAng = 180 - sameMaxAng;
    const hitObj = {
      det,
      distKm: bestDistKm,
      aheadKm: bestAheadKm,
      ang,
      isRoundabout: isRoundaboutDet,
      betweenStops: bestSeg.betweenStops
    };
    if (ang <= sameMaxAng) {
      sameHits.push(hitObj);
    } else if (ang >= oppMinAng) {
      oppHits.push(hitObj);
    }
  }

  const sortHits = (a, b) => (a.aheadKm + a.distKm * 2.5) - (b.aheadKm + b.distKm * 2.5);
  sameHits.sort(sortHits);
  oppHits.sort(sortHits);
  return { sameHits, oppHits };
}

function _matchCamerasAlongForwardSegments(segments, cameras, routeCtx = null) {
  if (!segments.length || !Array.isArray(cameras) || !cameras.length) return [];
  const isRoadSnapped = segments.some(s => Boolean(s.isRoadSnapped));
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    minLat = Math.min(minLat, s.la1, s.la2);
    maxLat = Math.max(maxLat, s.la1, s.la2);
    minLon = Math.min(minLon, s.lo1, s.lo2);
    maxLon = Math.max(maxLon, s.lo1, s.lo2);
  }
  const pad = isRoadSnapped ? 0.0020 : 0.0035;
  const matched = [];
  for (let i = 0; i < cameras.length; i++) {
    const cam = cameras[i];
    const cLat = Number(cam?.lat), cLon = Number(cam?.lon);
    if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
    if (cLat < minLat - pad || cLat > maxLat + pad || cLon < minLon - pad || cLon > maxLon + pad) continue;
    const camDir = extractCardinalDirectionMeta(cam, false).code;
    const rawCamBrg = Number(cam?.bearingDeg);
    const hasCamBrg = cam?.bearingDeg !== null && cam?.bearingDeg !== undefined && Number.isFinite(rawCamBrg);
    const isRoundaboutCam = isRoundaboutOrInterchangeDetectorHardcode(cam.desc || '', cam.descTc || '', cam.key || '', cLat, cLon);
    const isDividedHwyCam = isDividedHighwaySnapRoadHardcode(cam.desc || '', cam.descTc || '', cam.key || '');

    let bestDistKm = Infinity;
    let bestAheadKm = 0;
    let bestSeg = null;
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j];
      if (_isOffRouteHighwayLeakHardcode(cam.desc || '', cam.descTc || '', cam.key || '', routeCtx, seg)) continue;
      const spanKm = Number(seg.parentHopKm || seg.hopKm || 0);
      const isHighwaySeg = Boolean(seg.isBbiSeg || (spanKm >= 1.25 && !_isLocalRoadSpanNonHighwayHardcode(seg)));
      if (!_isSegmentRoadCompatibleWithFeature(seg, cam.desc || '', cam.descTc || '', cam.key || '')) continue;

      const proj = pointToSegmentDistanceKm(cLat, cLon, seg.la1, seg.lo1, seg.la2, seg.lo2);
      const minT = (j === 0 || seg.segIdx === 0) ? -0.02 : -0.10;
      const maxT = (j === segments.length - 1) ? 1.02 : 1.10;
      if (proj.t < minT || proj.t > maxT) continue;
      // Non-highway side streets: <= 45 m; highways: <= 60 m (<= 85 m on divided highways; <= 120 m on roundabouts)
      const unsnappedCamFallback = (!seg.isRoadSnapped && isHighwaySeg && seg.hopKm >= 2.0)
        ? Math.min(1.6, Math.max(0.35, seg.hopKm * 0.18))
        : 0;
      const maxCamRadius = isRoundaboutCam
        ? Math.max(0.120, unsnappedCamFallback)
        : (isDividedHwyCam && isHighwaySeg
          ? Math.max(0.085, unsnappedCamFallback)
          : (!isHighwaySeg
            ? 0.045
            : (seg.isRoadSnapped ? 0.060 : (seg.hopKm >= 2.0 ? unsnappedCamFallback : 0.060))));
      if (proj.distKm > maxCamRadius) continue;
      if (hasCamBrg && angularDiffDeg(rawCamBrg, seg.brg) > (isRoundaboutCam ? 65 : 45)) continue;
      const segDir = extractCardinalDirectionMeta({ rot: seg.brg }, false).code;
      if (camDir && segDir && _isOppositeCardinalHardcode(camDir, segDir)) continue;
      if (proj.distKm < bestDistKm) {
        bestDistKm = proj.distKm;
        bestAheadKm = seg.cumKm + Math.max(0, Math.min(1, proj.t)) * seg.hopKm;
        bestSeg = seg;
      }
    }
    if (bestSeg) {
      matched.push({
        cam: { ...cam, desc: _sanitizeDirectionTyposHardcode(cam.desc || cam.key || '') },
        distKm: bestDistKm,
        aheadKm: bestAheadKm,
        segBrg: bestSeg.brg,
        betweenStops: bestSeg.betweenStops
      });
    }
  }
  matched.sort((a, b) => (a.aheadKm + a.distKm * 2.0) - (b.aheadKm + b.distKm * 2.0));
  return matched;
}

function _crossesHkWaterBarrierHardcode(lat1, lon1, lat2, lon2) {
  const n1 = Number(lat1), m1 = Number(lon1), n2 = Number(lat2), m2 = Number(lon2);
  if (!Number.isFinite(n1) || !Number.isFinite(m1) || !Number.isFinite(n2) || !Number.isFinite(m2)) return false;

  const isTsingYi = (la, lo) => la >= 22.332 && la <= 22.365 && lo >= 114.085 && lo <= 114.111;
  if (isTsingYi(n1, m1) !== isTsingYi(n2, m2)) return true;

  const isMaWan = (la, lo) => la >= 22.345 && la <= 22.356 && lo >= 114.052 && lo <= 114.066;
  if (isMaWan(n1, m1) !== isMaWan(n2, m2)) return true;

  const isLantau = (la, lo) => lo < 114.052 && la < 22.356;
  if (isLantau(n1, m1) !== isLantau(n2, m2)) return true;

  const isHkIsland = (la, lo) => {
    const harbourLatLine = lo < 114.185 ? 22.2918 : 22.2945;
    return la < harbourLatLine && lo >= 114.110 && lo <= 114.265;
  };
  if (isHkIsland(n1, m1) !== isHkIsland(n2, m2)) return true;

  return false;
}

const MAJOR_TUNNEL_BBI_RE = /(?:chek\s*lap\s*kok\s*tunnel|tm[\s-]*clk|cross[\s-]*harbour\s*tunnel|western\s*harbour|eastern\s*harbour|tai\s*lam\s*tunnel|tate'?s?\s*cairn\s*tunnel|lion\s*rock\s*tunnel|shing\s*mun\s*tunnel|aberdeen\s*tunnel|tseung\s*kwan\s*o\s*tunnel|tsing\s*sha|eagle'?s?\s*nest|lung\s*shan\s*tunnel|tunnel\s*(?:bbi|toll\s*plaza|interchange)|隧道轉車站|隧道收費廣場|海底隧道|屯門赤鱲角隧道|大欖隧道|大老山隧道|獅子山隧道|城門隧道|香港仔隧道|將軍澳隧道|青沙公路轉車站)/i;
const INLAND_MOUNTAIN_TUNNEL_BBI_RE = /(?:tai\s*lam\s*tunnel|tate'?s?\s*cairn\s*tunnel|lion\s*rock\s*tunnel|shing\s*mun\s*tunnel|aberdeen\s*tunnel|tseung\s*kwan\s*o\s*tunnel|tsing\s*sha|eagle'?s?\s*nest|lung\s*shan\s*tunnel|大欖隧道|大老山隧道|獅子山隧道|城門隧道|香港仔隧道|將軍澳隧道|青沙公路轉車站)/i;

function isMajorTunnelBbiStop(stop) {
  if (!stop) return false;
  const txt = `${stop.stopName_e || ''} ${stop.name_tc || ''}`;
  return MAJOR_TUNNEL_BBI_RE.test(txt);
}

function isCrossSubseaOrMajorTunnelSpan(stopA, stopB, la1, lo1, la2, lo2, spanKm = 0) {
  if (_crossesHkWaterBarrierHardcode(la1, lo1, la2, lo2)) return true;
  if (spanKm >= 2.0) {
    const aTxt = `${stopA?.stopName_e || ''} ${stopA?.name_tc || ''}`;
    const bTxt = `${stopB?.stopName_e || ''} ${stopB?.name_tc || ''}`;
    if (INLAND_MOUNTAIN_TUNNEL_BBI_RE.test(aTxt) || INLAND_MOUNTAIN_TUNNEL_BBI_RE.test(bTxt)) {
      return true;
    }
  }
  return false;
}

function _buildStopPairSegments(stops, startIdx, endIdxExclusive, maxCumKm = 12.0, allowLongHighwayUpToKm = 12.0, opts = {}) {
  const bbiStopRe = /tunnel|toll\s*plaza|\bbbi\b|highway|interchange|tsing\s*ma|lantau\s*link|轉車站|隧道|收費廣場|公路/i;
  const limitKm = Math.max(0.5, Number(maxCumKm) || 12.0);
  const segments = [];
  let cumKm = 0;
  for (let idx = startIdx; idx < endIdxExclusive - 1; idx++) {
    if (cumKm >= limitKm) break;
    const a = stops[idx], b = stops[idx + 1];
    const la1 = parseFloat(a?.latitude ?? a?.lat), lo1 = parseFloat(a?.longitude ?? a?.lon);
    const la2 = parseFloat(b?.latitude ?? b?.lat), lo2 = parseFloat(b?.longitude ?? b?.lon);
    if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
    const hopKm = _haversineKm(la1, lo1, la2, lo2);
    if (hopKm < 0.04) continue;

    const aName = `${a?.stopName_e || ''} ${a?.name_tc || ''}`;
    const bName = `${b?.stopName_e || ''} ${b?.name_tc || ''}`;
    const isBbiSeg = bbiStopRe.test(aName) || bbiStopRe.test(bName);

    let endLat = la2, endLon = lo2, effHopKm = hopKm;
    if (cumKm + hopKm > limitKm) {
      const frac = Math.max(0, Math.min(1, (limitKm - cumKm) / hopKm));
      endLat = la1 + (la2 - la1) * frac;
      endLon = lo1 + (lo2 - lo1) * frac;
      effHopKm = limitKm - cumKm;
    }

    segments.push({
      segIdx: segments.length,
      la1, lo1, la2: endLat, lo2: endLon,
      hopKm: effHopKm,
      parentHopKm: hopKm,
      cumKm,
      isBbiSeg,
      isRoadSnapped: false,
      brg: computeBearingDeg(la1, lo1, la2, lo2),
      betweenStops: {
        fromSeq: idx + 1,
        toSeq: idx + 2,
        fromNameEn: _stripStopPlatformSuffix(a?.stopName_e || a?.name_tc || ''),
        fromNameTc: _stripStopPlatformSuffix(a?.name_tc || a?.stopName_e || ''),
        toNameEn: _stripStopPlatformSuffix(b?.stopName_e || b?.name_tc || ''),
        toNameTc: _stripStopPlatformSuffix(b?.name_tc || b?.stopName_e || ''),
        hopKm: Number(hopKm.toFixed(1))
      }
    });
    cumKm += effHopKm;
  }
  return segments;
}

// Match ordered stops monotonically onto a road-snapped polyline so shared two-way corridors bind to the right pass
function _mapStopsToRoadPolylineIndices(stops, roadPolylinePoints) {
  const stopPolyIdx = new Map();
  if (!Array.isArray(stops) || !Array.isArray(roadPolylinePoints) || roadPolylinePoints.length < 2) {
    return stopPolyIdx;
  }
  let searchFrom = 0;
  for (let idx = 0; idx < stops.length; idx++) {
    const s = stops[idx];
    const sLat = parseFloat(s?.latitude ?? s?.lat);
    const sLon = parseFloat(s?.longitude ?? s?.lon);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

    let bestI = -1;
    let bestKm = Infinity;
    for (let p = searchFrom; p < roadPolylinePoints.length; p++) {
      const pt = roadPolylinePoints[p];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const dKm = _haversineKm(sLat, sLon, pt[0], pt[1]);
      if (dKm < bestKm) {
        bestKm = dKm;
        bestI = p;
      }
    }
    if (bestI >= 0 && bestKm <= 0.65) {
      stopPolyIdx.set(idx, bestI);
      searchFrom = bestI;
    }
  }
  return stopPolyIdx;
}

// Slice the active route's road polyline strictly forward starting AT activeStopIdx
// up to exitStopIdx (if provided and > activeStopIdx) or maxLookaheadKm (default 12 km).
function sliceForwardPolylineFromStop(coords, stops = [], activeStopIdx = 0, maxLookaheadKm = 12.0, exitStopIdx = null) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const idx = Math.max(0, Number(activeStopIdx) || 0);
  if (Array.isArray(stops) && stops.length >= 2 && idx >= stops.length - 1) {
    return [];
  }
  const hasExitClamp = (
    exitStopIdx !== null &&
    exitStopIdx !== undefined &&
    Number.isFinite(Number(exitStopIdx)) &&
    Number(exitStopIdx) > idx &&
    Array.isArray(stops) &&
    Number(exitStopIdx) < stops.length
  );
  const clampedExitIdx = hasExitClamp ? Number(exitStopIdx) : null;
  const limitKm = hasExitClamp
    ? Math.max(Number(maxLookaheadKm) || 12.0, 60.0)
    : Math.max(0.5, Number(maxLookaheadKm) || 12.0);

  let startPolyIdx = 0;
  let endPolyIdx = coords.length - 1;
  const mapped = (Array.isArray(stops) && stops.length >= 2)
    ? _mapStopsToRoadPolylineIndices(stops, coords)
    : new Map();

  if (Array.isArray(stops) && stops.length >= 2 && idx > 0) {
    if (mapped.has(idx)) {
      startPolyIdx = mapped.get(idx);
    } else {
      const st = stops[idx];
      const sLat = parseFloat(st?.latitude ?? st?.lat);
      const sLon = parseFloat(st?.longitude ?? st?.lon);
      if (Number.isFinite(sLat) && Number.isFinite(sLon)) {
        let bestI = 0, bestKm = Infinity;
        for (let p = 0; p < coords.length; p++) {
          const dKm = _haversineKm(sLat, sLon, coords[p][0], coords[p][1]);
          if (dKm < bestKm) { bestKm = dKm; bestI = p; }
        }
        startPolyIdx = bestI;
      }
    }
  }

  if (clampedExitIdx !== null) {
    if (mapped.has(clampedExitIdx) && mapped.get(clampedExitIdx) > startPolyIdx) {
      endPolyIdx = mapped.get(clampedExitIdx);
    } else {
      const exSt = stops[clampedExitIdx];
      const eLat = parseFloat(exSt?.latitude ?? exSt?.lat);
      const eLon = parseFloat(exSt?.longitude ?? exSt?.lon);
      if (Number.isFinite(eLat) && Number.isFinite(eLon)) {
        let bestI = coords.length - 1, bestKm = Infinity;
        for (let p = startPolyIdx; p < coords.length; p++) {
          const dKm = _haversineKm(eLat, eLon, coords[p][0], coords[p][1]);
          if (dKm < bestKm) { bestKm = dKm; bestI = p; }
        }
        endPolyIdx = Math.max(startPolyIdx + 1, bestI);
      }
    }
  }

  const sliced = [];
  let cumKm = 0;
  for (let p = startPolyIdx; p <= endPolyIdx && p < coords.length; p++) {
    const pt = coords[p];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    if (!sliced.length) {
      sliced.push([pt[0], pt[1]]);
      continue;
    }
    const prev = sliced[sliced.length - 1];
    const segKm = _haversineKm(prev[0], prev[1], pt[0], pt[1]);
    if (segKm < 0.002) continue;
    if (cumKm + segKm >= limitKm) {
      const frac = Math.max(0, Math.min(1, (limitKm - cumKm) / segKm));
      sliced.push([
        prev[0] + (pt[0] - prev[0]) * frac,
        prev[1] + (pt[1] - prev[1]) * frac
      ]);
      break;
    }
    sliced.push([pt[0], pt[1]]);
    cumKm += segKm;
  }
  return sliced.length >= 2 ? sliced : [];
}

// Project ordered stops onto a road-snapped polyline (CSDI ROUTE_BUS / deterministic OSRM)
// and emit dense micro-segments strictly forward starting AT startIdx up to maxCumKm (default 12 km).
function _buildRoadSnappedSegments(stops, startIdx, endIdxExclusive, roadPolylinePoints, maxCumKm = 12.0, opts = {}) {
  if (!Array.isArray(roadPolylinePoints) || roadPolylinePoints.length < 3) return null;
  const bbiStopRe = /tunnel|toll\s*plaza|\bbbi\b|highway|interchange|tsing\s*ma|lantau\s*link|轉車站|隧道|收費廣場|公路/i;
  const limitKm = Math.max(0.5, Number(maxCumKm) || 12.0);

  const stopPolyIdx = _mapStopsToRoadPolylineIndices(stops, roadPolylinePoints);
  let matchedCount = 0;
  let totalChecked = 0;
  for (let idx = startIdx; idx < endIdxExclusive; idx++) {
    const s = stops[idx];
    const sLat = parseFloat(s?.latitude ?? s?.lat);
    const sLon = parseFloat(s?.longitude ?? s?.lon);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;
    totalChecked++;
    if (stopPolyIdx.has(idx)) matchedCount++;
  }

  if (totalChecked < 2 || matchedCount < Math.max(2, Math.ceil(totalChecked * 0.55))) {
    return null;
  }

  const segments = [];
  let cumKm = 0;
  for (let idx = startIdx; idx < endIdxExclusive - 1; idx++) {
    if (cumKm >= limitKm) break;
    const pStart = stopPolyIdx.get(idx);
    // Find next mapped stop index >= idx + 1 in case an intermediate stop had an off-road coordinate
    let nextIdx = idx + 1;
    while (nextIdx < endIdxExclusive && !stopPolyIdx.has(nextIdx)) nextIdx++;
    if (nextIdx >= endIdxExclusive) break;
    const pEnd = stopPolyIdx.get(nextIdx);
    if (pStart === undefined || pEnd === undefined || pEnd <= pStart) continue;

    const a = stops[idx], b = stops[nextIdx];
    const laA = parseFloat(a?.latitude ?? a?.lat), loA = parseFloat(a?.longitude ?? a?.lon);
    const laB = parseFloat(b?.latitude ?? b?.lat), loB = parseFloat(b?.longitude ?? b?.lon);
    const chordKm = (Number.isFinite(laA) && Number.isFinite(laB)) ? _haversineKm(laA, loA, laB, loB) : 0;

    let spanRoadKm = 0;
    for (let p = pStart; p < pEnd; p++) {
      const c1 = roadPolylinePoints[p], c2 = roadPolylinePoints[p + 1];
      spanRoadKm += _haversineKm(c1[0], c1[1], c2[0], c2[1]);
    }
    const parentHopKm = Math.max(chordKm, spanRoadKm);

    const aName = `${a?.stopName_e || ''} ${a?.name_tc || ''}`;
    const bName = `${b?.stopName_e || ''} ${b?.name_tc || ''}`;
    const isBbiSeg = bbiStopRe.test(aName) || bbiStopRe.test(bName);

    const betweenStops = {
      fromSeq: idx + 1,
      toSeq: nextIdx + 1,
      fromNameEn: _stripStopPlatformSuffix(a?.stopName_e || a?.name_tc || ''),
      fromNameTc: _stripStopPlatformSuffix(a?.name_tc || a?.stopName_e || ''),
      toNameEn: _stripStopPlatformSuffix(b?.stopName_e || b?.name_tc || ''),
      toNameTc: _stripStopPlatformSuffix(b?.name_tc || b?.stopName_e || ''),
      hopKm: Number(parentHopKm.toFixed(1))
    };

    for (let p = pStart; p < pEnd; p++) {
      if (cumKm >= limitKm) break;
      const c1 = roadPolylinePoints[p], c2 = roadPolylinePoints[p + 1];
      const segKm = _haversineKm(c1[0], c1[1], c2[0], c2[1]);
      if (segKm < 0.008) continue;

      let endLat = c2[0], endLon = c2[1], effSegKm = segKm;
      if (cumKm + segKm > limitKm) {
        const frac = Math.max(0, Math.min(1, (limitKm - cumKm) / segKm));
        endLat = c1[0] + (c2[0] - c1[0]) * frac;
        endLon = c1[1] + (c2[1] - c1[1]) * frac;
        effSegKm = limitKm - cumKm;
      }

      segments.push({
        segIdx: segments.length,
        la1: c1[0], lo1: c1[1],
        la2: endLat, lo2: endLon,
        hopKm: effSegKm,
        parentHopKm,
        cumKm,
        isBbiSeg,
        isRoadSnapped: true,
        brg: computeBearingDeg(c1[0], c1[1], c2[0], c2[1]),
        betweenStops
      });
      cumKm += effSegKm;
    }
    if (nextIdx > idx + 1) idx = nextIdx - 1;
  }

  return segments.length >= 1 ? segments : null;
}

// Hong Kong time-of-day context (UTC+8) for interpreting expected vs. actual corridor speed
// and whether distant queues are likely building or dissipating (never fabricates sensor speeds).
function getHongKongTimeOfDayContext(nowMs = null) {
  const ms = (nowMs !== null && nowMs !== undefined && Number.isFinite(Number(nowMs)))
    ? Number(nowMs)
    : Date.now();
  const hkDate = new Date(ms + 8 * 3600 * 1000);
  const hkHour = hkDate.getUTCHours();
  const hkMin = hkDate.getUTCMinutes();
  const hkDay = hkDate.getUTCDay(); // 0 = Sun, 6 = Sat
  const minsOfDay = hkHour * 60 + hkMin;
  const yyyy = hkDate.getUTCFullYear();
  const mm = String(hkDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(hkDate.getUTCDate()).padStart(2, '0');
  const ymd = `${yyyy}-${mm}-${dd}`;
  const isHol = Boolean(typeof window !== 'undefined' && window.__HK_PUBLIC_HOLIDAYS__ instanceof Set && window.__HK_PUBLIC_HOLIDAYS__.has(ymd));
  const isWeekend = (hkDay === 0 || hkDay === 6 || isHol);
  const isWeekday = !isWeekend;

  let period = 'OFF_PEAK';
  let isPeak = false;
  let isAmPeak = false;
  let isPmPeak = false;
  let isLateNight = false;
  let trend = 'STEADY';
  let expectedSpeedRatio = 0.94;
  let labelEn = 'Off-peak midday';
  let labelTc = '日間非繁忙時段';

  if (minsOfDay >= 1290 || minsOfDay < 420) {
    // 21:30–06:59
    period = 'LATE_NIGHT';
    isLateNight = true;
    trend = 'DISSIPATING';
    expectedSpeedRatio = 1.0;
    labelEn = 'Late night · light traffic window';
    labelTc = '深夜時段 · 路面一般暢順';
  } else if (isWeekend) {
    period = 'WEEKEND';
    trend = minsOfDay >= 1170 ? 'DISSIPATING' : 'STEADY';
    expectedSpeedRatio = 0.92;
    labelEn = isHol ? 'Public holiday flow' : 'Weekend flow';
    labelTc = isHol ? '公眾假期車流' : '週末車流';
  } else if (minsOfDay >= 420 && minsOfDay < 450) {
    // 07:00–07:29
    period = 'PRE_AM_PEAK';
    trend = 'BUILDING';
    expectedSpeedRatio = 0.86;
    labelEn = 'Entering AM peak · queues building';
    labelTc = '臨近早繁 · 車龍漸現';
  } else if (minsOfDay >= 450 && minsOfDay <= 585) {
    // 07:30–09:45
    period = 'AM_PEAK';
    isPeak = true;
    isAmPeak = true;
    trend = minsOfDay <= 540 ? 'BUILDING' : 'DISSIPATING';
    expectedSpeedRatio = 0.65;
    labelEn = 'Weekday AM rush';
    labelTc = '平日早繁時段';
  } else if (minsOfDay >= 990 && minsOfDay < 1035) {
    // 16:30–17:14
    period = 'PRE_PM_PEAK';
    trend = 'BUILDING';
    expectedSpeedRatio = 0.84;
    labelEn = 'Entering PM peak · queues building';
    labelTc = '臨近晚繁 · 車流漸增';
  } else if (minsOfDay >= 1035 && minsOfDay <= 1185) {
    // 17:15–19:45
    period = 'PM_PEAK';
    isPeak = true;
    isPmPeak = true;
    trend = minsOfDay <= 1140 ? 'BUILDING' : 'DISSIPATING';
    expectedSpeedRatio = 0.62;
    labelEn = 'Weekday PM rush';
    labelTc = '平日晚繁時段';
  } else if (minsOfDay > 1185 && minsOfDay < 1290) {
    // 19:46–21:29
    period = 'EVENING_EASING';
    trend = 'DISSIPATING';
    expectedSpeedRatio = 0.90;
    labelEn = 'Evening off-peak · queues easing';
    labelTc = '晚間非繁忙 · 車龍漸散';
  }

  return {
    period,
    isWeekday,
    isWeekend,
    isPeak,
    isAmPeak,
    isPmPeak,
    isLateNight,
    trend,
    expectedSpeedRatio,
    hkHour,
    hkMin,
    labelEn,
    labelTc
  };
}

function computeTimeToReachDecayWeight(etaMins, distKm = 0) {
  const mins = Math.max(0, Number(etaMins) || 0);
  const km = Math.max(0, Number(distKm) || 0);
  if (mins > 30 || km > 15) return 0.3;
  if (mins > 15) return 0.65;
  return 1.0;
}

function _normalizeBottleneckTier(tier, speedKmh, occ = 0) {
  const rawSpd = Number(speedKmh);
  const hasSpd = speedKmh !== null && speedKmh !== undefined && Number.isFinite(rawSpd) && rawSpd > 0;
  const spd = hasSpd ? Math.abs(rawSpd) : NaN;
  const occVal = Math.abs(Number(occ) || 0);
  if (hasSpd && spd >= 40) return 'SMOOTH';
  // Reserve Red (CONGESTED) strictly for live TD < 15 km/h or occupancy >= 75%
  if ((hasSpd && spd < 15) || occVal >= 75) return 'CONGESTED';
  if (hasSpd && spd < 40) return 'MODERATE';
  const t = String(tier || '').toUpperCase();
  if (t === 'CONGESTED' || t === 'JAMMED') return 'CONGESTED';
  if (t === 'MODERATE' || t === 'SLOW') return 'MODERATE';
  if (t === 'SMOOTH') return 'SMOOTH';
  return 'SMOOTH';
}

function _isTerminusApproachStopSpan(stops, toIdx, destStop = null) {
  if (!Array.isArray(stops) || stops.length < 2) return false;
  if (Number(toIdx) < stops.length - 1) return false;
  const st = destStop || stops[stops.length - 1];
  const nm = `${st?.stopName_e || ''} ${st?.name_tc || ''}`;
  return Boolean(
    stops.length >= 5 ||
    /\b(?:terminus|b\/t|pti|interchange|pier|ferry\s*pier|estate\s*bus\s*terminus|pat\s*heung\s*r(?:oa)?d)\b|總站|公共運輸交匯處|碼頭|八鄉路/i.test(nm)
  );
}

function computeBottleneckSeverityScore(detOrSeg, todCtx = null) {
  if (!detOrSeg) return 0;
  const spd = Number(detOrSeg.speedKmh ?? detOrSeg.spd);
  const effSpd = Number.isFinite(spd) ? Math.max(0, spd) : 50;
  const occ = Math.max(0, Number(detOrSeg.occ ?? detOrSeg.maxOcc ?? 0) || 0);
  const tier = _normalizeBottleneckTier(detOrSeg.tier || detOrSeg.status, effSpd, occ);

  let score = 0;
  if (tier === 'CONGESTED') {
    score = 78 + (20 - Math.min(20, effSpd)) * 1.6 + Math.min(18, occ * 0.18);
  } else if (tier === 'MODERATE') {
    score = 36 + (40 - Math.min(40, Math.max(20, effSpd))) * 1.25 + Math.min(10, occ * 0.12);
  } else {
    score = Math.max(0, 12 - effSpd * 0.14);
  }

  // Contextualize severity against expected Hong Kong time-of-day speed without altering raw speed
  if (todCtx) {
    if (tier === 'CONGESTED' && (todCtx.isLateNight || todCtx.expectedSpeedRatio >= 0.92)) {
      score *= 1.08; // Unexpected incident/jam during normally clear hours
    } else if (tier === 'MODERATE' && todCtx.isPeak && effSpd >= 28) {
      score *= 0.92; // Mild slowdown expected during peak rush
    }
  }
  return Number(score.toFixed(2));
}

// Build upstream segments leading INTO stops[stopIdx] (0–2.5 km behind the stop),
// oriented in the bus's forward travel direction so approaching-jam detectors align cleanly.
function _buildUpstreamSegments(stops, stopIdx, roadPolylinePoints = null, maxUpstreamKm = 2.5) {
  if (!Array.isArray(stops) || stopIdx <= 0 || stopIdx >= stops.length) return [];
  const limitKm = Math.max(0.2, Math.min(2.5, Number(maxUpstreamKm) || 2.5));
  const bbiStopRe = /tunnel|toll\s*plaza|\bbbi\b|highway|interchange|tsing\s*ma|lantau\s*link|轉車站|隧道|收費廣場|公路/i;

  if (Array.isArray(roadPolylinePoints) && roadPolylinePoints.length >= 3) {
    const stopPolyIdx = _mapStopsToRoadPolylineIndices(stops, roadPolylinePoints);
    const pAtStop = stopPolyIdx.get(stopIdx);
    if (pAtStop !== undefined && pAtStop > 0) {
      // Find immediate previous mapped stop for span/BBI context
      let prevStopIdx = stopIdx - 1;
      while (prevStopIdx >= 0 && !stopPolyIdx.has(prevStopIdx)) prevStopIdx--;
      const prevSt = stops[Math.max(0, prevStopIdx)];
      const curSt = stops[stopIdx];
      const aName = `${prevSt?.stopName_e || ''} ${prevSt?.name_tc || ''}`;
      const bName = `${curSt?.stopName_e || ''} ${curSt?.name_tc || ''}`;
      const isBbiSeg = bbiStopRe.test(aName) || bbiStopRe.test(bName);
      const pPrevStop = prevStopIdx >= 0 ? (stopPolyIdx.get(prevStopIdx) ?? 0) : 0;
      let parentSpanKm = 0;
      for (let q = pPrevStop; q < pAtStop; q++) {
        parentSpanKm += _haversineKm(roadPolylinePoints[q][0], roadPolylinePoints[q][1], roadPolylinePoints[q + 1][0], roadPolylinePoints[q + 1][1]);
      }

      const rawBack = [];
      let backKm = 0;
      for (let p = pAtStop; p > 0 && backKm < limitKm; p--) {
        const cPrev = roadPolylinePoints[p - 1];
        const cCur = roadPolylinePoints[p];
        const segKm = _haversineKm(cPrev[0], cPrev[1], cCur[0], cCur[1]);
        if (segKm < 0.008) continue;
        let la1 = cPrev[0], lo1 = cPrev[1], effSegKm = segKm;
        if (backKm + segKm > limitKm) {
          const frac = Math.max(0, Math.min(1, (limitKm - backKm) / segKm));
          la1 = cCur[0] + (cPrev[0] - cCur[0]) * frac;
          lo1 = cCur[1] + (cPrev[1] - cCur[1]) * frac;
          effSegKm = limitKm - backKm;
        }
        rawBack.push({
          la1, lo1, la2: cCur[0], lo2: cCur[1],
          hopKm: effSegKm,
          parentHopKm: Math.max(parentSpanKm, effSegKm),
          distBeforeStopEndKm: backKm,
          distBeforeStopStartKm: backKm + effSegKm,
          isBbiSeg,
          isRoadSnapped: true,
          brg: computeBearingDeg(la1, lo1, cCur[0], cCur[1]),
          betweenStops: {
            fromSeq: Math.max(1, prevStopIdx + 1),
            toSeq: stopIdx + 1,
            fromNameEn: _stripStopPlatformSuffix(prevSt?.stopName_e || prevSt?.name_tc || ''),
            fromNameTc: _stripStopPlatformSuffix(prevSt?.name_tc || prevSt?.stopName_e || ''),
            toNameEn: _stripStopPlatformSuffix(curSt?.stopName_e || curSt?.name_tc || ''),
            toNameTc: _stripStopPlatformSuffix(curSt?.name_tc || curSt?.stopName_e || ''),
            hopKm: Number(Math.max(parentSpanKm, effSegKm).toFixed(1))
          }
        });
        backKm += effSegKm;
      }
      rawBack.reverse();
      let cumKm = 0;
      return rawBack.map((seg, idx) => {
        const out = { ...seg, segIdx: idx, cumKm };
        cumKm += seg.hopKm;
        return out;
      });
    }
  }

  // Fallback: stop-pair upstream segments walking backward from stopIdx up to limitKm
  const backSegs = [];
  let backKm = 0;
  for (let idx = stopIdx - 1; idx >= 0 && backKm < limitKm; idx--) {
    const a = stops[idx], b = stops[idx + 1];
    const la1 = parseFloat(a?.latitude ?? a?.lat), lo1 = parseFloat(a?.longitude ?? a?.lon);
    const la2 = parseFloat(b?.latitude ?? b?.lat), lo2 = parseFloat(b?.longitude ?? b?.lon);
    if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
    const hopKm = _haversineKm(la1, lo1, la2, lo2);
    if (hopKm < 0.04) continue;
    const aName = `${a?.stopName_e || ''} ${a?.name_tc || ''}`;
    const bName = `${b?.stopName_e || ''} ${b?.name_tc || ''}`;
    const isBbiSeg = bbiStopRe.test(aName) || bbiStopRe.test(bName);

    let sLat = la1, sLon = lo1, effHopKm = hopKm;
    if (backKm + hopKm > limitKm) {
      const frac = Math.max(0, Math.min(1, (limitKm - backKm) / hopKm));
      sLat = la2 + (la1 - la2) * frac;
      sLon = lo2 + (lo1 - lo2) * frac;
      effHopKm = limitKm - backKm;
    }
    backSegs.push({
      la1: sLat, lo1: sLon, la2, lo2,
      hopKm: effHopKm,
      parentHopKm: hopKm,
      distBeforeStopEndKm: backKm,
      distBeforeStopStartKm: backKm + effHopKm,
      isBbiSeg,
      isRoadSnapped: false,
      brg: computeBearingDeg(sLat, sLon, la2, lo2),
      betweenStops: {
        fromSeq: idx + 1,
        toSeq: idx + 2,
        fromNameEn: _stripStopPlatformSuffix(a?.stopName_e || a?.name_tc || ''),
        fromNameTc: _stripStopPlatformSuffix(a?.name_tc || a?.stopName_e || ''),
        toNameEn: _stripStopPlatformSuffix(b?.stopName_e || b?.name_tc || ''),
        toNameTc: _stripStopPlatformSuffix(b?.name_tc || b?.stopName_e || ''),
        hopKm: Number(hopKm.toFixed(1))
      }
    });
    backKm += effHopKm;
  }
  backSegs.reverse();
  let cumKm = 0;
  return backSegs.map((seg, idx) => {
    const out = { ...seg, segIdx: idx, cumKm };
    cumKm += seg.hopKm;
    return out;
  });
}

function _estimateRouteArrivalMins(distKm, liveSpeedKmh = null, isHighwaySpan = false) {
  const km = Math.max(0, Number(distKm) || 0);
  if (km <= 0.05) return 0;
  const spd = Number(liveSpeedKmh);
  const baselineKmh = isHighwaySpan ? 46 : 24;
  // Blend actual local speed with corridor baseline (don't assume entire 15km is stuck at 1 point's speed)
  const effKmh = (Number.isFinite(spd) && spd >= 6)
    ? Math.max(10, Math.min(72, spd * 0.45 + baselineKmh * 0.55))
    : baselineKmh;
  return Math.max(1, Math.round((km / effKmh) * 60));
}

function _findNearestCamForPoint(lat, lon, forwardCameras = [], fallbackCameras = [], detBrg = null, maxKm = 0.65) {
  const cLat = Number(lat), cLon = Number(lon);
  if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) return null;
  let best = null;
  let bestDistKm = Infinity;

  const scan = (list, isWrapped) => {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const cam = isWrapped ? item.cam : item;
      if (!cam?.key) continue;
      const la = Number(cam.lat), lo = Number(cam.lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      const dKm = _haversineKm(cLat, cLon, la, lo);
      if (dKm > maxKm) continue;
      if (detBrg !== null && Number.isFinite(Number(detBrg))) {
        const camBrg = Number(cam.bearingDeg);
        if (cam.bearingDeg !== null && cam.bearingDeg !== undefined && Number.isFinite(camBrg)) {
          if (angularDiffDeg(camBrg, Number(detBrg)) > 65) continue;
        }
      }
      if (dKm < bestDistKm) {
        bestDistKm = dKm;
        best = {
          camKey: cam.key,
          key: cam.key,
          desc: cam.desc || cam.key,
          meters: Math.round(dKm * 1000),
          lat: la,
          lon: lo,
          dir: cam.dir || '',
          bearingDeg: cam.bearingDeg
        };
      }
    }
  };

  if (Array.isArray(forwardCameras) && forwardCameras.length) scan(forwardCameras, true);
  if (!best && Array.isArray(fallbackCameras) && fallbackCameras.length) scan(fallbackCameras, false);
  return best;
}

// ============================================================================
// SHARED WORST-AHEAD STOP SEGMENT SELECTOR (Single Source of Truth)
// Stop-row pills (refreshStopByStopTrafficUI) and the expanded stop-card banner
// (generateExpandedETAsHtml -> getDirectionalRoadSummary) BOTH call this exact function over the
// exact same unified stop-by-stop segment array & forward window, so they can NEVER contradict.
// ============================================================================
function _resolveUnifiedSegTierHardcode(u, stops = null) {
  if (!u) return 'SMOOTH';
  if (u.source === 'BUS_EST' || u.isSyntheticFallback) {
    const spd = Number(u.speedKmh);
    return (Number.isFinite(spd) && Math.abs(spd) >= 18) ? 'SMOOTH' : 'MODERATE';
  }
  if (u.source === 'BUS_API') {
    const isTermApproach = Boolean(
      u.isTerminusApproach ||
      (Array.isArray(stops) && _isTerminusApproachStopSpan(stops, u.toIdx, stops[u.toIdx]))
    );
    return capBusApiTierHardcode(u.tier, u.speedKmh, {
      isTerminusApproach: isTermApproach,
      isScheduledFallback: Boolean(u.isScheduledFallback),
      isVerifiedMultiBusStall: Boolean(u.isVerifiedMultiBusStall)
    });
  }
  return _normalizeBottleneckTier(u.tier, u.speedKmh, u.occ ?? u.det?.occ ?? 0);
}

function _isMonitoredUnifiedSegHardcode(u) {
  if (!u || !Number.isFinite(Number(u.speedKmh))) return false;
  if (u.source === 'TD') return true;
  if (u.source === 'BUS_API') return !(u.isScheduledOnly && !u.isScheduledFallback);
  if (u.source === 'BUS_EST') return Number(u.speedKmh) > 0;
  return false;
}

function selectWorstAheadStopSegment(unifiedSegs, stops, fromIdx = 0, opts = {}) {
  if (!Array.isArray(unifiedSegs) || !unifiedSegs.length) return null;
  const startIdx = Math.max(0, Number(fromIdx) || 0);
  const stopCount = Array.isArray(stops) ? stops.length : (unifiedSegs.length + 1);
  const rawExit = opts?.exitStopIdx;
  const hasExitClamp = (
    rawExit !== null && rawExit !== undefined &&
    Number.isFinite(Number(rawExit)) &&
    Number(rawExit) > startIdx &&
    Number(rawExit) < stopCount
  );
  const effLookahead = Math.max(2, Number(opts?.lookaheadStops) || 40);
  const endIdx = hasExitClamp
    ? Math.min(stopCount, Number(rawExit) + 1)
    : Math.min(stopCount, startIdx + effLookahead + 1);
  const baseMaxKm = Math.max(0.5, (Number(opts?.maxLookaheadMeters) || 12000) / 1000);
  const maxLookaheadKm = Number.isFinite(Number(opts?.maxLookaheadKm))
    ? Number(opts.maxLookaheadKm)
    : (hasExitClamp ? Math.max(baseMaxKm, 45.0) : baseMaxKm);

  const rank = { CONGESTED: 2, MODERATE: 1, SMOOTH: 0 };
  let best = null;
  let cumKm = 0;
  for (let i = 0; i < unifiedSegs.length; i++) {
    const u = unifiedSegs[i];
    if (!u || Number(u.fromIdx) < startIdx) continue;
    if (Number(u.toIdx) > endIdx - 1) break;
    const hopKm = Math.max(0.05, Number(u.roadDistKm) || 0.4);
    const distKm = Number((cumKm + hopKm * 0.5).toFixed(1));
    cumKm += hopKm;
    if (distKm > maxLookaheadKm + 0.05) break;
    if (!_isMonitoredUnifiedSegHardcode(u)) continue;
    const tier = _resolveUnifiedSegTierHardcode(u, stops);
    const r = rank[tier] ?? 0;
    const spd = Math.abs(Number(u.speedKmh));
    if (
      !best ||
      r > best.rank ||
      (r === best.rank && r > 0 && spd < best.spd)
    ) {
      best = { seg: u, tier, rank: r, spd, distKm };
    }
  }
  if (!best) return null;
  return {
    seg: best.seg,
    tier: best.tier,
    status: best.tier === 'CONGESTED' ? 'JAMMED' : (best.tier === 'MODERATE' ? 'SLOW' : 'SMOOTH'),
    speedKmh: Math.abs(Math.round(best.spd)),
    distKm: best.distKm,
    fromIdx: Number(best.seg.fromIdx),
    toIdx: Number(best.seg.toIdx)
  };
}

// Strict forward-only downstream corridor evaluation (optionally clamped to exitStopIdx)
// PLUS upstream "Jam Before Stop" (0–2.5 km leading into stops[startIdx]), segment-by-segment
// corridor bottlenecks with time-to-reach decay weighting, and Hong Kong time-of-day context.
// When opts.unifiedSegments (from buildStopByStopSegmentTraffic) is supplied, reads directly
// from that exact unified stop-by-stop array as Single Source of Truth!
function inferDirectionalRoadTrafficForStops(stops, startIdx = 0, detectors = [], lookaheadStops = 40, roadPolylinePoints = null, maxLookaheadMeters = 12000, cameras = null, opts = {}) {
  const emptyRes = {
    sameSide: null,
    oppSide: null,
    approaching: null,
    segments: [],
    stopBreakdownSegments: [],
    rankedBottlenecks: [],
    forwardCameras: [],
    aheadCam: null,
    timeOfDayContext: getHongKongTimeOfDayContext(opts?.nowMs ?? null),
    hasLive: false,
    capturedAt: '',
    usedRoadPolyline: false
  };
  if (!Array.isArray(stops) || stops.length < 2) {
    return emptyRes;
  }

  const detList = Array.isArray(detectors) ? detectors : [];
  const rawStart = Number(startIdx) || 0;
  const fromIdx = Math.max(0, Math.min(stops.length - 1, rawStart));
  const todCtx = getHongKongTimeOfDayContext(opts?.nowMs ?? null);
  const camList = Array.isArray(cameras)
    ? cameras
    : (typeof window !== 'undefined' && Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) ? window.__LIVE_TRAFFIC_CAMERAS__ : []);

  const routeCtx = { routeNo: String(opts?.routeNo || '').trim(), stops };

  // 1. Evaluate Upstream "Jam Before Stop" (0–2.5 km leading into stops[fromIdx] along route polyline)
  let approaching = null;
  if (fromIdx > 0 && detList.length) {
    const upSegs = _buildUpstreamSegments(stops, fromIdx, roadPolylinePoints, 2.5);
    if (upSegs.length) {
      const upTotalKm = upSegs.reduce((acc, s) => acc + (s.hopKm || 0), 0);
      const { sameHits: upSameHits } = _matchDetectorsAlongSegments(upSegs, detList, routeCtx);
      const activeUpHits = upSameHits
        .map(h => {
          const distBeforeKm = Math.max(0, Number((upTotalKm - (Number(h.aheadKm) || 0)).toFixed(2)));
          return { ...h, distBeforeKm };
        })
        .filter(h => h.distBeforeKm <= 2.55);

      const upBucket = summarizeDetectorBucket(activeUpHits);
      if (upBucket && (upBucket.status === 'JAMMED' || upBucket.status === 'SLOW')) {
        const upDet = upBucket.worstDet || upBucket.representativeDet;
        const worstHit = activeUpHits.find(h => h.det === upDet) || activeUpHits[0];
        const distKm = Math.abs(Number((worstHit?.distBeforeKm ?? 0.8).toFixed(1)));
        const tier = _normalizeBottleneckTier(upDet?.tier || upBucket.status, upBucket.minSpd, upBucket.maxOcc);
        const sevScore = computeBottleneckSeverityScore({ spd: upBucket.minSpd, occ: upBucket.maxOcc, tier }, todCtx);
        const etaMins = Math.max(1, _estimateRouteArrivalMins(distKm, upBucket.minSpd, distKm >= 1.2));
        const upCam = _findNearestCamForPoint(upDet?.lat, upDet?.lon, [], camList, upDet?.rot, 0.55);
        const roadEn = _shortRoadNameForVerdict(upDet, false);
        const roadTc = _shortRoadNameForVerdict(upDet, true);
        approaching = {
          status: upBucket.status,
          tier,
          speedKmh: Math.abs(upBucket.minSpd),
          minSpd: Math.abs(upBucket.minSpd),
          avgSpd: Math.abs(upBucket.avgSpd),
          maxOcc: Math.abs(upBucket.maxOcc),
          estDelayMins: Math.abs(upBucket.estDelayMins),
          distKm,
          distMeters: Math.abs(Math.round(distKm * 1000)),
          etaMins,
          severityScore: sevScore,
          timeDecayWeight: 1.0,
          impactScore: sevScore,
          isApproaching: true,
          isFarAhead: false,
          det: upDet,
          detectorId: upDet?.id || '',
          detId: upDet?.id || '',
          roadEn,
          roadTc,
          cam: upCam,
          camKey: upCam?.camKey || upCam?.key || upDet?.camKey || '',
          camDesc: _sanitizeDirectionTyposHardcode(upCam?.desc || ''),
          labelEn: `Jam before stop (${distKm.toFixed(1)} km upstream · ${Math.abs(upBucket.minSpd)} km/h)`,
          labelTc: `到站前塞車（前 ${distKm.toFixed(1)} km · ${Math.abs(upBucket.minSpd)} km/h）`
        };
      }
    }
  }

  // At or past terminus: nothing ahead, only return upstream approaching jam if active
  if (fromIdx >= stops.length - 1) {
    return {
      ...emptyRes,
      approaching,
      rankedBottlenecks: approaching ? [approaching] : [],
      hasLive: Boolean(approaching)
    };
  }

  // 2. Downstream forward corridor (strictly clamped to exitStopIdx when selected)
  const effLookahead = Math.max(2, Number(lookaheadStops) || 40);
  const rawExitIdx = opts?.exitStopIdx;
  const hasExitClamp = (
    rawExitIdx !== null &&
    rawExitIdx !== undefined &&
    Number.isFinite(Number(rawExitIdx)) &&
    Number(rawExitIdx) > fromIdx &&
    Number(rawExitIdx) < stops.length
  );
  const endIdx = hasExitClamp
    ? Math.min(stops.length, Number(rawExitIdx) + 1)
    : Math.min(stops.length, fromIdx + effLookahead + 1);
  const baseMaxKm = Math.max(0.5, (Number(maxLookaheadMeters) || 12000) / 1000);
  const maxLookaheadKm = hasExitClamp ? Math.max(baseMaxKm, 45.0) : baseMaxKm;

  const snappedAhead = roadPolylinePoints
    ? _buildRoadSnappedSegments(stops, fromIdx, endIdx, roadPolylinePoints, maxLookaheadKm)
    : null;
  const aheadSegs = Array.isArray(snappedAhead)
    ? snappedAhead
    : _buildStopPairSegments(stops, fromIdx, endIdx, maxLookaheadKm, maxLookaheadKm);

  const forwardCameras = camList.length ? _matchCamerasAlongForwardSegments(aheadSegs, camList, routeCtx) : [];
  const nearestFwdCam = forwardCameras.length ? forwardCameras[0] : null;
  const aheadCam = nearestFwdCam
    ? {
        key: nearestFwdCam.cam.key,
        camKey: nearestFwdCam.cam.key,
        desc: _sanitizeDirectionTyposHardcode(nearestFwdCam.cam.desc || nearestFwdCam.cam.key),
        aheadMeters: Math.max(10, Math.abs(Math.round((Number(nearestFwdCam.aheadKm) || 0) * 1000))),
        lat: Number(nearestFwdCam.cam.lat),
        lon: Number(nearestFwdCam.cam.lon),
        dir: _sanitizeDirectionTyposHardcode(nearestFwdCam.cam.dir || ''),
        bearingDeg: nearestFwdCam.cam.bearingDeg
      }
    : null;

  const { sameHits: rawSameHits, oppHits: rawOppHits } = detList.length
    ? _matchDetectorsAlongSegments(aheadSegs, detList, routeCtx)
    : { sameHits: [], oppHits: [] };
  const sameHits = rawSameHits.filter(h => (Number(h.aheadKm) || 0) <= maxLookaheadKm + 0.05);
  const oppHits = rawOppHits.filter(h => (Number(h.aheadKm) || 0) <= maxLookaheadKm + 0.05);

  const segments = [];
  const useUnified = Array.isArray(opts?.unifiedSegments) && opts.unifiedSegments.length > 0;
  let effectiveSameHits = sameHits;

  if (useUnified) {
    // Single Source of Truth: read directly from the unified stop-by-stop segment array
    // (after TD ground-truth matching/suppression & side-road protection), so stop-row pills
    // and the expanded card banner can NEVER contradict each other!
    const detById = new Map();
    for (let i = 0; i < detList.length; i++) {
      if (detList[i]?.id) detById.set(detList[i].id, detList[i]);
    }
    const unifiedTdHits = [];
    let cumKm = 0;
    for (let i = 0; i < opts.unifiedSegments.length; i++) {
      const u = opts.unifiedSegments[i];
      if (!u || Number(u.fromIdx) < fromIdx) continue;
      if (Number(u.toIdx) > endIdx - 1) break;
      const hopKm = Math.max(0.05, Number(u.roadDistKm) || 0.4);
      const distKm = Number((cumKm + hopKm * 0.5).toFixed(1));
      cumKm += hopKm;
      if (distKm > maxLookaheadKm + 0.05) break;

      const betweenStops = {
        fromSeq: u.fromSeq || (Number(u.fromIdx) + 1),
        toSeq: u.toSeq || (Number(u.toIdx) + 1),
        fromNameEn: u.fromNameEn || '',
        fromNameTc: u.fromNameTc || '',
        toNameEn: u.toNameEn || '',
        toNameTc: u.toNameTc || '',
        hopKm: Number(hopKm.toFixed(1))
      };

      if (u.source === 'TD' && Number.isFinite(Number(u.speedKmh))) {
        const detObj = u.det || (u.detId ? detById.get(u.detId) : null) || {
          id: u.detId || `TD_${betweenStops.fromSeq}_${betweenStops.toSeq}`,
          spd: Math.round(Number(u.speedKmh)),
          occ: Number(u.occ) || 0,
          tier: u.tier || 'SMOOTH',
          roadEn: u.roadEn || '',
          roadTc: u.roadTc || u.roadEn || '',
          camKey: u.camKey || '',
          lat: u.coords?.[0]?.[0] ?? 0,
          lon: u.coords?.[0]?.[1] ?? 0
        };
        const tdOcc = Math.abs(Number(u.occ ?? detObj.occ ?? 0) || 0);
        const tier = _normalizeBottleneckTier(u.tier, u.speedKmh, tdOcc);
        const speedKmh = Math.round(Number(u.speedKmh));
        const status = tier === 'CONGESTED' ? 'JAMMED' : (tier === 'MODERATE' ? 'SLOW' : 'SMOOTH');
        const isRb = Boolean(u.roundaboutBottleneck || isRoundaboutBottleneckHardcode(detObj));
        const isHwySpan = Boolean(hopKm >= 1.2 || isExpresswayOrTunnelDetector(detObj));
        const etaMins = _estimateRouteArrivalMins(distKm, speedKmh, isHwySpan);
        const timeDecayWeight = computeTimeToReachDecayWeight(etaMins, distKm);
        const severityScore = computeBottleneckSeverityScore({ spd: speedKmh, occ: tdOcc, tier }, todCtx);
        const impactScore = Number((severityScore * timeDecayWeight * (isRb ? 1.15 : 1)).toFixed(2));
        const isFarAhead = (etaMins > 30 || distKm > 15);
        unifiedTdHits.push({
          det: detObj,
          distKm: 0.02,
          aheadKm: distKm,
          ang: 0,
          betweenStops
        });
        segments.push({
          key: `STOP_${betweenStops.fromSeq}_${betweenStops.toSeq}`,
          source: 'TD',
          fromIdx: Number(u.fromIdx),
          toIdx: Number(u.toIdx),
          fromSeq: betweenStops.fromSeq,
          toSeq: betweenStops.toSeq,
          fromNameEn: betweenStops.fromNameEn,
          fromNameTc: betweenStops.fromNameTc,
          toNameEn: betweenStops.toNameEn,
          toNameTc: betweenStops.toNameTc,
          betweenStops,
          roadEn: u.roadEn || _shortRoadNameForVerdict(detObj, false),
          roadTc: u.roadTc || _shortRoadNameForVerdict(detObj, true),
          tier,
          status,
          speedKmh,
          occ: tdOcc,
          roundaboutBottleneck: isRb,
          estDelayMins: tier === 'CONGESTED' ? 8 : (tier === 'MODERATE' ? 3 : 0),
          distKm,
          etaMins,
          severityScore,
          timeDecayWeight,
          impactScore,
          isApproaching: false,
          isFarAhead,
          farAheadNoteEn: isFarAhead ? 'Far ahead · may clear before arrival' : '',
          farAheadNoteTc: isFarAhead ? '較遠路段 · 抵達前或已消散' : '',
          detectorId: detObj.id || '',
          detId: detObj.id || '',
          det: detObj,
          cam: u.cam || null,
          camKey: u.camKey || detObj.camKey || '',
          camDesc: u.camDesc || u.cam?.desc || ''
        });
      } else if (u.source === 'BUS_API' && Number.isFinite(Number(u.speedKmh))) {
        if (u.isScheduledOnly && !u.isScheduledFallback) continue;
        const isTermApproach = Boolean(u.isTerminusApproach || _isTerminusApproachStopSpan(stops, u.toIdx, stops[u.toIdx]));
        const isVerifiedStall = Boolean(u.isVerifiedMultiBusStall);
        const speedKmh = Math.abs(Math.round(Number(u.speedKmh)));
        const tier = capBusApiTierHardcode(u.tier, speedKmh, {
          isTerminusApproach: isTermApproach,
          isScheduledFallback: Boolean(u.isScheduledFallback),
          isVerifiedMultiBusStall: isVerifiedStall
        });
        const status = tier === 'CONGESTED' ? 'JAMMED' : (tier === 'MODERATE' ? 'SLOW' : 'SMOOTH');
        const etaMins = _estimateRouteArrivalMins(distKm, speedKmh, hopKm >= 1.2);
        const timeDecayWeight = computeTimeToReachDecayWeight(etaMins, distKm);
        const severityScore = computeBottleneckSeverityScore({ spd: speedKmh, occ: 0, tier }, todCtx);
        const impactScore = Number((severityScore * timeDecayWeight).toFixed(2));
        const isFarAhead = (etaMins > 30 || distKm > 15);
        segments.push({
          key: `BUS_${betweenStops.fromSeq}_${betweenStops.toSeq}`,
          source: 'BUS_API',
          fromIdx: Number(u.fromIdx),
          toIdx: Number(u.toIdx),
          fromSeq: betweenStops.fromSeq,
          toSeq: betweenStops.toSeq,
          fromNameEn: betweenStops.fromNameEn,
          fromNameTc: betweenStops.fromNameTc,
          toNameEn: betweenStops.toNameEn,
          toNameTc: betweenStops.toNameTc,
          betweenStops,
          roadEn: `${betweenStops.fromNameEn} → ${betweenStops.toNameEn}`.trim(),
          roadTc: `${betweenStops.fromNameTc || betweenStops.fromNameEn} → ${betweenStops.toNameTc || betweenStops.toNameEn}`.trim(),
          tier,
          status,
          speedKmh,
          occ: 0,
          estDelayMins: tier === 'CONGESTED' ? 8 : (tier === 'MODERATE' ? 3 : 0),
          distKm,
          etaMins,
          severityScore,
          timeDecayWeight,
          impactScore,
          isApproaching: false,
          isFarAhead,
          isTerminusApproach: isTermApproach,
          isScheduledFallback: Boolean(u.isScheduledFallback),
          isVerifiedMultiBusStall: isVerifiedStall,
          isSyntheticFallback: false,
          farAheadNoteEn: isFarAhead ? 'Far ahead · may clear before arrival' : '',
          farAheadNoteTc: isFarAhead ? '較遠路段 · 抵達前或已消散' : '',
          detectorId: '',
          detId: '',
          det: null,
          cam: u.cam || null,
          camKey: u.camKey || '',
          camDesc: u.camDesc || ''
        });
      } else if (u.source === 'BUS_EST' && Number.isFinite(Number(u.speedKmh)) && Number(u.speedKmh) > 0) {
        const speedKmh = Math.abs(Math.round(Number(u.speedKmh)));
        const tier = speedKmh >= 18 ? 'SMOOTH' : 'MODERATE';
        const status = tier === 'MODERATE' ? 'SLOW' : 'SMOOTH';
        const etaMins = _estimateRouteArrivalMins(distKm, speedKmh, hopKm >= 1.2);
        const timeDecayWeight = computeTimeToReachDecayWeight(etaMins, distKm);
        const severityScore = computeBottleneckSeverityScore({ spd: speedKmh, occ: 0, tier }, todCtx);
        const impactScore = Number((severityScore * timeDecayWeight * 0.85).toFixed(2));
        const isFarAhead = (etaMins > 30 || distKm > 15);
        segments.push({
          key: `EST_${betweenStops.fromSeq}_${betweenStops.toSeq}`,
          source: 'BUS_EST',
          fromIdx: Number(u.fromIdx),
          toIdx: Number(u.toIdx),
          fromSeq: betweenStops.fromSeq,
          toSeq: betweenStops.toSeq,
          fromNameEn: betweenStops.fromNameEn,
          fromNameTc: betweenStops.fromNameTc,
          toNameEn: betweenStops.toNameEn,
          toNameTc: betweenStops.toNameTc,
          betweenStops,
          roadEn: `${betweenStops.fromNameEn} → ${betweenStops.toNameEn}`.trim(),
          roadTc: `${betweenStops.fromNameTc || betweenStops.fromNameEn} → ${betweenStops.toNameTc || betweenStops.toNameEn}`.trim(),
          tier,
          status,
          speedKmh,
          occ: 0,
          estDelayMins: tier === 'MODERATE' ? 2 : 0,
          distKm,
          etaMins,
          severityScore,
          timeDecayWeight,
          impactScore,
          isApproaching: false,
          isFarAhead,
          isTerminusApproach: false,
          isScheduledFallback: false,
          isVerifiedMultiBusStall: false,
          isSyntheticFallback: true,
          allowRed: false,
          farAheadNoteEn: isFarAhead ? 'Far ahead · estimated road-class flow' : '',
          farAheadNoteTc: isFarAhead ? '較遠路段 · 按道路類型估算' : '',
          detectorId: '',
          detId: '',
          det: null,
          cam: u.cam || null,
          camKey: u.camKey || '',
          camDesc: u.camDesc || ''
        });
      }
    }
    effectiveSameHits = unifiedTdHits;
  } else {
    // 3. Build segment-by-segment corridor bottlenecks with time-to-reach decay weighting
    const segBuckets = new Map();
    for (let i = 0; i < sameHits.length; i++) {
      const h = sameHits[i];
      const bs = h.betweenStops;
      const roadCore = _shortRoadNameForVerdict(h.det, false);
      const key = bs ? `STOP_${bs.fromSeq}_${bs.toSeq}` : `ROAD_${roadCore.toLowerCase()}`;
      if (!segBuckets.has(key)) {
        segBuckets.set(key, { key, betweenStops: bs || null, hits: [] });
      }
      segBuckets.get(key).hits.push(h);
    }

    for (const bucket of segBuckets.values()) {
      const bSum = summarizeDetectorBucket(bucket.hits);
      if (!bSum) continue;
      const wDet = bSum.worstDet || bSum.representativeDet;
      const wHit = bucket.hits.find(x => x.det === wDet) || bucket.hits[0];
      const distKm = Number((wHit?.aheadKm ?? bSum.aheadKm ?? 0).toFixed(1));
      const speedKmh = bSum.status === 'SMOOTH' ? bSum.avgSpd : bSum.minSpd;
      const wOcc = Math.abs(Number(wDet?.occ ?? bSum.maxOcc ?? 0) || 0);
      const tier = _normalizeBottleneckTier(wDet?.tier || bSum.status, speedKmh, wOcc);
      const isRb = Boolean(bSum.roundaboutBottleneck || isRoundaboutBottleneckHardcode(wDet));
      const isHwySpan = Boolean((bucket.betweenStops?.hopKm || 0) >= 1.2 || isExpresswayOrTunnelDetector(wDet));
      const etaMins = _estimateRouteArrivalMins(distKm, speedKmh, isHwySpan);
      const timeDecayWeight = computeTimeToReachDecayWeight(etaMins, distKm);
      const severityScore = computeBottleneckSeverityScore({ spd: speedKmh, occ: bSum.maxOcc, tier }, todCtx);
      const impactScore = Number((severityScore * timeDecayWeight * (isRb ? 1.15 : 1)).toFixed(2));
      const isFarAhead = (etaMins > 30 || distKm > 15);

      let farAheadNoteEn = '';
      let farAheadNoteTc = '';
      if (isFarAhead) {
        if (todCtx.trend === 'DISSIPATING' || todCtx.isLateNight || todCtx.period === 'OFF_PEAK') {
          farAheadNoteEn = 'Far ahead · may clear before arrival';
          farAheadNoteTc = '較遠路段 · 抵達前或已消散';
        } else if (todCtx.trend === 'BUILDING') {
          farAheadNoteEn = 'Far ahead · peak queues may build';
          farAheadNoteTc = '較遠路段 · 繁忙車龍或持續';
        } else {
          farAheadNoteEn = 'Far ahead · may clear before arrival';
          farAheadNoteTc = '較遠路段 · 抵達前或有變化';
        }
      }

      const matchedCam = (wDet?.camKey && camList.find(c => c.key === wDet.camKey))
        ? (() => {
            const cObj = camList.find(c => c.key === wDet.camKey);
            const dM = (cObj && Number.isFinite(Number(cObj.lat)))
              ? Math.round(_haversineKm(wDet.lat, wDet.lon, Number(cObj.lat), Number(cObj.lon)) * 1000)
              : 0;
            return {
              camKey: cObj.key,
              key: cObj.key,
              desc: cObj.desc || cObj.key,
              meters: dM,
              lat: Number(cObj.lat),
              lon: Number(cObj.lon),
              dir: cObj.dir || '',
              bearingDeg: cObj.bearingDeg
            };
          })()
        : _findNearestCamForPoint(wDet?.lat, wDet?.lon, forwardCameras, [], wDet?.rot, 0.65);

      segments.push({
        key: bucket.key,
        source: 'TD',
        fromSeq: bucket.betweenStops?.fromSeq ?? null,
        toSeq: bucket.betweenStops?.toSeq ?? null,
        fromNameEn: bucket.betweenStops?.fromNameEn || '',
        fromNameTc: bucket.betweenStops?.fromNameTc || '',
        toNameEn: bucket.betweenStops?.toNameEn || '',
        toNameTc: bucket.betweenStops?.toNameTc || '',
        betweenStops: bucket.betweenStops || null,
        roadEn: _shortRoadNameForVerdict(wDet, false),
        roadTc: _shortRoadNameForVerdict(wDet, true),
        tier,
        status: bSum.status,
        speedKmh,
        occ: bSum.maxOcc,
        roundaboutBottleneck: isRb,
        estDelayMins: bSum.estDelayMins,
        distKm,
        etaMins,
        severityScore,
        timeDecayWeight,
        impactScore,
        isApproaching: false,
        isFarAhead,
        farAheadNoteEn,
        farAheadNoteTc,
        detectorId: wDet?.id || '',
        detId: wDet?.id || '',
        det: wDet,
        cam: matchedCam,
        camKey: matchedCam?.camKey || matchedCam?.key || wDet?.camKey || '',
        camDesc: matchedCam?.desc || ''
      });
    }

    // Optional Bus Speed Layer gap-fill segments (ONLY for stop stretches NOT covered by TD detectors/links)
    const busSpeedSegments = Array.isArray(opts?.busSpeedSegments) ? opts.busSpeedSegments : [];
    if (busSpeedSegments.length) {
      const tdCoveredSeqs = new Set(segments.filter(s => s.fromSeq && s.toSeq).map(s => `${s.fromSeq}_${s.toSeq}`));
      const tdSpeedGeo = opts?.tdSpeedGeoJson !== undefined
        ? opts.tdSpeedGeoJson
        : (typeof window !== 'undefined' ? window.__LIVE_TRAFFIC_SPEED_GEOJSON__ : null);
      const tdCoverFn = (typeof window !== 'undefined' && typeof window.isSegmentCoveredByTdGroundTruth === 'function')
        ? window.isSegmentCoveredByTdGroundTruth
        : (typeof isSegmentCoveredByTdGroundTruth === 'function' ? isSegmentCoveredByTdGroundTruth : null);
      let cumBusKm = 0;
      for (let i = 0; i < busSpeedSegments.length; i++) {
        const bs = busSpeedSegments[i];
        if (!bs || bs.fromIdx < fromIdx) continue;
        if (hasExitClamp && bs.toIdx > Number(rawExitIdx)) continue;
        const seqKey = `${bs.fromSeq}_${bs.toSeq}`;
        const segDistKm = Number((cumBusKm + (bs.roadDistKm || 0) * 0.5).toFixed(1));
        cumBusKm += (bs.roadDistKm || 0);
        if (tdCoveredSeqs.has(seqKey) || bs.coveredByTd || bs.tdCovered || bs.source === 'TD' || bs.isScheduledOnly) continue;
        if (tdCoverFn && Array.isArray(bs.coords) && bs.coords.length >= 2 && tdCoverFn(bs.coords, detectors, tdSpeedGeo, { maxDistKm: 0.10, maxAngDeg: 45 })) continue;
        if (segDistKm > maxLookaheadKm + 0.05) break;
        const isEstSeg = Boolean(bs.source === 'BUS_EST' || bs.isSyntheticFallback);
        const isTermApproach = Boolean(bs.isTerminusApproach || _isTerminusApproachStopSpan(stops, bs.toIdx, stops[bs.toIdx]));
        const isVerifiedStall = !isEstSeg && Boolean(bs.isVerifiedMultiBusStall);
        const tier = isEstSeg
          ? (Math.abs(Number(bs.speedKmh)) >= 18 ? 'SMOOTH' : 'MODERATE')
          : capBusApiTierHardcode(bs.tier, bs.speedKmh, {
              isTerminusApproach: isTermApproach,
              isScheduledFallback: Boolean(bs.isScheduledFallback),
              isVerifiedMultiBusStall: isVerifiedStall
            });
        const etaMins = _estimateRouteArrivalMins(segDistKm, bs.speedKmh, (bs.roadDistKm || 0) >= 1.2);
        const timeDecayWeight = computeTimeToReachDecayWeight(etaMins, segDistKm);
        const severityScore = computeBottleneckSeverityScore({ spd: bs.speedKmh, occ: 0, tier }, todCtx);
        const impactScore = Number((severityScore * timeDecayWeight * (isEstSeg ? 0.85 : 1)).toFixed(2));
        const isFarAhead = (etaMins > 30 || segDistKm > 15);
        segments.push({
          key: `${isEstSeg ? 'EST' : 'BUS'}_${seqKey}`,
          source: isEstSeg ? 'BUS_EST' : 'BUS_API',
          fromIdx: Number(bs.fromIdx),
          toIdx: Number(bs.toIdx),
          fromSeq: bs.fromSeq,
          toSeq: bs.toSeq,
          fromNameEn: bs.fromNameEn || '',
          fromNameTc: bs.fromNameTc || '',
          toNameEn: bs.toNameEn || '',
          toNameTc: bs.toNameTc || '',
          betweenStops: {
            fromSeq: bs.fromSeq,
            toSeq: bs.toSeq,
            fromNameEn: bs.fromNameEn || '',
            fromNameTc: bs.fromNameTc || '',
            toNameEn: bs.toNameEn || '',
            toNameTc: bs.toNameTc || '',
            hopKm: Number((bs.roadDistKm || 0).toFixed(1))
          },
          roadEn: `${bs.fromNameEn || ''} → ${bs.toNameEn || ''}`.trim(),
          roadTc: `${bs.fromNameTc || bs.fromNameEn || ''} → ${bs.toNameTc || bs.toNameEn || ''}`.trim(),
          tier,
          status: tier === 'CONGESTED' ? 'JAMMED' : (tier === 'MODERATE' ? 'SLOW' : 'SMOOTH'),
          speedKmh: Math.abs(Math.round(bs.speedKmh)),
          occ: 0,
          estDelayMins: tier === 'CONGESTED' ? 8 : (tier === 'MODERATE' ? (isEstSeg ? 2 : 3) : 0),
          distKm: segDistKm,
          etaMins,
          severityScore,
          timeDecayWeight,
          impactScore,
          isApproaching: false,
          isFarAhead,
          isTerminusApproach: isTermApproach,
          isScheduledFallback: Boolean(bs.isScheduledFallback),
          isVerifiedMultiBusStall: isVerifiedStall,
          isSyntheticFallback: isEstSeg,
          allowRed: !isEstSeg && Boolean(isVerifiedStall),
          farAheadNoteEn: isFarAhead ? 'Far ahead · may clear before arrival' : '',
          farAheadNoteTc: isFarAhead ? '較遠路段 · 抵達前或已消散' : '',
          detectorId: '',
          detId: '',
          det: null,
          cam: bs.cam || null,
          camKey: bs.camKey || '',
          camDesc: bs.camDesc || ''
        });
      }
    }
  }

  segments.sort((a, b) => a.distKm - b.distKm);

  const rankedBottlenecks = [
    ...(approaching ? [approaching] : []),
    ...segments
  ].sort((a, b) => {
    if (b.impactScore !== a.impactScore) return b.impactScore - a.impactScore;
    return a.distKm - b.distKm;
  });

  const sameSide = summarizeDetectorBucket(effectiveSameHits);
  const oppSide = summarizeDetectorBucket(oppHits);

  let leadSegment = null;
  if (useUnified) {
    const leadPick = selectWorstAheadStopSegment(opts.unifiedSegments, stops, fromIdx, {
      exitStopIdx: hasExitClamp ? rawExitIdx : null,
      maxLookaheadKm,
      lookaheadStops: effLookahead
    });
    if (leadPick) {
      leadSegment = segments.find(
        s => !s.isApproaching && Number(s.fromIdx) === leadPick.fromIdx && Number(s.toIdx) === leadPick.toIdx
      ) || null;
    }
  }

  // Override worstDet on sameSide so detector, speed, status, and stop-span label ALWAYS come from the exact same segment.
  if (useUnified && leadSegment && leadSegment.source === 'TD' && leadSegment.det && sameSide) {
    const leadSpd = Math.abs(Math.round(Number(leadSegment.speedKmh ?? leadSegment.det.spd ?? sameSide.minSpd)));
    sameSide.worstDet = leadSegment.det;
    sameSide.representativeDet = leadSegment.det;
    sameSide.aheadKm = leadSegment.distKm;
    sameSide.betweenStops = leadSegment.betweenStops || sameSide.betweenStops;
    sameSide.minSpd = leadSpd;
    sameSide.avgSpd = leadSpd;
    sameSide.status = leadSegment.status || sameSide.status;
    sameSide.maxOcc = Math.abs(Math.round(Number(leadSegment.occ ?? leadSegment.det.occ ?? sameSide.maxOcc) || 0));
    sameSide.estDelayMins = Number(leadSegment.estDelayMins ?? sameSide.estDelayMins) || 0;
    sameSide.roundaboutBottleneck = Boolean(leadSegment.roundaboutBottleneck || sameSide.roundaboutBottleneck);
  } else if (!useUnified) {
    // Non-unified path: use time-to-reach weighted bottleneck ranking so a minor jam 25 km away never outranks an active bottleneck 2 km ahead
    const topTdSeg = rankedBottlenecks.find(s => !s.isApproaching && s.source === 'TD' && s.det);
    if (sameSide && topTdSeg && topTdSeg.det) {
      sameSide.worstDet = topTdSeg.det;
      sameSide.aheadKm = topTdSeg.distKm;
      sameSide.betweenStops = topTdSeg.betweenStops || sameSide.betweenStops;
      sameSide.minSpd = Math.round(Number(topTdSeg.det.spd ?? sameSide.minSpd));
      sameSide.roundaboutBottleneck = Boolean(topTdSeg.roundaboutBottleneck || sameSide.roundaboutBottleneck);
    }
  }

  // Ensure any paired camera on the primary forward detector is also located along the forward polyline (never behind the stop)
  if (sameSide && camList.length) {
    const forwardCamKeySet = new Set(forwardCameras.map(fc => fc.cam.key));
    const attachSafeForwardCam = (detObj) => {
      if (!detObj) return detObj;
      if (detObj.camKey && detObj.id && detObj.camKey === detObj.id) {
        return detObj;
      }
      if (detObj.camKey && !forwardCamKeySet.has(detObj.camKey)) {
        const camInfo = camList.find(c => c.key === detObj.camKey);
        if (camInfo && forwardCameras.length) {
          const nearFwd = forwardCameras.find(fc => _haversineKm(detObj.lat, detObj.lon, fc.cam.lat, fc.cam.lon) <= 0.65);
          return { ...detObj, camKey: nearFwd ? nearFwd.cam.key : '' };
        }
        if (camInfo) return { ...detObj, camKey: '' };
      } else if (!detObj.camKey && forwardCameras.length) {
        const nearFwd = forwardCameras.find(fc => _haversineKm(detObj.lat, detObj.lon, fc.cam.lat, fc.cam.lon) <= 0.65);
        if (nearFwd) return { ...detObj, camKey: nearFwd.cam.key };
      }
      return detObj;
    };
    sameSide.worstDet = attachSafeForwardCam(sameSide.worstDet);
    sameSide.representativeDet = attachSafeForwardCam(sameSide.representativeDet);
  }

  const stopBreakdownSegments = segments.map((s) => ({
    fromIdx: s.fromIdx ?? (s.fromSeq ? s.fromSeq - 1 : null),
    toIdx: s.toIdx ?? (s.toSeq ? s.toSeq - 1 : null),
    fromSeq: s.fromSeq,
    toSeq: s.toSeq,
    fromNameEn: s.fromNameEn || '',
    fromNameTc: s.fromNameTc || '',
    toNameEn: s.toNameEn || '',
    toNameTc: s.toNameTc || '',
    source: s.source,
    tier: s.tier,
    speedKmh: Math.abs(Math.round(Number(s.speedKmh))),
    occ: Math.abs(Math.round(Number(s.occ) || 0)),
    roadEn: s.roadEn || '',
    roadTc: s.roadTc || '',
    detId: s.detId || '',
    camKey: s.camKey || '',
    distKm: s.distKm,
    roundaboutBottleneck: Boolean(s.roundaboutBottleneck),
    isTerminusApproach: Boolean(s.isTerminusApproach),
    isVerifiedMultiBusStall: Boolean(s.isVerifiedMultiBusStall),
    isSyntheticFallback: Boolean(s.isSyntheticFallback || s.source === 'BUS_EST')
  }));

  const hasBusApiSegment = segments.some(s => s.source === 'BUS_API' || s.source === 'BUS_EST');
  return {
    sameSide,
    oppSide,
    approaching,
    leadSegment,
    segments,
    stopBreakdownSegments,
    rankedBottlenecks,
    forwardCameras,
    aheadCam,
    timeOfDayContext: todCtx,
    hasLive: Boolean(sameSide || oppSide || approaching || hasBusApiSegment),
    capturedAt: '',
    usedRoadPolyline: Boolean(Array.isArray(snappedAhead) && snappedAhead.length > 0)
  };
}

function _formatBetweenStopsLabel(betweenStops, isZh = false) {
  if (!betweenStops || !betweenStops.fromNameEn || !betweenStops.toNameEn) return '';
  if (isZh) {
    const f = betweenStops.fromNameTc || betweenStops.fromNameEn;
    const t = betweenStops.toNameTc || betweenStops.toNameEn;
    return `${f} → ${t} 之間`;
  }
  return `Between ${betweenStops.fromNameEn} → ${betweenStops.toNameEn}`;
}

function getDirectionalRoadSummary(stops, startIdx, detectors, isZh = false, lookaheadStops = 40, roadPolylinePoints = null, maxLookaheadMeters = 12000, cameras = null, opts = {}) {
  const res = inferDirectionalRoadTrafficForStops(stops, startIdx, detectors, lookaheadStops, roadPolylinePoints, maxLookaheadMeters, cameras, opts);
  if (!res.hasLive) return null;

  const same = res.sameSide;
  const opp = res.oppSide;
  const approaching = res.approaching;
  const oppDet = opp?.worstDet || opp?.representativeDet || null;
  const firstRanked = res.rankedBottlenecks?.[0] || null;
  const todCtx = res.timeOfDayContext;

  // Determine whether upstream "Jam Before Stop" is the top-ranked concern (only when severe/active vs smooth/absent forward)
  const approachingLeads = Boolean(
    approaching &&
    (!same || same.status === 'SMOOTH' || (firstRanked && firstRanked.isApproaching))
  );

  // Use unified worst-ahead leadSegment when available so stop-row pill and expanded banner ALWAYS match
  const topRanked = approachingLeads ? firstRanked : (res.leadSegment || firstRanked);

  // If forward road is governed by a unified Bus API or synthetic BUS_EST segment
  const busApiLeads = Boolean(
    topRanked &&
    !topRanked.isApproaching &&
    (topRanked.source === 'BUS_API' || topRanked.source === 'BUS_EST') &&
    (
      Boolean(res.leadSegment && !approachingLeads) ||
      (!same && !approachingLeads) ||
      (same && same.status === 'SMOOTH' && !approachingLeads && (topRanked.tier === 'CONGESTED' || topRanked.tier === 'MODERATE'))
    )
  );
  if (busApiLeads) {
    const isBusEst = Boolean(topRanked.source === 'BUS_EST' || topRanked.isSyntheticFallback);
    // Anchor banner on the capped Bus API / BUS_EST tier so stop-row pill and expanded card NEVER contradict,
    // and single-bus Bus API / BUS_EST stretches NEVER render Red (Jammed).
    const cappedBusTier = isBusEst
      ? ((Number.isFinite(Number(topRanked.speedKmh)) && Math.abs(Number(topRanked.speedKmh)) >= 18) ? 'SMOOTH' : 'MODERATE')
      : capBusApiTierHardcode(topRanked.tier, topRanked.speedKmh, {
          isTerminusApproach: Boolean(topRanked.isTerminusApproach),
          isScheduledFallback: Boolean(topRanked.isScheduledFallback),
          isVerifiedMultiBusStall: Boolean(topRanked.isVerifiedMultiBusStall)
        });
    const busTone = cappedBusTier === 'CONGESTED' ? 'jammed' : (cappedBusTier === 'MODERATE' ? 'slow' : 'smooth');
    const busHeadline = isBusEst
      ? (cappedBusTier === 'MODERATE'
        ? (isZh ? '估算車流稍慢' : 'Estimated Slow Flow')
        : (isZh ? '估算行車暢通' : 'Estimated Clear Flow'))
      : (cappedBusTier === 'CONGESTED'
        ? (isZh ? '巴士車流嚴重受阻 · 多班緩慢' : 'Jammed Bus Flow · Multi-Bus Stall')
        : (cappedBusTier === 'MODERATE'
          ? (isZh ? '巴士車流偏慢' : 'Slow Bus Flow')
          : (isZh ? '巴士車流暢通' : 'Clear Bus Flow')));
    const betweenLabel = topRanked.betweenStops ? _formatBetweenStopsLabel(topRanked.betweenStops, isZh) : '';
    const absSpd = Number.isFinite(Number(topRanked.speedKmh)) && Number(topRanked.speedKmh) > 0
      ? Math.abs(Math.round(Number(topRanked.speedKmh)))
      : null;
    const busSrcLabel = isBusEst
      ? (absSpd !== null
        ? (isZh ? `🚌 路況估算 • ${absSpd} km/h` : `🚌 Bus Est. • ${absSpd} km/h`)
        : (isZh ? '🚌 路況估算' : '🚌 Bus Est.'))
      : (absSpd !== null
        ? (isZh ? `🚌 巴士推算 • ${absSpd} km/h` : `🚌 Bus API • ${absSpd} km/h`)
        : (isZh ? '🚌 巴士推算' : '🚌 Bus API'));
    return {
      ...res,
      tone: busTone,
      modeRec: cappedBusTier === 'CONGESTED' ? 'MTR_FASTER' : 'TAKE_BUS',
      headline: busHeadline,
      detail: [
        busSrcLabel,
        betweenLabel,
        topRanked.etaMins ? (isZh ? `約 ${topRanked.etaMins} 分鐘後` : `${Math.abs(Math.round(Number(topRanked.etaMins)))}m ahead`) : ''
      ].filter(Boolean).join(' · '),
      actionTip: isBusEst
        ? (isZh ? '此路段暫無運輸署感應器或實時配對，按道路類型及距離估算' : 'No TD sensor or live ETA pair on this stretch — estimated from road class & distance')
        : (isZh ? '此路段未設運輸署感應器，以巴士實時站間時間推算' : 'No TD sensor on this stretch — inferred from live bus stop-to-stop ETAs'),
      delayLabel: cappedBusTier === 'CONGESTED' ? '+6–10m' : (cappedBusTier === 'MODERATE' ? (isBusEst ? '+1–3m' : '+2–4m') : (isZh ? '無延誤' : 'No delay')),
      densityLabel: isBusEst ? (isZh ? '道路類型估算' : 'Road-class estimate') : (isZh ? '巴士實時推算' : 'Bus API speed'),
      aheadKm: topRanked.distKm,
      betweenLabel,
      isApproaching: false,
      focusDet: null,
      oppDet: oppDet || null
    };
  }

  const primary = same || (approachingLeads ? approaching : opp);
  const focusDet = approachingLeads
    ? approaching.det
    : ((same?.status === 'JAMMED' || same?.status === 'SLOW')
      ? same.worstDet
      : (same?.representativeDet || same?.worstDet || (opp?.status === 'JAMMED' ? opp.worstDet : (primary?.representativeDet || primary?.det || null))));

  const syntheticApproachingSame = (!same && approaching)
    ? {
        status: approaching.status,
        avgSpd: approaching.avgSpd,
        minSpd: approaching.minSpd,
        maxOcc: approaching.maxOcc,
        estDelayMins: approaching.estDelayMins,
        worstDet: approaching.det,
        representativeDet: approaching.det
      }
    : same;

  // Forward directional summary stays strictly scoped to the route's own travel direction:
  // opposite-carriageway jams are NEVER injected into the banner (opp param intentionally null).
  const decision = synthesizeTrafficDecision(syntheticApproachingSame, null, isZh);
  if (!decision) return null;

  const roadLabel = focusDet ? _sanitizeDirectionTyposHardcode(isZh ? (focusDet.roadTc || focusDet.roadEn) : (focusDet.roadEn || focusDet.roadTc)) : '';
  const aheadKm = Math.abs(Number((topRanked && !topRanked.isApproaching ? topRanked.distKm : primary?.aheadKm) || 0));
  const betweenStops = (topRanked && !topRanked.isApproaching ? topRanked.betweenStops : primary?.betweenStops) || null;
  const showBetween = Boolean(betweenStops && ((same?.status !== 'SMOOTH') || (betweenStops.hopKm || 0) >= 1.8));
  const betweenLabel = showBetween ? _formatBetweenStopsLabel(betweenStops, isZh) : '';
  const aheadStr = (!betweenLabel && aheadKm >= 0.4)
    ? (isZh ? `前方約 ${aheadKm.toFixed(1)} km` : `${aheadKm.toFixed(1)} km ahead`)
    : '';

  let headline = isZh ? decision.verdictTc : decision.verdictEn;
  if (approachingLeads && (!same || same.status === 'SMOOTH')) {
    const rShort = _sanitizeDirectionTyposHardcode(isZh ? approaching.roadTc : approaching.roadEn);
    headline = isZh
      ? `到站前塞車 · ${rShort} (${Math.abs(approaching.minSpd)} km/h)`
      : `Jam before stop · ${rShort} (${Math.abs(approaching.minSpd)} km/h)`;
  }

  const detailParts = [];
  if (approachingLeads) {
    detailParts.push(`${Math.abs(approaching.minSpd)} km/h`);
    detailParts.push(isZh ? `站前 ${Math.abs(approaching.distKm).toFixed(1)} km` : `${Math.abs(approaching.distKm).toFixed(1)} km before stop`);
  } else if (same) {
    const spdDisp = same.status === 'SMOOTH' ? `${Math.abs(Math.round(Number(same.avgSpd)))}` : `${Math.abs(Math.round(Number(same.minSpd)))}`;
    detailParts.push(`${spdDisp} km/h`);
    if (same.status !== 'SMOOTH' && Math.abs(Number(same.worstDet?.occ) || 0) > 0) {
      detailParts.push(isZh ? `佔用率 ${Math.abs(Math.round(Number(same.worstDet.occ)))}%` : `${Math.abs(Math.round(Number(same.worstDet.occ)))}% occ`);
    }
  }
  if (roadLabel) detailParts.push(roadLabel);
  if (betweenLabel) detailParts.push(betweenLabel);
  else if (aheadStr && !approachingLeads) detailParts.push(aheadStr);
  if (topRanked && topRanked.isFarAhead && (topRanked.tier === 'CONGESTED' || topRanked.tier === 'MODERATE')) {
    detailParts.push(isZh ? topRanked.farAheadNoteTc : topRanked.farAheadNoteEn);
  }
  if (todCtx && (todCtx.isPeak || todCtx.trend === 'BUILDING' || todCtx.isLateNight)) {
    detailParts.push(isZh ? todCtx.labelTc : todCtx.labelEn);
  }

  return {
    ...res,
    tone: approachingLeads ? (approaching.tier === 'CONGESTED' ? 'jammed' : 'slow') : decision.tone,
    modeRec: decision.modeRec,
    headline,
    detail: detailParts.join(' · '),
    actionTip: isZh ? decision.actionTc : decision.actionEn,
    delayLabel: isZh ? decision.delayLabelTc : decision.delayLabelEn,
    densityLabel: isZh ? decision.densityTc : decision.densityEn,
    aheadKm,
    betweenLabel,
    isApproaching: approachingLeads,
    focusDet,
    oppDet
  };
}

// ============================================================================
// BUS API SPEED INFERENCE ENGINE (SEPARATE BUS SPEED LAYER & TD GAP-FILLER)
// ============================================================================
function getBusSpeedLayerColorHex(tier, speedKmh = null) {
  const tRaw = String(tier || '').toUpperCase();
  if (tRaw === 'CONGESTED' || tRaw === 'JAMMED') return '#e11d48';
  if (tRaw === 'MODERATE' || tRaw === 'SLOW') return '#f59e0b';
  if (tRaw === 'SMOOTH') return '#10b981';
  const t = _normalizeBottleneckTier(tier, speedKmh);
  if (t === 'CONGESTED') return '#e11d48';
  if (t === 'MODERATE') return '#f59e0b';
  return '#10b981';
}

function inferBusApiSegmentSpeeds(stops, etaByStopIdx, roadPolylinePoints = null, opts = {}) {
  if (typeof window !== 'undefined' && window.BusSpeedEngine && typeof window.BusSpeedEngine.inferBusApiSegmentSpeeds === 'function') {
    return window.BusSpeedEngine.inferBusApiSegmentSpeeds(stops, etaByStopIdx, roadPolylinePoints, opts);
  }
  if (!Array.isArray(stops) || stops.length < 2 || !etaByStopIdx) return [];
  const getArrForIdx = (idx) => {
    if (etaByStopIdx instanceof Map) return etaByStopIdx.get(idx) || [];
    if (Array.isArray(etaByStopIdx)) return etaByStopIdx[idx] || [];
    return etaByStopIdx[idx] || etaByStopIdx[String(idx)] || [];
  };

  const stopPolyIdx = (Array.isArray(roadPolylinePoints) && roadPolylinePoints.length >= 2)
    ? _mapStopsToRoadPolylineIndices(stops, roadPolylinePoints)
    : new Map();
  const tdCoveredPairs = opts.tdCoveredStopPairs instanceof Set ? opts.tdCoveredStopPairs : null;
  const onlyUncovered = Boolean(opts.onlyUncoveredByTd);
  const routeNo = String(opts.routeNo || '');
  const company = String(opts.company || '');
  const out = [];

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const la1 = parseFloat(a?.latitude ?? a?.lat), lo1 = parseFloat(a?.longitude ?? a?.lon);
    const la2 = parseFloat(b?.latitude ?? b?.lat), lo2 = parseFloat(b?.longitude ?? b?.lon);
    if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;

    const coveredByTd = Boolean(tdCoveredPairs && tdCoveredPairs.has(`${i + 1}_${i + 2}`));
    if (onlyUncovered && coveredByTd) continue;

    // Slice road geometry between stop i and i + 1 if road-snapped polyline is available
    let segCoords = [[la1, lo1], [la2, lo2]];
    let roadDistKm = _haversineKm(la1, lo1, la2, lo2) * 1.12;
    const pA = stopPolyIdx.get(i), pB = stopPolyIdx.get(i + 1);
    if (pA !== undefined && pB !== undefined && pB > pA) {
      const sliced = roadPolylinePoints.slice(pA, pB + 1);
      if (sliced.length >= 2) {
        segCoords = sliced;
        let dSum = 0;
        for (let k = 0; k < sliced.length - 1; k++) {
          dSum += _haversineKm(sliced[k][0], sliced[k][1], sliced[k + 1][0], sliced[k + 1][1]);
        }
        if (dSum >= 0.05) roadDistKm = dSum;
      }
    }
    if (roadDistKm < 0.08 || roadDistKm > 28) continue;

    const arrA = (getArrForIdx(i) || [])
      .map(x => ({
        ms: Number(x?.rawTargetMs ?? x?.targetMs ?? (x?.eta ? new Date(x.eta).getTime() : NaN)),
        seq: Number(x?.etaSeq ?? x?.eta_seq ?? 0)
      }))
      .filter(x => Number.isFinite(x.ms))
      .sort((x, y) => x.ms - y.ms);
    const arrB = (getArrForIdx(i + 1) || [])
      .map(x => ({
        ms: Number(x?.rawTargetMs ?? x?.targetMs ?? (x?.eta ? new Date(x.eta).getTime() : NaN)),
        seq: Number(x?.etaSeq ?? x?.eta_seq ?? 0)
      }))
      .filter(x => Number.isFinite(x.ms))
      .sort((x, y) => x.ms - y.ms);

    if (!arrA.length || !arrB.length) continue;

    // Physical travel time bounds (3 km/h crawl to 95 km/h highway + dwell)
    const minSec = Math.max(15, (roadDistKm / 95) * 3600);
    const maxSec = Math.min(2400, (roadDistKm / 3) * 3600 + 180);
    const validDeltas = [];
    const usedB = new Set();

    for (let ai = 0; ai < arrA.length; ai++) {
      const ea = arrA[ai];
      let bestIdx = -1;
      let bestDelta = Infinity;
      for (let bi = 0; bi < arrB.length; bi++) {
        if (usedB.has(bi)) continue;
        const eb = arrB[bi];
        const dSec = (eb.ms - ea.ms) / 1000;
        if (dSec < minSec || dSec > maxSec) continue;
        // Prefer matching eta_seq when present, otherwise closest physically valid forward progression
        const seqBonus = (ea.seq > 0 && eb.seq === ea.seq) ? -20 : 0;
        if (dSec + seqBonus < bestDelta) {
          bestDelta = dSec + seqBonus;
          bestIdx = bi;
        }
      }
      if (bestIdx >= 0) {
        usedB.add(bestIdx);
        validDeltas.push((arrB[bestIdx].ms - ea.ms) / 1000);
      }
    }

    if (!validDeltas.length) continue;
    validDeltas.sort((x, y) => x - y);
    const deltaSec = validDeltas[Math.floor(validDeltas.length / 2)];
    const dwellSec = Math.min(deltaSec * 0.25, roadDistKm < 0.6 ? 20 : 12);
    const movingSec = Math.max(12, deltaSec - dwellSec);
    const speedKmh = Math.max(3, Math.min(95, Number(((roadDistKm / (movingSec / 3600))).toFixed(1))));

    const distM = roadDistKm * 1000;
    const highwayRatio = Math.min(1, Math.max(0, (distM - 500) / 1800));
    const expectedKmh = Math.round(18 + highwayRatio * 42);
    let severeSlowBusCount = 0;
    for (let vi = 0; vi < validDeltas.length; vi++) {
      const dS = validDeltas[vi];
      const dwS = Math.min(dS * 0.25, roadDistKm < 0.6 ? 20 : 12);
      const mvS = Math.max(12, dS - dwS);
      const busSpd = roadDistKm / (mvS / 3600);
      if (busSpd < 8) severeSlowBusCount++;
    }
    const isVerifiedMultiBusStall = Boolean(validDeltas.length >= 2 && severeSlowBusCount >= 2 && speedKmh < 8);
    const tier = capBusApiTierHardcode('', speedKmh, { isVerifiedMultiBusStall });

    out.push({
      fromIdx: i,
      toIdx: i + 1,
      fromSeq: i + 1,
      toSeq: i + 2,
      fromNameEn: _stripStopPlatformSuffix(a?.stopName_e || a?.name_tc || ''),
      fromNameTc: _stripStopPlatformSuffix(a?.name_tc || a?.stopName_e || ''),
      toNameEn: _stripStopPlatformSuffix(b?.stopName_e || b?.name_tc || ''),
      toNameTc: _stripStopPlatformSuffix(b?.name_tc || b?.stopName_e || ''),
      routeNo,
      company,
      roadDistKm: Number(roadDistKm.toFixed(2)),
      deltaSec: Math.round(deltaSec),
      speedKmh,
      expectedKmh,
      matchedBusCount: validDeltas.length,
      isVerifiedMultiBusStall,
      tier,
      isBottleneck: tier === 'CONGESTED' || tier === 'MODERATE',
      color: getBusSpeedLayerColorHex(tier, speedKmh),
      source: 'BUS_API',
      coveredByTd,
      coords: segCoords
    });
  }

  return out;
}

// ============================================================================
// ROUTE-LEVEL SPEED DIGITAL TWIN (GeoJSON FeatureCollection Builder)
// ============================================================================
function getTrafficSpeedColorHex(speedKmh, noDataColor = '#3b82f6') {
  if (speedKmh === null || speedKmh === undefined) return noDataColor;
  const s = Number(speedKmh);
  if (!Number.isFinite(s) || s <= 0) return noDataColor;
  if (s < 20) return '#dc2626';
  if (s <= 40) return '#f59e0b';
  return '#16a34a';
}

function buildRouteSpeedGeoJson(coords, detectors = [], opts = {}) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return { type: 'FeatureCollection', features: [] };
  }
  const optObj = (opts && typeof opts === 'object')
    ? opts
    : { noDataColor: (typeof opts === 'string' && opts) ? opts : '#3b82f6' };
  const noDataColor = optObj.noDataColor || '#3b82f6';
  const isRoadSnapped = optObj.isRoadSnapped !== false;
  const hasHighwaySpan = Boolean(optObj.hasHighwaySpan);
  const maxMatchKm = Number(optObj.maxMatchKm) || (isRoadSnapped ? 0.060 : 0.12);
  const sideStreetMaxMatchKm = Math.min(maxMatchKm, 0.045);
  const maxAngleDeg = Number(optObj.maxAngleDeg) || (isRoadSnapped ? 42 : 45);
  const influenceRadiusKm = Number(optObj.influenceRadiusKm) || 0.70;
  const maxMicroStepKm = Number(optObj.maxMicroStepKm) || 0.15;
  const stops = Array.isArray(optObj.stops) ? optObj.stops : [];
  const rawStopSegments = Array.isArray(optObj.stopSegments) ? optObj.stopSegments : [];
  const routeCtx = { routeNo: String(optObj.routeNo || '').trim(), stops };

  // Index optional unified stop-by-stop segments (TD / BUS_API / BUS_EST) for merging onto TD-blind stretches
  const stopSegByFromIdx = new Map();
  const stopSegByFromSeq = new Map();
  const knownStopFromIdxs = new Set();
  const paintableStopSegs = [];
  for (let i = 0; i < rawStopSegments.length; i++) {
    const s = rawStopSegments[i];
    if (!s) continue;
    const fIdx = Number(s.fromIdx);
    const fSeq = Number(s.fromSeq);
    if (Number.isFinite(fIdx)) knownStopFromIdxs.add(fIdx);
    const src = String(s.source || '').toUpperCase();
    if (src !== 'TD' && src !== 'BUS_API' && src !== 'BUS_EST') continue;
    if (src === 'BUS_API' && s.isScheduledOnly && !s.isScheduledFallback) continue;
    const spdNum = Number(s.speedKmh);
    if (!Number.isFinite(spdNum) || spdNum <= 0) continue;
    if (Number.isFinite(fIdx)) {
      const prev = stopSegByFromIdx.get(fIdx);
      const rankSrc = (x) => (x === 'TD' ? 3 : (x === 'BUS_API' ? 2 : 1));
      if (!prev || rankSrc(src) > rankSrc(String(prev.source || '').toUpperCase())) {
        stopSegByFromIdx.set(fIdx, s);
      }
    }
    if (Number.isFinite(fSeq)) {
      const prev = stopSegByFromSeq.get(fSeq);
      const rankSrc = (x) => (x === 'TD' ? 3 : (x === 'BUS_API' ? 2 : 1));
      if (!prev || rankSrc(src) > rankSrc(String(prev.source || '').toUpperCase())) {
        stopSegByFromSeq.set(fSeq, s);
      }
    }
    if (Array.isArray(s.coords) && s.coords.length >= 2) {
      paintableStopSegs.push(s);
    }
  }

  // 1. Densify long segments so speed color transitions localize cleanly around each TD detector
  const densePts = [];
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    const lat = Number(p[0]), lon = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!densePts.length) {
      densePts.push([lat, lon]);
      continue;
    }
    const prev = densePts[densePts.length - 1];
    const segKm = _haversineKm(prev[0], prev[1], lat, lon);
    if (segKm < 0.004) continue;
    if (segKm > maxMicroStepKm) {
      const steps = Math.min(48, Math.ceil(segKm / maxMicroStepKm));
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        densePts.push([prev[0] + (lat - prev[0]) * f, prev[1] + (lon - prev[1]) * f]);
      }
    } else {
      densePts.push([lat, lon]);
    }
  }
  if (densePts.length < 2) return { type: 'FeatureCollection', features: [] };

  // Optional stop-to-polyline attribution so non-highway side streets enforce <= 45m & road-name compatibility
  // and uncovered stop spans can bind directly to unified BUS_API / BUS_EST telemetry.
  const stopSpanMetaByDenseIdx = [];
  if (stops.length >= 2) {
    const stopIdxMap = _mapStopsToRoadPolylineIndices(stops, densePts);
    const orderedMapped = [];
    for (let i = 0; i < stops.length; i++) {
      if (stopIdxMap.has(i)) orderedMapped.push({ stopIdx: i, polyIdx: stopIdxMap.get(i) });
    }
    for (let k = 0; k < orderedMapped.length - 1; k++) {
      const cur = orderedMapped[k];
      const nxt = orderedMapped[k + 1];
      const sA = stops[cur.stopIdx];
      const sB = stops[nxt.stopIdx];
      const hopKm = _haversineKm(
        parseFloat(sA?.latitude ?? sA?.lat) || 0,
        parseFloat(sA?.longitude ?? sA?.lon) || 0,
        parseFloat(sB?.latitude ?? sB?.lat) || 0,
        parseFloat(sB?.longitude ?? sB?.lon) || 0
      );
      const isBbiSeg = Boolean(isMajorTunnelBbiStop(sA) || isMajorTunnelBbiStop(sB));
      const spanMeta = {
        fromStopIdx: cur.stopIdx,
        toStopIdx: nxt.stopIdx,
        betweenStops: {
          fromSeq: sA?.seq ?? (cur.stopIdx + 1),
          toSeq: sB?.seq ?? (nxt.stopIdx + 1),
          fromNameEn: sA?.stopName_e || sA?.name_en || '',
          fromNameTc: sA?.name_tc || '',
          toNameEn: sB?.stopName_e || sB?.name_en || '',
          toNameTc: sB?.name_tc || ''
        },
        parentHopKm: hopKm,
        hopKm,
        isBbiSeg,
        isHighwaySpan: false
      };
      spanMeta.isHighwaySpan = Boolean(isBbiSeg || (hopKm >= 1.25 && !_isLocalRoadSpanNonHighwayHardcode(spanMeta)));
      const startP = Math.max(0, cur.polyIdx);
      const endP = Math.min(densePts.length - 2, Math.max(startP, nxt.polyIdx - 1));
      for (let p = startP; p <= endP; p++) {
        stopSpanMetaByDenseIdx[p] = spanMeta;
      }
    }
  }

  // Build micro-segments with cumulative along-track distance and bbox
  const microSegs = [];
  let cumKm = 0;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (let i = 0; i < densePts.length - 1; i++) {
    const a = densePts[i], b = densePts[i + 1];
    const lenKm = _haversineKm(a[0], a[1], b[0], b[1]);
    if (lenKm < 0.002) continue;
    minLat = Math.min(minLat, a[0], b[0]);
    maxLat = Math.max(maxLat, a[0], b[0]);
    minLon = Math.min(minLon, a[1], b[1]);
    maxLon = Math.max(maxLon, a[1], b[1]);
    const spanMeta = stopSpanMetaByDenseIdx[i] || null;
    microSegs.push({
      a,
      b,
      lenKm,
      startKm: cumKm,
      midKm: cumKm + lenKm * 0.5,
      brg: computeBearingDeg(a[0], a[1], b[0], b[1]),
      fromStopIdx: spanMeta ? spanMeta.fromStopIdx : null,
      toStopIdx: spanMeta ? spanMeta.toStopIdx : null,
      betweenStops: spanMeta ? spanMeta.betweenStops : null,
      parentHopKm: spanMeta ? spanMeta.parentHopKm : 0,
      hopKm: spanMeta ? spanMeta.hopKm : lenKm,
      isBbiSeg: spanMeta ? spanMeta.isBbiSeg : false,
      isSideStreetSpan: Boolean(spanMeta && !spanMeta.isHighwaySpan)
    });
    cumKm += lenKm;
  }
  if (!microSegs.length) return { type: 'FeatureCollection', features: [] };

  // 2. Project same-direction live TD detectors strictly onto the route polyline
  // Divided highways (Tuen Mun Rd, Yuen Long Hwy, North Lantau Hwy, TM-CLKL) relax lateral snap to <= 85 m (<= 45°),
  // and major roundabouts/interchanges relax to <= 120 m (<= 65°) so localized bottlenecks are preserved.
  const matchedDets = [];
  const padDeg = 0.0025;
  if (Array.isArray(detectors) && detectors.length) {
    for (let dIdx = 0; dIdx < detectors.length; dIdx++) {
      const det = detectors[dIdx];
      if (!det || !Number.isFinite(Number(det.lat)) || !Number.isFinite(Number(det.lon))) continue;
      if (det.spd === null || det.spd === undefined || !Number.isFinite(Number(det.spd)) || Number(det.spd) <= 0) continue;
      const dLat = Number(det.lat), dLon = Number(det.lon);
      if (dLat < minLat - padDeg || dLat > maxLat + padDeg || dLon < minLon - padDeg || dLon > maxLon + padDeg) continue;
      const isRbDet = isRoundaboutOrInterchangeDetectorHardcode(det.roadEn || '', det.roadTc || '', det.id || '', dLat, dLon);
      const isDivHwyDet = isDividedHighwaySnapRoadHardcode(det.roadEn || '', det.roadTc || '', det.id || '');
      if (hasHighwaySpan && isOffCorridorLocalArterialDetector(det) && !isRbDet) continue;

      let bestDistKm = Infinity;
      let bestAllowedKm = maxMatchKm;
      let bestAlongKm = 0;
      const detRot = Number(det.rot);
      const hasRot = Number.isFinite(detRot);
      const detMaxAngleDeg = isRbDet ? Math.max(maxAngleDeg, 65) : (isDivHwyDet ? Math.max(maxAngleDeg, 45) : maxAngleDeg);

      for (let sIdx = 0; sIdx < microSegs.length; sIdx++) {
        const seg = microSegs[sIdx];
        if (_isOffRouteHighwayLeakHardcode(det.roadEn || '', det.roadTc || '', det.id || '', routeCtx, seg)) continue;
        const segMaxMatchKm = isRbDet
          ? Math.max(maxMatchKm, 0.120)
          : (isDivHwyDet && !seg.isSideStreetSpan
            ? Math.max(maxMatchKm, 0.085)
            : (seg.isSideStreetSpan ? sideStreetMaxMatchKm : maxMatchKm));
        const proj = pointToSegmentDistanceKm(dLat, dLon, seg.a[0], seg.a[1], seg.b[0], seg.b[1]);
        if (proj.distKm > segMaxMatchKm) continue;
        if ((sIdx === 0 && proj.t < -0.02) || (sIdx === microSegs.length - 1 && proj.t > 1.02)) continue;
        if (hasRot && angularDiffDeg(seg.brg, detRot) > detMaxAngleDeg) continue;
        if (seg.betweenStops && !_isSegmentRoadCompatibleWithFeature(seg, det.roadEn || '', det.roadTc || '', det.id || '')) continue;
        if (proj.distKm < bestDistKm) {
          bestDistKm = proj.distKm;
          bestAllowedKm = segMaxMatchKm;
          bestAlongKm = seg.startKm + Math.max(0, Math.min(1, proj.t)) * seg.lenKm;
        }
      }

      if (bestDistKm <= bestAllowedKm) {
        matchedDets.push({
          det,
          alongKm: bestAlongKm,
          distKm: bestDistKm,
          isRoundabout: isRbDet,
          isRoundaboutBottleneck: isRoundaboutBottleneckHardcode(det)
        });
      }
    }
  }

  const _matchStopSegForMicroSeg = (seg) => {
    if (!stopSegByFromIdx.size && !stopSegByFromSeq.size && !paintableStopSegs.length) return null;
    if (seg.fromStopIdx !== null && seg.fromStopIdx !== undefined) {
      if (stopSegByFromIdx.has(seg.fromStopIdx)) return stopSegByFromIdx.get(seg.fromStopIdx);
      if (seg.betweenStops?.fromSeq && stopSegByFromSeq.has(Number(seg.betweenStops.fromSeq))) {
        return stopSegByFromSeq.get(Number(seg.betweenStops.fromSeq));
      }
      // If the unified timeline explicitly marked this stop span as NONE/CAM_ONLY (e.g. final terminus span),
      // do not borrow an adjacent span's speed via spatial proximity.
      if (knownStopFromIdxs.has(seg.fromStopIdx)) return null;
    }
    if (!paintableStopSegs.length) return null;
    const midLat = (seg.a[0] + seg.b[0]) * 0.5;
    const midLon = (seg.a[1] + seg.b[1]) * 0.5;
    let bestSeg = null;
    let bestDistKm = Infinity;
    for (let i = 0; i < paintableStopSegs.length; i++) {
      const cand = paintableStopSegs[i];
      const cc = cand.coords;
      for (let k = 0; k < cc.length - 1; k++) {
        const p1 = cc[k], p2 = cc[k + 1];
        if (!Array.isArray(p1) || !Array.isArray(p2)) continue;
        const proj = pointToSegmentDistanceKm(midLat, midLon, Number(p1[0]), Number(p1[1]), Number(p2[0]), Number(p2[1]));
        if (proj.distKm > 0.065) continue;
        if (_haversineKm(Number(p1[0]), Number(p1[1]), Number(p2[0]), Number(p2[1])) >= 0.005) {
          const cBrg = computeBearingDeg(Number(p1[0]), Number(p1[1]), Number(p2[0]), Number(p2[1]));
          if (angularDiffDeg(seg.brg, cBrg) > 55) continue;
        }
        if (proj.distKm < bestDistKm) {
          bestDistKm = proj.distKm;
          bestSeg = cand;
        }
      }
    }
    return bestSeg;
  };

  // 3. Assign each micro-segment its live/bus/estimated speed color and merge consecutive same-span LineStrings
  const features = [];
  let curFeat = null;

  for (let sIdx = 0; sIdx < microSegs.length; sIdx++) {
    const seg = microSegs[sIdx];
    let chosen = null;
    let bestScore = Infinity;

    for (let mIdx = 0; mIdx < matchedDets.length; mIdx++) {
      const m = matchedDets[mIdx];
      const deltaKm = Math.abs(m.alongKm - seg.midKm);
      const effInfluenceKm = m.isRoundaboutBottleneck
        ? Math.min(influenceRadiusKm, 0.35)
        : (seg.isSideStreetSpan ? Math.min(influenceRadiusKm, 0.35) : influenceRadiusKm);
      if (deltaKm > effInfluenceKm) continue;
      if (seg.betweenStops && !_isSegmentRoadCompatibleWithFeature(seg, m.det.roadEn || '', m.det.roadTc || '', m.det.id || '')) {
        continue;
      }
      // Preserve localized red/amber roundabout & interchange bottlenecks without letting
      // downstream free-flow highway speed (e.g. 63 km/h) overwrite them!
      let score;
      if (m.isRoundaboutBottleneck && deltaKm <= 0.35) {
        score = -2.0 + Math.abs(Number(m.det.spd) || 0) * 0.002 + deltaKm;
      } else {
        score = deltaKm <= 0.25 ? (Number(m.det.spd) * 0.003 + deltaKm) : (deltaKm + 0.35);
      }
      if (score < bestScore) {
        bestScore = score;
        chosen = m.det;
      }
    }

    let speedKmh = chosen ? Math.abs(Number(chosen.spd)) : null;
    let occ = chosen ? Math.abs(Number(chosen.occ) || 0) : 0;
    let hasSpeedData = Boolean(speedKmh !== null && Number.isFinite(speedKmh) && speedKmh > 0);
    let source = hasSpeedData ? 'TD' : 'NONE';
    let tier = hasSpeedData ? _normalizeBottleneckTier(chosen.tier, speedKmh, occ) : 'NO_DATA';
    // Strict TD Red reservation: Red (#dc2626) only when speed < 15 km/h or occupancy >= 75%
    let color = !hasSpeedData
      ? noDataColor
      : (tier === 'CONGESTED' ? '#dc2626' : (tier === 'MODERATE' ? '#f59e0b' : '#16a34a'));
    let detId = chosen ? String(chosen.id || '') : '';
    let roadEn = chosen ? _sanitizeDirectionTyposHardcode(String(chosen.roadEn || '')) : '';
    let roadTc = chosen ? _sanitizeDirectionTyposHardcode(String(chosen.roadTc || chosen.roadEn || '')) : '';
    let roundaboutBottleneck = Boolean(chosen && isRoundaboutBottleneckHardcode(chosen));
    let isSyntheticFallback = false;
    let isVerifiedMultiBusStall = false;
    let isScheduledFallback = false;
    let segFromIdx = null;
    let segToIdx = null;
    let segFromSeq = null;
    let segToSeq = null;
    let segFromNameEn = '';
    let segFromNameTc = '';
    let segToNameEn = '';
    let segToNameTc = '';

    // Merge unified stop-by-stop TD / BUS_API / BUS_EST telemetry onto micro-segments lacking a direct TD point detector
    if (!hasSpeedData && rawStopSegments.length > 0) {
      const stopSeg = _matchStopSegForMicroSeg(seg);
      if (stopSeg) {
        const stSrc = String(stopSeg.source || '').toUpperCase();
        const stSpd = Math.abs(Math.round(Number(stopSeg.speedKmh)));
        if (Number.isFinite(stSpd) && stSpd > 0) {
          if (stSrc === 'TD') {
            speedKmh = stSpd;
            occ = Math.abs(Number(stopSeg.occ) || 0);
            hasSpeedData = true;
            source = 'TD';
            tier = _normalizeBottleneckTier(stopSeg.tier, speedKmh, occ);
            color = tier === 'CONGESTED' ? '#dc2626' : (tier === 'MODERATE' ? '#f59e0b' : '#16a34a');
            detId = String(stopSeg.detId || stopSeg.detectorId || '');
            roadEn = _sanitizeDirectionTyposHardcode(String(stopSeg.roadEn || ''));
            roadTc = _sanitizeDirectionTyposHardcode(String(stopSeg.roadTc || stopSeg.roadEn || ''));
            roundaboutBottleneck = Boolean(stopSeg.roundaboutBottleneck);
          } else if (stSrc === 'BUS_API') {
            speedKmh = stSpd;
            hasSpeedData = true;
            source = 'BUS_API';
            isVerifiedMultiBusStall = Boolean(stopSeg.isVerifiedMultiBusStall);
            isScheduledFallback = Boolean(stopSeg.isScheduledFallback);
            tier = capBusApiTierHardcode(stopSeg.tier, speedKmh, {
              isTerminusApproach: Boolean(stopSeg.isTerminusApproach),
              isScheduledFallback,
              isVerifiedMultiBusStall
            });
            color = tier === 'CONGESTED' ? '#dc2626' : (tier === 'MODERATE' ? '#f59e0b' : '#16a34a');
          } else if (stSrc === 'BUS_EST') {
            speedKmh = stSpd;
            hasSpeedData = true;
            source = 'BUS_EST';
            isSyntheticFallback = true;
            tier = speedKmh >= 18 ? 'SMOOTH' : 'MODERATE';
            color = tier === 'MODERATE' ? '#f59e0b' : '#16a34a';
          }
          if (source === 'BUS_API' || source === 'BUS_EST') {
            segFromIdx = Number.isFinite(Number(stopSeg.fromIdx)) ? Number(stopSeg.fromIdx) : (seg.fromStopIdx ?? null);
            segToIdx = Number.isFinite(Number(stopSeg.toIdx)) ? Number(stopSeg.toIdx) : (seg.toStopIdx ?? null);
            segFromSeq = Number.isFinite(Number(stopSeg.fromSeq)) ? Number(stopSeg.fromSeq) : (seg.betweenStops?.fromSeq ?? null);
            segToSeq = Number.isFinite(Number(stopSeg.toSeq)) ? Number(stopSeg.toSeq) : (seg.betweenStops?.toSeq ?? null);
            segFromNameEn = String(stopSeg.fromNameEn || seg.betweenStops?.fromNameEn || '');
            segFromNameTc = String(stopSeg.fromNameTc || seg.betweenStops?.fromNameTc || segFromNameEn);
            segToNameEn = String(stopSeg.toNameEn || seg.betweenStops?.toNameEn || '');
            segToNameTc = String(stopSeg.toNameTc || seg.betweenStops?.toNameTc || segToNameEn);
            roadEn = `${segFromNameEn} → ${segToNameEn}`.trim();
            roadTc = `${segFromNameTc || segFromNameEn} → ${segToNameTc || segToNameEn}`.trim();
          }
        }
      }
    }

    const ptA = [Number(seg.a[1].toFixed(6)), Number(seg.a[0].toFixed(6))];
    const ptB = [Number(seg.b[1].toFixed(6)), Number(seg.b[0].toFixed(6))];

    const canMerge = Boolean(
      curFeat &&
      curFeat.properties.color === color &&
      curFeat.properties.source === source &&
      curFeat.properties.detectorId === detId &&
      curFeat.properties.hasSpeedData === hasSpeedData &&
      curFeat.properties.fromIdx === segFromIdx &&
      (source === 'TD' || curFeat.properties.speedKmh === speedKmh)
    );
    if (canMerge) {
      curFeat.geometry.coordinates.push(ptB);
    } else {
      curFeat = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [ptA, ptB]
        },
        properties: {
          color,
          speedKmh,
          occ,
          hasSpeedData,
          source,
          detectorId: detId,
          roadEn,
          roadTc,
          tier,
          roundaboutBottleneck,
          isSyntheticFallback,
          isVerifiedMultiBusStall,
          isScheduledFallback,
          fromIdx: segFromIdx,
          toIdx: segToIdx,
          fromSeq: segFromSeq,
          toSeq: segToSeq,
          fromNameEn: segFromNameEn,
          fromNameTc: segFromNameTc,
          toNameEn: segToNameEn,
          toNameTc: segToNameTc
        }
      };
      features.push(curFeat);
    }
  }

  return { type: 'FeatureCollection', features };
}

// ============================================================================
// GPS DIRECTION TOGGLE: PROXIMITY + NAME-BASED PAIRED STOP CLUSTERING (<=200m)
// ============================================================================
function normalizePairedStopNameKey(nameEn = '', nameTc = '') {
  const cleanEn = String(nameEn || '')
    .replace(/\s*\([A-Z]{1,3}\d{2,4}\)\s*/g, ' ')
    .replace(/\s*\((?:platform|bay|northbound|southbound|eastbound|westbound|north|south|east|west|opp\.?|opposite)[^)]*\)/gi, ' ')
    .split(',')[0]
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  if (cleanEn) return cleanEn;
  return String(nameTc || '')
    .replace(/\s*[（(][^）)]*[）)]\s*/g, '')
    .split(/[，,]/)[0]
    .replace(/\s+/g, '')
    .trim();
}

function collectDirectionClusterStops(allStops, anchorStop, activeMode = 'BUS', maxRadiusKm = 0.20, options = {}) {
  if (!Array.isArray(allStops) || !anchorStop) return anchorStop ? [anchorStop] : [];
  const aLat = parseFloat(anchorStop.latitude ?? anchorStop.lat);
  const aLon = parseFloat(anchorStop.longitude ?? anchorStop.lon);
  if (!Number.isFinite(aLat) || !Number.isFinite(aLon)) return [anchorStop];

  const anchorEnKey = normalizePairedStopNameKey(anchorStop.stopName_e, '');
  const anchorTcKey = normalizePairedStopNameKey('', anchorStop.name_tc);
  const refLat = Number.isFinite(Number(options.refLat)) ? Number(options.refLat) : aLat;
  const refLon = Number.isFinite(Number(options.refLon)) ? Number(options.refLon) : aLon;
  const effRadiusKm = Math.max(0.05, Number(maxRadiusKm) || 0.20);

  const matched = [];
  const seenKeys = new Set();
  const pushStop = (st) => {
    const k = String(st.stopKey || `${st.stopId || ''}_${st.latitude}_${st.longitude}`);
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    matched.push(st);
  };
  pushStop(anchorStop);

  for (let i = 0; i < allStops.length; i++) {
    const s = allStops[i];
    if (!s || (s.mode || 'BUS') !== activeMode) continue;
    const sLat = parseFloat(s.latitude ?? s.lat);
    const sLon = parseFloat(s.longitude ?? s.lon);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;
    if (_crossesHkWaterBarrierHardcode(aLat, aLon, sLat, sLon)) continue;

    const dKm = _haversineKm(aLat, aLon, sLat, sLon);
    if (dKm > effRadiusKm) continue;

    const sEnKey = normalizePairedStopNameKey(s.stopName_e, '');
    const sTcKey = normalizePairedStopNameKey('', s.name_tc);
    const nameMatches = (anchorEnKey && sEnKey && anchorEnKey === sEnKey) ||
      (anchorTcKey && sTcKey && anchorTcKey === sTcKey);
    if (nameMatches) {
      pushStop(s);
    }
  }

  matched.sort((x, y) => {
    const dX = _haversineKm(refLat, refLon, parseFloat(x.latitude ?? x.lat), parseFloat(x.longitude ?? x.lon));
    const dY = _haversineKm(refLat, refLon, parseFloat(y.latitude ?? y.lat), parseFloat(y.longitude ?? y.lon));
    return dX - dY;
  });
  return matched;
}

if (typeof window !== 'undefined') {
  if (typeof MTR_LINE_COLORS !== 'undefined') window.__MTR_LINE_COLORS__ = MTR_LINE_COLORS;
  if (typeof getRouteColorHex === 'function') window.__GET_ROUTE_COLOR_HEX__ = getRouteColorHex;
  if (typeof HK_TRAM_ADULT_FARE !== 'undefined') window.HK_TRAM_ADULT_FARE = HK_TRAM_ADULT_FARE;
  if (typeof MTR_ADJACENT_RUNNING_TIME !== 'undefined') window.MTR_ADJACENT_RUNNING_TIME = MTR_ADJACENT_RUNNING_TIME;
  if (typeof MTR_ENGINE !== 'undefined') window.MTR_ENGINE = MTR_ENGINE;
  if (typeof MTR_FLEET_CONFIG !== 'undefined') window.MTR_FLEET_CONFIG = MTR_FLEET_CONFIG;
  if (typeof MTR_BOTTLENECK_STATIONS !== 'undefined') window.MTR_BOTTLENECK_STATIONS = MTR_BOTTLENECK_STATIONS;
  if (typeof SHARED_BIKE_PRICING !== 'undefined') window.SHARED_BIKE_PRICING = SHARED_BIKE_PRICING;
  if (typeof computeSharedBikeFareHkd === 'function') window.computeSharedBikeFareHkd = computeSharedBikeFareHkd;
  if (typeof LoadFactorEngine !== 'undefined') window.LoadFactorEngine = LoadFactorEngine;
  if (typeof MTR_EXITS_SEED !== 'undefined') window.MTR_EXITS_SEED = MTR_EXITS_SEED;
  if (typeof MAJOR_BBI_HUBS !== 'undefined') window.MAJOR_BBI_HUBS = MAJOR_BBI_HUBS;
  if (typeof HK_STRATEGIC_CORRIDORS !== 'undefined') window.HK_STRATEGIC_CORRIDORS = HK_STRATEGIC_CORRIDORS;
  if (typeof SECTIONAL_FARE_REGISTRY !== 'undefined') window.SECTIONAL_FARE_REGISTRY = SECTIONAL_FARE_REGISTRY;
  window._haversineKm = _haversineKm;
  window.resolveMtrStationCode = resolveMtrStationCode;
  window.resolveLrtNumericId = resolveLrtNumericId;
  window.resolveFerryLiveEtaKey = resolveFerryLiveEtaKey;
  window.getMajorBbiHubMatch = getMajorBbiHubMatch;
  window.resolveRelevantCorridorForTrip = resolveRelevantCorridorForTrip;
  if (typeof getSectionalFareMeta === 'function') window.getSectionalFareMeta = getSectionalFareMeta;
  if (typeof resolveBusLegNetFare === 'function') window.resolveBusLegNetFare = resolveBusLegNetFare;
  if (typeof hasStopTwoWaySectionalFare === 'function') window.hasStopTwoWaySectionalFare = hasStopTwoWaySectionalFare;
  if (typeof getFerryPierBerthLabel === 'function') window.getFerryPierBerthLabel = getFerryPierBerthLabel;
  window.computeBearingDeg = computeBearingDeg;
  window.angularDiffDeg = angularDiffDeg;
  window.pointToSegmentDistanceKm = pointToSegmentDistanceKm;
  window.isExpresswayOrTunnelDetector = isExpresswayOrTunnelDetector;
  window.areRoadNamesCompatibleHardcode = areRoadNamesCompatibleHardcode;
  window.isOffCorridorLocalArterialDetector = isOffCorridorLocalArterialDetector;
  window.isDividedHighwaySnapRoadHardcode = isDividedHighwaySnapRoadHardcode;
  window.isRoundaboutOrInterchangeDetectorHardcode = isRoundaboutOrInterchangeDetectorHardcode;
  window.isRoundaboutBottleneckHardcode = isRoundaboutBottleneckHardcode;
  window.capBusApiTierHardcode = capBusApiTierHardcode;
  window.isMajorTunnelBbiStop = isMajorTunnelBbiStop;
  window.isCrossSubseaOrMajorTunnelSpan = isCrossSubseaOrMajorTunnelSpan;
  window.parseHkGpsCoordinates = parseHkGpsCoordinates;
  window.findOppositeDirectionGroup = findOppositeDirectionGroup;
  window.synthesizeTrafficDecision = synthesizeTrafficDecision;
  window.getHongKongTimeOfDayContext = getHongKongTimeOfDayContext;
  window.computeTimeToReachDecayWeight = computeTimeToReachDecayWeight;
  window.computeBottleneckSeverityScore = computeBottleneckSeverityScore;
  window.selectWorstAheadStopSegment = selectWorstAheadStopSegment;
  window.inferDirectionalRoadTrafficForStops = inferDirectionalRoadTrafficForStops;
  window.getDirectionalRoadSummary = getDirectionalRoadSummary;
  window.getBusSpeedLayerColorHex = getBusSpeedLayerColorHex;
  window.inferBusApiSegmentSpeeds = inferBusApiSegmentSpeeds;
  window.sliceForwardPolylineFromStop = sliceForwardPolylineFromStop;
  window.extractCardinalDirectionMeta = extractCardinalDirectionMeta;
  window.findNearestMatchingDetectorForCamera = findNearestMatchingDetectorForCamera;
  window.getTrafficSpeedColorHex = getTrafficSpeedColorHex;
  window.buildRouteSpeedGeoJson = buildRouteSpeedGeoJson;
  window.normalizePairedStopNameKey = normalizePairedStopNameKey;
  window.collectDirectionClusterStops = collectDirectionClusterStops;
  window.normName = normName;
  window.normKey = normKey;
  window.mergeOperatingWindows = mergeOperatingWindows;
  window.deriveFerryActiveWindowsFromSched = deriveFerryActiveWindowsFromSched;
}

if (typeof module !== 'undefined' && module.exports) {
  if (typeof MTR_ENGINE === 'undefined' && typeof require === 'function') {
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis._haversineKm = _haversineKm;
        globalThis.resolveMtrStationCode = resolveMtrStationCode;
        globalThis.getMajorBbiHubMatch = getMajorBbiHubMatch;
      }
      _hcFareLoadMod = require('./fare-load-engine.js');
    } catch (e) {}
  }
  module.exports = {
    ...(_hcTransitDataMod || {}),
    ...(_hcFareLoadMod || {}),
    ...(typeof MTR_LINE_COLORS !== 'undefined' ? { MTR_LINE_COLORS } : {}),
    ...(typeof IOS_BUS_RED !== 'undefined' ? { IOS_BUS_RED } : {}),
    ...(typeof IOS_MTR_BLUE !== 'undefined' ? { IOS_MTR_BLUE } : {}),
    ...(typeof IOS_FERRY_BLUE !== 'undefined' ? { IOS_FERRY_BLUE } : {}),
    ...(typeof IOS_LRT_INDIGO !== 'undefined' ? { IOS_LRT_INDIGO } : {}),
    ...(typeof HK_TRAM_ADULT_FARE !== 'undefined' ? { HK_TRAM_ADULT_FARE } : {}),
    ...(typeof getRouteColorHex === 'function' ? { getRouteColorHex } : {}),
    ...(typeof LRT_STATION_DIRECTORY !== 'undefined' ? { LRT_STATION_DIRECTORY } : {}),
    ...(typeof MTR_STATION_DIRECTORY !== 'undefined' ? { MTR_STATION_DIRECTORY } : {}),
    ...(typeof FERRY_PIER_DIRECTORY !== 'undefined' ? { FERRY_PIER_DIRECTORY } : {}),
    ...(typeof HARDCODED_LRT_SEQUENCES !== 'undefined' ? { HARDCODED_LRT_SEQUENCES } : {}),
    ...(typeof INTER_ISLANDS_TEMP_NOTICE_EN !== 'undefined' ? { INTER_ISLANDS_TEMP_NOTICE_EN } : {}),
    ...(typeof INTER_ISLANDS_TEMP_NOTICE_TC !== 'undefined' ? { INTER_ISLANDS_TEMP_NOTICE_TC } : {}),
    ...(typeof INTER_ISLANDS_REVIEW_AFTER !== 'undefined' ? { INTER_ISLANDS_REVIEW_AFTER } : {}),
    ...(typeof VERIFIED_MAINLINE_FERRIES !== 'undefined' ? { VERIFIED_MAINLINE_FERRIES } : {}),
    ...(typeof MTR_ADJACENT_RUNNING_TIME !== 'undefined' ? { MTR_ADJACENT_RUNNING_TIME } : {}),
    ...(typeof MTR_ENGINE !== 'undefined' ? { MTR_ENGINE } : {}),
    ...(typeof MTR_FLEET_CONFIG !== 'undefined' ? { MTR_FLEET_CONFIG } : {}),
    ...(typeof MTR_BOTTLENECK_STATIONS !== 'undefined' ? { MTR_BOTTLENECK_STATIONS } : {}),
    ...(typeof SHARED_BIKE_PRICING !== 'undefined' ? { SHARED_BIKE_PRICING } : {}),
    ...(typeof computeSharedBikeFareHkd === 'function' ? { computeSharedBikeFareHkd } : {}),
    ...(typeof LoadFactorEngine !== 'undefined' ? { LoadFactorEngine } : {}),
    ...(typeof MTR_EXITS_SEED !== 'undefined' ? { MTR_EXITS_SEED } : {}),
    ...(typeof MAJOR_BBI_HUBS !== 'undefined' ? { MAJOR_BBI_HUBS } : {}),
    ...(typeof HK_STRATEGIC_CORRIDORS !== 'undefined' ? { HK_STRATEGIC_CORRIDORS } : {}),
    ...(typeof SECTIONAL_FARE_REGISTRY !== 'undefined' ? { SECTIONAL_FARE_REGISTRY } : {}),
    ...(typeof getSectionalFareMeta === 'function' ? { getSectionalFareMeta } : {}),
    ...(typeof resolveBusLegNetFare === 'function' ? { resolveBusLegNetFare } : {}),
    ...(typeof hasStopTwoWaySectionalFare === 'function' ? { hasStopTwoWaySectionalFare } : {}),
    ...(typeof getFerryPierBerthLabel === 'function' ? { getFerryPierBerthLabel } : {}),
    normName,
    normKey,
    _haversineKm,
    LRT_ID_BY_NORM_NAME,
    MTR_CODE_BY_NORM_NAME,
    resolveMtrStationCode,
    resolveLrtNumericId,
    resolveFerryLiveEtaKey,
    getMajorBbiHubMatch,
    resolveRelevantCorridorForTrip,
    computeBearingDeg,
    angularDiffDeg,
    pointToSegmentDistanceKm,
    isExpresswayOrTunnelDetector,
    areRoadNamesCompatibleHardcode,
    isOffCorridorLocalArterialDetector,
    isDividedHighwaySnapRoadHardcode,
    isRoundaboutOrInterchangeDetectorHardcode,
    isRoundaboutBottleneckHardcode,
    capBusApiTierHardcode,
    isMajorTunnelBbiStop,
    isCrossSubseaOrMajorTunnelSpan,
    parseHkGpsCoordinates,
    findOppositeDirectionGroup,
    synthesizeTrafficDecision,
    getHongKongTimeOfDayContext,
    computeTimeToReachDecayWeight,
    computeBottleneckSeverityScore,
    selectWorstAheadStopSegment,
    inferDirectionalRoadTrafficForStops,
    getDirectionalRoadSummary,
    getBusSpeedLayerColorHex,
    inferBusApiSegmentSpeeds,
    sliceForwardPolylineFromStop,
    extractCardinalDirectionMeta,
    findNearestMatchingDetectorForCamera,
    getTrafficSpeedColorHex,
    buildRouteSpeedGeoJson,
    normalizePairedStopNameKey,
    collectDirectionClusterStops,
    mergeOperatingWindows,
    deriveFerryActiveWindowsFromSched
  };
}
