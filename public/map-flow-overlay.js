/* Transit HK — Interactive Map "People Flow" Overlay & Floating Preview Scrubber (map-flow-overlay.js)
 * Dual Browser Global + CommonJS module.
 *
 * Strictly scoped Leaflet overlay consuming simulateCityPeopleFlow() from hk-people-flow.js.
 * - Uses its own dedicated Leaflet layerGroup per map (never touches Traffic & Cams, TD detectors,
 *   or busspeed.js road-speed polylines).
 * - Off by default; toggleable directly next to the existing Traffic control in both full Map view
 *   (#view-map) and route detail map (#map-container).
 * - Scrubber preview state is strictly isolated to this overlay and NEVER mutates window.__HKO_WEATHER__
 *   or live Bus/Rail/Ferry ETAs.
 */
(function (root) {
  'use strict';

  let _flowMod = null;
  if (typeof require === 'function' && !(root && root.HkPeopleFlowSimulator)) {
    try {
      _flowMod = require('./hk-people-flow.js');
    } catch (e) {}
  }

  function _getFlowFn(name) {
    if (typeof root !== 'undefined' && root.HkPeopleFlowSimulator && typeof root.HkPeopleFlowSimulator[name] === 'function') {
      return root.HkPeopleFlowSimulator[name];
    }
    if (_flowMod && typeof _flowMod[name] === 'function') return _flowMod[name];
    return null;
  }

  function _esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _isZh() {
    return typeof root !== 'undefined' && root.currentLang === 'zh';
  }

  // Pressure color thresholds: green < 1.0, amber 1.0–1.45, red >= 1.45
  function getPeopleFlowColor(pressure) {
    const p = Number(pressure) || 0;
    if (p >= 1.45) return '#dc2626'; // red
    if (p >= 1.0) return '#f59e0b';  // amber
    return '#16a34a';                // green
  }

  function getPeopleFlowTier(pressure) {
    const p = Number(pressure) || 0;
    if (p >= 1.45) return 'HIGH';
    if (p >= 1.0) return 'ELEVATED';
    return 'CALM';
  }

  // Hong Kong key population flow pressure zones
  const PEOPLE_FLOW_ZONES = Object.freeze([
    {
      id: 'pak_kung_au_trails',
      nameEn: 'Pak Kung Au / Nam Shan Trails',
      nameTc: '伯公坳／南山行山徑',
      lat: 22.2486,
      lon: 113.9412,
      vectors: ['TO_TRAIL_EXPOSED', 'FROM_TRAIL_EXPOSED'],
      baseRadiusM: 1200
    },
    {
      id: 'mui_wo_pier',
      nameEn: 'Mui Wo Ferry Pier',
      nameTc: '梅窩渡輪碼頭',
      lat: 22.2650,
      lon: 114.0018,
      vectors: ['ISLAND_OUTBOUND', 'ISLAND_INBOUND', 'TO_TRAIL_EXPOSED', 'FROM_TRAIL_EXPOSED'],
      baseRadiusM: 1050
    },
    {
      id: 'cheung_chau_pier',
      nameEn: 'Cheung Chau Pier',
      nameTc: '長洲渡輪碼頭',
      lat: 22.2086,
      lon: 114.0285,
      vectors: ['ISLAND_OUTBOUND', 'ISLAND_INBOUND'],
      baseRadiusM: 1000
    },
    {
      id: 'central_piers',
      nameEn: 'Central Ferry Piers',
      nameTc: '中環渡輪碼頭',
      lat: 22.2876,
      lon: 114.1594,
      vectors: ['ISLAND_OUTBOUND', 'ISLAND_INBOUND', 'CBD_INBOUND', 'CBD_OUTBOUND'],
      baseRadiusM: 950
    },
    {
      id: 'hkia_tung_chung_awe',
      nameEn: 'HKIA / Tung Chung / AWE',
      nameTc: '機場／東涌／博覽館',
      lat: 22.3075,
      lon: 113.9385,
      vectors: ['TO_AIRPORT_AWE', 'FROM_AIRPORT_AWE'],
      baseRadiusM: 1550
    },
    {
      id: 'cbd_urban_core',
      nameEn: 'Central / Causeway Bay / Mong Kok',
      nameTc: '中環／銅鑼灣／旺角核心區',
      lat: 22.2975,
      lon: 114.1715,
      vectors: ['CBD_INBOUND', 'CBD_OUTBOUND', 'SUNDAY_URBAN_HUB'],
      baseRadiusM: 1650
    },
    {
      id: 'school_belt_kt_hmt_midlevels',
      nameEn: 'Kowloon Tong / Ho Man Tin & Mid-Levels Schools',
      nameTc: '九龍塘／何文田及半山校網',
      lat: 22.3270,
      lon: 114.1795,
      vectors: ['SCHOOL_ZONE'],
      baseRadiusM: 1250
    },
    {
      id: 'northern_borders',
      nameEn: 'Lo Wu / Lok Ma Chau / Shenzhen Bay / HZMB Borders',
      nameTc: '羅湖／落馬洲／深圳灣／港珠澳口岸',
      lat: 22.5150,
      lon: 114.0900,
      vectors: ['TO_BORDER_NORTH', 'FROM_BORDER_NORTH'],
      baseRadiusM: 1750
    },
    {
      id: 'sai_kung',
      nameEn: 'Sai Kung Pier & Country Park',
      nameTc: '西貢碼頭及郊野公園',
      lat: 22.3818,
      lon: 114.2735,
      vectors: ['TO_BEACH_WATER', 'FROM_BEACH_WATER', 'TO_TRAIL_EXPOSED', 'FROM_TRAIL_EXPOSED'],
      baseRadiusM: 1400
    },
    {
      id: 'shek_o_repulse_bay',
      nameEn: 'Shek O / Repulse Bay Beaches',
      nameTc: '石澳／淺水灣泳灘',
      lat: 22.2330,
      lon: 114.2220,
      vectors: ['TO_BEACH_WATER', 'FROM_BEACH_WATER'],
      baseRadiusM: 1200
    },
    {
      id: 'cemeteries_festival',
      nameEn: 'Chai Wan / Tseung Kwan O / Diamond Hill Cemeteries',
      nameTc: '柴灣／將軍澳／鑽石山墳場',
      lat: 22.2660,
      lon: 114.2440,
      vectors: ['CEMETERY_FESTIVAL'],
      baseRadiusM: 1350,
      minThreshold: 0.3
    }
  ]);

  // Major directional flow corridors (drawn as dashed arrows whenever vector > 1.0)
  const PEOPLE_FLOW_CORRIDORS = Object.freeze([
    {
      id: 'cbd_inbound_corridor',
      vector: 'CBD_INBOUND',
      nameEn: 'Kowloon / NT → Central & Admiralty',
      nameTc: '九龍／新界 ➔ 中環及金鐘',
      coords: [[22.373, 114.118], [22.337, 114.175], [22.319, 114.169], [22.282, 114.158]]
    },
    {
      id: 'cbd_outbound_corridor',
      vector: 'CBD_OUTBOUND',
      nameEn: 'Central / Admiralty → Kowloon & NT',
      nameTc: '中環／金鐘 ➔ 九龍及新界',
      coords: [[22.282, 114.164], [22.315, 114.173], [22.340, 114.185], [22.382, 114.187]]
    },
    {
      id: 'school_zone_corridor',
      vector: 'SCHOOL_ZONE',
      nameEn: 'Kowloon Tong ↔ Ho Man Tin School Belt',
      nameTc: '九龍塘 ↔ 何文田校網走廊',
      coords: [[22.337, 114.176], [22.323, 114.181], [22.309, 114.183]]
    },
    {
      id: 'to_trail_corridor',
      vector: 'TO_TRAIL_EXPOSED',
      nameEn: 'Tung Chung / Mui Wo → Pak Kung Au Trails',
      nameTc: '東涌／梅窩 ➔ 伯公坳行山徑',
      coords: [[22.289, 113.941], [22.271, 113.936], [22.249, 113.941]]
    },
    {
      id: 'from_trail_corridor',
      vector: 'FROM_TRAIL_EXPOSED',
      nameEn: 'Pak Kung Au Trails → Tung Chung & Mui Wo',
      nameTc: '伯公坳行山徑 ➔ 東涌及梅窩',
      coords: [[22.249, 113.941], [22.244, 113.977], [22.265, 114.001]]
    },
    {
      id: 'island_outbound_corridor',
      vector: 'ISLAND_OUTBOUND',
      nameEn: 'Central Piers → Mui Wo & Cheung Chau',
      nameTc: '中環碼頭 ➔ 梅窩及長洲',
      coords: [[22.288, 114.159], [22.272, 114.075], [22.265, 114.002]]
    },
    {
      id: 'island_inbound_corridor',
      vector: 'ISLAND_INBOUND',
      nameEn: 'Mui Wo & Cheung Chau → Central Piers',
      nameTc: '梅窩及長洲 ➔ 中環碼頭',
      coords: [[22.209, 114.029], [22.252, 114.085], [22.288, 114.159]]
    },
    {
      id: 'to_border_corridor',
      vector: 'TO_BORDER_NORTH',
      nameEn: 'Urban Core → Lo Wu / Lok Ma Chau Borders',
      nameTc: '市區 ➔ 羅湖／落馬洲口岸',
      coords: [[22.337, 114.176], [22.414, 114.210], [22.492, 114.139], [22.527, 114.113]]
    },
    {
      id: 'from_border_corridor',
      vector: 'FROM_BORDER_NORTH',
      nameEn: 'Northern Borders → Kowloon & Urban Core',
      nameTc: '北部口岸 ➔ 九龍及市區',
      coords: [[22.515, 114.066], [22.465, 114.095], [22.382, 114.187], [22.319, 114.169]]
    },
    {
      id: 'to_airport_corridor',
      vector: 'TO_AIRPORT_AWE',
      nameEn: 'West Kowloon / Tsing Yi → HKIA & AWE',
      nameTc: '西九龍／青衣 ➔ 機場及博覽館',
      coords: [[22.304, 114.161], [22.358, 114.107], [22.339, 114.042], [22.316, 113.937]]
    },
    {
      id: 'from_airport_corridor',
      vector: 'FROM_AIRPORT_AWE',
      nameEn: 'HKIA / AWE → Tsing Yi & West Kowloon',
      nameTc: '機場／博覽館 ➔ 青衣及西九龍',
      coords: [[22.321, 113.941], [22.339, 114.042], [22.358, 114.107], [22.304, 114.161]]
    },
    {
      id: 'to_beach_corridor',
      vector: 'TO_BEACH_WATER',
      nameEn: 'Urban → Sai Kung & Repulse Bay Beaches',
      nameTc: '市區 ➔ 西貢及淺水灣泳灘',
      coords: [[22.335, 114.209], [22.356, 114.242], [22.382, 114.274]]
    },
    {
      id: 'from_beach_corridor',
      vector: 'FROM_BEACH_WATER',
      nameEn: 'Sai Kung / Shek O Beaches → Urban Core',
      nameTc: '西貢／石澳泳灘 ➔ 市區',
      coords: [[22.233, 114.222], [22.257, 114.192], [22.279, 114.165]]
    },
    {
      id: 'sunday_urban_corridor',
      vector: 'SUNDAY_URBAN_HUB',
      nameEn: 'Sunday Hub Gathering → Central / CWB / Mong Kok',
      nameTc: '週日市區聚會 ➔ 中環／銅鑼灣／旺角',
      coords: [[22.319, 114.169], [22.298, 114.172], [22.280, 114.184], [22.282, 114.158]]
    },
    {
      id: 'cemetery_festival_corridor',
      vector: 'CEMETERY_FESTIVAL',
      nameEn: 'Festival Grave-Sweeping → Chai Wan / TKO Cemeteries',
      nameTc: '清明／重陽掃墓 ➔ 柴灣／將軍澳墳場',
      coords: [[22.282, 114.222], [22.265, 114.237], [22.266, 114.244]]
    }
  ]);

  // 1-tap scenario presets strictly scoped to the Map People Flow overlay
  const PEOPLE_FLOW_PRESETS = Object.freeze({
    LIVE: { key: 'LIVE', labelEn: 'Live', labelTc: '實時', isPreview: false },
    MON_0815: {
      key: 'MON_0815', labelEn: 'Mon 08:15', labelTc: '週一 08:15', isPreview: true,
      isoHkt: '2026-11-23T08:15:00+08:00', weatherKey: 'DRY_22'
    },
    MON_1500: {
      key: 'MON_1500', labelEn: 'Mon 15:00', labelTc: '週一 15:00', isPreview: true,
      isoHkt: '2026-11-23T15:00:00+08:00', weatherKey: 'DRY_22'
    },
    SAT_1500: {
      key: 'SAT_1500', labelEn: 'Sat 15:00', labelTc: '週六 15:00', isPreview: true,
      isoHkt: '2026-11-28T15:00:00+08:00', weatherKey: 'DRY_22'
    },
    SUN_1830: {
      key: 'SUN_1830', labelEn: 'Sun 18:30', labelTc: '週日 18:30', isPreview: true,
      isoHkt: '2026-11-29T18:30:00+08:00', weatherKey: 'DRY_22'
    },
    CHING_MING: {
      key: 'CHING_MING', labelEn: 'Ching Ming', labelTc: '清明節', isPreview: true,
      isoHkt: '2026-04-05T10:30:00+08:00', weatherKey: 'DRY_22'
    },
    JUL_34C: {
      key: 'JUL_34C', labelEn: 'Jul 34°C', labelTc: '七月 34°C', isPreview: true,
      isoHkt: '2026-07-18T14:00:00+08:00', weatherKey: 'HOT_34'
    },
    T8: {
      key: 'T8', labelEn: 'T8', labelTc: '八號風球', isPreview: true,
      isoHkt: '2026-09-10T16:30:00+08:00', weatherKey: 'T8'
    }
  });

  const PEOPLE_FLOW_WEATHER_OVERRIDES = Object.freeze({
    LIVE:   { key: 'LIVE',   labelEn: 'Live HKO', labelTc: '實時天文台', payload: null },
    DRY_22: { key: 'DRY_22', labelEn: '22°C Dry', labelTc: '22°C 乾燥', payload: { temp: 22, isDry: true, isClear: true, condition: 'Clear' } },
    RAIN:   { key: 'RAIN',   labelEn: 'Rain',     labelTc: '大雨',     payload: { temp: 24, isRainy: true, heavyRain: true, warnings: ['WRAINR'], condition: 'Heavy Rain' } },
    HOT_34: { key: 'HOT_34', labelEn: '34°C',     labelTc: '34°C 酷熱', payload: { temp: 34, isDry: false, condition: 'Very Hot' } },
    T8:     { key: 'T8',     labelEn: 'T8',       labelTc: '八號風球', payload: { temp: 26, preT8: true, typhoon: true, warnings: ['PRE_T8'], heavyRain: true, condition: 'Pre-T8 Evacuation' } }
  });

  // Strictly overlay-scoped preview state (NEVER mutates window.__HKO_WEATHER__ or live ETAs)
  const PeopleFlowOverlayState = {
    enabled: false,
    isPreview: false,
    presetKey: 'LIVE',
    weatherOverrideKey: 'LIVE',
    baseDateYmd: null,   // 'YYYY-MM-DD' when previewing a preset date
    minutesOfDay: null   // 0..1425 when previewing a time
  };

  function _getCurrentHkTimeParts(nowMs) {
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const d = new Date(ms + 8 * 3600 * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = d.getUTCHours();
    const mi = d.getUTCMinutes();
    return { ymd: `${yyyy}-${mm}-${dd}`, minutesOfDay: hh * 60 + mi, hh, mi };
  }

  function _formatMinutesHHMM(totalMins) {
    const clamped = Math.max(0, Math.min(1439, Math.round(Number(totalMins) || 0)));
    const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
    const mm = String(clamped % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function _resolveEffectiveSimInputs(nowMsOverride, hkoWeatherOverride) {
    const liveNow = Number.isFinite(Number(nowMsOverride)) ? Number(nowMsOverride) : Date.now();
    const liveWx = hkoWeatherOverride !== undefined
      ? hkoWeatherOverride
      : ((typeof root !== 'undefined' && root.__HKO_WEATHER__) ? root.__HKO_WEATHER__ : null);

    if (!PeopleFlowOverlayState.isPreview) {
      return {
        simMs: liveNow,
        simWeather: liveWx,
        weatherSource: liveWx ? 'Live HKO' : 'Fallback',
        isPreview: false
      };
    }

    const hkLive = _getCurrentHkTimeParts(liveNow);
    const ymd = PeopleFlowOverlayState.baseDateYmd || hkLive.ymd;
    const mins = Number.isFinite(Number(PeopleFlowOverlayState.minutesOfDay))
      ? Number(PeopleFlowOverlayState.minutesOfDay)
      : hkLive.minutesOfDay;
    const hhmm = _formatMinutesHHMM(mins);
    const parsedMs = Date.parse(`${ymd}T${hhmm}:00+08:00`);
    const simMs = Number.isFinite(parsedMs) ? parsedMs : liveNow;

    const wxKey = PeopleFlowOverlayState.weatherOverrideKey || 'LIVE';
    const wxPreset = PEOPLE_FLOW_WEATHER_OVERRIDES[wxKey];
    const simWeather = (wxKey !== 'LIVE' && wxPreset && wxPreset.payload) ? wxPreset.payload : liveWx;
    const weatherSource = (wxKey !== 'LIVE' && wxPreset)
      ? wxPreset.labelEn
      : (liveWx ? 'Live HKO' : 'Fallback');

    return { simMs, simWeather, weatherSource, isPreview: true };
  }

  function _computeBearingDeg(p1, p2) {
    const lat1 = (p1[0] * Math.PI) / 180;
    const lat2 = (p2[0] * Math.PI) / 180;
    const dLon = ((p2[1] - p1[1]) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /**
   * Pure data builder for the Map People Flow overlay (safe for unit tests without DOM/Leaflet).
   *
   * @param {number} [nowMs]
   * @param {Object|null} [hkoWeather]
   * @param {Object} [opts]
   */
  function buildPeopleFlowOverlayModel(nowMs, hkoWeather, opts) {
    const simFn = _getFlowFn('simulateCityPeopleFlow');
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const cityFlow = simFn
      ? simFn(ms, hkoWeather, opts)
      : {
          calendar: { isoWeek: 1, month: 0, dayType: 'weekday', isEveOfHoliday: false, isSchoolDay: true, hourFloat: 12, dateStr: '', isHoliday: false, isAweEventDate: false },
          weather: { outdoorMod: 1.0, urbanIndoorMod: 1.0, preTyphoonEvacMod: 1.0 },
          vectors: {}
        };

    const vec = cityFlow.vectors || {};
    const cal = cityFlow.calendar || {};
    const wx = cityFlow.weather || { outdoorMod: 1.0, urbanIndoorMod: 1.0, preTyphoonEvacMod: 1.0 };

    const zones = [];
    for (let i = 0; i < PEOPLE_FLOW_ZONES.length; i++) {
      const z = PEOPLE_FLOW_ZONES[i];
      const matched = [];
      let peakPressure = 0;
      let peakVector = z.vectors[0] || '';
      for (let j = 0; j < z.vectors.length; j++) {
        const k = z.vectors[j];
        const val = Number(vec[k] || 0);
        matched.push({ key: k, value: Number(val.toFixed(2)) });
        if (val > peakPressure) {
          peakPressure = val;
          peakVector = k;
        }
      }
      matched.sort((a, b) => b.value - a.value);

      // Cemeteries zone ONLY appears when CEMETERY_FESTIVAL > 0.3
      if (typeof z.minThreshold === 'number' && peakPressure <= z.minThreshold) {
        continue;
      }

      const radiusM = Math.round(z.baseRadiusM * (0.62 + Math.min(1.0, peakPressure / 2.0) * 0.78));
      zones.push({
        id: z.id,
        nameEn: z.nameEn,
        nameTc: z.nameTc,
        lat: z.lat,
        lon: z.lon,
        pressure: Number(peakPressure.toFixed(2)),
        primaryVector: peakVector,
        matchedVectors: matched,
        color: getPeopleFlowColor(peakPressure),
        tier: getPeopleFlowTier(peakPressure),
        radiusM
      });
    }

    const arrows = [];
    for (let i = 0; i < PEOPLE_FLOW_CORRIDORS.length; i++) {
      const c = PEOPLE_FLOW_CORRIDORS[i];
      const pressure = Number(vec[c.vector] || 0);
      if (pressure <= 1.0) continue; // Only show active corridors where vector > 1.0
      const endA = c.coords[c.coords.length - 2];
      const endB = c.coords[c.coords.length - 1];
      arrows.push({
        id: c.id,
        vector: c.vector,
        nameEn: c.nameEn,
        nameTc: c.nameTc,
        pressure: Number(pressure.toFixed(2)),
        color: getPeopleFlowColor(pressure),
        tier: getPeopleFlowTier(pressure),
        coords: c.coords,
        arrowTip: endB,
        bearingDeg: Math.round(_computeBearingDeg(endA, endB))
      });
    }

    const dayLabelMap = { weekday: 'Wkdy', saturday: 'Sat', sunday: 'Sun', holiday: 'Hol' };
    const dayTag = dayLabelMap[cal.dayType] || 'Wkdy';
    const schoolTag = cal.isSchoolDay ? 'School ON' : 'School OFF';
    const wxTag = hkoWeather ? 'Live HKO' : 'Fallback';
    const summaryChip = `W${cal.isoWeek || 1} · ${dayTag} · ${schoolTag} · ${wxTag}`;

    return {
      cityFlow,
      calendar: cal,
      weather: wx,
      zones,
      arrows,
      summaryChip
    };
  }

  function _buildFlowPopupHtml(title, matchedVectors, pressure, cal, wx, weatherSource) {
    const isZh = _isZh();
    const color = getPeopleFlowColor(pressure);
    const vecRows = (matchedVectors || []).slice(0, 3).map(v =>
      `<div style="display:flex;justify-content:space-between;gap:10px;font-size:0.72rem;line-height:1.35;">
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#374151;">${_esc(v.key)}</span>
        <strong style="color:${getPeopleFlowColor(v.value)};font-variant-numeric:tabular-nums;">${Number(v.value).toFixed(2)}</strong>
      </div>`
    ).join('');
    const flags = [
      `W${cal.isoWeek || 1}`,
      String(cal.dayType || 'weekday'),
      cal.isSchoolDay ? (isZh ? '上課日' : 'School ON') : (isZh ? '非上課日' : 'School OFF'),
      cal.isEveOfHoliday ? (isZh ? '假期前夕' : 'Holiday Eve') : null
    ].filter(Boolean).join(' · ');

    return `
      <div style="min-width:195px;max-width:245px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;">
          <strong style="font-size:0.80rem;color:#111827;line-height:1.25;">${_esc(title)}</strong>
          <span style="padding:1px 7px;border-radius:999px;font-size:0.68rem;font-weight:800;color:#fff;background:${color};font-variant-numeric:tabular-nums;">${Number(pressure).toFixed(2)}</span>
        </div>
        <div style="padding:5px 7px;border-radius:8px;background:rgba(15,23,42,0.05);margin-bottom:5px;">
          ${vecRows}
        </div>
        <div style="font-size:0.68rem;color:#4b5563;line-height:1.35;">
          <div><strong>${isZh ? '日曆：' : 'Calendar:'}</strong> ${_esc(flags)}</div>
          <div><strong>${isZh ? '天氣倍率：' : 'Weather:'}</strong> ${_esc(weatherSource)} · Out ×${Number(wx.outdoorMod || 1).toFixed(2)} · Urb ×${Number(wx.urbanIndoorMod || 1).toFixed(2)}${Number(wx.preTyphoonEvacMod || 1) > 1.05 ? ` · T8 ×${Number(wx.preTyphoonEvacMod).toFixed(2)}` : ''}</div>
        </div>
      </div>
    `;
  }

  // Dedicated WeakMap of Leaflet LayerGroups per map — 100% isolated from Traffic & Cams layers
  const _peopleFlowLayerByMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function _getOrCreateFlowLayer(mapInst) {
    if (!mapInst || typeof L === 'undefined' || !_peopleFlowLayerByMap) return null;
    let lg = _peopleFlowLayerByMap.get(mapInst);
    if (!lg) {
      lg = L.layerGroup();
      _peopleFlowLayerByMap.set(mapInst, lg);
    }
    return lg;
  }

  function clearPeopleFlowOverlayOnMap(mapInst) {
    if (!mapInst || !_peopleFlowLayerByMap) return;
    const lg = _peopleFlowLayerByMap.get(mapInst);
    if (lg) {
      try { lg.clearLayers(); } catch (e) {}
      try { if (mapInst.hasLayer(lg)) mapInst.removeLayer(lg); } catch (e) {}
    }
  }

  function renderPeopleFlowOverlayOnMap(mapInst) {
    if (!mapInst || typeof L === 'undefined') return null;
    if (!PeopleFlowOverlayState.enabled) {
      clearPeopleFlowOverlayOnMap(mapInst);
      return null;
    }

    const lg = _getOrCreateFlowLayer(mapInst);
    if (!lg) return null;
    lg.clearLayers();
    if (!mapInst.hasLayer(lg)) {
      lg.addTo(mapInst);
    }

    const { simMs, simWeather, weatherSource } = _resolveEffectiveSimInputs();
    const model = buildPeopleFlowOverlayModel(simMs, simWeather);
    const isZh = _isZh();

    // 1. Pressure Zone Halos
    for (let i = 0; i < model.zones.length; i++) {
      const z = model.zones[i];
      const title = isZh ? z.nameTc : z.nameEn;
      const circle = L.circle([z.lat, z.lon], {
        radius: z.radiusM,
        color: z.color,
        weight: z.pressure >= 1.45 ? 2.2 : 1.5,
        opacity: 0.72,
        fillColor: z.color,
        fillOpacity: z.pressure >= 1.45 ? 0.28 : (z.pressure >= 1.0 ? 0.22 : 0.14),
        interactive: true
      });
      circle.bindPopup(_buildFlowPopupHtml(title, z.matchedVectors, z.pressure, model.calendar, model.weather, weatherSource), {
        maxWidth: 260,
        closeButton: true
      });
      lg.addLayer(circle);

      // Compact center label pill for elevated/high pressure zones
      if (z.pressure >= 0.85) {
        const icon = L.divIcon({
          className: 'people-flow-zone-badge-wrap',
          html: `<div class="people-flow-zone-badge" style="border-color:${z.color};color:${z.color};">${_esc(z.pressure.toFixed(1))}</div>`,
          iconSize: [34, 18],
          iconAnchor: [17, 9]
        });
        const badgeMarker = L.marker([z.lat, z.lon], { icon, interactive: true });
        badgeMarker.bindPopup(_buildFlowPopupHtml(title, z.matchedVectors, z.pressure, model.calendar, model.weather, weatherSource), {
          maxWidth: 260,
          closeButton: true
        });
        lg.addLayer(badgeMarker);
      }
    }

    // 2. Directional Flow Arrows (only active corridors where vector > 1.0)
    for (let i = 0; i < model.arrows.length; i++) {
      const a = model.arrows[i];
      const title = isZh ? a.nameTc : a.nameEn;
      const line = L.polyline(a.coords, {
        color: a.color,
        weight: a.pressure >= 1.45 ? 4 : 3,
        opacity: 0.84,
        dashArray: '8, 7',
        lineCap: 'round',
        interactive: true
      });
      const popupHtml = _buildFlowPopupHtml(
        title,
        [{ key: a.vector, value: a.pressure }],
        a.pressure,
        model.calendar,
        model.weather,
        weatherSource
      );
      line.bindPopup(popupHtml, { maxWidth: 260, closeButton: true });
      lg.addLayer(line);

      const arrowIcon = L.divIcon({
        className: 'people-flow-arrow-head-wrap',
        html: `<div class="people-flow-arrow-head" style="transform:rotate(${a.bearingDeg}deg);color:${a.color};">▲</div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      });
      const arrowMarker = L.marker(a.arrowTip, { icon: arrowIcon, interactive: true });
      arrowMarker.bindPopup(popupHtml, { maxWidth: 260, closeButton: true });
      lg.addLayer(arrowMarker);
    }

    return model;
  }

  function _syncPeopleFlowToggleButtons() {
    const isZh = _isZh();
    const on = Boolean(PeopleFlowOverlayState.enabled);
    const label = on
      ? (isZh ? '👥 人流模擬 開' : '👥 People Flow ON')
      : (isZh ? '👥 人流模擬' : '👥 People Flow');

    ['browseMapFlowBtn', 'detailMapFlowBtn'].forEach((id) => {
      const btn = typeof document !== 'undefined' ? document.getElementById(id) : null;
      if (!btn) return;
      btn.innerText = label;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function _ensureScrubberMounted(hostId, scrubberId) {
    if (typeof document === 'undefined') return null;
    const host = document.getElementById(hostId);
    if (!host) return null;
    let bar = document.getElementById(scrubberId);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = scrubberId;
      bar.className = 'people-flow-scrubber-bar';
      bar.style.display = 'none';
      if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.disableScrollPropagation(bar);
      }
      host.appendChild(bar);
    }
    return bar;
  }

  function _renderScrubberHtml(model, weatherSource, simMs) {
    const isZh = _isZh();
    const hk = _getCurrentHkTimeParts(simMs);
    const sliderVal = Math.floor(hk.minutesOfDay / 15) * 15;
    const timeStr = _formatMinutesHHMM(sliderVal);
    const dayMap = { weekday: 'Wkdy', saturday: 'Sat', sunday: 'Sun', holiday: 'Hol' };
    const dayTag = dayMap[model.calendar.dayType] || 'Wkdy';
    const schoolTag = model.calendar.isSchoolDay ? (isZh ? '上課' : 'School ON') : (isZh ? '休假' : 'School OFF');
    const liveChipText = `W${model.calendar.isoWeek || 1} · ${dayTag} · ${schoolTag} · ${weatherSource}`;

    const presetsHtml = Object.values(PEOPLE_FLOW_PRESETS).map((p) => {
      const active = PeopleFlowOverlayState.presetKey === p.key;
      const lbl = isZh ? p.labelTc : p.labelEn;
      return `<button type="button" class="pf-chip ${active ? 'active' : ''}" onclick="setPeopleFlowPreset('${p.key}')">${_esc(lbl)}</button>`;
    }).join('');

    const wxHtml = Object.values(PEOPLE_FLOW_WEATHER_OVERRIDES).map((w) => {
      const active = PeopleFlowOverlayState.weatherOverrideKey === w.key;
      const lbl = isZh ? w.labelTc : w.labelEn;
      return `<button type="button" class="pf-chip pf-wx-chip ${active ? 'active' : ''}" onclick="setPeopleFlowWeatherOverride('${w.key}')">${_esc(lbl)}</button>`;
    }).join('');

    return `
      <div class="pf-scrubber-top">
        <span class="pf-state-chip">${_esc(liveChipText)}</span>
        ${PeopleFlowOverlayState.isPreview
          ? `<span class="pf-preview-pill">PREVIEW</span>
             <button type="button" class="pf-reset-btn" onclick="resetPeopleFlowToLive()">${isZh ? '重設實時' : 'Reset to Live'}</button>`
          : ''}
        <button type="button" class="pf-close-btn" onclick="togglePeopleFlowOverlay(false)" title="${isZh ? '關閉人流模擬' : 'Close People Flow'}">✕</button>
      </div>
      <div class="pf-slider-row">
        <span class="pf-time-readout">${_esc(timeStr)}</span>
        <input type="range" class="pf-time-slider" min="0" max="1425" step="15" value="${sliderVal}" oninput="onPeopleFlowTimeScrub(this.value)" aria-label="Simulation time of day">
      </div>
      <div class="pf-chip-row">${presetsHtml}</div>
      <div class="pf-chip-row pf-wx-row">${wxHtml}</div>
    `;
  }

  function _syncScrubberBars() {
    if (typeof document === 'undefined') return;
    const browseCanvas = document.getElementById('browse-map-canvas');
    const browseHost = browseCanvas ? browseCanvas.parentElement : null;
    if (browseHost && !browseHost.id) browseHost.id = 'browse-map-viewport-wrap';

    const targets = [
      { hostId: browseHost ? browseHost.id : '', scrubberId: 'browsePeopleFlowScrubber', isVisibleView: typeof root.currentView === 'undefined' || root.currentView === 'map' },
      { hostId: 'map-container', scrubberId: 'detailPeopleFlowScrubber', isVisibleView: typeof root.currentView === 'undefined' || root.currentView === 'detail' }
    ];

    if (!PeopleFlowOverlayState.enabled) {
      targets.forEach((t) => {
        const el = document.getElementById(t.scrubberId);
        if (el) el.style.display = 'none';
      });
      return;
    }

    const { simMs, simWeather, weatherSource } = _resolveEffectiveSimInputs();
    const model = buildPeopleFlowOverlayModel(simMs, simWeather);
    const html = _renderScrubberHtml(model, weatherSource, simMs);

    targets.forEach((t) => {
      if (!t.hostId) return;
      const bar = _ensureScrubberMounted(t.hostId, t.scrubberId);
      if (!bar) return;
      if (t.isVisibleView) {
        bar.innerHTML = html;
        bar.style.display = 'flex';
      } else {
        bar.style.display = 'none';
      }
    });
  }

  function syncPeopleFlowOverlaysAllMaps() {
    _syncPeopleFlowToggleButtons();
    if (typeof root !== 'undefined') {
      if (root.browseMapInstance) renderPeopleFlowOverlayOnMap(root.browseMapInstance);
      if (root.mapInstance) renderPeopleFlowOverlayOnMap(root.mapInstance);
    }
    _syncScrubberBars();
  }

  function togglePeopleFlowOverlay(forceState) {
    const next = typeof forceState === 'boolean' ? forceState : !PeopleFlowOverlayState.enabled;
    PeopleFlowOverlayState.enabled = next;
    if (typeof root !== 'undefined') {
      root.peopleFlowOverlayEnabled = next;
    }
    if (typeof root !== 'undefined' && typeof root.triggerHaptic === 'function') {
      root.triggerHaptic(10);
    }
    syncPeopleFlowOverlaysAllMaps();
    // Zoom browse map slightly out to Hong Kong overview when turning ON at high street zoom so halos & arrows are immediately visible
    if (next && typeof root !== 'undefined' && root.browseMapInstance && root.currentView === 'map') {
      try {
        if (root.browseMapInstance.getZoom() > 12) {
          root.browseMapInstance.setView([22.312, 114.12], 11, { animate: true });
        }
      } catch (e) {}
    }
  }

  function setPeopleFlowPreset(presetKey) {
    const p = PEOPLE_FLOW_PRESETS[presetKey];
    if (!p) return;
    if (!p.isPreview || presetKey === 'LIVE') {
      resetPeopleFlowToLive();
      return;
    }
    const parsedMs = Date.parse(p.isoHkt);
    const hk = _getCurrentHkTimeParts(parsedMs);
    PeopleFlowOverlayState.isPreview = true;
    PeopleFlowOverlayState.presetKey = p.key;
    PeopleFlowOverlayState.baseDateYmd = hk.ymd;
    PeopleFlowOverlayState.minutesOfDay = hk.minutesOfDay;
    PeopleFlowOverlayState.weatherOverrideKey = p.weatherKey || 'LIVE';
    syncPeopleFlowOverlaysAllMaps();
  }

  function onPeopleFlowTimeScrub(minsValue) {
    const mins = Math.max(0, Math.min(1425, Number(minsValue) || 0));
    if (!PeopleFlowOverlayState.baseDateYmd) {
      PeopleFlowOverlayState.baseDateYmd = _getCurrentHkTimeParts(Date.now()).ymd;
    }
    PeopleFlowOverlayState.isPreview = true;
    PeopleFlowOverlayState.minutesOfDay = mins;
    if (PeopleFlowOverlayState.presetKey === 'LIVE') {
      PeopleFlowOverlayState.presetKey = 'CUSTOM';
    }
    syncPeopleFlowOverlaysAllMaps();
  }

  function setPeopleFlowWeatherOverride(wxKey) {
    if (!PEOPLE_FLOW_WEATHER_OVERRIDES[wxKey]) return;
    PeopleFlowOverlayState.weatherOverrideKey = wxKey;
    if (wxKey !== 'LIVE') {
      if (!PeopleFlowOverlayState.baseDateYmd) {
        const hk = _getCurrentHkTimeParts(Date.now());
        PeopleFlowOverlayState.baseDateYmd = hk.ymd;
        PeopleFlowOverlayState.minutesOfDay = hk.minutesOfDay;
      }
      PeopleFlowOverlayState.isPreview = true;
      if (PeopleFlowOverlayState.presetKey === 'LIVE') {
        PeopleFlowOverlayState.presetKey = 'CUSTOM';
      }
    } else if (PeopleFlowOverlayState.presetKey === 'CUSTOM' || PeopleFlowOverlayState.presetKey === 'LIVE') {
      PeopleFlowOverlayState.isPreview = false;
      PeopleFlowOverlayState.presetKey = 'LIVE';
      PeopleFlowOverlayState.baseDateYmd = null;
      PeopleFlowOverlayState.minutesOfDay = null;
    }
    syncPeopleFlowOverlaysAllMaps();
  }

  function resetPeopleFlowToLive() {
    PeopleFlowOverlayState.isPreview = false;
    PeopleFlowOverlayState.presetKey = 'LIVE';
    PeopleFlowOverlayState.weatherOverrideKey = 'LIVE';
    PeopleFlowOverlayState.baseDateYmd = null;
    PeopleFlowOverlayState.minutesOfDay = null;
    syncPeopleFlowOverlaysAllMaps();
  }

  /**
   * Attaches the off-by-default "People Flow" toggle pill right beside the existing
   * Traffic pill inside the full browse map (#view-map).
   */
  function attachPeopleFlowOverlayToMap(mapInst) {
    if (!mapInst || typeof L === 'undefined') return;
    if (typeof document !== 'undefined' && !document.getElementById('browseMapFlowBtn')) {
      const trafficCtrl = document.querySelector('#view-map .leaflet-control-global-traffic');
      const isZh = _isZh();
      const makeBtn = () => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'browseMapFlowBtn';
        btn.className = 'map-traffic-chip-btn map-flow-toggle global-traffic-btn';
        btn.innerText = PeopleFlowOverlayState.enabled
          ? (isZh ? '👥 人流模擬 開' : '👥 People Flow ON')
          : (isZh ? '👥 人流模擬' : '👥 People Flow');
        btn.classList.toggle('active', Boolean(PeopleFlowOverlayState.enabled));
        btn.setAttribute('aria-pressed', PeopleFlowOverlayState.enabled ? 'true' : 'false');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          togglePeopleFlowOverlay();
        });
        return btn;
      };

      if (trafficCtrl) {
        trafficCtrl.classList.add('leaflet-control-map-chips-row');
        trafficCtrl.appendChild(makeBtn());
      } else if (typeof L.Control !== 'undefined') {
        const FlowCtrl = L.Control.extend({
          options: { position: 'bottomright' },
          onAdd: function () {
            const c = L.DomUtil.create('div', 'leaflet-control-global-traffic leaflet-control-map-chips-row');
            c.appendChild(makeBtn());
            L.DomEvent.disableClickPropagation(c);
            L.DomEvent.disableScrollPropagation(c);
            return c;
          }
        });
        new FlowCtrl().addTo(mapInst);
      }
    }
    renderPeopleFlowOverlayOnMap(mapInst);
    _syncScrubberBars();
  }

  function syncPeopleFlowOverlayOnMap(mapInst) {
    _syncPeopleFlowToggleButtons();
    if (mapInst) renderPeopleFlowOverlayOnMap(mapInst);
    _syncScrubberBars();
  }

  const MapPeopleFlowOverlay = {
    PEOPLE_FLOW_ZONES,
    PEOPLE_FLOW_CORRIDORS,
    PEOPLE_FLOW_PRESETS,
    PEOPLE_FLOW_WEATHER_OVERRIDES,
    PeopleFlowOverlayState,
    getPeopleFlowColor,
    getPeopleFlowTier,
    buildPeopleFlowOverlayModel,
    renderPeopleFlowOverlayOnMap,
    clearPeopleFlowOverlayOnMap,
    syncPeopleFlowOverlaysAllMaps,
    attachPeopleFlowOverlayToMap,
    syncPeopleFlowOverlayOnMap,
    togglePeopleFlowOverlay,
    setPeopleFlowPreset,
    onPeopleFlowTimeScrub,
    setPeopleFlowWeatherOverride,
    resetPeopleFlowToLive
  };

  if (root) {
    root.peopleFlowOverlayEnabled = false;
    root.MapPeopleFlowOverlay = MapPeopleFlowOverlay;
    root.buildPeopleFlowOverlayModel = buildPeopleFlowOverlayModel;
    root.attachPeopleFlowOverlayToMap = attachPeopleFlowOverlayToMap;
    root.syncPeopleFlowOverlayOnMap = syncPeopleFlowOverlayOnMap;
    root.syncPeopleFlowOverlaysAllMaps = syncPeopleFlowOverlaysAllMaps;
    root.togglePeopleFlowOverlay = togglePeopleFlowOverlay;
    root.setPeopleFlowPreset = setPeopleFlowPreset;
    root.onPeopleFlowTimeScrub = onPeopleFlowTimeScrub;
    root.setPeopleFlowWeatherOverride = setPeopleFlowWeatherOverride;
    root.resetPeopleFlowToLive = resetPeopleFlowToLive;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...MapPeopleFlowOverlay,
      MapPeopleFlowOverlay
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
