// ============================================================================
// File: functions/api/worker.js (johntjz/Hk-Fleet — Self-Contained ESM Worker)
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

const CORRIDOR_PATTERNS = {
  LANTAU_TM:    /tuen\s*mun.*chek\s*lap\s*kok|tm-?clk|north\s*lantau|lantau\s*link|tsing\s*ma|kap\s*shui\s*mun|south\s*lantau\s*road|tung\s*chung\s*road|penny'?s\s*bay/i,
  TUEN_MUN_RD:  /tuen\s*mun\s*road|ting\s*kau\s*bridge|ting\s*kau/i,
  TAI_LAM:      /tai\s*lam\s*tunnel|tsing\s*long\s*highway|yuen\s*long\s*highway/i,
  TOLO_HWY:     /tolo\s*highway|fanling\s*highway|tai\s*po\s*road/i,
  LION_TATES:   /lion\s*rock\s*tunnel|tate'?s\s*cairn|tai\s*lo\s*shan/i,
  SHING_MUN:    /shing\s*mun\s*tunnel|tsing\s*sha\s*highway|eagle'?s\s*nest|sha\s*tin\s*heights/i,
  HARBOUR_TUNS: /cross[\s-]*harbour\s*tunnel|western\s*harbour|eastern\s*harbour|central[\s-]*wan\s*chai\s*bypass/i,
  TKO_TUN:      /tseung\s*kwan\s*o\s*tunnel|tseung\s*kwan\s*o[\s-]*lam\s*tin|cross\s*bay\s*link/i
};

function normKey(s, stripPierSuffix = true) {
  let out = String(s || '').toLowerCase()
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

async function fetchWithTimeout(url, timeoutMs = 4500, customHeaders = {}, cacheTtl = 60, method = 'GET', body = null) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = {
      method,
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Transit-HK/4.0', ...customHeaders },
      cf: { cacheTtl, cacheEverything: true }
    };
    if (body) opts.body = body;
    const r = await fetch(url, opts);
    clearTimeout(tid);
    return r;
  } catch (e) {
    clearTimeout(tid);
    return null;
  }
}

function isValidHkCoord(lat, lon) {
  const la = parseFloat(lat), lo = parseFloat(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && la > 22.15 && la < 22.58 && lo > 113.82 && lo < 114.45;
}

function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const splitRow = (row) => {
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === '"') {
        if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        out.push(cur.trim()); cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitRow(lines[0]);
  return lines.slice(1).map(l => {
    const vals = splitRow(l);
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
}

function parseXmlRecords(xmlText, rowTag) {
  const out = [];
  const rowRegex = new RegExp(`<${rowTag}>([\\s\\S]*?)<\\/${rowTag}>`, 'gi');
  const tagRegex = /<([A-Z0-9_]+)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = rowRegex.exec(String(xmlText || ''))) !== null) {
    const obj = {};
    let tm;
    tagRegex.lastIndex = 0;
    while ((tm = tagRegex.exec(m[1])) !== null) {
      obj[tm[1]] = tm[2]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .trim();
    }
    out.push(obj);
  }
  return out;
}

function hk80ToWgs84LocalFallback(north, east) {
  const n = Number(north), e = Number(east);
  if (!Number.isFinite(n) || !Number.isFinite(e) || n < 790000 || e < 790000) return null;
  const lat = 22.3121333 + (n - 819069.80) / 110730.0 - 0.0015278;
  const lon = 114.1785556 + (e - 836694.05) / 102990.0 + 0.0024444;
  if (isValidHkCoord(lat, lon)) {
    return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
  }
  return null;
}

async function hk80ToWgs84Api(north, east, allowNetwork = true) {
  if (allowNetwork) {
    try {
      const r = await fetchWithTimeout(
        `https://www.geodetic.gov.hk/transform/v2/?inSys=hkgrid&outSys=wgsgeog&n=${encodeURIComponent(north)}&e=${encodeURIComponent(east)}`,
        2200,
        { 'Accept': 'application/json' },
        86400
      );
      if (r && r.ok) {
        const d = await r.json().catch(() => null);
        const lat = parseFloat(d?.wgsLat), lon = parseFloat(d?.wgsLong);
        if (isValidHkCoord(lat, lon)) {
          return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
        }
      }
    } catch (e) {}
  }
  return hk80ToWgs84LocalFallback(north, east);
}

// Operator Ferry CSV Schedule Parser (Only fetched when explicitly requested via ?sched=1)
async function fetchOperatorFerryCsvSchedules() {
  const ferrySchedByPair = new Map();
  const hktTodayYmd = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

  const addSample = (pairKey, isWk, isSat, isHol, depMin, slotDur = 0, updatedStr = '') => {
    if (!pairKey || !Number.isFinite(depMin) || depMin < 0 || depMin >= 1440) return;
    if (!ferrySchedByPair.has(pairKey)) {
      ferrySchedByPair.set(pairKey, { wk: new Map(), sat: new Map(), hol: new Map(), updated: '' });
    }
    const b = ferrySchedByPair.get(pairKey);
    if (updatedStr && !b.updated) b.updated = updatedStr;
    if (isWk) b.wk.set(depMin, slotDur || b.wk.get(depMin) || 0);
    if (isSat) b.sat.set(depMin, slotDur || b.sat.get(depMin) || 0);
    if (isHol) b.hol.set(depMin, slotDur || b.hol.get(depMin) || 0);
  };

  const feeds = [
    { pair: ['central_cheungchau', 'cheungchau_central'], url: 'https://www.sunferry.com.hk/eta/timetable/SunFerry_central_cheungchau_timetable_eng.csv', isOutlyingDualSpeed: true },
    { pair: ['central_muiwo', 'muiwo_central'], url: 'https://www.sunferry.com.hk/eta/timetable/SunFerry_central_muiwo_timetable_eng.csv', isOutlyingDualSpeed: true },
    { pair: ['northpoint_hunghom', 'hunghom_northpoint'], url: 'https://www.sunferry.com.hk/eta/timetable/SunFerry_northpoint_hunghom_timetable_eng.csv' },
    { pair: ['northpoint_kowlooncity', 'kowlooncity_northpoint'], url: 'https://www.sunferry.com.hk/eta/timetable/SunFerry_northpoint_kowlooncity_timetable_eng.csv' },
    { pair: ['pengchau_cheungchau', 'cheungchau_pengchau'], url: 'https://www.sunferry.com.hk/eta/timetable/SunFerry_inter_islands_timetable_eng.csv' },
    { pair: ['central_tsimshatsui', 'tsimshatsui_central'], url: 'https://www.starferry.com.hk/sites/default/files/upload/open_data/csv/ferry_sf_central_tsimshatsui_timetable_eng.csv' },
    { pair: ['wanchai_tsimshatsui', 'tsimshatsui_wanchai'], url: 'https://www.starferry.com.hk/sites/default/files/upload/open_data/csv/ferry_sf_wanchai_tsimshatsui_timetable_eng.csv' },
    { pair: ['central_hunghom', 'hunghom_central'], url: 'https://www.hongkongwatertaxi.com.hk/csv/CHHTimetable_eng.csv' },
    { pair: ['northpoint_kwuntong', 'kwuntong_northpoint'], url: 'https://www.hongkongwatertaxi.com.hk/csv/NPKTTimetable_eng.csv' },
    { pair: ['tuenmun_taio', 'taio_tuenmun'], url: 'https://www.hongkongwatertaxi.com.hk/csv/TMTOTimetable_eng.csv' }
  ];

  await Promise.allSettled(feeds.map(async (feed) => {
    const res = await fetchWithTimeout(feed.url, 3500, {}, 1800);
    if (!res || !res.ok) return;
    const lm = res.headers.get('last-modified');
    const rawText = await res.text();
    const updDate = (lm && !isNaN(Date.parse(lm)))
      ? new Date(lm).toISOString().slice(0, 10)
      : (rawText.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/)?.[0] || hktTodayYmd);

    const rows = parseCsv(rawText);
    const [p0a, p0b] = feed.pair[0].split('_');
    let dayMask = { wk: true, sat: false, hol: false };
    const lastMinByBucket = new Map();

    const parseCellMinutes = (str, bucketSig) => {
      const out = [];
      const re = /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*(a\.?m\.?|p\.?m\.?|nn|noon|mn|midnight))?/gi;
      let m;
      while ((m = re.exec(String(str || ''))) !== null) {
        let h = Number(m[1]), mn = Number(m[2]);
        const suf = (m[3] || '').toLowerCase().replace(/\./g, '');
        if (suf.startsWith('p')) h = (h % 12) + 12;
        else if (suf.startsWith('a') || suf === 'mn' || suf === 'midnight') h = h % 12;
        else if (suf === 'nn' || suf === 'noon') h = 12;
        else if (h >= 1 && h <= 11 && !/^0\d:/.test(m[0])) {
          const prev = lastMinByBucket.get(bucketSig) ?? -1;
          if (prev >= 690 && (h * 60 + mn) < prev - 180) h += 12;
        }
        const totalMin = (h % 24) * 60 + mn;
        lastMinByBucket.set(bucketSig, totalMin);
        out.push(totalMin);
      }
      return out;
    };

    rows.forEach(row => {
      const entries = Object.entries(row);
      const rowStr = entries.map(([, v]) => v).join(' ');
      const dayCandidate = entries
        .filter(([k]) => /day|date|service|星期|日子/i.test(k) && !/hour|time/i.test(k))
        .map(([, v]) => v).join(' ') || String(entries[0]?.[1] || '');

      if (/monday|weekday|saturday|sunday|holiday|daily|星期|平日|假日|公眾假期/i.test(dayCandidate)) {
        const cleanDay = String(dayCandidate)
          .replace(/[\(（]?except\s*public\s*holidays?[\)）]?/gi, ' ')
          .replace(/[\(（]?公眾假期除外[\)）]?/g, ' ');
        const hol = /sunday|public\s*holiday|holiday|星期日|公眾假期|假日/i.test(cleanDay);
        const sat = /saturday|mon(?:day)?s?\s*(?:to|-)\s*sat(?:urday)?s?|daily|星期六|每日/i.test(cleanDay);
        const wk  = (/monday|weekday|daily|星期一|平日|每日/i.test(cleanDay) && !/saturday\s*only/i.test(cleanDay)) || (!hol && !sat);
        dayMask = { wk, sat, hol };
      }

      const daySig = `${dayMask.wk ? 1 : 0}${dayMask.sat ? 1 : 0}${dayMask.hol ? 1 : 0}`;
      const rmkCells = entries.filter(([k]) => /remark|type|vessel|class|備註|船種/i.test(k)).map(([, v]) => String(v || '').trim()).join(' ');
      let slotDur = 0;
      if (/fast\s*ferry|高速/i.test(rowStr)) slotDur = 38;
      else if (/ordinary\s*ferry|普通/i.test(rowStr)) slotDur = 55;
      else if (feed.isOutlyingDualSpeed) {
        if (/\b0\b/.test(rmkCells)) slotDur = 55;
        else if (/\b1\b/.test(rmkCells)) slotDur = 38;
      }

      if (feed.url.includes('inter_islands')) {
        const pierTimes = {};
        for (const [colHdr, cellVal] of entries) {
          const hClean = colHdr.toLowerCase().replace(/[^a-z]/g, '');
          const p = ['pengchau', 'muiwo', 'chimawan', 'cheungchau'].find(x => hClean.includes(x));
          if (!p || !cellVal) continue;
          const mins = parseCellMinutes(cellVal, `ii_${p}_${daySig}`);
          if (mins.length) pierTimes[p] = mins[0];
        }
        const order = ['pengchau', 'muiwo', 'chimawan', 'cheungchau'].filter(p => pierTimes[p] !== undefined);
        if (order.length >= 2) {
          const diff = (pierTimes[order[order.length - 1]] - pierTimes[order[0]] + 1440) % 1440;
          const seq = (diff > 0 && diff < 180) ? order : [...order].reverse();
          for (let i = 0; i < seq.length - 1; i++) {
            for (let j = i + 1; j < seq.length; j++) {
              addSample(`${seq[i]}_${seq[j]}`, dayMask.wk, dayMask.sat, dayMask.hol, pierTimes[seq[i]], (j - i) * 18, updDate);
            }
          }
        }
        return;
      }

      let matchedCols = false;
      if (!feed.url.includes('starferry')) {
        for (const [colHdr, cellVal] of entries) {
          if (!cellVal) continue;
          const hClean = colHdr.toLowerCase().replace(/[^a-z]/g, '');
          if (/origin|destination|route|direction|remark|day|date/i.test(hClean) && !/from|depart|time|hour/.test(hClean)) continue;
          const idxA = hClean.indexOf(p0a), idxB = hClean.indexOf(p0b);
          const colPair = (idxA !== -1 && idxB !== -1) ? (idxA < idxB ? feed.pair[0] : feed.pair[1])
            : (/from|depart/.test(hClean) ? (idxA !== -1 ? feed.pair[0] : (idxB !== -1 ? feed.pair[1] : null)) : null);
          if (!colPair) continue;
          const cellDur = slotDur || (feed.isOutlyingDualSpeed && /\*/.test(cellVal) ? 55 : (feed.isOutlyingDualSpeed ? 38 : 0));
          const mins = parseCellMinutes(cellVal, `${colPair}_${daySig}`);
          if (mins.length) {
            matchedCols = true;
            mins.forEach(mn => addSample(colPair, dayMask.wk, dayMask.sat, dayMask.hol, mn, cellDur, updDate));
          }
        }
      }
      if (matchedCols) return;

      const origCol = normKey(row.Origin || row.From || '', true), destCol = normKey(row.Destination || row.To || '', true);
      let pKey = (origCol.includes(p0a) || destCol.includes(p0b)) ? feed.pair[0]
        : ((origCol.includes(p0b) || destCol.includes(p0a)) ? feed.pair[1] : null);
      if (!pKey) {
        const dc = String(row.Direction || row.Route || row.Service || rowStr).toLowerCase().replace(/[^a-z]/g, '');
        const i0 = dc.indexOf(p0a), i1 = dc.indexOf(p0b);
        pKey = (i0 !== -1 && (i1 === -1 || i0 < i1)) ? feed.pair[0] : feed.pair[1];
      }
      const timeCells = entries.filter(([k]) => !/day|date|route|origin|dest|direction|remark/i.test(k) || /hour|time/i.test(k)).map(([, v]) => v).join(' ');
      const mins = parseCellMinutes(timeCells || rowStr, `${pKey}_${daySig}`);

      if (feed.url.includes('starferry') && mins.length >= 2) {
        const sM = mins[0]; let eM = mins[1]; if (eM <= sM) eM += 1440;
        const step = Number((rowStr.replace(/\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*[ap]\.?m\.?)?/gi, ' ').match(/\b(\d{1,2})\b/) || [])[1] || 0);
        if (step >= 4 && step <= 30) {
          for (let t = sM; t <= eM; t += step) addSample(pKey, dayMask.wk, dayMask.sat, dayMask.hol, t % 1440, 9, updDate);
        }
      } else {
        mins.forEach(mn => addSample(pKey, dayMask.wk, dayMask.sat, dayMask.hol, mn, slotDur, updDate));
      }
    });
  }));

  const out = {};
  const packMap = (m) => [...m.entries()].sort((a, c) => a[0] - c[0]).map(([min, d]) => d ? [min, d] : min);
  for (const [k, b] of ferrySchedByPair.entries()) {
    out[k] = {
      wk: packMap(b.wk),
      sat: packMap(b.sat),
      hol: packMap(b.hol),
      updated: b.updated || hktTodayYmd
    };
  }
  return out;
}

