import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

function loadWorkerSandbox() {
  const rawSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  const sandboxSrc = rawSrc.replace(/^export\s+/gm, '');
  const ctx: Record<string, any> = { URL, Response, AbortController, setTimeout, clearTimeout, Date, Math, console };
  vm.createContext(ctx);
  return vm.runInContext(
    `${sandboxSrc}\n;({ parseXmlRecords, parseFerryRowSortMin, sortFerryEtasChronologically, classifyTrafficCorridorSeverity, parseHkoWeatherSummary, onRequest });`,
    ctx
  );
}

function loadHardcodeAndPlannerSandbox(overrides: Record<string, any> = {}) {
  const hardcodeSrc = fs.readFileSync('public/hardcode.js', 'utf8');
  const plannerSrc = fs.readFileSync('public/planner.js', 'utf8');

  const win: Record<string, any> = {
    __HKO_WEATHER__: { heavyRain: false, rainAdvisory: false, typhoon: false },
    __LIVE_TRAFFIC_CORRIDORS__: {},
    crossesWaterBarrier: () => false,
    __GET_ROUTE_COLOR_HEX__: () => '#007AFF',
    getExactMtrFare: () => 12.5,
  };

  const ctx: Record<string, any> = {
    window: win,
    navigator: { onLine: true },
    currentLang: 'en',
    xferSortPref: 'BULLETPROOF',
    xferTimeMode: 'NOW',
    xferLocoBikeEnabled: false,
    routeMapIndex: new Map(),
    stopMapIndex: new Map(),
    groupedRoutes: [],
    routeStopsCache: {},
    allStops: [],
    bookmarkedStops: [],
    SignalHealthMonitor: {
      byOperator: {
        KMB: { okMs: 0 },
        CTB: { okMs: 0 },
        MTR: { okMs: 0 },
      },
    },
    SafeStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
      const R = 6371;
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(Math.max(0, a)), Math.sqrt(Math.max(0, 1 - a)));
    },
    isValidRailOrFerryCoord: (la: number, lo: number) =>
      Number.isFinite(la) && Number.isFinite(lo) && la > 22.1 && la < 22.6 && lo > 113.8 && lo < 114.5,
    getHongKongNow: (ms = Date.now()) => new Date(ms),
    isHongKongHolidayFareDay: () => false,
    getStopName: (s: any) => s?.stopName_e || '',
    getBaseStopNameKey: (n: string) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    normStationLookupKey: (n: string) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    extractRouteBoundCode: (g: any) => (String(g?.key || '').endsWith('_I') ? 'I' : 'O'),
    getEffectiveStopFare: (g: any, s: any) => Number(s?.fare || g?.maxFare || 8.0),
    getCorridorLiveStatusAt: () => ({ status: 'SMOOTH', speedKmh: 70 }),
    getStopsForGroup: (g: any) => g?._stops || [],
    fetchEtaRaw: async () => [],
    isAirportPremiumRoute: (g: any) => g?.routeNo === 'AEL' || /^A\d+/.test(String(g?.routeNo || '')),
    isExternalERoute: (g: any) => /^E\d+/.test(String(g?.routeNo || '')),
    isRouteActiveAtPlannerTime: () => true,
    ...overrides,
  };

  vm.createContext(ctx);
  const exportsObj = vm.runInContext(
    `${hardcodeSrc}\n${plannerSrc}\n;({
      MTR_ENGINE,
      MTR_EXITS_SEED,
      LoadFactorEngine,
      SHARED_BIKE_PRICING,
      computeSharedBikeFareHkd,
      inferPlannerLegLoad,
      SECTIONAL_FARE_REGISTRY,
      resolveBusLegNetFare,
      getRaptorGraph,
      runRaptorCorridorPass,
      buildFromToEdgeRequestSpec,
      isBusLegOnIncidentCorridor,
      resolveFirstLegWindow,
      resolveLiveOrStaticLegWindow,
      pruneDominatedPlannerCards,
      getInterchangeTransferSec,
      getLegServiceCutoffWarning,
      computeLegChainFareHkd,
      formatPlannerCardShareText,
      getFerryPierBerthLabel,
      computeDisruptionAdjustedScore,
      detectTungChungNorthLoopPenalty,
      computeBusPeakCongestionBufferMins,
      isShortLastMileFeederLeg,
      renderWalkTimelineRowHtml,
      findNearestMtrExitForPoint,
      resolveMtrTransferExit,
      getPlannerAutocompleteRefPoint,
      formatCompactDistanceLabel,
      deduplicatePlannerAutocompleteStops,
      getPlannerAutocompleteSectionOrder,
      evaluatePlannerAlertBannerState,
      syncPlannerAlertBannerUI,
      dismissPlannerAlertBanner,
      onPlannerInlineInput,
      clearCommuteSlot,
      renderPlannerInlineDropdown,
    });`,
    ctx
  );

  return { ctx, ...exportsObj };
}

test('Detour BS is completely removed from all app source files', () => {
  const files = [
    'index.html',
    'public/planner.js',
    'public/map.js',
    'public/hardcode.js',
    'functions/api/worker.js',
  ];
  const forbidden = [
    'launchDetourFromRoute',
    'eta-rescue-btn',
    'rescueHtml',
    'rescueBtnHtml',
    'resolveWalkableNeighborFallbackEtas',
    'allowWalkNeighborFallback',
    'walkRedirect',
    'WALK_NEIGHBOR_RECOVERY',
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const token of forbidden) {
      assert.equal(
        content.includes(token),
        false,
        `Found forbidden detour token "${token}" in ${file}`
      );
    }
  }
});

test('hardcode.js: Admiralty TWL<->SIL interchange uses sorted key ADM_SIL_TWL (240s)', () => {
  const { MTR_ENGINE } = loadHardcodeAndPlannerSandbox();
  assert.equal(MTR_ENGINE.getInterchangeWalkSec('ADM', 'TWL', 'SIL'), 240);
  assert.equal(MTR_ENGINE.getInterchangeWalkSec('ADM', 'SIL', 'TWL'), 240);
});

test('hardcode.js: NLB 3M and NLB 1 have bilingual sectional fare notices and accurate short-hop fare', () => {
  const { SECTIONAL_FARE_REGISTRY, resolveBusLegNetFare } = loadHardcodeAndPlannerSandbox();
  assert.ok(SECTIONAL_FARE_REGISTRY.NLB_3M.noticeEn.length > 10);
  assert.ok(SECTIONAL_FARE_REGISTRY.NLB_3M.noticeTc.length > 10);
  assert.ok(SECTIONAL_FARE_REGISTRY.NLB_1.noticeEn.length > 10);
  assert.ok(SECTIONAL_FARE_REGISTRY.NLB_1.noticeTc.length > 10);

  const resWk = resolveBusLegNetFare(
    { company: 'NLB', routeNo: '3M', key: 'NLB_3M_O', maxFare: 12.1 },
    { stopName_e: 'Tung Chung Station Bus Terminus', seq: 1, fare: '12.1', fareHol: '19.7' },
    { stopName_e: 'Shek Mun Kap', seq: 4, fare: '12.1', fareHol: '19.7' },
    false
  );
  assert.equal(resWk.netFare, 2.8);
  assert.ok(resWk.noticeEn.includes('sectional fare'));

  const resHol = resolveBusLegNetFare(
    { company: 'NLB', routeNo: '3M', key: 'NLB_3M_O', maxFare: 12.1 },
    { stopName_e: 'Tung Chung Station Bus Terminus', seq: 1, fare: '12.1', fareHol: '19.7' },
    { stopName_e: 'Shek Mun Kap', seq: 4, fare: '12.1', fareHol: '19.7' },
    true
  );
  assert.equal(resHol.netFare, 5.6);
});

test('worker.js: XML decoding, Sun Ferry chronological sorting, traffic incident filter, and Typhoon priority', () => {
  const {
    parseXmlRecords,
    sortFerryEtasChronologically,
    classifyTrafficCorridorSeverity,
    parseHkoWeatherSummary,
  } = loadWorkerSandbox();
  const recs = parseXmlRecords(
    '<message><EngText><![CDATA[Slow lane &amp; &lt;exit&gt; closed &#39;now&#39;]]></EngText></message>',
    'message'
  ) as Array<Record<string, string>>;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].EngText, "Slow lane & <exit> closed 'now'");

  const sorted = sortFerryEtasChronologically([
    { depart_time: '10:30', vessel_type: 'Ordinary Ferry' },
    { depart_time: '09:45', vessel_type: 'Fast Ferry' },
    { depart_time: '10:05', vessel_type: 'Fast Ferry' },
  ]);
  assert.deepEqual(
    Array.from(sorted, (r: any) => r.depart_time),
    ['09:45', '10:05', '10:30']
  );

  // Genuine traffic accident mentioning slow lane MUST still trigger INCIDENT
  assert.equal(
    classifyTrafficCorridorSeverity('The slow lane of Tuen Mun Road is closed due to traffic accident.', 'Active'),
    'INCIDENT'
  );
  // Routine roadworks stays ignored
  assert.equal(
    classifyTrafficCorridorSeverity('Slow lane of Tuen Mun Road closed due to roadworks.', 'Active'),
    null
  );
  // Re-opened / cleared stays ignored
  assert.equal(
    classifyTrafficCorridorSeverity('Tuen Mun Road has been re-opened after traffic accident.', 'Active'),
    null
  );

  // Typhoon TC8NE must not be overwritten by Rainstorm warning appearing later
  const w = parseHkoWeatherSummary({
    WTCSGNL: { code: 'TC8NE' },
    WRAIN: { code: 'WRAINB' },
  });
  assert.equal(w.typhoon, true);
  assert.equal(w.heavyRain, true);
  assert.equal(w.labelEn, 'Typhoon TC8NE');
});

test('planner.js: RAPTOR boarding upgrade (+) and multi-round backtracking work without false cycle drops', () => {
  const { runRaptorCorridorPass } = loadHardcodeAndPlannerSandbox();

  // Construct synthetic 4-stop graph:
  // Stop 0 (Origin) --[Route A (fast)]--> Stop 2 (arrives early)
  // Stop 0 --[Route C (slow)]--> Stop 1
  // Route B runs Stop 1 -> Stop 2 -> Stop 3 (cumSecs: 0, 600, 900)
  // Staying on Route B from Stop 1 reaches Stop 2 much later than transferring at Stop 2 via Route A!
  // With the old minus-sign bug, boarding at Stop 1 prevented upgrading to Stop 2.
  const stops = [
    { stopKey: 'S0', stopName_e: 'Origin Hub', lat: 22.28, lon: 114.15, mode: 'BUS', routeDensity: 3 },
    { stopKey: 'S1', stopName_e: 'Mid West', lat: 22.29, lon: 114.16, mode: 'BUS', routeDensity: 3 },
    { stopKey: 'S2', stopName_e: 'Mid Fast', lat: 22.30, lon: 114.17, mode: 'BUS', routeDensity: 3 },
    { stopKey: 'S3', stopName_e: 'Dest Hub', lat: 22.32, lon: 114.19, mode: 'BUS', routeDensity: 3 },
  ];

  const makeStopObj = (idx: number) => ({
    stopKey: stops[idx].stopKey,
    stopName_e: stops[idx].stopName_e,
    name_tc: stops[idx].stopName_e,
    lat: stops[idx].lat,
    lon: stops[idx].lon,
    latitude: String(stops[idx].lat),
    longitude: String(stops[idx].lon),
    fare: '6.0',
  });

  const gA = { key: 'KMB_A_O', mode: 'BUS', company: 'KMB', routeNo: 'A', headwayMins: 6, maxFare: 6.0, activeWindows: [[0, 1439]] };
  const gB = { key: 'KMB_B_O', mode: 'BUS', company: 'KMB', routeNo: 'B', headwayMins: 6, maxFare: 6.0, activeWindows: [[0, 1439]] };
  const gC = { key: 'KMB_C_O', mode: 'BUS', company: 'KMB', routeNo: 'C', headwayMins: 6, maxFare: 6.0, activeWindows: [[0, 1439]] };

  const routes = [
    { group: gC, stIndices: [0, 1], stObjs: [makeStopObj(0), makeStopObj(1)], cumSecs: [0, 500] },
    { group: gA, stIndices: [0, 2], stObjs: [makeStopObj(0), makeStopObj(2)], cumSecs: [0, 300] },
    { group: gB, stIndices: [1, 2, 3], stObjs: [makeStopObj(1), makeStopObj(2), makeStopObj(3)], cumSecs: [0, 900, 1200] },
  ];

  const stopRoutes = stops.map(() => [] as Array<{ rIdx: number; seq: number }>);
  routes.forEach((rt, rIdx) => {
    rt.stIndices.forEach((sIdx, seq) => stopRoutes[sIdx].push({ rIdx, seq }));
  });

  const G = {
    stops,
    routes,
    stopRoutes,
    transfers: stops.map(() => []),
  };

  const originAccess = new Map([[0, { sec: 60, distM: 75, byBike: false, exitObj: null }]]);
  const destEgress = new Map([[3, { sec: 60, distM: 75, byBike: false, exitObj: null }]]);
  const queryDate = new Date('2026-11-21T10:00:00+08:00');

  const corridors = runRaptorCorridorPass(
    G,
    originAccess,
    destEgress,
    queryDate,
    false,
    false,
    false,
    { name_en: 'Origin', lat: 22.28, lon: 114.15 },
    { name_en: 'Dest', lat: 22.32, lon: 114.19 },
    { maxRounds: 4 }
  );

  assert.ok(corridors.length >= 1, 'Expected RAPTOR to reconstruct valid transfer corridor');
  // Best corridor MUST board Route B at Stop 2 via Route A (not stuck at Stop 1 via Route C)
  const best = corridors[0];
  assert.equal(best.leg1Group.routeNo, 'A');
  assert.equal(best.leg2Group.routeNo, 'B');
  assert.equal(best.xferStopNodes[0].board2StopObj.stopKey, 'S2');
});

