/* Transit HK — Interactive Map "People Flow" Overlay & Floating Preview Scrubber (map-flow-overlay.js)
 * Dual Browser Global + CommonJS module.
 *
 * Strictly scoped Leaflet overlay consuming simulateCityPeopleFlow() from hk-people-flow.js.
 * - Uses dedicated Leaflet panes & layerGroups per map (never touches Traffic & Cams, TD detectors,
 *   or busspeed.js road-speed polylines).
 * - Off by default; stacked vertically below Traffic on the map control column.
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
    if (p >= 1.0) return '#d97706';  // high-contrast amber
    return '#16a34a';                // green
  }

  function getPeopleFlowTier(pressure) {
    const p = Number(pressure) || 0;
    if (p >= 1.45) return 'HIGH';
    if (p >= 1.0) return 'ELEVATED';
    return 'CALM';
  }

  // Hong Kong key population flow pressure zones — pinned accurately to real transit nodes with tight halos
  const PEOPLE_FLOW_ZONES = Object.freeze([
    {
      id: 'pak_kung_au_trails',
      shortEn: 'Lantau Trails',
      shortTc: '大嶼山行山',
      nameEn: 'Pak Kung Au / Nam Shan Trails',
      nameTc: '伯公坳／南山行山徑',
      lat: 22.2486,
      lon: 113.9412,
      vectors: ['TO_TRAIL_EXPOSED', 'FROM_TRAIL_EXPOSED'],
      baseRadiusM: 650
    },
    {
      id: 'mui_wo_pier',
      shortEn: 'Mui Wo Pier',
      shortTc: '梅窩碼頭',
      nameEn: 'Mui Wo Ferry Pier',
      nameTc: '梅窩渡輪碼頭',
      lat: 22.2647,
      lon: 114.0017,
      vectors: ['ISLAND_OUTBOUND', 'ISLAND_INBOUND', 'TO_TRAIL_EXPOSED', 'FROM_TRAIL_EXPOSED'],
      baseRadiusM: 560
    },
    {
      id: 'cheung_chau_pier',
      shortEn: 'Cheung Chau',
      shortTc: '長洲碼頭',
      nameEn: 'Cheung Chau Pier',
      nameTc: '長洲渡輪碼頭',
      lat: 22.2089,
      lon: 114.0282,
      vectors: ['ISLAND_OUTBOUND', 'ISLAND_INBOUND'],
      baseRadiusM: 540
    },
    {
      id: 'central_piers',
      shortEn: 'Central Piers',
      shortTc: '中環碼頭',
      nameEn: 'Central Ferry Piers',
      nameTc: '中環渡輪碼頭',
      lat: 22.2869,
      lon: 114.1602,
      vectors: ['ISLAND_OUTBOUND', 'ISLAND_INBOUND', 'CBD_INBOUND', 'CBD_OUTBOUND'],
      baseRadiusM: 520
    },
    {
      id: 'hkia_tung_chung_awe',
      shortEn: 'HKIA',
      shortTc: '機場／東涌',
      nameEn: 'HKIA Terminal 1 / Tung Chung Station',
      nameTc: '機場一號客運大樓／東涌站',
      lat: 22.3135,
      lon: 113.9365,
      vectors: ['TO_AIRPORT_AWE', 'FROM_AIRPORT_AWE'],
      baseRadiusM: 820
    },
    {
      id: 'cbd_urban_core',
      shortEn: 'Harbour',
      shortTc: '維港核心',
      nameEn: 'Central / Tsim Sha Tsui Harbour Core',
      nameTc: '中環／尖沙咀維港核心區',
      lat: 22.2935,
      lon: 114.1705,
      vectors: ['CBD_INBOUND', 'CBD_OUTBOUND', 'SUNDAY_URBAN_HUB'],
      baseRadiusM: 860
    },
    {
      id: 'school_belt_kt_hmt_midlevels',
      shortEn: 'School Belt',
      shortTc: '九龍塘校網',
      nameEn: 'Kowloon Tong / Ho Man Tin Schools',
      nameTc: '九龍塘／何文田校網',
      lat: 22.3369,
      lon: 114.1761,
      vectors: ['SCHOOL_ZONE'],
      baseRadiusM: 680
    },
    {
      id: 'northern_borders',
      shortEn: 'Borders',
      shortTc: '北區口岸',
      nameEn: 'Lo Wu / Lok Ma Chau Borders',
      nameTc: '羅湖／落馬洲口岸',
      lat: 22.5282,
      lon: 114.1133,
      vectors: ['TO_BORDER_NORTH', 'FROM_BORDER_NORTH'],
      baseRadiusM: 900
    },
    {
      id: 'sai_kung',
      shortEn: 'Sai Kung',
      shortTc: '西貢',
      nameEn: 'Sai Kung Pier & Country Park',
      nameTc: '西貢碼頭及郊野公園',
      lat: 22.3816,
      lon: 114.2739,
      vectors: ['TO_BEACH_WATER', 'FROM_BEACH_WATER', 'TO_TRAIL_EXPOSED', 'FROM_TRAIL_EXPOSED'],
      baseRadiusM: 720
    },
    {
      id: 'shek_o_repulse_bay',
      shortEn: 'South Beaches',
      shortTc: '南區泳灘',
      nameEn: 'Repulse Bay / Shek O Beaches',
      nameTc: '淺水灣／石澳泳灘',
      lat: 22.2367,
      lon: 114.1973,
      vectors: ['TO_BEACH_WATER', 'FROM_BEACH_WATER'],
      baseRadiusM: 640
    },
    {
      id: 'cemeteries_festival',
      shortEn: 'Cemeteries',
      shortTc: '掃墓人潮',
      nameEn: 'Chai Wan / Tseung Kwan O Cemeteries',
      nameTc: '柴灣／將軍澳墳場',
      lat: 22.2644,
      lon: 114.2372,
      vectors: ['CEMETERY_FESTIVAL'],
      baseRadiusM: 700,
      minThreshold: 0.3
    }
  ]);

  // Opposing vector pairs for readable hub direction arrows
  const VECTOR_DIR_INFO = Object.freeze({
    TO_TRAIL_EXPOSED:   { arrow: '↑', opp: 'FROM_TRAIL_EXPOSED' },
    FROM_TRAIL_EXPOSED: { arrow: '↓', opp: 'TO_TRAIL_EXPOSED' },
    TO_BORDER_NORTH:    { arrow: '↑', opp: 'FROM_BORDER_NORTH' },
    FROM_BORDER_NORTH:  { arrow: '↓', opp: 'TO_BORDER_NORTH' },
    TO_AIRPORT_AWE:     { arrow: '↑', opp: 'FROM_AIRPORT_AWE' },
    FROM_AIRPORT_AWE:   { arrow: '↓', opp: 'TO_AIRPORT_AWE' },
    TO_BEACH_WATER:     { arrow: '↑', opp: 'FROM_BEACH_WATER' },
    FROM_BEACH_WATER:   { arrow: '↓', opp: 'TO_BEACH_WATER' },
    ISLAND_OUTBOUND:    { arrow: '↑', opp: 'ISLAND_INBOUND' },
    ISLAND_INBOUND:     { arrow: '↓', opp: 'ISLAND_OUTBOUND' },
    CBD_OUTBOUND:       { arrow: '↑', opp: 'CBD_INBOUND' },
    CBD_INBOUND:        { arrow: '↓', opp: 'CBD_OUTBOUND' }
  });

  // Major directional flow corridors (drawn with crisp arrows whenever vector >= 1.05)
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
      coords: [[22.249, 113.941], [22.244, 113.977], [22.265, 114.002]]
    },
    {
      id: 'island_outbound_corridor',
      vector: 'ISLAND_OUTBOUND',
      nameEn: 'Central Piers → Mui Wo & Cheung Chau',
      nameTc: '中環碼頭 ➔ 梅窩及長洲',
      coords: [[22.287, 114.160], [22.272, 114.075], [22.265, 114.002]]
    },
    {
      id: 'island_inbound_corridor',
      vector: 'ISLAND_INBOUND',
      nameEn: 'Mui Wo & Cheung Chau → Central Piers',
      nameTc: '梅窩及長洲 ➔ 中環碼頭',
      coords: [[22.209, 114.028], [22.252, 114.085], [22.287, 114.160]]
    },
    {
      id: 'to_border_corridor',
      vector: 'TO_BORDER_NORTH',
      nameEn: 'Urban Core → Lo Wu / Lok Ma Chau Borders',
      nameTc: '市區 ➔ 羅湖／落馬洲口岸',
      coords: [[22.337, 114.176], [22.414, 114.210], [22.492, 114.139], [22.528, 114.113]]
    },
    {
      id: 'from_border_corridor',
      vector: 'FROM_BORDER_NORTH',
      nameEn: 'Northern Borders → Kowloon & Urban Core',
      nameTc: '北部口岸 ➔ 九龍及市區',
      coords: [[22.528, 114.113], [22.465, 114.105], [22.382, 114.187], [22.319, 114.169]]
    },
    {
      id: 'to_airport_corridor',
      vector: 'TO_AIRPORT_AWE',
      nameEn: 'West Kowloon / Tsing Yi → HKIA & AWE',
      nameTc: '西九龍／青衣 ➔ 機場及博覽館',
      coords: [[22.304, 114.161], [22.358, 114.107], [22.339, 114.042], [22.314, 113.937]]
    },
    {
      id: 'from_airport_corridor',
      vector: 'FROM_AIRPORT_AWE',
      nameEn: 'HKIA / AWE → Tsing Yi & West Kowloon',
      nameTc: '機場／博覽館 ➔ 青衣及西九龍',
      coords: [[22.314, 113.937], [22.339, 114.042], [22.358, 114.107], [22.304, 114.161]]
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
      coords: [[22.237, 114.197], [22.257, 114.185], [22.279, 114.165]]
    },
    {
      id: 'sunday_urban_corridor',
      vector: 'SUNDAY_URBAN_HUB',
      nameEn: 'Sunday Hub Gathering → Central / CWB / Mong Kok',
      nameTc: '週日市區聚會 ➔ 中環／銅鑼灣／旺角',
      coords: [[22.319, 114.169], [22.294, 114.171], [22.280, 114.184], [22.282, 114.158]]
    },
    {
      id: 'cemetery_festival_corridor',
      vector: 'CEMETERY_FESTIVAL',
      nameEn: 'Festival Grave-Sweeping → Chai Wan / TKO Cemeteries',
      nameTc: '清明／重陽掃墓 ➔ 柴灣／將軍澳墳場',
      coords: [[22.282, 114.222], [22.265, 114.237], [22.264, 114.244]]
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
    DRY_22: { key: 'DRY_22', labelEn: '22°C Dry', labelTc: '22°C 乾燥', payload: { temp: 22, isDry: true, isClear: true, condition: 'Dry' } },
    RAIN:   { key: 'RAIN',   labelEn: 'Rain',     labelTc: '大雨',     payload: { temp: 24, isRainy: true, heavyRain: true, warnings: ['WRAINR'], condition: 'Rain' } },
    HOT_34: { key: 'HOT_34', labelEn: '34°C',     labelTc: '34°C 酷熱', payload: { temp: 34, isDry: false, condition: 'Hot' } },
    T8:     { key: 'T8',     labelEn: 'T8',       labelTc: '八號風球', payload: { temp: 26, preT8: true, typhoon: true, warnings: ['PRE_T8'], heavyRain: true, condition: 'T8' } }
  });

  // Strictly overlay-scoped preview state (NEVER mutates window.__HKO_WEATHER__ or live ETAs)
  const PeopleFlowOverlayState = {
    enabled: false,
    isPreview: false,
    presetsExpanded: false,
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

  function _getLiveHkoWeatherFromRoot() {
    if (typeof root === 'undefined' || !root) return null;
    if (typeof root.getResolvedLiveHkoWeather === 'function') {
      const resolved = root.getResolvedLiveHkoWeather();
      if (resolved && typeof resolved === 'object') return resolved;
    }
    if (root.__HKO_WEATHER__ && typeof root.__HKO_WEATHER__ === 'object') return root.__HKO_WEATHER__;
    if (root.hkoWeather && typeof root.hkoWeather === 'object') return root.hkoWeather;
    return null;
  }

  function _triggerLiveHkoWarmIfNeeded() {
    if (typeof root === 'undefined' || !root || typeof root.ensureLiveHkoWeather !== 'function') return;
    const wx = _getLiveHkoWeatherFromRoot();
    const hasTemp = wx && Number.isFinite(Number(wx.temp ?? wx.temperature ?? wx.tempC));
    if (!wx || !hasTemp) {
      try {
        Promise.resolve(root.ensureLiveHkoWeather()).catch(() => {});
      } catch (e) {}
    }
  }

  function formatPeopleFlowWeatherLabel(wx, isZh) {
    const zh = Boolean(isZh);
    if (!wx || typeof wx !== 'object') {
      return zh ? '預設天氣' : 'Fallback';
    }
    if (zh && wx.displayLabelTc) return String(wx.displayLabelTc);
    if (!zh && wx.displayLabelEn) return String(wx.displayLabelEn);

    const warnTokens = []
      .concat(Array.isArray(wx.warnings) ? wx.warnings : [])
      .concat(Array.isArray(wx.warningCodes) ? wx.warningCodes : [])
      .map(s => String(s || '').toUpperCase());
    if (wx.typhoon || wx.preT8 || wx.preTyphoonEvac || warnTokens.some(c => /^TC(8|9|10)|PRE_T8/.test(c))) {
      return zh ? '八號風球' : 'T8';
    }

    const rawTemp = wx.temp ?? wx.temperature ?? wx.tempC ?? wx.temperatureC;
    const temp = (rawTemp !== null && rawTemp !== undefined && rawTemp !== '' && Number.isFinite(Number(rawTemp)))
      ? Math.round(Number(rawTemp))
      : null;
    const rawHum = wx.humidity ?? wx.rh ?? wx.relativeHumidity;
    const hum = (rawHum !== null && rawHum !== undefined && rawHum !== '' && Number.isFinite(Number(rawHum)))
      ? Number(rawHum)
      : null;
    const isRain = Boolean(
      wx.heavyRain || wx.rainAdvisory || wx.isRainy || wx.rain ||
      (Number.isFinite(Number(wx.rainfallMm)) && Number(wx.rainfallMm) >= 1) ||
      warnTokens.some(c => /^WRAIN/.test(c))
    );
    const isDry = Boolean(!isRain && (wx.isDry === true || wx.dry === true || (hum !== null && hum <= 78)));
    const isClear = Boolean(!isRain && (wx.isClear === true || wx.clear === true));

    let condEn = '';
    let condTc = '';
    if (wx.heavyRain) { condEn = 'Heavy Rain'; condTc = '大雨'; }
    else if (isRain) { condEn = 'Rain'; condTc = '有雨'; }
    else if (temp !== null && temp > 31) { condEn = 'Hot'; condTc = '酷熱'; }
    else if (temp !== null && temp < 12) { condEn = 'Cold'; condTc = '寒冷'; }
    else if (isDry) { condEn = 'Dry'; condTc = '乾燥'; }
    else if (hum !== null && hum > 85) { condEn = 'Humid'; condTc = '潮濕'; }
    else if (isClear) { condEn = 'Clear'; condTc = '天晴'; }
    else if (wx.condition) { condEn = String(wx.condition); condTc = String(wx.condition); }

    if (temp !== null) {
      const cond = zh ? condTc : condEn;
      return cond ? `${temp}°C ${cond}` : `${temp}°C`;
    }
    if (zh && wx.labelTc) return String(wx.labelTc);
    if (!zh && wx.labelEn) return String(wx.labelEn);
    if (condEn || condTc) return zh ? (condTc || condEn) : condEn;
    return zh ? '實時天文台' : 'Live HKO';
  }

  function formatPeopleFlowHubLabel(zone, isZh) {
    const zh = Boolean(isZh);
    const shortName = zh ? (zone.shortTc || zone.nameTc || zone.shortEn || '') : (zone.shortEn || zone.nameEn || '');
    const arrow = zone.dirArrow ? ` ${zone.dirArrow}` : '';
    const mult = Number(zone.pressure || 0).toFixed(1);
    return `${shortName}${arrow} ${mult}x`;
  }

  function _resolveEffectiveSimInputs(nowMsOverride, hkoWeatherOverride) {
    const liveNow = Number.isFinite(Number(nowMsOverride)) ? Number(nowMsOverride) : Date.now();
    const liveWx = hkoWeatherOverride !== undefined
      ? hkoWeatherOverride
      : _getLiveHkoWeatherFromRoot();
    const isZh = _isZh();

    if (!PeopleFlowOverlayState.isPreview) {
      return {
        simMs: liveNow,
        simWeather: liveWx,
        weatherSource: formatPeopleFlowWeatherLabel(liveWx, isZh),
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
      ? (isZh ? wxPreset.labelTc : wxPreset.labelEn)
      : formatPeopleFlowWeatherLabel(liveWx, isZh);

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

  function _computeCorridorMidChevron(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const segIdx = Math.floor((coords.length - 1) / 2);
    const a = coords[segIdx];
    const b = coords[Math.min(coords.length - 1, segIdx + 1)];
    return {
      point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      bearingDeg: Math.round(_computeBearingDeg(a, b))
    };
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
    const effectiveWx = hkoWeather !== undefined ? hkoWeather : _getLiveHkoWeatherFromRoot();
    const cityFlow = simFn
      ? simFn(ms, effectiveWx, opts)
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

      // Show directional arrow (↑/↓) when primary vector clearly dominates its opposing flow
      let dirArrow = '';
      const dirInfo = VECTOR_DIR_INFO[peakVector];
      if (dirInfo && peakPressure >= 0.95) {
        const oppVal = Number(vec[dirInfo.opp] || 0);
        if ((peakPressure - oppVal) >= 0.15) {
          dirArrow = dirInfo.arrow;
        }
      }

      // Tighter halo radius (~45% smaller than v1 so hubs sit cleanly over transit nodes)
      const radiusM = Math.round(z.baseRadiusM * (0.65 + Math.min(1.0, peakPressure / 2.0) * 0.45));
      const zoneObj = {
        id: z.id,
        shortEn: z.shortEn,
        shortTc: z.shortTc,
        nameEn: z.nameEn,
        nameTc: z.nameTc,
        lat: z.lat,
        lon: z.lon,
        pressure: Number(peakPressure.toFixed(2)),
        isQuietBaseline: peakPressure < 0.95,
        primaryVector: peakVector,
        dirArrow,
        matchedVectors: matched,
        color: getPeopleFlowColor(peakPressure),
        tier: getPeopleFlowTier(peakPressure),
        radiusM,
        badgeLabelEn: '',
        badgeLabelTc: ''
      };
      zoneObj.badgeLabelEn = formatPeopleFlowHubLabel(zoneObj, false);
      zoneObj.badgeLabelTc = formatPeopleFlowHubLabel(zoneObj, true);
      zones.push(zoneObj);
    }

    const arrows = [];
    for (let i = 0; i < PEOPLE_FLOW_CORRIDORS.length; i++) {
      const c = PEOPLE_FLOW_CORRIDORS[i];
      const pressure = Number(vec[c.vector] || 0);
      if (pressure < 1.05) continue; // Show active directional corridors whenever vector >= 1.05
      const endA = c.coords[c.coords.length - 2];
      const endB = c.coords[c.coords.length - 1];
      const midChevron = _computeCorridorMidChevron(c.coords);
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
        bearingDeg: Math.round(_computeBearingDeg(endA, endB)),
        midChevron
      });
    }

    const hk = _getCurrentHkTimeParts(ms);
    const timeStr = _formatMinutesHHMM(hk.minutesOfDay);
    const dayLabelMap = { weekday: 'Wkdy', saturday: 'Sat', sunday: 'Sun', holiday: 'Hol' };
    const dayTag = dayLabelMap[cal.dayType] || 'Wkdy';
    const wxTag = formatPeopleFlowWeatherLabel(effectiveWx, false);
    const summaryChip = `W${cal.isoWeek || 1} · ${dayTag} ${timeStr} · ${wxTag}`;

    return {
      cityFlow,
      calendar: cal,
      weather: wx,
      weatherLabelEn: wxTag,
      weatherLabelTc: formatPeopleFlowWeatherLabel(effectiveWx, true),
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
        <strong style="color:${getPeopleFlowColor(v.value)};font-variant-numeric:tabular-nums;">${Number(v.value).toFixed(2)}x</strong>
      </div>`
    ).join('');
    const flags = [
      `W${cal.isoWeek || 1}`,
      String(cal.dayType || 'weekday'),
      cal.isSchoolDay ? (isZh ? '上課日' : 'School ON') : (isZh ? '非上課日' : 'School OFF'),
      cal.isEveOfHoliday ? (isZh ? '假期前夕' : 'Holiday Eve') : null
    ].filter(Boolean).join(' · ');

    return `
      <div style="min-width:195px;max-width:248px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;">
          <strong style="font-size:0.80rem;color:#111827;line-height:1.25;">${_esc(title)}</strong>
          <span style="padding:1px 7px;border-radius:999px;font-size:0.68rem;font-weight:800;color:#fff;background:${color};font-variant-numeric:tabular-nums;">${Number(pressure).toFixed(2)}x</span>
        </div>
        <div style="padding:5px 7px;border-radius:8px;background:rgba(15,23,42,0.05);margin-bottom:5px;">
          ${vecRows}
        </div>
        <div style="font-size:0.68rem;color:#4b5563;line-height:1.35;">
          <div><strong>${isZh ? '日曆：' : 'Calendar:'}</strong> ${_esc(flags)}</div>
          <div><strong>${isZh ? '天氣：' : 'Weather:'}</strong> ${_esc(weatherSource)} · Out ×${Number(wx.outdoorMod || 1).toFixed(2)} · Urb ×${Number(wx.urbanIndoorMod || 1).toFixed(2)}${Number(wx.preTyphoonEvacMod || 1) > 1.05 ? ` · T8 ×${Number(wx.preTyphoonEvacMod).toFixed(2)}` : ''}</div>
        </div>
      </div>
    `;
  }

  // Dedicated WeakMap of Leaflet LayerGroups per map — 100% isolated from Traffic & Cams layers
  const _peopleFlowLayerByMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  const _peopleFlowZoomBound = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function _ensureFlowPanes(mapInst) {
    if (!mapInst || typeof mapInst.getPane !== 'function' || typeof mapInst.createPane !== 'function') return;
    const specs = [
      ['peopleFlowHaloPane', '440'],
      ['peopleFlowArrowPane', '520'],
      ['peopleFlowLabelPane', '620']
    ];
    for (let i = 0; i < specs.length; i++) {
      const [name, zIdx] = specs[i];
      let pane = mapInst.getPane(name);
      if (!pane) {
        pane = mapInst.createPane(name);
        if (pane && pane.style) {
          pane.style.zIndex = zIdx;
        }
      }
    }
  }

  function _syncMapDimmingClass(mapInst, active) {
    try {
      const container = mapInst && typeof mapInst.getContainer === 'function' ? mapInst.getContainer() : null;
      if (container && container.classList) {
        container.classList.toggle('people-flow-active', Boolean(active));
      }
    } catch (e) {}
    if (typeof root !== 'undefined' && root && mapInst === root.browseMapInstance && typeof root.setBrowseMapStopDimming === 'function') {
      try { root.setBrowseMapStopDimming(Boolean(active)); } catch (e) {}
    }
  }

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
    _syncMapDimmingClass(mapInst, false);
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

    _ensureFlowPanes(mapInst);
    _syncMapDimmingClass(mapInst, true);

    if (_peopleFlowZoomBound && !_peopleFlowZoomBound.get(mapInst) && typeof mapInst.on === 'function') {
      _peopleFlowZoomBound.set(mapInst, true);
      mapInst.on('zoomend', () => {
        if (PeopleFlowOverlayState.enabled) {
          renderPeopleFlowOverlayOnMap(mapInst);
        }
      });
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
    const currentZoom = typeof mapInst.getZoom === 'function' ? Number(mapInst.getZoom()) : 11;

    // 1. Pressure Zone Halos & Clear Hub + Direction Labels
    for (let i = 0; i < model.zones.length; i++) {
      const z = model.zones[i];
      const title = isZh ? z.nameTc : z.nameEn;
      const isQuiet = z.pressure < 0.95;

      // Hide quiet baseline zones (< 0.95) at overview zoom unless zoomed in (>= 13);
      // keep a subtle tappable hit area when zoomed in or keep quiet zones out of clutter.
      if (isQuiet && currentZoom < 13) {
        const faintHit = L.circle([z.lat, z.lon], {
          pane: 'peopleFlowHaloPane',
          radius: Math.round(z.radiusM * 0.72),
          color: z.color,
          weight: 1,
          opacity: 0.22,
          fillColor: z.color,
          fillOpacity: 0.04,
          interactive: true
        });
        faintHit.bindPopup(_buildFlowPopupHtml(title, z.matchedVectors, z.pressure, model.calendar, model.weather, weatherSource), {
          maxWidth: 260,
          closeButton: true
        });
        lg.addLayer(faintHit);
        continue;
      }

      const circle = L.circle([z.lat, z.lon], {
        pane: 'peopleFlowHaloPane',
        radius: z.radiusM,
        color: z.color,
        weight: z.pressure >= 1.45 ? 2.2 : 1.6,
        opacity: 0.85,
        fillColor: z.color,
        fillOpacity: z.pressure >= 1.45 ? 0.20 : (z.pressure >= 1.0 ? 0.14 : 0.08),
        interactive: true
      });
      circle.bindPopup(_buildFlowPopupHtml(title, z.matchedVectors, z.pressure, model.calendar, model.weather, weatherSource), {
        maxWidth: 260,
        closeButton: true
      });
      lg.addLayer(circle);

      // Clear Hub + Direction tag pill (e.g., "Borders ↓ 1.2x", "HKIA 1.1x", "Lantau Trails ↑ 1.6x")
      const pillText = isZh ? z.badgeLabelTc : z.badgeLabelEn;
      const icon = L.divIcon({
        className: 'people-flow-zone-badge-wrap',
        html: `<div class="people-flow-zone-badge tier-${z.tier.toLowerCase()}" style="border-color:${z.color};color:${z.color};">${_esc(pillText)}</div>`,
        iconSize: null,
        iconAnchor: [0, 0]
      });
      const badgeMarker = L.marker([z.lat, z.lon], { icon, pane: 'peopleFlowLabelPane', interactive: true });
      badgeMarker.bindPopup(_buildFlowPopupHtml(title, z.matchedVectors, z.pressure, model.calendar, model.weather, weatherSource), {
        maxWidth: 260,
        closeButton: true
      });
      lg.addLayer(badgeMarker);
    }

    // 2. Visible Directional Flow Arrows on dedicated pane above halos & OSM ferry lines (vector >= 1.05)
    for (let i = 0; i < model.arrows.length; i++) {
      const a = model.arrows[i];
      const title = isZh ? a.nameTc : a.nameEn;
      const strokeW = a.pressure >= 1.45 ? 4.5 : 3.5;

      // Crisp light casing underneath so arrows stand out sharply over OSM ferry lines & roads
      const casing = L.polyline(a.coords, {
        pane: 'peopleFlowArrowPane',
        color: '#ffffff',
        weight: strokeW + 3,
        opacity: 0.88,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      lg.addLayer(casing);

      const line = L.polyline(a.coords, {
        pane: 'peopleFlowArrowPane',
        color: a.color,
        weight: strokeW,
        opacity: 0.95,
        dashArray: '10, 7',
        lineCap: 'round',
        lineJoin: 'round',
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

      const addArrowChevron = (latLon, deg, sizePx) => {
        const arrowIcon = L.divIcon({
          className: 'people-flow-arrow-head-wrap',
          html: `<div class="people-flow-arrow-head" style="transform:rotate(${deg}deg);color:${a.color};width:${sizePx}px;height:${sizePx}px;">▲</div>`,
          iconSize: [sizePx, sizePx],
          iconAnchor: [sizePx / 2, sizePx / 2]
        });
        const arrowMarker = L.marker(latLon, { icon: arrowIcon, pane: 'peopleFlowArrowPane', interactive: true });
        arrowMarker.bindPopup(popupHtml, { maxWidth: 260, closeButton: true });
        lg.addLayer(arrowMarker);
      };

      if (a.midChevron && a.midChevron.point) {
        addArrowChevron(a.midChevron.point, a.midChevron.bearingDeg, 18);
      }
      addArrowChevron(a.arrowTip, a.bearingDeg, 22);
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
    const timeStr = _formatMinutesHHMM(hk.minutesOfDay);
    const dayMap = isZh
      ? { weekday: '平日', saturday: '週六', sunday: '週日', holiday: '假期' }
      : { weekday: 'Wkdy', saturday: 'Sat', sunday: 'Sun', holiday: 'Hol' };
    const dayTag = dayMap[model.calendar.dayType] || (isZh ? '平日' : 'Wkdy');
    const liveChipText = `W${model.calendar.isoWeek || 1} · ${dayTag} ${timeStr} · ${weatherSource}`;
    const expanded = Boolean(PeopleFlowOverlayState.presetsExpanded);

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

    const presetsToggleLabel = expanded
      ? (isZh ? '預設 ▴' : 'Presets ▴')
      : (isZh ? '預設 ▾' : 'Presets ▾');

    return `
      <div class="pf-scrubber-top">
        <span class="pf-state-chip">${_esc(liveChipText)}</span>
        ${PeopleFlowOverlayState.isPreview
          ? `<span class="pf-preview-pill">PREVIEW</span>
             <button type="button" class="pf-reset-btn" onclick="resetPeopleFlowToLive()">${isZh ? '重設實時' : 'Reset to Live'}</button>`
          : ''}
        <button type="button" class="pf-presets-toggle-btn ${expanded ? 'open' : ''}" onclick="togglePeopleFlowPresetsDrawer()" aria-expanded="${expanded ? 'true' : 'false'}">${_esc(presetsToggleLabel)}</button>
        <button type="button" class="pf-close-btn" onclick="togglePeopleFlowOverlay(false)" title="${isZh ? '關閉人流模擬' : 'Close People Flow'}">✕</button>
      </div>
      <div class="pf-slider-row">
        <span class="pf-time-readout">${_esc(_formatMinutesHHMM(sliderVal))}</span>
        <input type="range" class="pf-time-slider" min="0" max="1425" step="15" value="${sliderVal}" oninput="onPeopleFlowTimeScrub(this.value)" aria-label="Simulation time of day">
      </div>
      <div class="pf-presets-drawer" style="display:${expanded ? 'flex' : 'none'};">
        <div class="pf-chip-row">${presetsHtml}</div>
        <div class="pf-chip-row pf-wx-row">${wxHtml}</div>
      </div>
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

  function togglePeopleFlowPresetsDrawer(forceState) {
    PeopleFlowOverlayState.presetsExpanded = typeof forceState === 'boolean'
      ? forceState
      : !PeopleFlowOverlayState.presetsExpanded;
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
    if (next) {
      _triggerLiveHkoWarmIfNeeded();
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
    _triggerLiveHkoWarmIfNeeded();
    syncPeopleFlowOverlaysAllMaps();
  }

  /**
   * Attaches the off-by-default "People Flow" toggle pill stacked directly below the existing
   * Traffic pill inside the full browse map (#view-map).
   */
  function attachPeopleFlowOverlayToMap(mapInst) {
    if (!mapInst || typeof L === 'undefined') return;
    _triggerLiveHkoWarmIfNeeded();
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
    formatPeopleFlowWeatherLabel,
    formatPeopleFlowHubLabel,
    buildPeopleFlowOverlayModel,
    renderPeopleFlowOverlayOnMap,
    clearPeopleFlowOverlayOnMap,
    syncPeopleFlowOverlaysAllMaps,
    attachPeopleFlowOverlayToMap,
    syncPeopleFlowOverlayOnMap,
    togglePeopleFlowOverlay,
    togglePeopleFlowPresetsDrawer,
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
    root.togglePeopleFlowPresetsDrawer = togglePeopleFlowPresetsDrawer;
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