function parseFerryRowSortMin(row) {
  const raw = String(row?.depart_time || row?.ETA || row?.eta || row?.time || row?.rmk_en || '');
  const m = raw.match(/(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?[Mm]\.?)?/);
  if (!m) return 9999;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  if (m[3]) {
    hh = hh % 12;
    if (m[3].toLowerCase() === 'p') hh += 12;
  }
  return (hh % 24) * 60 + mm;
}

function sortFerryEtasChronologically(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  return [...rows].sort((a, b) => parseFerryRowSortMin(a) - parseFerryRowSortMin(b));
}

// 1. SCOPED LIVE FERRY PROXY (Includes Sun Ferry H-suffix Fast Ferry merge)
async function handleFerryLiveRequest(urlObj) {
  const reqKey = (urlObj?.searchParams?.get('key') || '').trim().toUpperCase();
  const liveEtas = {};

  const sfGroups = {
    SF_CECC: ['CECC', 'CECCH'], SF_CCCE: ['CCCE', 'CCCEH'],
    SF_CEMW: ['CEMW', 'CEMWH'], SF_MWCE: ['MWCE', 'MWCEH'],
    SF_NPHH: ['NPHH'],          SF_HHNP: ['HHNP'],
    SF_NPKC: ['NPKC'],          SF_KCNP: ['KCNP'],
    SF_PCMW: ['PCMW'],          SF_MWPC: ['MWPC'],
    SF_CCMW: ['CCMW'],          SF_MWCC: ['MWCC']
  };

  const tasks = [];

  if (reqKey !== '_NONE') {
    for (const [targetKey, codes] of Object.entries(sfGroups)) {
      if (reqKey && reqKey !== targetKey) continue;
      tasks.push((async () => {
        const merged = [];
        await Promise.all(codes.map(async (rc) => {
          const r = await fetchWithTimeout(`https://www.sunferry.com.hk/eta/?route=${encodeURIComponent(rc)}`, 3200, {}, 20);
          if (r && r.ok) {
            const d = await r.json().catch(() => null);
            const rows = Array.isArray(d?.data) ? d.data : [];
            rows.forEach(row => {
              const rowTxt = Object.values(row || {}).join(' ');
              const isFast = rc.endsWith('H') || /fast|高速/i.test(rowTxt);
              const isOrd  = !isFast && /ordinary|普通/i.test(rowTxt);
              merged.push({
                ...row,
                vessel_type: isFast ? 'Fast Ferry' : (isOrd ? 'Ordinary Ferry' : (row.vessel_type || '')),
                vessel_type_tc: isFast ? '高速船' : (isOrd ? '普通渡輪' : (row.vessel_type_tc || ''))
              });
            });
          }
        }));
        if (merged.length > 0) {
          liveEtas[targetKey] = sortFerryEtasChronologically(merged);
        }
      })());
    }

    for (let routeId = 1; routeId <= 4; routeId++) {
      for (const dir of ['inbound', 'outbound']) {
        const k = `HKKF_${routeId}_${dir === 'outbound' ? 'O' : 'I'}`;
        if (reqKey && reqKey !== k) continue;
        tasks.push((async () => {
          const r = await fetchWithTimeout(`https://www.hkkfeta.com/opendata/eta/${routeId}/${dir}`, 3200, {}, 20);
          if (r && r.ok) {
            const d = await r.json().catch(() => null);
            if (Array.isArray(d?.data) && d.data.length > 0) liveEtas[k] = d.data;
          }
        })());
      }
    }

    for (const ffCode of ['CHH', 'HHC', 'NPKT', 'KTNP', 'TMTO', 'TOTM']) {
      const k = `FF_${ffCode}`;
      if (reqKey && reqKey !== k) continue;
      tasks.push((async () => {
        const r = await fetchWithTimeout(`https://www.hongkongwatertaxi.com.hk/eta/?route=${encodeURIComponent(ffCode)}`, 3200, {}, 20);
        if (r && r.ok) {
          const d = await r.json().catch(() => null);
          if (Array.isArray(d?.data) && d.data.length > 0) liveEtas[k] = d.data;
        }
      })());
    }
  }

  let csvSchedules = {};
  if (!reqKey || urlObj?.searchParams?.get('sched') === '1') {
    tasks.push((async () => {
      csvSchedules = await fetchOperatorFerryCsvSchedules();
    })());
  }

  await Promise.allSettled(tasks);
  return new Response(JSON.stringify({ ok: true, ts: Date.now(), liveEtas, csvSchedules }), {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=15' }
  });
}