test('planner.js: resolveFirstLegWindow does NOT falsely prune route as isDeadGhost on API failure', async () => {
  // Case 1: API timed out / failed (okMs === 0) and fetchEtaRaw returns []
  const sbTimeout = loadHardcodeAndPlannerSandbox({
    fetchEtaRaw: async () => [],
    SignalHealthMonitor: { byOperator: { KMB: { okMs: 0 } } },
  });
  const group = { key: 'KMB_1A_O', mode: 'BUS', company: 'KMB', routeNo: '1A', headwayMins: 10, maxFare: 7.5 };
  const now = Date.now();
  const winTimeout = await sbTimeout.resolveFirstLegWindow(group, 'STOP_1', now + 60_000, 600, null);
  assert.equal(winTimeout.isDeadGhost, false);
  assert.equal(winTimeout.signalType, 'HEADWAY_PROJ');

  // Case 2: API confirmed healthy (<10s ago) and returned 0 buses => accurately marked isDeadGhost
  const sbConfirmedEmpty = loadHardcodeAndPlannerSandbox({
    fetchEtaRaw: async () => [],
    SignalHealthMonitor: { byOperator: { KMB: { okMs: Date.now() } } },
  });
  const winEmpty = await sbConfirmedEmpty.resolveFirstLegWindow(group, 'STOP_1', now + 60_000, 600, null);
  assert.equal(winEmpty.isDeadGhost, true);
  assert.equal(winEmpty.signalType, 'NO_SERVICE');
});

test('bus_index.min.json contains all 10 MTR lines, 12 LRT routes, ferries, buses, and valid fare matrix', () => {
  const db = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));
  assert.equal(db.schemaVersion, 9);

  const mtrLines = new Set(db.groupedRoutes.filter((g: any) => g.mode === 'MTR' && g.company === 'MTR').map((g: any) => g.routeNo));
  for (const code of ['AEL', 'TCL', 'TML', 'TKL', 'EAL', 'SIL', 'TWL', 'ISL', 'KTL', 'DRL']) {
    assert.ok(mtrLines.has(code), `Missing MTR line ${code}`);
  }

  const lrtRoutes = new Set(db.groupedRoutes.filter((g: any) => g.mode === 'MTR' && g.company === 'LRT').map((g: any) => g.routeNo));
  for (const rNo of ['505', '507', '610', '614', '614P', '615', '615P', '705', '706', '751', '751P', '761P']) {
    assert.ok(lrtRoutes.has(rNo), `Missing LRT route ${rNo}`);
  }

  const ferries = db.groupedRoutes.filter((g: any) => g.mode === 'FERRY');
  const buses = db.groupedRoutes.filter((g: any) => g.mode === 'BUS');
  assert.ok(ferries.length >= 20, `Expected >=20 ferry routes, got ${ferries.length}`);
  assert.ok(buses.length >= 20, `Expected >=20 bus routes, got ${buses.length}`);

  const buf = Buffer.from(db.mtrFareMatrixB64, 'base64');
  const arr = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const N = db.mtrFareStations.length;
  assert.equal(arr.length, N * N);
  const cenIdx = db.mtrFareStations.indexOf('CEN');
  const tucIdx = db.mtrFareStations.indexOf('TUC');
  assert.ok(cenIdx >= 0 && tucIdx >= 0);
  assert.ok(arr[cenIdx * N + tucIdx] > 100, 'Expected CEN->TUC fare > $10.0');
});

test('planner.js: pruneDominatedPlannerCards drops redundant slower transfers (TCL->TWL/ISL) while keeping genuine trade-offs (MTR vs Star Ferry)', () => {
  const { pruneDominatedPlannerCards } = loadHardcodeAndPlannerSandbox();

  // Scenario 1: Tung Chung -> Central
  const tcToCentral = [
    {
      type: 'DIRECT',
      key: 'DIRECT_TCL',
      score: 34,
      item: {
        group: { company: 'MTR', routeNo: 'TCL', mode: 'MTR' },
        totalMins: 34,
        fareHkd: 19.4,
        accessWalkDistM: 120,
        egressWalkDistM: 180,
      },
    },
    {
      type: 'XFER',
      key: 'XFER_TCL_TWL',
      score: 48,
      item: {
        leg1Group: { company: 'MTR', routeNo: 'TCL', mode: 'MTR' },
        leg2Group: { company: 'MTR', routeNo: 'TWL', mode: 'MTR' },
        xferStopNodes: [{ walkDistM: 100 }],
        totalMins: 46,
        fareHkd: 19.4,
        accessWalkDistM: 120,
        egressWalkDistM: 140,
      },
    },
    {
      type: 'XFER',
      key: 'XFER_TCL_ISL',
      score: 52,
      item: {
        leg1Group: { company: 'MTR', routeNo: 'TCL', mode: 'MTR' },
        leg2Group: { company: 'MTR', routeNo: 'ISL', mode: 'MTR' },
        xferStopNodes: [{ walkDistM: 180 }],
        totalMins: 50,
        fareHkd: 19.4,
        accessWalkDistM: 120,
        egressWalkDistM: 120,
      },
    },
    {
      type: 'DIRECT',
      key: 'DIRECT_BUS_SLOW',
      score: 68,
      item: {
        group: { company: 'CTB', routeNo: 'E11', mode: 'BUS' },
        totalMins: 66,
        fareHkd: 21.0,
        accessWalkDistM: 200,
        egressWalkDistM: 250,
      },
    },
  ];

  const prunedTc = pruneDominatedPlannerCards(tcToCentral, 'BULLETPROOF');
  assert.deepEqual(
    Array.from(prunedTc, (c: any) => c.key),
    ['DIRECT_TCL'],
    'Slower redundant TCL->TWL, TCL->ISL, and slower pricier bus must be pruned'
  );

  // Scenario 2: Central -> Tsim Sha Tsui (MTR fastest vs Star Ferry cheaper)
  const cenToTst = [
    {
      type: 'DIRECT',
      key: 'DIRECT_TWL',
      score: 10,
      item: {
        group: { company: 'MTR', routeNo: 'TWL', mode: 'MTR' },
        totalMins: 8,
        fareHkd: 10.5,
        accessWalkDistM: 150,
        egressWalkDistM: 180,
      },
    },
    {
      type: 'DIRECT',
      key: 'DIRECT_STAR_FERRY',
      score: 14,
      item: {
        group: { company: 'SF', routeNo: 'CEN-TST', mode: 'FERRY' },
        totalMins: 13,
        fareHkd: 5.0,
        accessWalkDistM: 250,
        egressWalkDistM: 200,
      },
    },
    {
      type: 'XFER',
      key: 'XFER_SLOW_JUNK',
      score: 42,
      item: {
        leg1Group: { company: 'MTR', routeNo: 'ISL', mode: 'MTR' },
        leg2Group: { company: 'MTR', routeNo: 'TWL', mode: 'MTR' },
        xferStopNodes: [{ walkDistM: 80 }],
        totalMins: 26,
        fareHkd: 10.5,
        accessWalkDistM: 150,
        egressWalkDistM: 180,
      },
    },
  ];

  const prunedTst = pruneDominatedPlannerCards(cenToTst, 'BULLETPROOF');
  assert.deepEqual(
    Array.from(prunedTst, (c: any) => c.key),
    ['DIRECT_TWL', 'DIRECT_STAR_FERRY'],
    'Genuine trade-off (Star Ferry saves $5.50) must be preserved while slow junk is pruned'
  );
});

test('planner.js: resolveLiveOrStaticLegWindow uses live API ETAs on downstream Leg 2 within 35m horizon and falls back cleanly', async () => {
  const now = Date.now();
  const transferArrivalMs = now + 12 * 60000;
  const liveBusDepMs = now + 15 * 60000;

  const sbLive = loadHardcodeAndPlannerSandbox({
    fetchEtaRaw: async () => [
      { targetMs: now + 5 * 60000, isSched: false },
      { targetMs: liveBusDepMs, isSched: false },
    ],
  });

  const group = { key: 'KMB_268C_O', mode: 'BUS', company: 'KMB', routeNo: '268C', headwayMins: 15, maxFare: 19.3 };
  const leg2Live = await sbLive.resolveLiveOrStaticLegWindow(group, 'STOP_XFER', transferArrivalMs, 900, null, false);
  assert.equal(leg2Live.signalType, 'LIVE');
  assert.equal(leg2Live.depMs, liveBusDepMs);
  assert.equal(leg2Live.isDeadGhost, false);

  // If Leg 2 is beyond the live bus API 3-bus window, fall back cleanly to static headway (NOT dead ghost)
  const sbFallback = loadHardcodeAndPlannerSandbox({
    fetchEtaRaw: async () => [{ targetMs: now + 4 * 60000, isSched: false }],
    SignalHealthMonitor: { byOperator: { KMB: { okMs: Date.now() } } },
  });
  const leg2Fallback = await sbFallback.resolveLiveOrStaticLegWindow(group, 'STOP_XFER', now + 22 * 60000, 900, null, false);
  assert.equal(leg2Fallback.isDeadGhost, false);
  assert.equal(leg2Fallback.signalType, 'HEADWAY_PROJ');
});

test('GitHub Actions workflows (.github/workflows/actions.yml, version.yml), .npmrc, package.json, and worker.js pass deployment hygiene checks', () => {
  const yml = fs.readFileSync('.github/workflows/actions.yml', 'utf8');
  const lines = yml.split('\n');
  assert.ok(yml.includes('name: Weekly Bus, MTR & Ferry Index Update'));
  assert.ok(yml.includes('update-index:'));
  assert.ok(yml.includes('public/bus_index.min.json'), 'actions.yml must read/write public/bus_index.min.json');
  assert.ok(yml.includes('public/version.json'), 'actions.yml must update public/version.json');
  assert.equal(yml.includes('\t'), false, 'actions.yml must not contain tab characters');
  for (const ignoredPath of [
    "'public/bus_index.min.json'",
    "'public/version.json'",
    "'public/planner.js'",
    "'public/hardcode.js'",
    "'public/map.js'",
    "'public/icon.png'",
    "'public/_headers'",
    "'.github/workflows/version.yml'",
  ]) {
    assert.ok(yml.includes(`      - ${ignoredPath}`), `actions.yml paths-ignore must include ${ignoredPath}`);
  }

  // Verify embedded Node script inside run: | has valid >=10-space indentation and valid JS syntax
  const startIdx = lines.findIndex(l => l.includes("node << 'EOF'"));
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === 'EOF');
  assert.ok(startIdx > 0 && endIdx > startIdx, 'actions.yml must contain node << EOF block');
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (lines[i].length > 0) {
      assert.ok(lines[i].startsWith('          '), `Line ${i + 1} in actions.yml run:| block must have >=10 leading spaces`);
    }
  }
  const jsCode = lines.slice(startIdx + 1, endIdx).map(l => l.slice(10)).join('\n');
  assert.doesNotThrow(() => new Function(jsCode), 'Embedded JS in actions.yml must parse cleanly');
  assert.equal(/\bhaversineKm\b/.test(jsCode), false, 'actions.yml must not reference undefined haversineKm');
  assert.ok(jsCode.includes('function loadHardcodeModule()'), 'actions.yml must define fault-tolerant loadHardcodeModule');
  assert.ok(jsCode.includes('const exitDistKm ='), 'actions.yml must define self-contained exitDistKm helper');
  assert.ok(jsCode.includes("const INDEX_PATH = 'public/bus_index.min.json'"), 'actions.yml must target public/bus_index.min.json');
  assert.ok(jsCode.includes("const PUBLIC_VERSION_PATH = 'public/version.json'"), 'actions.yml must update public/version.json');
  assert.ok(jsCode.includes("const REMOVED_COMPANIES = new Set(['DB', 'PITCL'])"), 'actions.yml must keep private residential bus operators excluded');
  assert.ok(jsCode.includes('mergedMtrExits.length < 50 || stopsDict.length < 1000'), 'actions.yml must enforce mtrExits/stopsDict sanity gate');
  assert.ok(jsCode.includes('serializedByteLen < 100000') && jsCode.includes('writtenSize < 100000'), 'actions.yml must enforce non-empty file size checks');
  assert.ok(
    jsCode.includes("'public/planner.js'") && jsCode.includes("'public/hardcode.js'") && jsCode.includes("'public/map.js'"),
    'actions.yml pre-write sanity checks must verify public/planner.js, public/hardcode.js, and public/map.js'
  );
  assert.ok(yml.includes('git add public/bus_index.min.json public/version.json'), 'actions.yml must stage public/bus_index.min.json and public/version.json');

  // Execute loadHardcodeModule + exitDistKm + mergedMtrExits + pre-write runtime asset checks against public/
  const loaderStart = jsCode.indexOf('function loadHardcodeModule()');
  const loaderEnd = jsCode.indexOf('// Load single-source-of-truth');
  const exitStart = jsCode.indexOf('// Self-contained haversine distance (km) for MTR exit deduplication');
  const exitEnd = jsCode.indexOf('const outDb = {');
  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, 'Must extract loadHardcodeModule from actions.yml');
  assert.ok(exitStart >= 0 && exitEnd > exitStart, 'Must extract exitDistKm + mergedMtrExits block from actions.yml');
  const execHarness = `
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const { createRequire } = require('module');
    const INDEX_PATH = 'public/bus_index.min.json';
    const isValidHkCoord = (lat, lon) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && Number(lat) >= 22.1 && Number(lat) <= 22.6 && Number(lon) >= 113.8 && Number(lon) <= 114.5;
    ${jsCode.slice(loaderStart, loaderEnd)}
    const hardcodeMod = loadHardcodeModule();
    const MTR_EXITS_SEED = Array.isArray(hardcodeMod.MTR_EXITS_SEED) ? hardcodeMod.MTR_EXITS_SEED : [];
    const mtrExits = [{ ref: 'B2', sta: 'LOP', lat: 22.44836, lon: 114.02376, name_en: 'Exit B2 (Overpass)' }];
    const existingDb = { mtrExits: [] };
    const stopsDict = new Array(1200);
    ${jsCode.slice(exitStart, exitEnd)}
    return { hardcodeKeys: Object.keys(hardcodeMod).length, seedLen: MTR_EXITS_SEED.length, mergedMtrExits };
  `;
  const cjsRequire = createRequire(import.meta.url);
  const runRes = new Function('require', 'process', 'console', execHarness)(cjsRequire, process, console);
  assert.ok(runRes.hardcodeKeys > 10, 'loadHardcodeModule must load hardcode.js exports');
  assert.ok(runRes.seedLen >= 90, `Expected >=90 MTR_EXITS_SEED entries (got ${runRes.seedLen})`);
  assert.ok(runRes.mergedMtrExits.length >= 90, `Expected >=90 mergedMtrExits (got ${runRes.mergedMtrExits.length})`);
  const lopB2 = runRes.mergedMtrExits.filter((e: any) => e.sta === 'LOP' && e.ref === 'B2');
  assert.equal(lopB2.length, 1, 'exitDistKm must deduplicate nearby Overpass + seed exits for LOP Exit B2');

  // Verify standalone .github/workflows/version.yml auto-stamper workflow syncs both public/version.json and version.json
  const verYml = fs.readFileSync('.github/workflows/version.yml', 'utf8');
  assert.equal(verYml.includes('\t'), false, 'version.yml must not contain tab characters');
  assert.ok(verYml.includes('contents: write'), 'version.yml must request contents: write permission');
  assert.ok(verYml.includes("github.actor != 'github-actions[bot]'"), 'version.yml must guard against bot loops');
  assert.ok(verYml.includes('index.html') && verYml.includes('public/version.json') && verYml.includes('version.json'), 'version.yml must stamp index.html, public/version.json, and root version.json');
  assert.ok(verYml.includes("- 'public/version.json'"), 'version.yml paths-ignore must ignore public/version.json');
  assert.equal(verYml.includes('[skip ci]'), false, 'version.yml must not use [skip ci] so Cloudflare Pages deploys the stamped footer');
  const verNodeMatch = verYml.match(/node -e '([\s\S]*?)'/);
  assert.ok(verNodeMatch && verNodeMatch[1], 'version.yml must contain embedded node -e script');
  assert.doesNotThrow(() => new Function(verNodeMatch[1]), 'Embedded JS in version.yml must parse cleanly');

  // Verify .npmrc and package.json test script for clean CI/local builds
  const npmrc = fs.readFileSync('.npmrc', 'utf8');
  assert.ok(/^legacy-peer-deps=true$/m.test(npmrc), '.npmrc must set legacy-peer-deps=true');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(typeof pkg.scripts?.test === 'string' && pkg.scripts.test.includes('transit.test.ts'), 'package.json must define a test script running transit.test.ts');

  // Cloudflare Pages Functions must only export standard HTTP handlers (onRequest*)
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  const exportLines = workerSrc.split('\n').filter(l => /^export\s+/.test(l));
  assert.deepEqual(exportLines, ['export async function onRequest(context) {'], 'worker.js must only export onRequest for Cloudflare Pages Functions');
});

