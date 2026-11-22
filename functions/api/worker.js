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

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || '').toLowerCase();

  if (action === 'ferry_live') return handleFerryLiveRequest(url);

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