// 2. DOMESTIC HK GEOCODER (ALS + GeoData + Photon + Nominatim)
async function handleAddressLookup(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (q.length < 1) return new Response(JSON.stringify({ ok: true, results: [] }), { headers: CORS_HEADERS });

  const cleanedQ = q
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(limited|ltd|co\.?|inc\.?|corp\.?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || q;

  const alsUrl = `https://www.als.gov.hk/lookup?q=${encodeURIComponent(cleanedQ)}&n=10&t=35`;
  const geoUrl = `https://geodata.gov.hk/gs/api/v1.0.0/locationSearch?q=${encodeURIComponent(cleanedQ)}`;
  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanedQ)}&bbox=113.82,22.15,114.45,22.57&limit=6`;
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanedQ)}&format=jsonv2&viewbox=113.82,22.57,114.45,22.15&bounded=1&addressdetails=1&namedetails=1&limit=5`;

  const [alsRes, geoRes, photonRes, nomRes] = await Promise.all([
    fetchWithTimeout(alsUrl, 2600, { 'Accept': 'application/json', 'Accept-Language': 'en,zh-Hant' }, 600),
    fetchWithTimeout(geoUrl, 2300, { 'Accept': 'application/json' }, 600),
    fetchWithTimeout(photonUrl, 2400, { 'Accept': 'application/json' }, 3600),
    fetchWithTimeout(nominatimUrl, 2500, { 'Accept': 'application/json', 'Accept-Language': 'en,zh-HK' }, 3600)
  ]);

  const toTitleCaseEn = (str) => String(str || '')
    .replace(/^(BLOCK|TOWER|FLAT|ROOM|UNIT|FLOOR|PHASE)\s+[A-Z0-9-]+\s*,\s*/i, '')
    .toLowerCase()
    .replace(/\b[a-z]/g, ch => ch.toUpperCase())
    .replace(/\bRoad\b/g, 'Rd')
    .replace(/\bStreet\b/g, 'St')
    .replace(/\bAvenue\b/g, 'Ave')
    .trim();

  const cleanZhPrefix = (str) => String(str || '')
    .replace(/^(第?[A-Z0-9一二三四五六七八九十]+(座|期|樓|室))\s*/i, '')
    .trim();

  const distMeters = (la1, lo1, la2, lo2) => Math.hypot((la2 - la1) * 111320, (lo2 - lo1) * 102900);

  const results = [];
  const pushUnique = (item) => {
    if (!item || !isValidHkCoord(item.lat, item.lon)) return;
    const itemNameEn = String(item.name_en || '').trim();
    if (!itemNameEn) return;
    item.name_en = itemNameEn;
    const itemKeyLower = itemNameEn.toLowerCase();
    const isDup = results.some(ex =>
      distMeters(ex.lat, ex.lon, item.lat, item.lon) < 95 &&
      (String(ex.name_en || '').toLowerCase() === itemKeyLower || (item.streetKey && ex.streetKey === item.streetKey))
    );
    if (!isDup && results.length < 10) results.push(item);
  };

  if (alsRes && alsRes.ok) {
    try {
      const data = await alsRes.json();
      const rawList = Array.isArray(data?.SuggestedAddress) ? data.SuggestedAddress : (data?.SuggestedAddress ? [data.SuggestedAddress] : []);
      for (const item of rawList) {
        const prem = item?.Address?.PremisesAddress;
        const geoRaw = prem?.GeospatialInformation;
        const geo = Array.isArray(geoRaw) ? geoRaw[0] : geoRaw;
        const lat = parseFloat(geo?.Latitude), lon = parseFloat(geo?.Longitude);
        const eng = prem?.EngPremisesAddress || {};
        const chi = prem?.ChiPremisesAddress || {};
        const engSt = [eng.EngStreet?.BuildingNoFrom, eng.EngStreet?.StreetName].filter(Boolean).join(' ');
        const chiSt = [chi.ChiStreet?.StreetName, chi.ChiStreet?.BuildingNoFrom ? `${chi.ChiStreet.BuildingNoFrom}號` : ''].filter(Boolean).join('');
        const rawEn = [eng.BuildingName, eng.EngEstate?.EstateName, engSt].filter(Boolean).join(', ') || cleanedQ;
        const name_en = toTitleCaseEn(rawEn);
        const chiBldg = cleanZhPrefix(chi.BuildingName || '');
        const name_zh = [chi.ChiEstate?.EstateName, chiBldg, chiSt].filter(Boolean).join(' ').trim() || name_en;
        pushUnique({
          name_en,
          name_zh,
          name_tc: name_zh,
          district_en: toTitleCaseEn((eng.EngDistrict?.DcDistrict || '').replace(/\s+DISTRICT$/i, '')),
          district_zh: chi.ChiDistrict?.DcDistrict || '',
          streetKey: (engSt || name_en).toLowerCase(),
          lat: Number(lat.toFixed(6)),
          lon: Number(lon.toFixed(6))
        });
      }
    } catch (e) {}
  }

  if (geoRes && geoRes.ok) {
    try {
      const gList = await geoRes.json();
      if (Array.isArray(gList)) {
        const converted = await Promise.all(
          gList.slice(0, 6).map(async (g) => {
            if (!g?.x || !g?.y) return null;
            const wgs = await hk80ToWgs84Api(Number(g.y), Number(g.x), true);
            return wgs ? { g, wgs } : null;
          })
        );
        for (const item of converted) {
          if (!item) continue;
          const { g, wgs } = item;
          const name_en = toTitleCaseEn(g.nameEN || g.addressEN || cleanedQ);
          const name_zh = (g.nameZH || g.addressZH || name_en).trim();
          pushUnique({
            name_en,
            name_zh,
            name_tc: name_zh,
            district_en: toTitleCaseEn(g.districtEN || ''),
            district_zh: g.districtZH || '',
            streetKey: name_en.toLowerCase(),
            lat: Number(wgs.lat.toFixed(6)),
            lon: Number(wgs.lon.toFixed(6))
          });
        }
      }
    } catch (e) {}
  }

  if (nomRes && nomRes.ok) {
    try {
      const nomList = await nomRes.json();
      if (Array.isArray(nomList)) {
        for (const n of nomList) {
          const lat = parseFloat(n.lat), lon = parseFloat(n.lon);
          const nameEn = n.namedetails?.['name:en'] || n.name || (n.display_name || '').split(',')[0];
          const nameZh = n.namedetails?.['name:zh-Hant'] || n.namedetails?.['name:zh'] || n.namedetails?.name || nameEn;
          const distEn = n.address?.suburb || n.address?.town || n.address?.city_district || n.address?.city || '';
          pushUnique({
            name_en: nameEn,
            name_zh: nameZh,
            name_tc: nameZh,
            district_en: distEn,
            district_zh: distEn,
            streetKey: nameEn.toLowerCase(),
            lat: Number(lat.toFixed(6)),
            lon: Number(lon.toFixed(6))
          });
        }
      }
    } catch (e) {}
  }

  if (photonRes && photonRes.ok) {
    try {
      const pJson = await photonRes.json();
      for (const feat of (pJson?.features || [])) {
        const coords = feat?.geometry?.coordinates;
        const prop = feat?.properties || {};
        if (!Array.isArray(coords) || coords.length < 2 || !prop.name) continue;
        const lon = Number(coords[0]), lat = Number(coords[1]);
        const streetPart = [prop.housenumber, prop.street].filter(Boolean).join(' ');
        const rawLabel = [prop.name, streetPart].filter(Boolean).join(', ');
        pushUnique({
          name_en: rawLabel,
          name_zh: prop.name,
          name_tc: prop.name,
          district_en: prop.district || prop.city || '',
          district_zh: prop.district || '',
          streetKey: rawLabel.toLowerCase(),
          lat: Number(lat.toFixed(6)),
          lon: Number(lon.toFixed(6))
        });
      }
    } catch (e) {}
  }

  return new Response(JSON.stringify({ ok: true, results }), { headers: CORS_HEADERS });
}