test('planner.js: Lo Uk Tsuen -> Cyberport preserves direct CTB 30X over GMB 8X + walk, ranks 30X #1, and keeps explicit final walk on 8X', () => {
  const { runRaptorCorridorPass, renderWalkTimelineRowHtml } = loadHardcodeAndPlannerSandbox({
    escapeHtml: (s: string) => String(s ?? ''),
    t: (k: string) => (k === 'minsUnit' ? 'm' : k),
  });

  // Exact real-world geometry:
  // 0: Lo Uk Tsuen (22.2389, 113.9636)
  // 1: Tung Chung Station (22.2896, 113.9416)
  // 2: Hong Kong Station (22.2849, 114.1581)
  // 3: Central Exchange Square (22.2836, 114.1580)
  // 4: Lower Baguio Villa (22.2637, 114.1292) — ~404m from Cyberport Bus Terminus
  // 5: Cyberport Bus Terminus (22.2603, 114.1306) — exact destination
  const stops = [
    { stopKey: 'NLB_LOUK', stopName_e: 'Lo Uk Tsuen', lat: 22.2389, lon: 113.9636, mode: 'BUS', routeDensity: 2 },
    { stopKey: 'MTR_TUC', stopName_e: 'Tung Chung Station', lat: 22.2896, lon: 113.9416, mode: 'MTR', mtrCode: 'TUC', routeDensity: 5 },
    { stopKey: 'MTR_HOK', stopName_e: 'Hong Kong Station', lat: 22.2849, lon: 114.1581, mode: 'MTR', mtrCode: 'HOK', routeDensity: 6 },
    { stopKey: 'CTB_EXSQ', stopName_e: 'Central (Exchange Square)', lat: 22.2836, lon: 114.1580, mode: 'BUS', routeDensity: 6 },
    { stopKey: 'GMB_LBV', stopName_e: 'Lower Baguio Villa', lat: 22.2637, lon: 114.1292, mode: 'BUS', routeDensity: 2 },
    { stopKey: 'CTB_CYB', stopName_e: 'Cyberport Bus Terminus', lat: 22.2603, lon: 114.1306, mode: 'BUS', routeDensity: 4 },
  ];

  const mkStop = (idx: number, fare = '6.9') => ({
    stopKey: stops[idx].stopKey,
    stopName_e: stops[idx].stopName_e,
    name_tc: stops[idx].stopName_e,
    lat: stops[idx].lat,
    lon: stops[idx].lon,
    latitude: String(stops[idx].lat),
    longitude: String(stops[idx].lon),
    fare,
    mtrCode: (stops[idx] as any).mtrCode || '',
  });

  const g3M = { key: 'NLB_3M_I', mode: 'BUS', company: 'NLB', routeNo: '3M', headwayMins: 15, maxFare: 10.2, activeWindows: [[0, 1439]] };
  const gTCL = { key: 'MTR_TCL_I', mode: 'MTR', company: 'MTR', routeNo: 'TCL', headwayMins: 5, maxFare: 23.6, activeWindows: [[0, 1439]] };
  // Give GMB 8X a much shorter headway (4m vs 16m) so its raw ride + walk arrival could beat 30X in tau[3][Cyberport]
  const g8X = { key: 'GMB_8X_O', mode: 'BUS', company: 'GMB', routeNo: '8X', headwayMins: 4, maxFare: 11.3, activeWindows: [[0, 1439]] };
  const g30X = { key: 'CTB_30X_O', mode: 'BUS', company: 'CTB', routeNo: '30X', headwayMins: 16, maxFare: 6.9, activeWindows: [[0, 1439]] };

  const routes = [
    { group: g3M, stIndices: [0, 1], stObjs: [mkStop(0, '10.2'), mkStop(1, '0')], cumSecs: [0, 2040] },
    { group: gTCL, stIndices: [1, 2], stObjs: [mkStop(1, '23.6'), mkStop(2, '0')], cumSecs: [0, 1560] },
    { group: g30X, stIndices: [3, 5], stObjs: [mkStop(3, '6.9'), mkStop(5, '0')], cumSecs: [0, 1080] },
    { group: g8X, stIndices: [3, 4], stObjs: [mkStop(3, '11.3'), mkStop(4, '0')], cumSecs: [0, 900] },
  ];

  const stopRoutes = stops.map(() => [] as Array<{ rIdx: number; seq: number }>);
  routes.forEach((rt, rIdx) => {
    rt.stIndices.forEach((sIdx, seq) => stopRoutes[sIdx].push({ rIdx, seq }));
  });

  const transfers = stops.map(() => [] as Array<{ toIdx: number; walkSec: number; distM: number }>);
  // Hong Kong Station <-> Central Exchange Square transfer (150m, 120s)
  transfers[2].push({ toIdx: 3, walkSec: 120, distM: 150 });
  // Lower Baguio Villa -> Cyberport Bus Terminus walk edge (476m, 381s) — this previously overwrote 30X in RAPTOR!
  transfers[4].push({ toIdx: 5, walkSec: 381, distM: 476 });

  const G = { stops, routes, stopRoutes, transfers };
  const originAccess = new Map([[0, { sec: 0, distM: 0, byBike: false, exitObj: null }]]);
  const destEgress = new Map([
    [5, { sec: 0, distM: 0, byBike: false, exitObj: null }],
    [4, { sec: 381, distM: 476, byBike: false, exitObj: null }],
  ]);

  const corridors = runRaptorCorridorPass(
    G,
    originAccess,
    destEgress,
    new Date('2026-11-22T15:45:00+08:00'),
    false,
    true,
    false,
    { name_en: 'Lo Uk Tsuen', lat: 22.2389, lon: 113.9636 },
    { name_en: 'Cyberport Bus Terminus', lat: 22.2603, lon: 114.1306 },
    { maxRounds: 4 }
  );

  const cor30X = corridors.find((c: any) => c.chainKey === 'NLB_3M>MTR_TCL>CTB_30X');
  const cor8X = corridors.find((c: any) => c.chainKey === 'NLB_3M>MTR_TCL>GMB_8X');

  assert.ok(cor30X, 'Direct-to-terminus CTB 30X must NOT be overwritten by GMB 8X + walk relaxation');
  assert.ok(cor8X, 'Nearby GMB 8X corridor should still be discovered with explicit egress walk');
  assert.equal(corridors[0].chainKey, 'NLB_3M>MTR_TCL>CTB_30X', 'Zero-final-walk CTB 30X must rank #1 ahead of GMB 8X (476m walk)');
  assert.equal(cor30X.egressWalkDistM, 0, 'CTB 30X terminates at Cyberport Bus Terminus (0m walk)');
  assert.ok(cor8X.egressWalkDistM >= 400, `GMB 8X must carry true >=400m final walk (got ${cor8X.egressWalkDistM}m)`);
  assert.ok(cor8X.egressWalkSec >= 300, `GMB 8X must carry true >=300s final walk (got ${cor8X.egressWalkSec}s)`);

  const walkHtml = renderWalkTimelineRowHtml(
    cor8X.egressWalkDistM,
    cor8X.egressWalkSec,
    false,
    'Cyberport Bus Terminus',
    22.2637,
    114.1292,
    22.2603,
    114.1306
  );
  assert.ok(walkHtml.includes('Walk') && walkHtml.includes('Cyberport Bus Terminus'), 'Final walk timeline row must render for GMB 8X');
});

test('icon.png asset, index.html image/png MIME type, auto-stampable HKT footer timestamp, and clean file headers without legacy Patch lines', () => {
  const pngBytes = fs.readFileSync('public/icon.png');
  assert.deepEqual(Array.from(pngBytes.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'public/icon.png must be a valid PNG');

  const html = fs.readFileSync('index.html', 'utf8');
  assert.equal(html.includes('image/pngl'), false, 'Must not contain image/pngl MIME typo');
  assert.equal(html.includes('icon.svg'), false, 'index.html should reference icon.png instead of icon.svg');
  assert.ok(html.includes('href="icon.png"'), 'index.html must link icon.png');
  assert.ok(html.includes('type="image/png"'), 'index.html must set type="image/png"');

  // Visible bottom UI build timestamp in index.html matches YYYY-MM-DD HH:MM HKT (auto-stamped by version.yml on push to main)
  const hktRe = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} HKT/;
  const fixedTsMatch = html.match(/window\.__FIXED_JS_BUILD_TS__\s*=\s*'([^']+)'/);
  const appVerMatch = html.match(/const APP_VERSION\s*=\s*'([^']+)'/);
  assert.ok(fixedTsMatch && hktRe.test(fixedTsMatch[1]), 'window.__FIXED_JS_BUILD_TS__ must contain a valid HKT timestamp');
  assert.ok(appVerMatch && hktRe.test(appVerMatch[1]), 'APP_VERSION must contain a valid HKT timestamp');
  assert.equal(fixedTsMatch[1], appVerMatch[1], 'APP_VERSION and window.__FIXED_JS_BUILD_TS__ must stay in sync');

  // Legacy // Patch: YYYY-MM-DD HH:MM HKT comments removed from core JS files while retaining clean // File: headers
  for (const f of ['public/planner.js', 'public/map.js', 'public/hardcode.js', 'functions/api/worker.js']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(src.includes('// File:'), `${f} should retain its clean // File: header`);
    assert.equal(/\/\/\s*Patch:/i.test(src), false, `${f} must not contain legacy // Patch: timestamp comments`);
  }
});

test('planner.js: autocomplete pins Bus & Minibus Stops above async ALS landmarks, deduplicates opposite-side stops within 120m, and sorts by distance with compact labels', () => {
  const {
    ctx,
    getPlannerAutocompleteSectionOrder,
    deduplicatePlannerAutocompleteStops,
    formatCompactDistanceLabel,
    getPlannerAutocompleteRefPoint,
  } = loadHardcodeAndPlannerSandbox({
    getStopDistrictTag: (s: any) => {
      const la = Number(s?.latitude ?? s?.lat);
      const lo = Number(s?.longitude ?? s?.lon);
      if (lo < 114.05 && la < 22.30) return 'South Lantau';
      if (la > 22.40) return 'Yuen Long';
      return 'Kowloon';
    },
  });

  // 1. Fixed section order guarantees async ALS never jumps above Hubs or Bus Stops
  assert.deepEqual(
    Array.from(getPlannerAutocompleteSectionOrder()),
    ['HUBS', 'STOPS', 'ALS']
  );

  // 2. Compact distance label formatting
  assert.equal(formatCompactDistanceLabel(0.324), '320m');
  assert.equal(formatCompactDistanceLabel(0.082), '80m');
  assert.equal(formatCompactDistanceLabel(2.43), '2.4 km');
  assert.equal(formatCompactDistanceLabel(18.6), '19 km');

  // 3. Ref point prefers live GPS and falls back to Planner map center
  ctx.lastKnownPos = null;
  ctx.window.xferMapInstance = { getCenter: () => ({ lat: 22.282, lng: 114.158 }) };
  const mapRef = getPlannerAutocompleteRefPoint();
  assert.equal(mapRef.source, 'map');
  assert.equal(mapRef.lat, 22.282);

  ctx.lastKnownPos = { lat: 22.240, lon: 113.964 };
  const gpsRef = getPlannerAutocompleteRefPoint();
  assert.equal(gpsRef.source, 'gps');
  assert.equal(gpsRef.lat, 22.240);

  // 4. Opposite-side Lo Uk Tsuen stops within ~60m merge into ONE entry with combined sorted route numbers,
  // while distant Lo Uk Tsuen stops in Yuen Long / Kowloon stay distinct and sorted by distance from GPS (South Lantau first!)
  const rawStops = [
    { stopKey: 'YL_1', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.4450, longitude: 114.0220, routeNos: new Set(['K68']) },
    { stopKey: 'YL_2', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.4454, longitude: 114.0223, routeNos: new Set(['64K', 'K68']) },
    { stopKey: 'SL_OUT', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.2389, longitude: 113.9636, routeNos: new Set(['3M', '1', 'A35']) },
    { stopKey: 'SL_IN', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.2392, longitude: 113.9639, routeNos: new Set(['2', '3M', '4']) },
    { stopKey: 'KLN_1', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.3320, longitude: 114.1910, routeNos: new Set(['29M']) },
  ];

  const deduped = deduplicatePlannerAutocompleteStops(rawStops, 22.240, 113.964, 'lo uk', 0.12);
  assert.equal(deduped.length, 3, 'Expected 5 opposite-side stops to deduplicate into 3 distinct district clusters');
  assert.equal(deduped[0]._distTag, 'South Lantau', 'Closest South Lantau cluster must rank first');
  assert.deepEqual(
    Array.from(deduped[0].mergedRouteNos),
    ['1', '2', '3M', '4', 'A35'],
    'Merged opposite-side cluster must combine and naturally sort all route numbers'
  );
  const ylCluster = deduped.find((s: any) => s._distTag === 'Yuen Long');
  assert.ok(ylCluster);
  assert.deepEqual(Array.from(ylCluster.mergedRouteNos), ['64K', 'K68']);
});

test('map.js & planner.js: Planner map disables tap-to-pin popup (preserved in Map Browser) and clears stale route layers while editing or clearing inputs', () => {
  const mapSrc = fs.readFileSync('public/map.js', 'utf8');
  assert.equal(
    mapSrc.includes("window.xferMapInstance.on('click', handleXferMapSpotClick)"),
    false,
    'Planner map must NOT bind click tap-to-pin listener'
  );
  assert.equal(
    mapSrc.includes("window.xferMapInstance.on('contextmenu', handleXferMapSpotClick)"),
    false,
    'Planner map must NOT bind contextmenu tap-to-pin listener'
  );
  assert.ok(
    mapSrc.includes("window.browseMapInstance.on('contextmenu'"),
    'Map Stop Browser outside Planner mode must keep tap-to-pin listener intact'
  );

  // Verify handleXferMapSpotClick is a no-op when currentView === 'xfer'
  const removedLayers: any[] = [];
  let popupClosed = false;
  let markerCreated = false;
  const mapWin: Record<string, any> = {
    attachStandardMapLayers: () => {},
    MULTI_MODAL_HUBS_DIRECTORY: [],
  };
  const mapCtx: Record<string, any> = {
    window: mapWin,
    document: { readyState: 'complete', getElementById: () => null, addEventListener: () => {} },
    currentView: 'xfer',
    currentLang: 'en',
    triggerHaptic: () => {},
    isValidRailOrFerryCoord: () => true,
    calculateDistanceKm: () => 0.5,
    getStopDistrictTag: () => 'Central',
    L: {
      circleMarker: () => {
        markerCreated = true;
        return { addTo: () => ({ bindPopup: () => ({ openPopup: () => {} }) }) };
      },
    },
  };
  vm.createContext(mapCtx);
  vm.runInContext(mapSrc, mapCtx);

  mapWin.xferMapInstance = {
    removeLayer: (l: any) => removedLayers.push(l),
    closePopup: () => { popupClosed = true; },
  };
  mapWin.handleXferMapSpotClick({ latlng: { lat: 22.282, lng: 114.158 } });
  assert.equal(markerCreated, false, 'handleXferMapSpotClick must NOT drop pins or popups in Planner mode');

  // Verify clearTransferPlannerMapLayers removes stale layers cleanly
  vm.runInContext(`xferMapLayers = ['poly1', 'pin1']; xferMapClickedSpotMarker = 'spot1';`, mapCtx);
  mapWin.clearTransferPlannerMapLayers();
  assert.deepEqual(removedLayers, ['poly1', 'pin1', 'spot1']);
  assert.equal(popupClosed, true);

  // Verify editing or clearing an input in planner.js clears stale map layers immediately
  let clearCalls = 0;
  const fakeFromInp = { value: 'lo uk' };
  const fakeDd = { innerHTML: '', style: { display: 'none' } };
  const sb = loadHardcodeAndPlannerSandbox({
    document: {
      activeElement: fakeFromInp,
      getElementById: (id: string) => {
        if (id === 'plannerFromInput') return fakeFromInp;
        if (id === 'plannerInlineDropdown') return fakeDd;
        return null;
      },
      addEventListener: () => {},
    },
    SavedHubsManager: { getHubs: () => ({}) },
    stripPlatformCodeFromDisplay: (s: string) => s,
    getStopDistrictTag: () => '',
    escapeHtml: (s: string) => String(s ?? ''),
    escapeJsAttr: (s: string) => String(s ?? ''),
    buildNearbyStopsFast: () => {},
    nearbyStopsList: [],
    triggerHaptic: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    renderTransferPlannerView: () => {},
  });
  sb.ctx.window.clearTransferPlannerMapLayers = () => { clearCalls++; };
  sb.ctx.userCommuteProfile.home = { stopKey: 'S1', stopName_e: 'Ngan King Centre', name_tc: '銀景中心', lat: 22.265, lon: 114.000 };
  sb.ctx.userCommuteProfile.work = { stopKey: 'S2', stopName_e: 'Tai O', name_tc: '大澳', lat: 22.254, lon: 113.862 };

  sb.onPlannerInlineInput('home');
  assert.equal(clearCalls, 1, 'Editing Origin input must immediately clear stale route/pins from the map');

  sb.clearCommuteSlot('work');
  assert.equal(clearCalls, 2, 'Clearing Destination input must immediately clear stale route/pins from the map');
});

test('planner.js & bus_index.min.json: MTR Exit-Level Walking Snap selects nearest physical station exit and displays Exit letter in timeline', () => {
  const db = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));
  assert.ok(Array.isArray(db.mtrExits) && db.mtrExits.length >= 20, 'bus_index.min.json must include mtrExits');

  const {
    ctx,
    findNearestMtrExitForPoint,
    resolveMtrTransferExit,
    renderWalkTimelineRowHtml,
  } = loadHardcodeAndPlannerSandbox({
    escapeHtml: (s: string) => String(s ?? ''),
    t: (k: string) => (k === 'minsUnit' ? 'm' : k),
  });
  ctx.window.MTR_EXITS_DIRECTORY = db.mtrExits;

  // Point near Exchange Square (22.2836, 114.1580) relative to Hong Kong Station (22.284667, 114.158224)
  // Must snap to a real Exchange Square exit (Exit B2 from MTR_EXITS_SEED or Exit D from Overpass) rather than station centroid
  const nearEx = findNearestMtrExitForPoint(22.2836, 114.1580, 22.284667, 114.158224);
  assert.ok(nearEx, 'Expected physical MTR exit near Hong Kong Station');
  assert.ok(['B2', 'D'].includes(nearEx.ref), `Expected Hong Kong Station Exchange Square exit B2 or D, got ${nearEx.ref}`);

  // Transfer from TCL (Hong Kong Station) to CTB 30X (Exchange Square) snaps to nearest physical exit
  const xferSnap = resolveMtrTransferExit(
    { mode: 'MTR', company: 'MTR', routeNo: 'TCL' },
    { lat: 22.284667, lon: 114.158224, stopName_e: 'Hong Kong Station' },
    { mode: 'BUS', company: 'CTB', routeNo: '30X' },
    { lat: 22.2836, lon: 114.1580, stopName_e: 'Central (Exchange Square)' }
  );
  assert.ok(xferSnap, 'Expected BUS<->MTR transfer to snap to nearest MTR exit');
  assert.ok(['B2', 'D'].includes(xferSnap.exitObj.ref), `Expected transfer exit B2 or D, got ${xferSnap.exitObj.ref}`);
  assert.equal(xferSnap.side, 'alight');

  // Timeline row surfaces exit letter for both access ("(Exit A)") and egress ("via Exit D")
  const accessHtml = renderWalkTimelineRowHtml(180, 145, false, 'Central Station', 22.2835, 114.1581, 22.28305, 114.15805, { ref: 'A' }, 'to');
  assert.ok(accessHtml.includes('Central Station (Exit A)'), `Expected "(Exit A)" in access walk HTML: ${accessHtml}`);

  const egressHtml = renderWalkTimelineRowHtml(35, 30, false, 'Central (Exchange Square)', 22.28375, 114.15780, 22.2836, 114.1580, { ref: 'D' }, 'from');
  assert.ok(egressHtml.includes('via Exit D'), `Expected "via Exit D" in egress walk HTML: ${egressHtml}`);
});

test('planner.js: HKO Severe Weather (TC8+/WRAINB) and strategic corridor INCIDENT banner activates accurately and supports dismissal', () => {
  const bannerEl = { style: { display: 'none' }, className: '', innerHTML: '' };
  const {
    ctx,
    evaluatePlannerAlertBannerState,
    syncPlannerAlertBannerUI,
    dismissPlannerAlertBanner,
  } = loadHardcodeAndPlannerSandbox({
    document: {
      getElementById: (id: string) => (id === 'plannerAlertBanner' ? bannerEl : null),
      addEventListener: () => {},
    },
    escapeHtml: (s: string) => String(s ?? ''),
  });

  const homeCentral = { lat: 22.282, lon: 114.158, stopName_e: 'Central' };
  const workTst = { lat: 22.298, lon: 114.172, stopName_e: 'Tsim Sha Tsui' };

  // 1. Clear weather + smooth corridors -> inactive
  const clearState = evaluatePlannerAlertBannerState(
    { typhoon: false, heavyRain: false, rainAdvisory: false, warningCodes: [] },
    { HARBOUR_TUNS: { status: 'SMOOTH', speedKmh: 70 } },
    homeCentral,
    workTst
  );
  assert.equal(clearState.active, false);

  // 2. Unrelated corridor INCIDENT (e.g. Tuen Mun Rd on a Central->TST trip) -> inactive
  const unrelatedInc = evaluatePlannerAlertBannerState(
    { typhoon: false, heavyRain: false, warningCodes: [] },
    { TUEN_MUN_RD: { status: 'INCIDENT', speedKmh: 32, headline: 'Traffic accident on Tuen Mun Road' } },
    homeCentral,
    workTst
  );
  assert.equal(unrelatedInc.active, false);

  // 3. Relevant corridor INCIDENT (HARBOUR_TUNS on Central->TST) -> active incident banner
  const harbourInc = evaluatePlannerAlertBannerState(
    { typhoon: false, heavyRain: false, warningCodes: [] },
    { HARBOUR_TUNS: { status: 'INCIDENT', speedKmh: 32, headline: 'Cross-Harbour Tunnel lane closed due to accident' } },
    homeCentral,
    workTst
  );
  assert.equal(harbourInc.active, true);
  assert.equal(harbourInc.severity, 'incident');
  assert.ok(harbourInc.title.includes('Harbour Tuns'));
  assert.ok(harbourInc.detail.includes('Cross-Harbour Tunnel'));

  // 4. HKO TC8NE & WRAINB severe warnings -> active severe banner + dismissal works
  ctx.userCommuteProfile.home = homeCentral;
  ctx.userCommuteProfile.work = workTst;
  ctx.window.__HKO_WEATHER__ = { typhoon: true, heavyRain: true, labelEn: 'Typhoon TC8NE', labelTc: '八號或以上風球', warningCodes: ['TC8NE'] };
  ctx.window.__LIVE_CORRIDORS__ = { HARBOUR_TUNS: { status: 'SMOOTH', speedKmh: 70 } };

  syncPlannerAlertBannerUI(null);
  assert.equal(bannerEl.style.display, 'flex');
  assert.ok(bannerEl.innerHTML.includes('Typhoon TC8NE'));
  assert.ok(bannerEl.innerHTML.includes('dismissPlannerAlertBanner'));

  dismissPlannerAlertBanner();
  assert.equal(bannerEl.style.display, 'none');

  // Re-syncing same alert key stays dismissed; a new distinct alert (WRAINB) re-opens banner
  syncPlannerAlertBannerUI(null);
  assert.equal(bannerEl.style.display, 'none');

  ctx.window.__HKO_WEATHER__ = { typhoon: false, heavyRain: true, labelEn: 'Black Rainstorm', labelTc: '黑色暴雨', warningCodes: ['WRAINB'] };
  syncPlannerAlertBannerUI(null);
  assert.equal(bannerEl.style.display, 'flex');
  assert.ok(bannerEl.innerHTML.includes('Black Rainstorm'));
});