function classifyTrafficCorridorSeverity(rawBody, curStatus = '') {
  const st = String(curStatus || '').toLowerCase();
  if (/cancel|clear|normal/.test(st)) return null;
  const body = String(rawBody || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!body || /re-?opened|back to normal|resumed|normal traffic|has been removed|disperse/.test(body)) return null;

  const isRoutineWorks = /watermain|roadworks|scheduled\s+maintenance|road\s+resurfacing/i.test(body);
  const isSevereHazard = /traffic\s*accident|flooding|landslip|vehicle\s*fire|fallen\s*tree/i.test(body);
  const isFullClosure = /all lanes.*closed|entire.*closed|full.*closure|bus service.*suspended|route.*suspended/i.test(body);
  const isPartialLane = /part of the lanes|one lane|remaining lane|slow lane|fast lane|middle lane/i.test(body);

  if (isRoutineWorks && !isFullClosure && !isSevereHazard) return null;

  const isFullBlockage = isFullClosure || isSevereHazard;
  const isHeavyCongestion = !isPartialLane && /very\s*busy|congested|congestion|heavy\s*traffic|long\s*queue|seriously\s*delayed/i.test(body);
  if (isFullBlockage) return 'INCIDENT';
  if (isHeavyCongestion) return 'SLOW';
  return null;
}

function parseHkoWeatherSummary(wData) {
  const weather = {
    heavyRain: false,
    rainAdvisory: false,
    typhoon: false,
    warningCodes: [],
    labelEn: '',
    labelTc: ''
  };
  if (!wData || typeof wData !== 'object') return weather;

  let priority = 0; // 1=Amber, 2=Red, 3=Black, 4=Typhoon 8+
  for (const val of Object.values(wData)) {
    const code = String(val?.code || '').toUpperCase();
    if (!code) continue;
    weather.warningCodes.push(code);
    if (/^TC(8|9|10)/.test(code)) {
      weather.heavyRain = true;
      weather.typhoon = true;
      if (priority < 4) {
        priority = 4;
        weather.labelEn = `Typhoon ${code}`;
        weather.labelTc = '八號或以上風球';
      }
    } else if (code === 'WRAINB') {
      weather.heavyRain = true;
      if (priority < 3) {
        priority = 3;
        weather.labelEn = 'Black Rainstorm';
        weather.labelTc = '黑色暴雨';
      }
    } else if (code === 'WRAINR') {
      weather.heavyRain = true;
      if (priority < 2) {
        priority = 2;
        weather.labelEn = 'Red Rainstorm';
        weather.labelTc = '紅色暴雨';
      }
    } else if (code === 'WRAINA') {
      weather.rainAdvisory = true;
      if (priority < 1) {
        priority = 1;
        weather.labelEn = 'Amber Rainstorm';
        weather.labelTc = '黃色暴雨';
      }
    } else if (code === 'TC3') {
      weather.rainAdvisory = true;
    }
  }
  return weather;
}

// 3. ALL 8 HK STRATEGIC CORRIDORS + HKO SEVERE WEATHER
async function syncTdStrategicTrafficCorridorsAndWeather() {
  const highwayCorridors = {};
  for (const id of Object.keys(CORRIDOR_PATTERNS)) {
    highwayCorridors[id] = { id, speedKmh: 70, status: 'SMOOTH', headline: '' };
  }

  const [stnRes, hkoRes] = await Promise.all([
    fetchWithTimeout('https://resource.data.one.gov.hk/td/en/specialtrafficnews.xml', 2800, {}, 60),
    fetchWithTimeout('https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en', 2500, {}, 120)
  ]);

  try {
    const messages = stnRes?.ok ? parseXmlRecords(await stnRes.text(), 'message') : [];
    for (const msg of messages) {
      const rawBody = `${msg.EngText || ''} ${msg.EngShort || ''}`.replace(/\s+/g, ' ').trim();
      const severity = classifyTrafficCorridorSeverity(rawBody, msg.CurrentStatus);
      if (!severity) continue;

      const body = rawBody.toLowerCase();
      for (const [corId, pat] of Object.entries(CORRIDOR_PATTERNS)) {
        if (!pat.test(body)) continue;
        if (severity === 'INCIDENT') {
          highwayCorridors[corId] = {
            id: corId,
            speedKmh: 32,
            status: 'INCIDENT',
            headline: rawBody.slice(0, 140)
          };
        } else if (highwayCorridors[corId].status === 'SMOOTH') {
          highwayCorridors[corId] = {
            id: corId,
            speedKmh: 45,
            status: 'SLOW',
            headline: rawBody.slice(0, 140)
          };
        }
      }
    }
  } catch (e) {}

  let weather = parseHkoWeatherSummary(null);
  try {
    const wData = hkoRes?.ok ? await hkoRes.json().catch(() => null) : null;
    weather = parseHkoWeatherSummary(wData);
  } catch (e) {}

  // Backward-compatible alias for older cached clients
  highwayCorridors.TM_CLK_TUNNEL = { ...highwayCorridors.LANTAU_TM, id: 'TM_CLK_TUNNEL' };

  return { highwayCorridors, weather };
}

function haversineKmWorker(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.max(0, a)), Math.sqrt(Math.max(0, 1 - a)));
}

function classifyDetectorCongestion(speedKmh, occPct) {
  const spd = Number(speedKmh);
  const occ = Number(occPct) || 0;
  if (!Number.isFinite(spd)) return 'SMOOTH';
  if (spd < 24 || (occ >= 60 && spd < 38)) return 'JAMMED';
  if (spd < 46 || (occ >= 35 && spd < 56)) return 'SLOW';
  return 'SMOOTH';
}

function parseStrategicDetectorCsv(csvText) {
  const rows = parseCsv(csvText);
  const out = new Map();
  for (const r of rows) {
    const id = String(r.AID_ID_Number || '').trim();
    const lat = parseFloat(r.Latitude);
    const lon = parseFloat(r.Longitude);
    if (!id || !isValidHkCoord(lat, lon)) continue;
    const rotRaw = parseFloat(r.Rotation);
    const roadEn = String(r.Road_EN || '').replace(/\s*\[AID[^\]]*\]\s*/gi, '').trim();
    const roadTc = String(r.Road_TC || '').replace(/\s*\[AID[^\]]*\]\s*/gi, '').trim();
    out.set(id, {
      id,
      district: String(r.District || '').trim(),
      roadEn,
      roadTc: roadTc || roadEn,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      dir: String(r.Direction || '').trim(),
      rot: Number.isFinite(rotRaw) ? ((Math.round(rotRaw) % 360) + 360) % 360 : 0
    });
  }
  return out;
}

function parseRawSpeedVolXml(xmlText) {
  const liveMap = new Map();
  const str = String(xmlText || '');
  const dateM = str.match(/<date>([^<]+)<\/date>/);
  const perM = str.match(/<period_to>([^<]+)<\/period_to>/);
  const capturedAt = [dateM?.[1], perM?.[1]].filter(Boolean).join(' ').trim();

  const detRe = /<detector>[\s\S]*?<detector_id>([^<]+)<\/detector_id>[\s\S]*?<lanes>([\s\S]*?)<\/lanes>[\s\S]*?<\/detector>/gi;
  let m;
  while ((m = detRe.exec(str)) !== null) {
    const id = m[1].trim();
    const lanesBlock = m[2];
    const laneRe = /<lane>[\s\S]*?<speed>([^<]+)<\/speed>[\s\S]*?<occupancy>([^<]+)<\/occupancy>[\s\S]*?<volume>([^<]+)<\/volume>[\s\S]*?<valid>([^<]+)<\/valid>/gi;
    let lm;
    let sumSpd = 0, sumOcc = 0, sumVol = 0, cnt = 0;
    while ((lm = laneRe.exec(lanesBlock)) !== null) {
      if (lm[4].trim().toUpperCase() !== 'Y') continue;
      const spd = parseFloat(lm[1]);
      const occ = parseFloat(lm[2]);
      const vol = parseFloat(lm[3]);
      if (Number.isFinite(spd) && spd >= 0 && spd <= 140) {
        sumSpd += spd;
        sumOcc += (Number.isFinite(occ) ? occ : 0);
        sumVol += (Number.isFinite(vol) ? vol : 0);
        cnt++;
      }
    }
    if (cnt > 0) {
      liveMap.set(id, {
        speed: Math.round(sumSpd / cnt),
        occ: Math.round(sumOcc / cnt),
        vol: Math.round(sumVol)
      });
    }
  }
  return { capturedAt, liveMap };
}