test('planner.js: rejects scheduled-only ghost buses during active corridor INCIDENT while preserving live GPS routes and unaffected corridors', async () => {
  const now = Date.now();
  const boardLoUk = { stopKey: 'NLB_LOUK', stopName_e: 'Lo Uk Tsuen', lat: 22.2389, lon: 113.9636 };
  const alightTungChung = { stopKey: 'NLB_TUC', stopName_e: 'Tung Chung Station Bus Terminus', lat: 22.2896, lon: 113.9416 };
  const alightMuiWo = { stopKey: 'NLB_MW', stopName_e: 'Mui Wo Ferry Pier', lat: 22.2651, lon: 114.0022 };
  const g3M = { key: 'NLB_3M_I', mode: 'BUS', company: 'NLB', routeNo: '3M', headwayMins: 15, maxFare: 12.1 };
  const g1 = { key: 'NLB_1_I', mode: 'BUS', company: 'NLB', routeNo: '1', headwayMins: 20, maxFare: 11.8 };

  // 1. Active LANTAU_TM INCIDENT + scheduled-only ETAs on NLB 3M -> pruned as isDeadGhost / NO_SERVICE
  const sbIncidentSchedOnly = loadHardcodeAndPlannerSandbox({
    xferTimeMode: 'NOW',
    fetchEtaRaw: async () => [
      { targetMs: now + 8 * 60000, isSched: true },
      { targetMs: now + 23 * 60000, isSched: true },
    ],
  });
  sbIncidentSchedOnly.ctx.window.__LIVE_CORRIDORS__ = {
    LANTAU_TM: { status: 'INCIDENT', speedKmh: 28, headline: 'South Lantau Road traffic accident' },
  };
  const ghost3M = await sbIncidentSchedOnly.resolveLiveOrStaticLegWindow(
    g3M, 'NLB_LOUK', now + 60_000, 2040, boardLoUk, true, alightTungChung
  );
  assert.equal(ghost3M.isDeadGhost, true, 'Scheduled-only NLB 3M during LANTAU_TM INCIDENT must be pruned as isDeadGhost');
  assert.equal(ghost3M.signalType, 'NO_SERVICE');

  // 2. Active LANTAU_TM INCIDENT + live GPS vehicle on NLB 1 -> MUST NOT be pruned
  const sbIncidentLive = loadHardcodeAndPlannerSandbox({
    xferTimeMode: 'NOW',
    fetchEtaRaw: async () => [
      { targetMs: now + 6 * 60000, isSched: false },
      { targetMs: now + 26 * 60000, isSched: true },
    ],
  });
  sbIncidentLive.ctx.window.__LIVE_CORRIDORS__ = {
    LANTAU_TM: { status: 'INCIDENT', speedKmh: 28, headline: 'South Lantau Road traffic accident' },
  };
  const live1 = await sbIncidentLive.resolveLiveOrStaticLegWindow(
    g1, 'NLB_LOUK', now + 60_000, 900, boardLoUk, true, alightMuiWo
  );
  assert.equal(live1.isDeadGhost, false, 'Live GPS-tracked NLB 1 must stay active during corridor INCIDENT');
  assert.equal(live1.signalType, 'LIVE');

  // 3. Unaffected Kowloon bus (KMB 1A) with scheduled-only ETAs during LANTAU_TM INCIDENT -> MUST NOT be pruned
  const kmb1A = { key: 'KMB_1A_O', mode: 'BUS', company: 'KMB', routeNo: '1A', headwayMins: 10, maxFare: 7.5 };
  const mongKok = { stopKey: 'MK', stopName_e: 'Mong Kok', lat: 22.3193, lon: 114.1694 };
  const tst = { stopKey: 'TST', stopName_e: 'Tsim Sha Tsui', lat: 22.2977, lon: 114.1722 };
  const klnRes = await sbIncidentSchedOnly.resolveLiveOrStaticLegWindow(
    kmb1A, 'MK', now + 60_000, 600, mongKok, true, tst
  );
  assert.equal(klnRes.isDeadGhost, false, 'Unaffected Kowloon bus must not be pruned by LANTAU_TM INCIDENT');
  assert.equal(klnRes.signalType, 'SCHED');

  // 4. Cross-harbour bus during HARBOUR_TUNS INCIDENT with scheduled-only ETAs -> pruned as isDeadGhost
  const sbHarbourInc = loadHardcodeAndPlannerSandbox({
    xferTimeMode: 'NOW',
    fetchEtaRaw: async () => [{ targetMs: now + 7 * 60000, isSched: true }],
  });
  sbHarbourInc.ctx.window.__LIVE_CORRIDORS__ = {
    HARBOUR_TUNS: { status: 'INCIDENT', speedKmh: 30, headline: 'Cross-Harbour Tunnel accident' },
  };
  const ctb101 = { key: 'CTB_101_O', mode: 'BUS', company: 'CTB', routeNo: '101', headwayMins: 10, maxFare: 12.1 };
  const centralStop = { stopKey: 'CEN', stopName_e: 'Central', lat: 22.282, lon: 114.158 };
  const hungHomStop = { stopKey: 'HUH', stopName_e: 'Hung Hom', lat: 22.303, lon: 114.182 };
  const harbourGhost = await sbHarbourInc.resolveLiveOrStaticLegWindow(
    ctb101, 'CEN', now + 60_000, 1200, centralStop, true, hungHomStop
  );
  assert.equal(harbourGhost.isDeadGhost, true);
  assert.equal(harbourGhost.signalType, 'NO_SERVICE');

  // 5. Same NLB 3M when LANTAU_TM is SMOOTH -> NOT pruned
  sbIncidentSchedOnly.ctx.window.__LIVE_CORRIDORS__ = {
    LANTAU_TM: { status: 'SMOOTH', speedKmh: 70 },
  };
  const smooth3M = await sbIncidentSchedOnly.resolveLiveOrStaticLegWindow(
    g3M, 'NLB_LOUK', now + 60_000, 2040, boardLoUk, true, alightTungChung
  );
  assert.equal(smooth3M.isDeadGhost, false);
  assert.equal(smooth3M.signalType, 'SCHED');

  // 6. When xferTimeMode === 'PLAN' (future trip), do NOT prune scheduled departures even if corridor has live INCIDENT
  const sbPlanMode = loadHardcodeAndPlannerSandbox({
    fetchEtaRaw: async () => [{ targetMs: now + 8 * 60000, isSched: true }],
  });
  sbPlanMode.ctx.xferTimeMode = 'PLAN';
  sbPlanMode.ctx.window.__LIVE_CORRIDORS__ = {
    LANTAU_TM: { status: 'INCIDENT', speedKmh: 28 },
  };
  const plan3M = await sbPlanMode.resolveLiveOrStaticLegWindow(
    g3M, 'NLB_LOUK', now + 60_000, 2040, boardLoUk, true, alightTungChung
  );
  assert.equal(plan3M.isDeadGhost, false);
});

test('planner.js: merges opposite-side stops within 220m by default (Yuen Long Lo Uk Tsuen K65/K65A) while keeping stops >220m apart distinct', () => {
  const { deduplicatePlannerAutocompleteStops } = loadHardcodeAndPlannerSandbox({
    getStopDistrictTag: () => 'Yuen Long',
  });

  // Two opposite-side rural stops ~180m apart (0.00162 deg lat ≈ 180m) + one stop ~360m away
  const rawStops = [
    { stopKey: 'YL_A', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.44500, longitude: 114.02200, routeNos: new Set(['K65']) },
    { stopKey: 'YL_B', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.44662, longitude: 114.02200, routeNos: new Set(['K65', 'K65A']) },
    { stopKey: 'YL_FAR', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: 22.44990, longitude: 114.02200, routeNos: new Set(['68A']) },
  ];

  // Omit maxMergeKm to verify the default is now 0.22 (220m)
  const merged = deduplicatePlannerAutocompleteStops(rawStops, 22.440, 114.022, 'lo uk');
  assert.equal(merged.length, 2, '180m opposite-side stops must merge into one row while 360m stop remains distinct');
  assert.deepEqual(Array.from(merged[0].mergedRouteNos), ['K65', 'K65A']);
  assert.deepEqual(Array.from(merged[1].mergedRouteNos), ['68A']);
});

test('index.html: Planner autocomplete dropdown is 100% opaque in dark and light modes with isolated stacking and theme-aware banner/chip CSS', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.includes('#plannerInlineDropdown'), 'index.html must explicitly style #plannerInlineDropdown');
  assert.ok(html.includes('background-color: #1C1C1E;'), 'Dark mode dropdown must use solid opaque #1C1C1E');
  assert.ok(html.includes('background-color: #FFFFFF;'), 'Light mode dropdown must use solid opaque #FFFFFF');
  assert.ok(html.includes('isolation: isolate;'), 'Dropdown must isolate stacking context');
  assert.ok(html.includes('z-index: 3000;'), 'Dropdown must layer cleanly above route cards and map controls');
  assert.ok(html.includes('html.light-mode .planner-alert-banner'), 'Alert banner must key off .light-mode class instead of OS prefers-color-scheme');
  assert.ok(html.includes('html.light-mode .planner-walk-chip'), 'Walk chip must define explicit dark/light contrast rules');
  assert.ok(html.includes('html.light-mode .planner-ac-dist'), 'Autocomplete distance badge must define explicit dark/light contrast rules');
});

test('Logging functions (BlackboxLogger, Log modal, Log buttons) are completely removed while SignalHealthMonitor remains intact', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const planner = fs.readFileSync('public/planner.js', 'utf8');
  const removedTokens = [
    'BlackboxLogger',
    'exportAndEmailDiagnosticLog',
    'closeJsonDiagModal',
    'copyDiagJsonFromBox',
    'downloadDiagJsonFile',
    'jsonDiagModal',
    'settingRowLblExportDiag',
    'statusExportBtn',
    'settingValDiagSize',
  ];
  for (const tok of removedTokens) {
    assert.equal(html.includes(tok), false, `index.html should not contain removed logging token "${tok}"`);
    assert.equal(planner.includes(tok), false, `public/planner.js should not contain removed logging token "${tok}"`);
  }
  assert.ok(html.includes('SignalHealthMonitor'), 'SignalHealthMonitor must remain intact for live API timeout safety');
});

test('MTR_EXITS_SEED is populated in hardcode.js, merged in actions.yml, fallback-wired in index.html, and present in bus_index.min.json', () => {
  const { MTR_EXITS_SEED } = loadHardcodeAndPlannerSandbox();
  assert.ok(Array.isArray(MTR_EXITS_SEED) && MTR_EXITS_SEED.length >= 60, 'MTR_EXITS_SEED must include canonical Hong Kong MTR exits');
  assert.ok(MTR_EXITS_SEED.some((e: any) => e.sta === 'LOP' && e.ref === 'B2'), 'MTR_EXITS_SEED must include Long Ping Exit B2');
  assert.ok(MTR_EXITS_SEED.some((e: any) => e.sta === 'LOP' && e.ref === 'F'), 'MTR_EXITS_SEED must include Long Ping Exit F');
  assert.ok(MTR_EXITS_SEED.some((e: any) => e.sta === 'TUC' && e.ref === 'B'), 'MTR_EXITS_SEED must include Tung Chung Exit B');

  const yml = fs.readFileSync('.github/workflows/actions.yml', 'utf8');
  assert.ok(yml.includes('MTR_EXITS_SEED'), 'actions.yml must import MTR_EXITS_SEED from hardcode.js');
  assert.ok(yml.includes('mtrExits: mergedMtrExits'), 'actions.yml must write mergedMtrExits into outDb.mtrExits');

  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.includes('window.MTR_EXITS_SEED'), 'index.html must fall back to window.MTR_EXITS_SEED when cached db.mtrExits is empty');

  const idxDb = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));
  assert.ok(Array.isArray(idxDb.mtrExits) && idxDb.mtrExits.length >= 80, 'public/bus_index.min.json must contain merged MTR exits');
  assert.ok(
    idxDb.mtrExits.some((e: any) => e.sta === 'LOP' && e.ref === 'B2'),
    'public/bus_index.min.json must include Long Ping Exit B2 for Yuen Long Industrial Estate'
  );
});

test('planner.js: penalizes Tung Chung North loop (E36A) vs direct E36, buffers weekday peak highway buses, and boosts short GMB 74 last-mile feeder', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const {
    detectTungChungNorthLoopPenalty,
    computeBusPeakCongestionBufferMins,
    computeDisruptionAdjustedScore,
  } = sb;

  const fromLoUk = { name_en: 'Lo Uk Tsuen', lat: 22.238, lon: 113.938 };
  const toWangLee = { name_en: '48 Wang Lee St', lat: 22.456, lon: 114.027 };

  const legE36 = {
    group: { company: 'LWB', routeNo: 'E36', mode: 'BUS', headwayMins: 15, maxFare: 13.9 },
    boardStopObj: { stopName_e: 'Tung Chung Town Centre', lat: 22.289, lon: 113.941, seq: 3 },
    alightStopObj: { stopName_e: 'Yuen Long Plaza', lat: 22.445, lon: 114.024, seq: 10 },
    driveSec: 2100,
    stopsCount: 7,
  };
  const legE36A = {
    group: { company: 'LWB', routeNo: 'E36A', mode: 'BUS', headwayMins: 20, maxFare: 13.9 },
    boardStopObj: { stopName_e: 'Yu Nga Shopping Centre', lat: 22.295, lon: 113.951, seq: 6 },
    alightStopObj: { stopName_e: 'Yuen Long (West) B/T', lat: 22.446, lon: 114.025, seq: 16 },
    driveSec: 2520,
    stopsCount: 10,
  };

  assert.equal(detectTungChungNorthLoopPenalty(legE36, fromLoUk, toWangLee).isLoop, false);
  assert.equal(detectTungChungNorthLoopPenalty(legE36A, fromLoUk, toWangLee).isLoop, true);
  assert.ok(detectTungChungNorthLoopPenalty(legE36A, fromLoUk, toWangLee).penaltyMins >= 7);

  // If destination IS Tung Chung North, do NOT penalize E36A
  const toCaribbean = { name_en: 'Caribbean Coast', lat: 22.2925, lon: 113.9495 };
  assert.equal(detectTungChungNorthLoopPenalty(legE36A, fromLoUk, toCaribbean).isLoop, false);

  // Weekday AM peak (Mon 08:30) vs Sunday off-peak (Sun 14:00) highway bus reliability buffer
  const monAmPeak = new Date(2026, 10, 23, 8, 30, 0);
  const sunOffPeak = new Date(2026, 10, 22, 14, 0, 0);
  const peakBuf = computeBusPeakCongestionBufferMins(legE36, monAmPeak, false, 'BULLETPROOF');
  const offBuf = computeBusPeakCongestionBufferMins(legE36, sunOffPeak, true, 'BULLETPROOF');
  assert.ok(peakBuf >= 7.0, `Expected weekday AM peak buffer >= 7m for long E36 highway bus, got ${peakBuf}`);
  assert.equal(offBuf, 0, 'Expected 0 congestion buffer on smooth Sunday off-peak');

  // Last-mile GMB 74 from Long Ping MTR to 48 Wang Lee St (<=100m walk) beats 900m walk from Long Ping MTR
  const gTml = { company: 'MTR', routeNo: 'TML', mode: 'MTR', headwayMins: 4 };
  const g74 = { company: 'GMB_NT', routeNo: '74', mode: 'BUS', headwayMins: 10, maxFare: 6.2 };
  const lopStop = { stopName_e: 'Long Ping MTR Station', mtrCode: 'LOP', lat: 22.4478, lon: 114.0253, seq: 12 };
  const wangLeeStop = { stopName_e: 'Wang Lee Street', lat: 22.4561, lon: 114.0270, seq: 4 };

  const scoreMtrWalk900m = computeDisruptionAdjustedScore(
    66,
    [{ group: gTml, boardStopObj: { mtrCode: 'NAC', lat: 22.3267, lon: 114.1536 }, alightStopObj: lopStop, driveSec: 1500, stopsCount: 6 }],
    120,
    720,
    [],
    25.0,
    [],
    0,
    { queryDate: monAmPeak, isLantauTrip: true, fromMeta: fromLoUk, toMeta: toWangLee, egressByBike: false, egressWalkDistM: 950 }
  );
  const scoreMtrGmb74 = computeDisruptionAdjustedScore(
    63,
    [
      { group: gTml, boardStopObj: { mtrCode: 'NAC', lat: 22.3267, lon: 114.1536 }, alightStopObj: lopStop, driveSec: 1500, stopsCount: 6 },
      { group: g74, boardStopObj: lopStop, alightStopObj: wangLeeStop, driveSec: 360, stopsCount: 4 },
    ],
    120,
    60,
    ['LOP'],
    30.7,
    [lopStop],
    120,
    { queryDate: monAmPeak, isLantauTrip: true, fromMeta: fromLoUk, toMeta: toWangLee, egressByBike: false, egressWalkDistM: 80 }
  );
  assert.ok(
    scoreMtrGmb74 < scoreMtrWalk900m,
    `Expected MTR + GMB 74 (${scoreMtrGmb74}) to beat MTR + 950m walk (${scoreMtrWalk900m})`
  );
});

test('planner.js: generates 3-transfer 3M -> TCL -> TML -> GMB 74 and 3M -> TCL -> TML (+Bike) alongside E36 and preserves jam-free MTR in pruning', () => {
  const mkStop = (stopKey: string, stopName_e: string, lat: number, lon: number, extra: Record<string, any> = {}) => ({
    stopKey,
    stopId: extra.mtrCode || stopKey,
    stopName_e,
    name_tc: stopName_e,
    latitude: lat,
    longitude: lon,
    lat,
    lon,
    ...extra,
  });

  const sLoUk = mkStop('NLB_LOUK', 'Lo Uk Tsuen', 22.2380, 113.9380, { seq: 1, fare: '12.2' });
  const sTCTown = mkStop('TC_TOWN', 'Tung Chung Town Centre', 22.2890, 113.9415, { seq: 8, fare: '12.2' });
  const sTUC = mkStop('MTR_TUC', 'Tung Chung', 22.2892, 113.9416, { seq: 1, mtrCode: 'TUC' });
  const sTSY = mkStop('MTR_TSY', 'Tsing Yi', 22.3584, 114.1069, { seq: 2, mtrCode: 'TSY' });
  const sLAK = mkStop('MTR_LAK', 'Lai King', 22.3484, 114.1261, { seq: 3, mtrCode: 'LAK' });
  const sNAC = mkStop('MTR_NAC', 'Nam Cheong', 22.3267, 114.1536, { seq: 4, mtrCode: 'NAC' });
  const sMEF = mkStop('MTR_MEF', 'Mei Foo', 22.3375, 114.1380, { seq: 5, mtrCode: 'MEF' });
  const sTWW = mkStop('MTR_TWW', 'Tsuen Wan West', 22.3686, 114.1097, { seq: 6, mtrCode: 'TWW' });
  const sKSR = mkStop('MTR_KSR', 'Kam Sheung Road', 22.4347, 114.0633, { seq: 7, mtrCode: 'KSR' });
  const sYUL = mkStop('MTR_YUL', 'Yuen Long', 22.4461, 114.0352, { seq: 8, mtrCode: 'YUL' });
  const sLOP = mkStop('MTR_LOP', 'Long Ping', 22.4478, 114.0253, { seq: 9, mtrCode: 'LOP' });
  const sLopBus = mkStop('GMB_LOP', 'Long Ping Station (Exit B2)', 22.4483, 114.0238, { seq: 1, fare: '6.2' });
  const sWangLok = mkStop('GMB_WLK', 'Wang Lok Street', 22.4525, 114.0256, { seq: 2, fare: '6.2' });
  const sWangLee = mkStop('GMB_WLE', '48 Wang Lee Street', 22.4562, 114.0270, { seq: 3, fare: '6.2' });
  const sYlPlaza = mkStop('LWB_YLP', 'Yuen Long Plaza', 22.4448, 114.0242, { seq: 12, fare: '13.9' });

  const g3M = { key: 'NLB_3M_O', mode: 'BUS', company: 'NLB', routeNo: '3M', headwayMins: 15, maxFare: 12.2, _stops: [sLoUk, sTCTown] };
  const gE36 = { key: 'LWB_E36_O', mode: 'BUS', company: 'LWB', routeNo: 'E36', headwayMins: 15, maxFare: 13.9, _stops: [sTCTown, sYlPlaza] };
  const gTcl = { key: 'MTR_TCL_I', mode: 'MTR', company: 'MTR', routeNo: 'TCL', headwayMins: 5, _stops: [sTUC, sTSY, sLAK, sNAC] };
  const gTml = { key: 'MTR_TML_O', mode: 'MTR', company: 'MTR', routeNo: 'TML', headwayMins: 4, _stops: [sNAC, sMEF, sTWW, sKSR, sYUL, sLOP] };
  const g74 = { key: 'GMB_NT_74_O', mode: 'BUS', company: 'GMB_NT', routeNo: '74', headwayMins: 10, maxFare: 6.2, _stops: [sLopBus, sWangLok, sWangLee] };

  const sb = loadHardcodeAndPlannerSandbox({
    groupedRoutes: [g3M, gE36, gTcl, gTml, g74],
    initRouteMapFast: () => {},
    isParallelRailTerminusPair: () => false,
    isAirportOrPortZone: () => false,
    isLantauOrAirportZone: (la: number, lo: number) => lo < 114.04 && la < 22.34,
    computeSegmentStepSeconds: (_mode: string, _co: string, dKm: number) => Math.max(45, Math.round((dKm / 28) * 3600)),
  });
  sb.ctx.xferLocoBikeEnabled = true;
  sb.ctx.userCommuteProfile = {
    home: { stopKey: 'NLB_LOUK', stopName_e: 'Lo Uk Tsuen', lat: 22.2380, lon: 113.9380 },
    work: { stopKey: 'DEST_WL', stopName_e: '48 Wang Lee St', lat: 22.4562, lon: 114.0270 },
  };

  const monAmPeak = new Date(2026, 10, 23, 8, 25, 0);
  const spec = sb.buildFromToEdgeRequestSpec(monAmPeak);
  assert.ok(spec, 'buildFromToEdgeRequestSpec must return a valid plan spec');

  const chains = spec.transferCorridors.map((c: any) => c.chainKey);
  assert.ok(
    chains.includes('NLB_3M>MTR_TCL>MTR_TML>GMB_NT_74'),
    `Expected 3-transfer 3M -> TCL -> TML -> GMB 74 chain in transferCorridors, got: ${chains.join(', ')}`
  );
  assert.ok(
    chains.includes('NLB_3M>MTR_TCL>MTR_TML'),
    `Expected 3M -> TCL -> TML (+Bike) chain in transferCorridors, got: ${chains.join(', ')}`
  );
  assert.ok(
    chains.includes('NLB_3M>LWB_E36'),
    `Expected 3M -> E36 bus trunk in transferCorridors, got: ${chains.join(', ')}`
  );

  // Verify pruneDominatedPlannerCards preserves jam-free heavy-MTR alternative alongside bus-only E36 trunk
  const busCard = {
    type: 'XFER',
    key: 'XFER_3M_E36',
    score: 80,
    item: {
      leg1Group: g3M,
      leg2Group: gE36,
      leg3Options: [],
      totalMins: 74,
      fareHkd: 26.1,
      accessWalkDistM: 50,
      egressWalkDistM: 1200,
      xferStopNodes: [{ walkDistM: 40 }],
    },
  };
  const mtrCard = {
    type: 'XFER',
    key: 'XFER_3M_TCL_TML_74',
    score: 88,
    item: {
      leg1Group: g3M,
      leg2Group: gTcl,
      leg3Options: [{ group: gTml, routeNo: 'TML', walkDistM: 30 }, { group: g74, routeNo: '74', walkDistM: 120 }],
      totalMins: 88,
      fareHkd: 43.2,
      accessWalkDistM: 50,
      egressWalkDistM: 60,
      xferStopNodes: [{ walkDistM: 140 }],
    },
  };
  const pruned = sb.pruneDominatedPlannerCards([busCard, mtrCard], 'BULLETPROOF');
  assert.equal(pruned.length, 2, 'Mode-diversity preservation must keep jam-free MTR trunk alongside bus-only E36 trunk');
  assert.ok(pruned.some((c: any) => c.key === 'XFER_3M_TCL_TML_74'));
});

test('hardcode.js: upgraded LoadFactorEngine models weekday/Sat/Sun waves, live headway expansion vs isSched filtering, GMB capacity, and MTR directional surge', () => {
  const { LoadFactorEngine } = loadHardcodeAndPlannerSandbox();

  const monAmPeak = new Date(2026, 10, 23, 8, 25, 0);
  const satMidday = new Date(2026, 10, 21, 14, 15, 0);
  const sunMorning = new Date(2026, 10, 22, 8, 25, 0);

  const gE36 = { company: 'LWB', routeNo: 'E36', mode: 'BUS', headwayMins: 15 };
  const gGmb74 = { company: 'GMB_NT', routeNo: '74', mode: 'BUS', headwayMins: 10 };

  // 1. Weekday AM peak > Sunday morning at same clock time
  const e36MonPeak = LoadFactorEngine.inferBusLoad({
    group: gE36, stopIdx: 6, totalStops: 14, dateObj: monAmPeak, isHoliday: false,
  });
  const e36SunAm = LoadFactorEngine.inferBusLoad({
    group: gE36, stopIdx: 6, totalStops: 14, dateObj: sunMorning, isHoliday: true,
  });
  assert.ok(e36MonPeak.pct > e36SunAm.pct + 15, `Weekday AM peak (${e36MonPeak.pct}%) should significantly exceed Sunday 08:25 (${e36SunAm.pct}%)`);
  assert.equal(e36MonPeak.dayType, 'WEEKDAY');
  assert.equal(e36MonPeak.basis, 'SCHEDULE_PROFILE');
  assert.equal(e36SunAm.dayType, 'HOLIDAY');

  // 2. Live headway gap expansion (2.1x scheduled) boosts load and marks basis=LIVE_GAP, confidence=HIGH
  const e36WideGap = LoadFactorEngine.inferBusLoad({
    group: gE36, stopIdx: 6, totalStops: 14, obsHeadwaySec: 1900, schedHeadwaySec: 900, isSched: false, dateObj: satMidday, isHoliday: false,
  });
  const e36Bunched = LoadFactorEngine.inferBusLoad({
    group: gE36, stopIdx: 6, totalStops: 14, obsHeadwaySec: 450, schedHeadwaySec: 900, isSched: false, dateObj: satMidday, isHoliday: false,
  });
  assert.equal(e36WideGap.basis, 'LIVE_GAP');
  assert.equal(e36WideGap.confidence, 'HIGH');
  assert.ok(e36WideGap.pct >= e36Bunched.pct + 25, `Wide headway gap (${e36WideGap.pct}%) must exceed bunched bus (${e36Bunched.pct}%)`);

  // 3. Scheduled-only slot during INCIDENT must NOT be treated as live gap telemetry
  const e36GhostSched = LoadFactorEngine.inferBusLoad({
    group: gE36, stopIdx: 6, totalStops: 14, obsHeadwaySec: 2100, schedHeadwaySec: 900, isSched: true, corridorStatus: 'INCIDENT', dateObj: satMidday,
  });
  assert.equal(e36GhostSched.basis, 'SCHEDULE_PROFILE');
  assert.equal(e36GhostSched.confidence, 'BASELINE');

  // 4. 19-seat GMB packs faster than 130-pax double-deck bus at same period/stop ratio
  const gmbLoad = LoadFactorEngine.inferBusLoad({
    group: gGmb74, stopIdx: 4, totalStops: 8, dateObj: monAmPeak, isHoliday: false,
  });
  assert.equal(gmbLoad.capacityPax, 19);
  assert.ok(gmbLoad.pct > e36MonPeak.pct, `19-seat GMB (${gmbLoad.pct}%) should infer higher % load than double-deck bus (${e36MonPeak.pct}%)`);

  // 5. MTR directional peak bias (AM peak inbound TCL to Hong Kong > counter-peak outbound to Tung Chung) + interchange surge at NAC
  const mtrAmInbound = LoadFactorEngine.inferMtrLoad({
    lineCode: 'TCL', staCode: 'NAC', destCode: 'HOK', destName: 'Hong Kong', dateObj: monAmPeak, isHoliday: false,
  });
  const mtrAmOutbound = LoadFactorEngine.inferMtrLoad({
    lineCode: 'TCL', staCode: 'NAC', destCode: 'TUC', destName: 'Tung Chung', dateObj: monAmPeak, isHoliday: false,
  });
  assert.ok(
    mtrAmInbound.pct > mtrAmOutbound.pct + 8,
    `AM peak inbound TCL to HOK (${mtrAmInbound.pct}%) must exceed counter-peak outbound to TUC (${mtrAmOutbound.pct}%)`
  );
  assert.equal(mtrAmInbound.dayType, 'WEEKDAY');
});