function decodeTextBufferAuto(buf) {
  if (!buf || !buf.byteLength) return '';
  const u8 = new Uint8Array(buf);
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(u8.subarray(2));
  }
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(u8.subarray(2));
  }
  return new TextDecoder('utf-8').decode(u8);
}

function parseTrafficCameraCsv(tsvOrCsvText) {
  const lines = String(tsvOrCsvText || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const hdrs = lines[0].split(delim).map(h => h.trim().toLowerCase());
  const iKey = hdrs.indexOf('key');
  const iDesc = hdrs.indexOf('description');
  const iLat = hdrs.indexOf('latitude');
  const iLon = hdrs.indexOf('longitude');
  const iUrl = hdrs.indexOf('url');
  const cams = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    if (cols.length < 7) continue;
    const key = String(cols[iKey >= 0 ? iKey : 0] || '').trim();
    const desc = String(cols[iDesc >= 0 ? iDesc : 3] || '').replace(/\s*\[[^\]]+\]\s*$/, '').trim();
    const lat = parseFloat(cols[iLat >= 0 ? iLat : 6]);
    const lon = parseFloat(cols[iLon >= 0 ? iLon : 7]);
    const url = String(cols[iUrl >= 0 ? iUrl : 8] || '').trim();
    if (!key || !isValidHkCoord(lat, lon)) continue;
    cams.push({
      key,
      desc,
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      url: url || `https://tdcctv.data.one.gov.hk/${key}.JPG`
    });
  }
  return cams;
}

let _cachedTrafficStaticMeta = null;
let _cachedTrafficStaticMetaTs = 0;