test('planner.js: buildRaptorGraph connects Long Ping MTR Exit to GMB 74 up to 450m even among >45 closer bus stops, while keeping bus-to-bus <= 300m', () => {
  // Long Ping Station center (22.447626, 114.025449), Exit E/F/B2 from MTR_EXITS_SEED
  // GMB 74 On Lok Road stop at (22.44435, 114.02605): ~370m from Exit D/E, ~490m from Exit F — >300m, <=450m!
  // Also add 50 closer urban bus stops (within 180m of LOP) so naive .slice(0,45) would have dropped GMB 74!
  const crowdedBusGroups: any[] = [];
  for (let i = 0; i < 50; i++) {
    const la = 22.4476 + ((i % 10) - 5) * 0.00018;
    const lo = 114.0254 + (Math.floor(i / 10) - 2) * 0.00018;
    crowdedBusGroups.push({
      key: `KMB_B${i}_O`,
      mode: 'BUS',
      company: 'KMB',
      routeNo: `B${i}`,
      headwayMins: 12,
      maxFare: 6.0,
      _stops: [
        { stopId: `BUS_NEAR_${i}`, stopName_e: `Near Bus ${i}`, latitude: String(la), longitude: String(lo), fare: '6.0' },
        { stopId: `BUS_END_${i}`, stopName_e: `End Bus ${i}`, latitude: '22.4550', longitude: '114.0300', fare: '0' },
      ],
    });
  }

  // Two ordinary bus stops 350m apart (must NOT connect via bus-to-bus transfer edge)
  const busPairA = {
    key: 'KMB_FAR_A_O',
    mode: 'BUS',
    company: 'KMB',
    routeNo: 'FA',
    headwayMins: 10,
    maxFare: 6.0,
    _stops: [
      { stopId: 'FAR_A1', stopName_e: 'Mong Kok A', latitude: '22.3193', longitude: '114.1694', fare: '6.0' },
      { stopId: 'FAR_A2', stopName_e: 'Mong Kok A2', latitude: '22.3300', longitude: '114.1694', fare: '0' },
    ],
  };
  const busPairB = {
    key: 'KMB_FAR_B_O',
    mode: 'BUS',
    company: 'KMB',
    routeNo: 'FB',
    headwayMins: 10,
    maxFare: 6.0,
    _stops: [
      { stopId: 'FAR_B1', stopName_e: 'Mong Kok B', latitude: '22.3225', longitude: '114.1694', fare: '6.0' }, // ~356m north
      { stopId: 'FAR_B2', stopName_e: 'Mong Kok B2', latitude: '22.3400', longitude: '114.1694', fare: '0' },
    ],
  };

  const tmlGroup = {
    key: 'MTR_TML_O',
    mode: 'MTR',
    company: 'MTR',
    routeNo: 'TML',
    headwayMins: 4,
    maxFare: 20,
    _stops: [
      { stopId: 'YUL', mtrCode: 'YUL', stopName_e: 'Yuen Long Station', latitude: '22.446072', longitude: '114.035165', fare: '0' },
      { stopId: 'LOP', mtrCode: 'LOP', stopName_e: 'Long Ping Station', latitude: '22.447626', longitude: '114.025449', fare: '0' },
    ],
  };
  const gmb74Group = {
    key: 'GMB_74_O',
    mode: 'BUS',
    company: 'GMB',
    routeNo: '74',
    headwayMins: 8,
    maxFare: 6.3,
    _stops: [
      { stopId: 'GMB74_ONLOK', stopName_e: 'On Lok Road, Near Tai Kiu', latitude: '22.44435', longitude: '114.02605', fare: '6.3' },
      { stopId: 'GMB74_WANGLEE', stopName_e: '48 Wang Lee St', latitude: '22.4648', longitude: '114.0262', fare: '0' },
    ],
  };

  const sb = loadHardcodeAndPlannerSandbox({
    groupedRoutes: [tmlGroup, gmb74Group, busPairA, busPairB, ...crowdedBusGroups],
    getGlobalStopKey: (s: any) => s?.mtrCode ? `MTR_${s.mtrCode}` : String(s?.stopId || s?.stopName_e || ''),
    computeSegmentStepSeconds: () => 90,
  });
  sb.ctx.window.MTR_EXITS_DIRECTORY = sb.MTR_EXITS_SEED;

  const G = sb.getRaptorGraph();
  const lopIdx = G.stops.findIndex((s: any) => s.mtrCode === 'LOP');
  const gmb74Idx = G.stops.findIndex((s: any) => s.stopName_e === 'On Lok Road, Near Tai Kiu');
  assert.ok(lopIdx >= 0 && gmb74Idx >= 0, 'LOP and GMB 74 stops must exist in RAPTOR graph');

  const lopToGmb = G.transfers[lopIdx].find((e: any) => e.toIdx === gmb74Idx);
  assert.ok(lopToGmb, 'Long Ping MTR must link to GMB 74 On Lok Rd (~350-420m from Exit) despite >45 closer bus stops');
  assert.equal(lopToGmb.isMtrGmb, true);
  assert.ok(lopToGmb.distM <= 450, `Exit-based walk distance should be <= 450m (got ${lopToGmb.distM}m)`);

  // Ordinary bus-to-bus stops 356m apart must remain unlinked (capped at 300m)
  const farAIdx = G.stops.findIndex((s: any) => s.stopName_e === 'Mong Kok A');
  const farBIdx = G.stops.findIndex((s: any) => s.stopName_e === 'Mong Kok B');
  const farLink = G.transfers[farAIdx].find((e: any) => e.toIdx === farBIdx);
  assert.equal(farLink, undefined, 'Bus-to-bus transfers >300m apart must NOT be linked');
});

test('planner.js & hardcode.js: 3-min transfer buffer, bi-directional MTR-GMB Octopus discounts, last-bus/ferry cutoff warnings, and ferry pier berths work accurately', () => {
  const sb = loadHardcodeAndPlannerSandbox({
    getHongKongNow: (ms = Date.now()) => {
      // Shift UTC timestamp to HKT (+8h) for deterministic hour/minute reads
      const shifted = new Date(ms + 8 * 3600000);
      return {
        getHours: () => shifted.getUTCHours(),
        getMinutes: () => shifted.getUTCMinutes(),
        getDay: () => shifted.getUTCDay(),
      };
    },
  });

  // 1. Minimum 3-minute (180s) road-to-road transfer buffer
  const gE36 = { mode: 'BUS', company: 'LWB', routeNo: 'E36', headwayMins: 15 };
  const g74 = { mode: 'BUS', company: 'GMB', routeNo: '74', headwayMins: 10, maxFare: 6.3, activeWindows: [[390, 1320]] }; // 06:30-22:00
  const roadBuf = sb.getInterchangeTransferSec(gE36, g74, { isGoldenHub: false }, 60);
  assert.ok(roadBuf >= 180, `Road-to-road transfer buffer must be >= 180s (got ${roadBuf}s)`);

  // 2. Last-bus / last-ferry cutoff warning within 20 min of closing
  const dep2148Hkt = Date.parse('2026-11-23T21:48:00+08:00');
  const dep1400Hkt = Date.parse('2026-11-23T14:00:00+08:00');
  const gmbCutoff = sb.getLegServiceCutoffWarning(g74, dep2148Hkt, false);
  assert.ok(gmbCutoff?.isLastSoon, 'GMB 74 at 21:48 (closing 22:00) must trigger Last bus soon warning');
  assert.equal(gmbCutoff.cutoffLabel, '22:00');
  assert.ok(gmbCutoff.labelEn.includes('Last bus ~22:00'));
  assert.equal(sb.getLegServiceCutoffWarning(g74, dep1400Hkt, false), null, 'Midday bus must NOT trigger cutoff warning');

  const ferryGroup = { mode: 'FERRY', company: 'SF', routeNo: 'Central-MW', orig_en: 'Central', dest_en: 'Mui Wo', activeWindows: [[360, 1350]] }; // 22:30
  const ferryCutoff = sb.getLegServiceCutoffWarning(ferryGroup, Date.parse('2026-11-23T22:15:00+08:00'), false);
  assert.ok(ferryCutoff?.isLastSoon && ferryCutoff.labelEn.includes('Last ferry ~22:30'));

  // 3. Bi-directional MTR <-> GMB Octopus interchange discount ($0.50 for NT GMB 74 at LOP)
  sb.ctx.window.getExactMtrFare = () => 15.0;
  const mtrLeg = { group: { mode: 'MTR', company: 'MTR', routeNo: 'TML' }, boardStopObj: { mtrCode: 'NAC' }, alightStopObj: { mtrCode: 'LOP' }, driveSec: 1200 };
  const gmbLeg = { group: g74, boardStopObj: { fare: '6.3', stopName_e: 'On Lok Rd' }, alightStopObj: { fare: '0', stopName_e: 'Wang Lee St' }, driveSec: 420 };

  const metaAfter: any = {};
  const fareAfter = sb.computeLegChainFareHkd([mtrLeg, gmbLeg], false, metaAfter);
  assert.equal(fareAfter, 20.8, `MTR ($15.0) + GMB 74 ($6.3 - $0.5) must equal $20.8 (got ${fareAfter})`);
  assert.ok(metaAfter.notices.some((n: any) => n.type === 'mtr_interchange' && n.en.includes('-$0.5')));

  const metaBefore: any = {};
  const fareBefore = sb.computeLegChainFareHkd([gmbLeg, { ...mtrLeg, boardStopObj: { mtrCode: 'LOP' }, alightStopObj: { mtrCode: 'NAC' } }], false, metaBefore);
  assert.equal(fareBefore, 20.8, `GMB 74 -> MTR reverse direction must also apply -$0.5 discount (got ${fareBefore})`);
  assert.ok(metaBefore.notices.some((n: any) => n.type === 'mtr_interchange' && n.en.includes('-$0.5')));

  // 4. Ferry pier berth labels
  assert.equal(sb.getFerryPierBerthLabel(ferryGroup, { stopName_e: 'Central Ferry Pier' }, false), 'Central Pier 6');
  assert.equal(sb.getFerryPierBerthLabel(ferryGroup, { name_tc: '中環渡輪碼頭' }, true), '中環6號碼頭');
  assert.equal(
    sb.getFerryPierBerthLabel({ mode: 'FERRY', orig_en: 'Central', dest_en: 'Cheung Chau' }, { stopName_e: 'Central' }, false),
    'Central Pier 5'
  );
  assert.equal(
    sb.getFerryPierBerthLabel({ mode: 'FERRY', orig_en: 'Central', dest_en: 'Tsim Sha Tsui' }, { stopName_e: 'Central' }, false),
    'Central Pier 7 (Star Ferry)'
  );
});

test('planner.js, map.js, index.html & actions.yml: Share Trip summary, active leg polyline highlight, GMB route-stop fallback, and mtrExits sanity gate', () => {
  const sb = loadHardcodeAndPlannerSandbox({
    formatHkArrivalClock: () => '20:15',
  });

  // 1. Share Trip text formatting includes origin/dest, fare, MTR Exit F, and route numbers
  const spec = {
    fromMeta: { name_en: 'Lo Uk Tsuen', lat: 22.2389, lon: 113.9636 },
    toMeta: { name_en: '48 Wang Lee St', lat: 22.4648, lon: 114.0262 },
  };
  const card = {
    type: 'XFER',
    item: {
      totalMins: 116,
      fareHkd: 36.1,
      liveDep1Ms: 1000,
      liveDep2Ms: 2000,
      liveArrMs: 3000,
      accessWalkDistM: 0,
      egressWalkDistM: 380,
      egressExitObj: { ref: 'F' },
      leg1Group: { mode: 'BUS', company: 'NLB', routeNo: '3M' },
      leg2Group: { mode: 'MTR', company: 'MTR', routeNo: 'TML' },
      board1StopObj: { stopName_e: 'Lo Uk Tsuen' },
      alight2StopObj: { stopName_e: 'Long Ping Station' },
      xferStopNodes: [{
        alight1StopObj: { stopName_e: 'Tung Chung Station' },
        board2StopObj: { stopName_e: 'Tung Chung Station' },
        walkDistM: 120,
        xferExitObj: { ref: 'D' },
      }],
      leg3Options: [],
    },
  };
  const shareTxt = sb.formatPlannerCardShareText(spec, card, false);
  assert.ok(shareTxt.includes('Lo Uk Tsuen → 48 Wang Lee St'), 'Share text must contain origin -> destination');
  assert.ok(shareTxt.includes('116m') && shareTxt.includes('$36.1'), 'Share text must include duration & fare');
  assert.ok(shareTxt.includes('Exit D') && shareTxt.includes('Exit F'), 'Share text must include MTR Exit letters');

  // 2. Map active leg highlight dims non-selected polylines and toggles cleanly
  const mapSrc = fs.readFileSync('public/map.js', 'utf8');
  assert.ok(mapSrc.includes('function highlightPlannerMapLeg'), 'map.js must export highlightPlannerMapLeg');
  assert.ok(mapSrc.includes('xferMapLegPolylines.push'), 'map.js must track leg polylines for click-to-highlight sync');

  // 3. index.html includes TD GMB /eta/route-stop/ fallback and Share Trip CSS
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.includes('https://data.etagmb.gov.hk/eta/route-stop/'), 'index.html must include /eta/route-stop/ GMB fallback');
  assert.ok(html.includes('.planner-share-btn') && html.includes('.planner-step-transit.active-leg'), 'index.html must style Share Trip button and active leg');

  // 4. actions.yml includes extended mtrExits sanity gate
  const yml = fs.readFileSync('.github/workflows/actions.yml', 'utf8');
  assert.ok(yml.includes('mergedMtrExits.length < 50'), 'actions.yml must enforce mtrExits sanity gate before overwriting bus_index.min.json');
});

test('hardcode.js & planner.js: LocoBike HK shared bike pricing ($5.0/30m) factors into Direct Bike Ride, MTR+Bike fares, and notices', () => {
  const {
    ctx,
    SHARED_BIKE_PRICING,
    computeSharedBikeFareHkd,
    computeLegChainFareHkd,
    buildFromToEdgeRequestSpec,
    formatPlannerCardShareText,
  } = loadHardcodeAndPlannerSandbox({
    initRouteMapFast: () => {},
    getGlobalStopKey: (s: any) => (s?.mtrCode ? `MTR_${s.mtrCode}` : String(s?.stopId || s?.stopName_e || '')),
    isParallelRailTerminusPair: () => false,
    isAirportOrPortZone: () => false,
    isLantauOrAirportZone: (la: number, lo: number) => lo < 114.04 && la < 22.34,
    computeSegmentStepSeconds: (_mode: string, _co: string, dKm: number) => Math.max(45, Math.round((dKm / 28) * 3600)),
    userCommuteProfile: { home: null, work: null },
  });
  ctx.window.getExactMtrFare = () => 5.3;

  assert.equal(SHARED_BIKE_PRICING.ratePerBlockHkd, 5.0);
  assert.equal(SHARED_BIKE_PRICING.blockMins, 30);

  // 1. Sub-30m bike rides cost $5.0; >30m rides cost $10.0; 0m returns $0
  assert.equal(computeSharedBikeFareHkd(0, 0), 0);
  assert.equal(computeSharedBikeFareHkd(900, 3535), 5.0); // 15m ride
  assert.equal(computeSharedBikeFareHkd(2400, 9980), 10.0); // 40m ride (2 x 30m blocks)

  // 2. Tin Shui Wai MTR -> Long Ping MTR ($5.3) + Bike egress (2.0km) = $10.3 + notice
  const legTml = {
    group: { mode: 'MTR', company: 'MTR', routeNo: 'TML' },
    boardStopObj: { mtrCode: 'TIS', stopName_e: 'Tin Shui Wai' },
    alightStopObj: { mtrCode: 'LOP', stopName_e: 'Long Ping' },
    driveSec: 240,
  };
  const fareMeta: any = {};
  const totalWithBike = computeLegChainFareHkd([legTml], false, fareMeta, 22.448, 114.005, {
    accessByBike: false,
    accessWalkDistM: 80,
    egressByBike: true,
    egressWalkDistM: 2050,
  });
  assert.equal(totalWithBike, 10.3, `MTR ($5.3) + LocoBike ($5.0) must equal $10.3 (got ${totalWithBike})`);
  assert.ok(fareMeta.notices.some((n: any) => n.type === 'shared_bike' && n.en.includes('5.0')));

  // Dual bike access + egress charges two 30m rental sessions ($5.0 + $5.0)
  const totalDualBike = computeLegChainFareHkd([legTml], false, {}, 22.448, 114.005, {
    accessByBike: true,
    accessWalkDistM: 1200,
    egressByBike: true,
    egressWalkDistM: 2050,
  });
  assert.equal(totalDualBike, 15.3);

  // 3. End-to-end buildFromToEdgeRequestSpec with xferLocoBikeEnabled = true (Tin Shui Wai -> 48 Wang Lee St)
  ctx.xferLocoBikeEnabled = true;
  ctx.groupedRoutes = [
    {
      key: 'MTR_TML_O',
      mode: 'MTR',
      company: 'MTR',
      routeNo: 'TML',
      headwayMins: 4,
      maxFare: 5.3,
      _stops: [
        { stopId: 'TIS', mtrCode: 'TIS', stopName_e: 'Tin Shui Wai Station', latitude: '22.4481', longitude: '114.0054', fare: '5.3' },
        { stopId: 'LOP', mtrCode: 'LOP', stopName_e: 'Long Ping Station', latitude: '22.4476', longitude: '114.0254', fare: '0' },
      ],
    },
  ];
  ctx.userCommuteProfile = {
    home: { stopKey: 'MTR_TIS', stopName_e: 'Tin Shui Wai Station', lat: 22.4481, lon: 114.0054 },
    work: { stopKey: 'WANG_LEE', stopName_e: '48 Wang Lee St', lat: 22.4648, lon: 114.0262 },
  };
  const spec = buildFromToEdgeRequestSpec(new Date(2026, 10, 23, 9, 7, 0));
  assert.ok(spec.walkBikeDirectCard?.isBike, 'Should produce Bike Direct option (~2.9km)');
  assert.equal(spec.walkBikeDirectCard.fareHkd, 5.0, 'Direct Bike Ride must cost $5.0 (not $0)');
  const mtrPlusBike = spec.directRoutes.find((d: any) => d.group.routeNo === 'TML' && d.egressByBike);
  assert.ok(mtrPlusBike, 'Should produce TML MTR + Bike last-mile option');
  assert.equal(mtrPlusBike.fareHkd, 10.3, `TML MTR + Bike must combine $5.3 + $5.0 = $10.3 (got ${mtrPlusBike.fareHkd})`);

  const wbShare = formatPlannerCardShareText(spec, { type: 'WALK_BIKE', item: spec.walkBikeDirectCard }, false);
  assert.ok(wbShare.includes('LocoBike') && wbShare.includes('$5.0'));
});

test('hardcode.js & planner.js: refactored LoadFactorEngine fixes Sunday 8pm / early morning South Lantau false crowding across all 3 modes (Bus, MTR, Ferry)', () => {
  const { LoadFactorEngine, inferPlannerLegLoad } = loadHardcodeAndPlannerSandbox();

  // Nov 22, 2026 is Sunday!
  const sun0759 = new Date(2026, 10, 22, 7, 59, 0);
  const sun2000 = new Date(2026, 10, 22, 20, 0, 0);
  const sat1100 = new Date(2026, 10, 21, 11, 0, 0);
  const sat1730 = new Date(2026, 10, 21, 17, 30, 0);
  const wkAm0815 = new Date(2026, 10, 23, 8, 15, 0);
  const wkPm1815 = new Date(2026, 10, 23, 18, 15, 0);
  const sat2045 = new Date(2026, 10, 21, 20, 45, 0);

  // 1. South Lantau NLB 1, 3M, 4, A35 at Sunday 20:00 (BOTH WAYS) and Sunday 07:59 must report LOW / Seats — no tourists, no false 12m gap inflation
  const nlbCases = [
    { group: { company: 'NLB', routeNo: '1', mode: 'BUS', headwayMins: 12, orig_e: 'Mui Wo Ferry Pier', dest_e: 'Tai O' }, idx: 25, total: 56 },
    { group: { company: 'NLB', routeNo: '1', mode: 'BUS', headwayMins: 12, orig_e: 'Tai O', dest_e: 'Mui Wo Ferry Pier' }, idx: 26, total: 52 },
    { group: { company: 'NLB', routeNo: '3M', mode: 'BUS', headwayMins: 20, orig_e: 'Tung Chung Station', dest_e: 'Mui Wo Ferry Pier' }, idx: 16, total: 34 },
    { group: { company: 'NLB', routeNo: '3M', mode: 'BUS', headwayMins: 20, orig_e: 'Mui Wo Ferry Pier', dest_e: 'Tung Chung Station' }, idx: 17, total: 35 },
    { group: { company: 'NLB', routeNo: '4', mode: 'BUS', headwayMins: 20, orig_e: 'Mui Wo Ferry Pier', dest_e: 'Tong Fuk' }, idx: 12, total: 25 },
    { group: { company: 'NLB', routeNo: 'A35', mode: 'BUS', headwayMins: 30, orig_e: 'Mui Wo Ferry Pier', dest_e: 'HZMB Hong Kong Port' }, idx: 28, total: 61 },
  ];

  for (const tc of nlbCases) {
    const loadSun20 = LoadFactorEngine.inferBusLoad({
      group: tc.group,
      stopIdx: tc.idx,
      totalStops: tc.total,
      obsHeadwaySec: 1500,
      schedHeadwaySec: tc.group.headwayMins * 60,
      isSched: false,
      dateObj: sun2000,
      isHoliday: true,
    });
    assert.equal(
      loadSun20.tier,
      'LOW',
      `NLB ${tc.group.routeNo} (${tc.group.orig_e} -> ${tc.group.dest_e}) at Sun 20:00 must be Seats/LOW (got ${loadSun20.pct}% ${loadSun20.labelEn})`
    );
    assert.ok(loadSun20.pct <= 36, `Expected <=36% at Sun 20:00, got ${loadSun20.pct}%`);

    const loadSun0759 = LoadFactorEngine.inferBusLoad({
      group: tc.group,
      stopIdx: tc.idx,
      totalStops: tc.total,
      dateObj: sun0759,
      isHoliday: true,
    });
    assert.equal(
      loadSun0759.tier,
      'LOW',
      `NLB ${tc.group.routeNo} (${tc.group.orig_e} -> ${tc.group.dest_e}) at Sun 07:59 must be Seats/LOW (got ${loadSun0759.pct}% ${loadSun0759.labelEn})`
    );
  }

  // Tourist contrast: Saturday 11:00 heading TO Tai O is significantly busier than Sat 20:45
  const nlb11ToTaiO = { company: 'NLB', routeNo: '11', mode: 'BUS', headwayMins: 15, orig_e: 'Tung Chung Station', dest_e: 'Tai O' };
  const satMorningToTaiO = LoadFactorEngine.inferBusLoad({
    group: nlb11ToTaiO, stopIdx: 22, totalStops: 54, dateObj: sat1100, isHoliday: false,
  });
  const satEveningToTaiO = LoadFactorEngine.inferBusLoad({
    group: nlb11ToTaiO, stopIdx: 22, totalStops: 54, dateObj: sat2045, isHoliday: false,
  });
  assert.ok(
    satMorningToTaiO.pct >= satEveningToTaiO.pct + 20,
    `Sat 11:00 tourist wave toward Tai O (${satMorningToTaiO.pct}%) must far exceed Sat 20:45 (${satEveningToTaiO.pct}%)`
  );

  // 2. MTR refactored curves: Disneyland DRL fireworks wave vs quiet midday; Sunday 20:00 suburban quiet
  const drlExitFireworks = LoadFactorEngine.inferMtrLoad({
    lineCode: 'DRL', staCode: 'DIS', destCode: 'SUN', destName: 'Sunny Bay', dateObj: sat2045, isHoliday: false,
  });
  const drlQuietMid = LoadFactorEngine.inferMtrLoad({
    lineCode: 'DRL', staCode: 'DIS', destCode: 'SUN', destName: 'Sunny Bay', dateObj: wkAm0815, isHoliday: false,
  });
  assert.ok(drlExitFireworks.pct > drlQuietMid.pct + 20, 'DRL post-fireworks exit (20:45) must surge vs quiet weekday AM');

  const mtrSun20 = LoadFactorEngine.inferMtrLoad({
    lineCode: 'TML', staCode: 'LOP', destCode: 'WKS', destName: 'Wu Kai Sha', dateObj: sun2000, isHoliday: true,
  });
  assert.equal(mtrSun20.tier, 'LOW', `Sunday 20:00 suburban TML must be LOW/Seats (got ${mtrSun20.pct}%)`);

  // 3. Ferry refactored model: Commuter direction, Fast vs Triple-Deck Ordinary capacity, Tourist weekend, Sunday 20:00 calm, & Planner integration
  const gCcOut = {
    mode: 'FERRY',
    company: 'SF',
    routeNo: 'Central-CC',
    orig_e: 'Central',
    dest_e: 'Cheung Chau',
    ferryMeta: { durFast: 40, durOrd: 60 },
  };
  const gCcIn = {
    mode: 'FERRY',
    company: 'SF',
    routeNo: 'CC-Central',
    orig_e: 'Cheung Chau',
    dest_e: 'Central',
    ferryMeta: { durFast: 40, durOrd: 60 },
  };

  // Weekday AM: Cheung Chau -> Central commuters >> Central -> Cheung Chau counter-flow
  const wkAmToCentral = LoadFactorEngine.inferFerryLoad({ group: gCcIn, vesselClass: 'FAST', dateObj: wkAm0815 });
  const wkAmToIsland = LoadFactorEngine.inferFerryLoad({ group: gCcOut, vesselClass: 'FAST', dateObj: wkAm0815 });
  assert.ok(wkAmToCentral.pct >= wkAmToIsland.pct + 25, `Wkdy AM ferry to Central (${wkAmToCentral.pct}%) >> outbound (${wkAmToIsland.pct}%)`);
  assert.equal(wkAmToCentral.mode, 'FERRY');
  assert.equal(wkAmToCentral.capacityPax, 320);

  // Weekday PM: Central -> Cheung Chau commuters >> reverse
  const wkPmToIsland = LoadFactorEngine.inferFerryLoad({ group: gCcOut, vesselClass: 'FAST', dateObj: wkPm1815 });
  const wkPmToCentral = LoadFactorEngine.inferFerryLoad({ group: gCcIn, vesselClass: 'FAST', dateObj: wkPm1815 });
  assert.ok(wkPmToIsland.pct >= wkPmToCentral.pct + 25);

  // Weekend return wave (17:30): Fast Ferry (~320 pax) significantly higher % than Triple-Deck Ordinary (~850 pax)
  const satReturnFast = LoadFactorEngine.inferFerryLoad({ group: gCcIn, vesselClass: 'FAST', dateObj: sat1730 });
  const satReturnOrd = LoadFactorEngine.inferFerryLoad({ group: gCcIn, vesselClass: 'ORD', dateObj: sat1730 });
  assert.ok(satReturnFast.pct >= 72 && satReturnFast.pct >= satReturnOrd.pct + 20, `Sat 17:30 Fast (${satReturnFast.pct}%) >> Ord (${satReturnOrd.pct}%)`);
  assert.equal(satReturnOrd.capacityPax, 850);

  // Sunday 20:00 both ways calm ('Seats')
  const sun20FerryOut = LoadFactorEngine.inferFerryLoad({ group: gCcOut, vesselClass: 'FAST', dateObj: sun2000, isHoliday: true });
  const sun20FerryIn = LoadFactorEngine.inferFerryLoad({ group: gCcIn, vesselClass: 'ORD', dateObj: sun2000, isHoliday: true });
  assert.equal(sun20FerryOut.tier, 'LOW');
  assert.equal(sun20FerryIn.tier, 'LOW');

  // Planner integration: inferPlannerLegLoad supports FERRY now (no longer returns null!)
  const plannerFerryLoad = inferPlannerLegLoad(gCcIn, { stopName_e: 'Cheung Chau Pier' }, sat1730, false, 0, { vesselClass: 'FAST' });
  assert.ok(plannerFerryLoad && plannerFerryLoad.mode === 'FERRY' && plannerFerryLoad.pct >= 72);
});