function _extractRoadCoreWorker(text) {
  return String(text || '')
    .split(/\s+near\s+|\s+-\s+|\s*\/\s*|\s*\(/i)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function _extractCardinalDirWorker(text, rot = null) {
  const s = String(text || '');
  if (/\b(?:eastbound|east[\s-]*bound|\(eb\)|eb)\b|東行/i.test(s)) return 'EB';
  if (/\b(?:westbound|west[\s-]*bound|\(wb\)|wb)\b|西行/i.test(s)) return 'WB';
  if (/\b(?:northbound|north[\s-]*bound|\(nb\)|nb)\b|北行/i.test(s)) return 'NB';
  if (/\b(?:southbound|south[\s-]*bound|\(sb\)|sb)\b|南行/i.test(s)) return 'SB';
  if (/^\s*east\s*$/i.test(s)) return 'EB';
  if (/^\s*west\s*$/i.test(s)) return 'WB';
  if (/^\s*north\s*$/i.test(s)) return 'NB';
  if (/^\s*south\s*$/i.test(s)) return 'SB';
  if (rot !== null && rot !== undefined && Number.isFinite(Number(rot))) {
    const deg = ((Number(rot) % 360) + 360) % 360;
    if (deg >= 45 && deg < 135) return 'EB';
    if (deg >= 135 && deg < 225) return 'SB';
    if (deg >= 225 && deg < 315) return 'WB';
    return 'NB';
  }
  return '';
}

function _isOppositeCardinalWorker(a, b) {
  return (a === 'EB' && b === 'WB') || (a === 'WB' && b === 'EB') || (a === 'NB' && b === 'SB') || (a === 'SB' && b === 'NB');
}

const HK_CAMERA_LANDMARK_ANCHORS = [
  { re: /\btm[\s-]*clk(?:l|\s*tunnel)?\s*(?:northern|north)\s*portal\b/i, lat: 22.3694, lon: 113.9585 },
  { re: /\btm[\s-]*clk(?:l|\s*tunnel)?\s*(?:southern|south)\s*portal\b/i, lat: 22.3176, lon: 113.9498 },
  { re: /\btm[\s-]*clkl\b|\btuen\s*mun[\s-]*chek\s*lap\s*kok\b/i, lat: 22.3694, lon: 113.9585 },
  { re: /\blung\s*mun\s*(?:rd|road)\s*roundabout\b/i, lat: 22.3712, lon: 113.9562 },
  { re: /\blung\s*mun\s*(?:rd|road)\b/i, lat: 22.3782, lon: 113.9612 },
  { re: /\bwong\s*chu\s*(?:rd|road)\b/i, lat: 22.3822, lon: 113.9675 },
  { re: /\btuen\s*mun\s*(?:rd|road)\b/i, lat: 22.3885, lon: 113.9765 },
  { re: /\bhzmb\b|\bhong\s*kong\s*port\b|\bshun\s*long\s*(?:rd|road)\b/i, lat: 22.3168, lon: 113.9502 },
  { re: /\bnorth\s*lantau\s*(?:hwy|highway)\b/i, lat: 22.2952, lon: 113.9438 },
  { re: /\btung\s*chung\b/i, lat: 22.2892, lon: 113.9416 },
  { re: /\bairport\b|\bchek\s*lap\s*kok\b/i, lat: 22.3080, lon: 113.9185 },
  { re: /\btsing\s*ma\b|\blantau\s*link\b/i, lat: 22.3514, lon: 114.0737 },
  { re: /\bting\s*kau\b/i, lat: 22.3688, lon: 114.0793 },
  { re: /\btai\s*lam\s*tunnel\b/i, lat: 22.4048, lon: 114.0598 },
  { re: /\byuen\s*long\s*(?:hwy|highway)\b/i, lat: 22.4388, lon: 114.0110 },
  { re: /\btolo\s*(?:hwy|highway)\b/i, lat: 22.4265, lon: 114.2055 },
  { re: /\blion\s*rock\s*tunnel\b/i, lat: 22.3568, lon: 114.1755 },
  { re: /\btate'?s\s*cairn\b/i, lat: 22.3698, lon: 114.2125 },
  { re: /\bshing\s*mun\s*tunnel\b/i, lat: 22.3792, lon: 114.1562 },
  { re: /\bcross[\s-]*harbour\s*tunnel\b|\bcht\b/i, lat: 22.2918, lon: 114.1818 },
  { re: /\bwestern\s*harbour\b|\bwhc\b/i, lat: 22.2955, lon: 114.1525 },
  { re: /\beastern\s*harbour\b|\behc\b/i, lat: 22.2958, lon: 114.2225 },
  { re: /\baberdeen\s*tunnel\b/i, lat: 22.2562, lon: 114.1755 },
  { re: /\btseung\s*kwan\s*o\s*tunnel\b|\btko\s*tunnel\b/i, lat: 22.3182, lon: 114.2465 },
  { re: /\bcheung\s*tsing\b/i, lat: 22.3515, lon: 114.0985 },
  { re: /\beagle'?s\s*nest\b|\btsing\s*sha\b/i, lat: 22.3502, lon: 114.1538 },
  { re: /\bcentral[\s-]*wan\s*chai\s*bypass\b/i, lat: 22.2852, lon: 114.1745 }
];

function _normalizeBearingDegWorker(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return ((Math.round(n) % 360) + 360) % 360;
}

function _cardinalToDegWorker(dirCode) {
  if (dirCode === 'NB') return 0;
  if (dirCode === 'NE') return 45;
  if (dirCode === 'EB') return 90;
  if (dirCode === 'SE') return 135;
  if (dirCode === 'SB') return 180;
  if (dirCode === 'SW') return 225;
  if (dirCode === 'WB') return 270;
  if (dirCode === 'NW') return 315;
  return null;
}

function computeCameraBearingDegWorker(cam, detectorList = [], cameraList = []) {
  if (!cam) return 0;
  const cLat = Number(cam.lat);
  const cLon = Number(cam.lon);
  const desc = String(cam.desc || '');
  const cRoad = _extractRoadCoreWorker(desc);

  // 1. Exact paired detector rot bearing
  if (Array.isArray(detectorList) && detectorList.length) {
    for (let i = 0; i < detectorList.length; i++) {
      const d = detectorList[i];
      if (!d) continue;
      if ((d.id === cam.key || d.camKey === cam.key) && Number.isFinite(Number(d.rot))) {
        return _normalizeBearingDegWorker(d.rot);
      }
    }
  }

  // 2. Explicit cardinal / intercardinal bound from camera description, refined by nearby compatible detector rot
  let textDir = cam.dir || _extractCardinalDirWorker(desc, null);
  if (!textDir) {
    if (/\bnorth[\s-]*east(?:bound)?\b/i.test(desc)) textDir = 'NE';
    else if (/\bnorth[\s-]*west(?:bound)?\b/i.test(desc)) textDir = 'NW';
    else if (/\bsouth[\s-]*east(?:bound)?\b/i.test(desc)) textDir = 'SE';
    else if (/\bsouth[\s-]*west(?:bound)?\b/i.test(desc)) textDir = 'SW';
  }
  const textDeg = _cardinalToDegWorker(textDir);
  if (textDeg !== null) {
    if (Number.isFinite(cLat) && Number.isFinite(cLon) && Array.isArray(detectorList) && detectorList.length) {
      let bestDetRot = null;
      let bestScore = Infinity;
      for (let i = 0; i < detectorList.length; i++) {
        const d = detectorList[i];
        if (!d || !Number.isFinite(Number(d.rot)) || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
        if (Math.abs(d.lat - cLat) > 0.007 || Math.abs(d.lon - cLon) > 0.007) continue;
        const dKm = haversineKmWorker(cLat, cLon, d.lat, d.lon);
        if (dKm > 0.65) continue;
        const dAng = angDiffDegWorker(textDeg, Number(d.rot));
        if (dAng > 55) continue;
        const dRoad = _extractRoadCoreWorker(d.roadEn);
        const sameRoad = Boolean(cRoad && dRoad && (cRoad === dRoad || cRoad.includes(dRoad) || dRoad.includes(cRoad)));
        const score = dKm + (sameRoad ? 0 : 0.25) + dAng * 0.002;
        if (score < bestScore) {
          bestScore = score;
          bestDetRot = Number(d.rot);
        }
      }
      if (bestDetRot !== null) return _normalizeBearingDegWorker(bestDetRot);
    }
    return textDeg;
  }

  // 3. Standalone intersection / roundabout / tunnel portal cameras:
  //    infer bearing from vector to named landmark / cross-road in description
  if (Number.isFinite(cLat) && Number.isFinite(cLon) && desc) {
    const landmarkFocusMatch = desc.match(/(?:\bnear\b|\btowards?\b|\bfacing\b|\bat\b|\/)\s*([^(\-–,]+)/i);
    const focusPhrase = landmarkFocusMatch ? landmarkFocusMatch[1].trim() : '';

    // 3a. Check named focus phrase first (e.g. "near TM-CLKL" in TC002F), then full description
    const candidatePhrases = focusPhrase ? [focusPhrase, desc] : [desc];
    for (let pIdx = 0; pIdx < candidatePhrases.length; pIdx++) {
      const phrase = candidatePhrases[pIdx];
      for (let aIdx = 0; aIdx < HK_CAMERA_LANDMARK_ANCHORS.length; aIdx++) {
        const anchor = HK_CAMERA_LANDMARK_ANCHORS[aIdx];
        if (!anchor.re.test(phrase)) continue;
        const distKm = haversineKmWorker(cLat, cLon, anchor.lat, anchor.lon);
        if (distKm >= 0.025 && distKm <= 8.0) {
          return _normalizeBearingDegWorker(bearingDegWorker(cLat, cLon, anchor.lat, anchor.lon));
        }
      }
    }

    // 3b. Cross-road token match against nearby detectors or sibling cameras within 1.5 km
    const crossCore = _extractRoadCoreWorker(focusPhrase || '');
    if (crossCore && crossCore.length >= 4) {
      let bestTarget = null;
      let bestDistKm = Infinity;
      for (let i = 0; i < detectorList.length; i++) {
        const d = detectorList[i];
        if (!d || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
        const dKm = haversineKmWorker(cLat, cLon, d.lat, d.lon);
        if (dKm < 0.025 || dKm > 1.5) continue;
        const dText = String(d.roadEn || '').toLowerCase();
        if (dText.includes(crossCore) && dKm < bestDistKm) {
          bestDistKm = dKm;
          bestTarget = d;
        }
      }
      if (!bestTarget && Array.isArray(cameraList)) {
        for (let i = 0; i < cameraList.length; i++) {
          const other = cameraList[i];
          if (!other || other.key === cam.key) continue;
          const dKm = haversineKmWorker(cLat, cLon, other.lat, other.lon);
          if (dKm < 0.025 || dKm > 1.5) continue;
          if (String(other.desc || '').toLowerCase().includes(crossCore) && dKm < bestDistKm) {
            bestDistKm = dKm;
            bestTarget = other;
          }
        }
      }
      if (bestTarget) {
        return _normalizeBearingDegWorker(bearingDegWorker(cLat, cLon, bestTarget.lat, bestTarget.lon));
      }
    }

    // 4. Nearest road segment tangent / detector vector fallback
    let nearestSameRoadDet = null;
    let nearestSameRoadDist = Infinity;
    let nearestAnyDet = null;
    let nearestAnyDist = Infinity;
    for (let i = 0; i < detectorList.length; i++) {
      const d = detectorList[i];
      if (!d || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
      if (Math.abs(d.lat - cLat) > 0.015 || Math.abs(d.lon - cLon) > 0.015) continue;
      const dKm = haversineKmWorker(cLat, cLon, d.lat, d.lon);
      if (dKm > 1.4) continue;
      const dRoad = _extractRoadCoreWorker(d.roadEn);
      const sameRoad = Boolean(cRoad && dRoad && (cRoad === dRoad || cRoad.includes(dRoad) || dRoad.includes(cRoad)));
      if (sameRoad && dKm < nearestSameRoadDist) {
        nearestSameRoadDist = dKm;
        nearestSameRoadDet = d;
      }
      if (dKm < nearestAnyDist) {
        nearestAnyDist = dKm;
        nearestAnyDet = d;
      }
    }
    const chosenDet = nearestSameRoadDet || nearestAnyDet;
    if (chosenDet) {
      if (Number.isFinite(Number(chosenDet.rot)) && nearestSameRoadDist <= 0.65) {
        return _normalizeBearingDegWorker(chosenDet.rot);
      }
      if (haversineKmWorker(cLat, cLon, chosenDet.lat, chosenDet.lon) >= 0.02) {
        return _normalizeBearingDegWorker(bearingDegWorker(cLat, cLon, chosenDet.lat, chosenDet.lon));
      }
      if (Number.isFinite(Number(chosenDet.rot))) {
        return _normalizeBearingDegWorker(chosenDet.rot);
      }
    }
  }

  return 0;
}

async function getTrafficStaticMetadata() {
  const now = Date.now();
  if (_cachedTrafficStaticMeta && (now - _cachedTrafficStaticMetaTs) < 6 * 3600 * 1000) {
    return _cachedTrafficStaticMeta;
  }
  const [majCsvRes, slpCsvRes, camRes] = await Promise.all([
    fetchWithTimeout('https://static.data.gov.hk/td/traffic-data-strategic-major-roads/info/traffic_speed_volume_occ_info.csv', 4000, {}, 86400),
    fetchWithTimeout('https://static.data.gov.hk/td/traffic-data-slp/info/traffic_speed_volume_occ_info-slp.csv', 3000, {}, 86400),
    fetchWithTimeout('https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.csv', 3500, {}, 86400)
  ]);

  const detectorMeta = new Map();
  if (majCsvRes?.ok) {
    for (const [k, v] of parseStrategicDetectorCsv(await majCsvRes.text())) detectorMeta.set(k, v);
  }
  if (slpCsvRes?.ok) {
    for (const [k, v] of parseStrategicDetectorCsv(await slpCsvRes.text())) detectorMeta.set(k, v);
  }

  let cameras = [];
  if (camRes?.ok) {
    const camBuf = await camRes.arrayBuffer();
    cameras = parseTrafficCameraCsv(decodeTextBufferAuto(camBuf)).map((c) => ({
      ...c,
      dir: _extractCardinalDirWorker(c.desc, null)
    }));
  }

  // Pre-bind official TD road snapshot camera using exact ID first, then same-road/direction proximity (<= 0.35 km)
  const detectorList = Array.from(detectorMeta.values());
  if (cameras.length && detectorMeta.size) {
    const camByKey = new Map();
    for (let i = 0; i < cameras.length; i++) {
      camByKey.set(cameras[i].key, cameras[i]);
    }
    for (const det of detectorMeta.values()) {
      const exactCam = camByKey.get(det.id);
      if (exactCam) {
        det.camKey = exactCam.key;
        det.camDesc = exactCam.desc;
        continue;
      }
      const detRoad = _extractRoadCoreWorker(det.roadEn);
      const detDir = _extractCardinalDirWorker(`${det.roadEn || ''} ${det.dir || ''}`, det.rot);
      let bestCam = null;
      let bestScore = Infinity;
      for (let i = 0; i < cameras.length; i++) {
        const c = cameras[i];
        if (Math.abs(c.lat - det.lat) > 0.004 || Math.abs(c.lon - det.lon) > 0.0045) continue;
        const dKm = haversineKmWorker(det.lat, det.lon, c.lat, c.lon);
        if (dKm > 0.35) continue;
        const cDir = c.dir || '';
        if (detDir && cDir && _isOppositeCardinalWorker(detDir, cDir)) continue;
        const cRoad = _extractRoadCoreWorker(c.desc);
        const sameRoad = Boolean(detRoad && cRoad && (cRoad === detRoad || cRoad.includes(detRoad) || detRoad.includes(cRoad)));
        if (!sameRoad && dKm > 0.15) continue;
        const dirBonus = (detDir && cDir && detDir === cDir) ? 0 : (cDir ? 0.08 : 0.04);
        const roadPenalty = sameRoad ? 0 : 0.12;
        const score = dKm + dirBonus + roadPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestCam = c;
        }
      }
      if (bestCam) {
        det.camKey = bestCam.key;
        det.camDesc = bestCam.desc;
      }
    }
  }

  // Compute directional viewing bearing (0-359 deg) for every TD camera (paired detectors, bounds & roundabout/portal landmarks)
  if (cameras.length) {
    cameras = cameras.map((c) => {
      const bearingDeg = computeCameraBearingDegWorker(c, detectorList, cameras);
      return {
        ...c,
        bearingDeg
      };
    });
  }

  if (detectorMeta.size > 0) {
    _cachedTrafficStaticMeta = { detectorMeta, cameras };
    _cachedTrafficStaticMetaTs = now;
  }
  return _cachedTrafficStaticMeta || { detectorMeta, cameras };
}

function getTrafficSpeedColorHexWorker(speedKmh) {
  if (speedKmh === null || speedKmh === undefined) return '#3b82f6';
  const s = Number(speedKmh);
  if (!Number.isFinite(s)) return '#3b82f6';
  if (s < 20) return '#dc2626';
  if (s <= 40) return '#f59e0b';
  return '#16a34a';
}

function projectPointMetersWorker(lat, lon, bearingDeg, meters) {
  const rad = (Number(bearingDeg) || 0) * Math.PI / 180;
  const dLat = (meters * Math.cos(rad)) / 111111;
  const dLon = (meters * Math.sin(rad)) / (111111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [Number((lat + dLat).toFixed(6)), Number((lon + dLon).toFixed(6))];
}

function angDiffDegWorker(a, b) {
  const d = Math.abs(((Number(a) || 0) - (Number(b) || 0)) % 360);
  return d > 180 ? 360 - d : d;
}

function bearingDegWorker(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function buildWorkerSpeedMapGeoJson(detectorMeta, combinedLive) {
  const features = [];
  const allEntries = [];
  for (const [id, det] of detectorMeta.entries()) {
    const reading = combinedLive.get(id);
    if (!reading) continue;
    const spd = reading.speed;
    const occ = reading.occ;
    const tier = classifyDetectorCongestion(reading.speed, reading.occ);
    const color = getTrafficSpeedColorHexWorker(spd);
    // Light default left-hand offset (6m) for HK left-hand traffic; client refines dynamically by zoom
    const leftBrg = ((Number(det.rot) || 0) + 270) % 360;
    const [cLat, cLon] = projectPointMetersWorker(det.lat, det.lon, leftBrg, 6);
    allEntries.push({
      id,
      lat: det.lat,
      lon: det.lon,
      cLat,
      cLon,
      rot: Number(det.rot) || 0,
      spd,
      occ,
      dir: det.dir || '',
      roadEn: det.roadEn || '',
      roadTc: det.roadTc || det.roadEn || '',
      roadCore: _extractRoadCoreWorker(det.roadEn),
      tier,
      color,
      camKey: det.camKey || ''
    });
  }

  // Group by road core name to stitch adjacent same-direction strategic detectors into clean arterial links (>= 350 m)
  const byRoad = new Map();
  for (let i = 0; i < allEntries.length; i++) {
    const e = allEntries[i];
    const rk = e.roadCore || e.id;
    if (!byRoad.has(rk)) byRoad.set(rk, []);
    byRoad.get(rk).push(e);
  }

  for (const list of byRoad.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      let bestNext = null;
      let bestDistKm = Infinity;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const b = list[j];
        if (angDiffDegWorker(a.rot, b.rot) > 30) continue;
        const dKm = haversineKmWorker(a.lat, a.lon, b.lat, b.lon);
        // Filter out short/curved interchange ramp stubs (< 350 m straight-line distance)
        if (dKm < 0.35 || dKm > 2.2) continue;
        const linkBrg = bearingDegWorker(a.lat, a.lon, b.lat, b.lon);
        const maxLinkAng = dKm > 1.0 ? 16 : 22;
        if (angDiffDegWorker(a.rot, linkBrg) > maxLinkAng) continue;
        if (angDiffDegWorker(b.rot, linkBrg) > maxLinkAng) continue;
        if (dKm < bestDistKm) {
          bestDistKm = dKm;
          bestNext = b;
        }
      }

      if (!bestNext) continue;

      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[a.cLon, a.cLat], [bestNext.cLon, bestNext.cLat]] },
        properties: {
          id: a.id,
          roadEn: a.roadEn,
          roadTc: a.roadTc,
          dir: a.dir,
          rot: a.rot,
          spd: a.spd,
          occ: a.occ,
          tier: a.tier,
          color: a.color,
          camKey: a.camKey,
          lenM: Math.round(bestDistKm * 1000),
          rawCoords: [[a.lon, a.lat], [bestNext.lon, bestNext.lat]]
        }
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

async function handleTrafficLiveRequest() {
  const [metaBundle, majXmlRes, slpXmlRes] = await Promise.all([
    getTrafficStaticMetadata(),
    fetchWithTimeout('https://resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol-all.xml', 4200, {}, 25),
    fetchWithTimeout('https://resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol_SLP-all.xml', 3000, {}, 25)
  ]);

  const detectorMeta = metaBundle?.detectorMeta || new Map();
  const cameras = Array.isArray(metaBundle?.cameras) ? metaBundle.cameras : [];
  const parsedMaj = majXmlRes?.ok ? parseRawSpeedVolXml(await majXmlRes.text()) : { capturedAt: '', liveMap: new Map() };
  const parsedSlp = slpXmlRes?.ok ? parseRawSpeedVolXml(await slpXmlRes.text()) : { capturedAt: '', liveMap: new Map() };

  const combinedLive = new Map([...parsedMaj.liveMap, ...parsedSlp.liveMap]);
  const detectors = [];
  let smooth = 0, slow = 0, jammed = 0;

  for (const [id, det] of detectorMeta.entries()) {
    const reading = combinedLive.get(id);
    if (!reading) continue;
    const tier = classifyDetectorCongestion(reading.speed, reading.occ);
    if (tier === 'JAMMED') jammed++;
    else if (tier === 'SLOW') slow++;
    else smooth++;

    // Compact object preserving full fidelity & fast client lookup
    detectors.push({
      id,
      lat: det.lat,
      lon: det.lon,
      rot: det.rot,
      spd: reading.speed,
      occ: reading.occ,
      vol: reading.vol,
      dir: det.dir,
      roadEn: det.roadEn,
      roadTc: det.roadTc,
      tier,
      color: getTrafficSpeedColorHexWorker(reading.speed),
      camKey: det.camKey || ''
    });
  }

  const speedMapGeoJson = buildWorkerSpeedMapGeoJson(detectorMeta, combinedLive);

  return new Response(
    JSON.stringify({
      ok: true,
      ts: Date.now(),
      capturedAt: parsedMaj.capturedAt || parsedSlp.capturedAt || '',
      stats: { total: detectors.length, smooth, slow, jammed, cameras: cameras.length },
      detectors,
      cameras,
      speedMapGeoJson
    }),
    { headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=20' } }
  );
}

function distSqDeg(a, b) {
  const dLat = a[0] - b[0];
  const dLon = a[1] - b[1];
  return dLat * dLat + dLon * dLon;
}

function perpDistDegSq(p, a, b) {
  const dx = b[1] - a[1];
  const dy = b[0] - a[0];
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return distSqDeg(p, a);
  const t = Math.max(0, Math.min(1, ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / lenSq));
  const px = a[1] + t * dx;
  const py = a[0] + t * dy;
  return (p[0] - py) ** 2 + (p[1] - px) ** 2;
}

function simplifyPolylineCoords(pts, epsDeg = 0.00008, maxPts = 420) {
  if (!Array.isArray(pts) || pts.length <= 2) return pts || [];
  const dp = (arr, epsSq) => {
    const keep = new Uint8Array(arr.length);
    keep[0] = 1;
    keep[arr.length - 1] = 1;
    const stack = [[0, arr.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = -1, maxIdx = -1;
      for (let i = s + 1; i < e; i++) {
        const d = perpDistDegSq(arr[i], arr[s], arr[e]);
        if (d > maxD) { maxD = d; maxIdx = i; }
      }
      if (maxD > epsSq && maxIdx > s && maxIdx < e) {
        keep[maxIdx] = 1;
        stack.push([s, maxIdx], [maxIdx, e]);
      }
    }
    const out = [];
    for (let i = 0; i < arr.length; i++) if (keep[i]) out.push(arr[i]);
    return out;
  };
  let curEps = epsDeg;
  let res = dp(pts, curEps * curEps);
  let guard = 0;
  while (res.length > maxPts && guard < 4) {
    curEps *= 1.65;
    res = dp(pts, curEps * curEps);
    guard++;
  }
  return res.map(p => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]);
}

function stitchGeoJsonBusGeometry(geometry, origPt = null, destPt = null) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  let parts = [];
  if (geometry.type === 'LineString') {
    parts = [geometry.coordinates];
  } else if (geometry.type === 'MultiLineString') {
    parts = geometry.coordinates;
  } else {
    return [];
  }

  const latLonParts = parts
    .map(part => (Array.isArray(part) ? part : [])
      .filter(c => Array.isArray(c) && c.length >= 2 && isValidHkCoord(c[1], c[0]))
      .map(c => [Number(c[1]), Number(c[0])]))
    .filter(p => p.length >= 2);

  if (!latLonParts.length) return [];

  const merged = [];
  for (let i = 0; i < latLonParts.length; i++) {
    let seg = latLonParts[i];
    if (merged.length > 0) {
      const prevEnd = merged[merged.length - 1];
      const dStart = distSqDeg(prevEnd, seg[0]);
      const dEnd = distSqDeg(prevEnd, seg[seg.length - 1]);
      if (dEnd < dStart && dEnd < 0.000004) {
        seg = [...seg].reverse();
      }
      const skipFirst = distSqDeg(prevEnd, seg[0]) < 1e-10 ? 1 : 0;
      for (let k = skipFirst; k < seg.length; k++) merged.push(seg[k]);
    } else {
      for (let k = 0; k < seg.length; k++) merged.push(seg[k]);
    }
  }

  if (merged.length >= 2 && origPt && destPt) {
    const fwdScore = haversineKmWorker(merged[0][0], merged[0][1], origPt[0], origPt[1]) +
      haversineKmWorker(merged[merged.length - 1][0], merged[merged.length - 1][1], destPt[0], destPt[1]);
    const revScore = haversineKmWorker(merged[0][0], merged[0][1], destPt[0], destPt[1]) +
      haversineKmWorker(merged[merged.length - 1][0], merged[merged.length - 1][1], origPt[0], origPt[1]);
    if (revScore + 0.35 < fwdScore) {
      merged.reverse();
    }
  }
  return merged;
}

async function fetchCsdiBusRouteGeometry({ gtfsId, routeNo, company, bound, origPt, destPt }) {
  const cleanId = String(gtfsId || '').replace(/\D/g, '');
  const cleanRoute = String(routeNo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanCo = String(company || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!cleanId && !cleanRoute) return null;
  if (cleanCo.startsWith('GMB')) return null;

  const where = cleanId
    ? `ROUTE_ID=${cleanId}`
    : (cleanCo
      ? `ROUTE_NAMEE='${cleanRoute}' AND COMPANY_CODE LIKE '%${cleanCo}%'`
      : `ROUTE_NAMEE='${cleanRoute}'`);

  const baseUrl = 'https://portal.csdi.gov.hk/server/rest/services/common/td_rcd_1638844988873_41214/MapServer/0/query';
  const qs = `where=${encodeURIComponent(where)}&outFields=ROUTE_ID,ROUTE_NAMEE,ROUTE_SEQ,COMPANY_CODE&outSR=4326&maxAllowableOffset=0.00009&f=geojson`;
  const res = await fetchWithTimeout(`${baseUrl}?${qs}`, 4200, { Accept: 'application/json' }, 86400);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  const features = Array.isArray(data?.features) ? data.features : [];
  if (!features.length) return null;

  const targetSeq = bound === 'I' ? 2 : (bound === 'O' ? 1 : 0);
  let bestCoords = null;
  let bestScore = Infinity;

  for (const feat of features) {
    const coords = stitchGeoJsonBusGeometry(feat?.geometry, origPt, destPt);
    if (coords.length < 2) continue;
    let score = 0;
    if (origPt && destPt) {
      const dStart = haversineKmWorker(coords[0][0], coords[0][1], origPt[0], origPt[1]);
      const dEnd = haversineKmWorker(coords[coords.length - 1][0], coords[coords.length - 1][1], destPt[0], destPt[1]);
      score += dStart + dEnd;
    } else if (targetSeq && Number(feat?.properties?.ROUTE_SEQ) !== targetSeq) {
      score += 5.0;
    }
    const featCo = String(feat?.properties?.COMPANY_CODE || '').toUpperCase();
    if (cleanCo && featCo && !featCo.includes(cleanCo)) score += 3.0;
    if (score < bestScore) {
      bestScore = score;
      bestCoords = coords;
    }
  }

  if (!bestCoords || bestCoords.length < 2) return null;
  if (origPt && destPt && bestScore > 3.5) return null;
  return simplifyPolylineCoords(bestCoords, 0.00008, 420);
}

async function fetchOsrmDeterministicBusGeometry(stopPts) {
  if (!Array.isArray(stopPts) || stopPts.length < 2) return null;
  const maxPerBatch = 24;
  const allCoords = [];
  for (let start = 0; start < stopPts.length - 1; start += (maxPerBatch - 1)) {
    const batch = stopPts.slice(start, Math.min(stopPts.length, start + maxPerBatch));
    if (batch.length < 2) break;
    const coordStr = batch.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson&alternatives=false&continue_straight=true&steps=false`;
    const res = await fetchWithTimeout(url, 4200, { Accept: 'application/json' }, 86400);
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    const raw = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const batchCoords = raw
      .filter(c => Array.isArray(c) && c.length >= 2 && isValidHkCoord(c[1], c[0]))
      .map(c => [Number(c[1]), Number(c[0])]);
    if (!batchCoords.length) return null;
    const skipFirst = (allCoords.length > 0 && distSqDeg(allCoords[allCoords.length - 1], batchCoords[0]) < 1e-8) ? 1 : 0;
    for (let k = skipFirst; k < batchCoords.length; k++) allCoords.push(batchCoords[k]);
  }
  if (allCoords.length < 2) return null;
  return simplifyPolylineCoords(allCoords, 0.00008, 420);
}

async function handleBusGeomRequest(urlObj) {
  const gtfsId = (urlObj.searchParams.get('gtfsId') || '').trim();
  const routeNo = (urlObj.searchParams.get('route') || '').trim();
  const company = (urlObj.searchParams.get('company') || '').trim();
  const bound = (urlObj.searchParams.get('bound') || '').trim().toUpperCase();
  const rawStops = (urlObj.searchParams.get('stops') || '').trim();

  const stopPts = rawStops
    ? rawStops.split(';').map(pair => {
        const [la, lo] = pair.split(',').map(Number);
        return isValidHkCoord(la, lo) ? [la, lo] : null;
      }).filter(Boolean).slice(0, 60)
    : [];

  const origPt = stopPts.length >= 2 ? stopPts[0] : null;
  const destPt = stopPts.length >= 2 ? stopPts[stopPts.length - 1] : null;

  let coords = null;
  let source = '';
  try {
    coords = await fetchCsdiBusRouteGeometry({ gtfsId, routeNo, company, bound, origPt, destPt });
    if (coords && coords.length >= 2) source = 'CSDI';
  } catch (e) {}

  if (!coords && stopPts.length >= 2) {
    try {
      coords = await fetchOsrmDeterministicBusGeometry(stopPts);
      if (coords && coords.length >= 2) source = 'OSRM';
    } catch (e) {}
  }

  return new Response(
    JSON.stringify({ ok: Boolean(coords && coords.length >= 2), source: source || 'NONE', coords: coords || [] }),
    { headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=86400' } }
  );
}

async function handleCameraImageProxy(urlObj) {
  const key = String(urlObj.searchParams.get('key') || '').trim();
  // Strict allowlist validation against HKSAR TD camera key format (prevents SSRF)
  if (!/^[A-Z0-9_-]{3,16}$/i.test(key)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid camera key' }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  const upstreamUrl = `https://tdcctv.data.one.gov.hk/${encodeURIComponent(key)}.JPG`;
  const res = await fetchWithTimeout(upstreamUrl, 4500, { Accept: 'image/jpeg,image/*;q=0.8' }, 30);
  if (!res || !res.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'Camera feed unavailable' }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' }
    });
  }
  const buf = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return new Response(buf, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=30',
      'X-Cam-Bytes': String(buf.byteLength)
    }
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || '').toLowerCase();

  if (action === 'ferry_live') return handleFerryLiveRequest(url);

  if (action === 'traffic_live') return handleTrafficLiveRequest();

  if (action === 'cam_img') return handleCameraImageProxy(url);

  if (action === 'bus_geom') return handleBusGeomRequest(url);

  if (action === 'lrt_live') {
    const stId = String(url.searchParams.get('station_id') || '').replace(/\D/g, '');
    const r = await fetchWithTimeout(`https://rt.data.gov.hk/v1/transport/mtr/lrt/getSchedule?station_id=${encodeURIComponent(stId)}`, 3500, {}, 10);
    const data = (r && r.ok) ? await r.json().catch(() => null) : null;
    return new Response(JSON.stringify(data || { status: 0, platform_list: [] }), { headers: CORS_HEADERS });
  }

  if (action === 'address_lookup' || action === 'als' || action === 'address') {
    return handleAddressLookup(url.searchParams.get('q') || '');
  }

  // Legacy endpoint slimmed to ferry CSV schedules only (full topology ships in bus_index.min.json)
  if (action === 'rail_ferry_topology') {
    const csvSchedules = await fetchOperatorFerryCsvSchedules();
    return new Response(JSON.stringify({ ok: true, slim: true, csvSchedules }), {
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=1800' }
    });
  }

  const { highwayCorridors, weather } = await syncTdStrategicTrafficCorridorsAndWeather();
  return new Response(
    JSON.stringify({ ok: true, service: 'transit-unified-edge', ts: Date.now(), highwayCorridors, weather }),
    { headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60' } }
  );
}
