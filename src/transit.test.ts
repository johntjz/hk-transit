import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// index.html now holds only markup + early boot loaders; inline CSS/JS lives in external files.
// Assertions that previously scanned index.html for CSS rules / app functions read this concatenated bundle.
function readAppBundle(): string {
  return ['index.html', 'public/app.css', 'public/eta-engine.js', 'public/onboarding-pwa.js', 'public/app-ui.js']
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

function readHardcodeBundle(): string {
  return ['public/transit-data.js', 'public/fare-load-engine.js', 'public/hardcode.js']
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

function readMapBundle(): string {
  return ['public/map-traffic-overlay.js', 'public/map.js']
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

function readPlannerBundle(): string {
  return ['public/commute-hubs.js', 'public/raptor-cost-engine.js', 'public/planner.js']
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

function loadWorkerSandbox(extraCtx: Record<string, any> = {}) {
  const rawSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  const sandboxSrc = rawSrc.replace(/^export\s+/gm, '');
  const ctx: Record<string, any> = {
    URL,
    Response,
    AbortController,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    console,
    ...extraCtx,
  };
  vm.createContext(ctx);
  return vm.runInContext(
    `${sandboxSrc}\n;({ parseXmlRecords, parseFerryRowSortMin, sortFerryEtasChronologically, classifyTrafficCorridorSeverity, parseHkoWeatherSummary, classifyDetectorCongestion, parseStrategicDetectorCsv, parseRawSpeedVolXml, decodeTextBufferAuto, parseTrafficCameraCsv, handleTrafficLiveRequest, onRequest });`,
    ctx
  );
}

function loadHardcodeAndPlannerSandbox(overrides: Record<string, any> = {}) {
  const hardcodeSrc = readHardcodeBundle();
  const plannerSrc = readPlannerBundle();

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
      hasStopTwoWaySectionalFare,
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
      collapseParallelDirectRoutes,
      formatLegSignalTagHtml,
      computeBearingDeg,
      angularDiffDeg,
      inferDirectionalRoadTrafficForStops,
      getDirectionalRoadSummary,
      synthesizeTrafficDecision,
      parseHkGpsCoordinates,
      findOppositeDirectionGroup,
      SavedHubsManager,
      SmartReturnManager,
      buildPlannerLegRoadTrafficTagHtml,
    });`,
    ctx
  );

  return { ctx, ...exportsObj };
}

test('Detour BS is completely removed from all app source files', () => {
  const files = [
    'index.html',
    'public/transit-data.js',
    'public/fare-load-engine.js',
    'public/hardcode.js',
    'public/map-traffic-overlay.js',
    'public/map.js',
    'public/commute-hubs.js',
    'public/raptor-cost-engine.js',
    'public/planner.js',
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

  const html = readAppBundle();
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
  const mapSrc = readMapBundle();
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
  assert.ok(['B1', 'B2', 'D'].includes(nearEx.ref), `Expected Hong Kong Station Exchange Square exit B1, B2 or D, got ${nearEx.ref}`);

  // Transfer from TCL (Hong Kong Station) to CTB 30X (Exchange Square) snaps to nearest physical exit
  const xferSnap = resolveMtrTransferExit(
    { mode: 'MTR', company: 'MTR', routeNo: 'TCL' },
    { lat: 22.284667, lon: 114.158224, stopName_e: 'Hong Kong Station' },
    { mode: 'BUS', company: 'CTB', routeNo: '30X' },
    { lat: 22.2836, lon: 114.1580, stopName_e: 'Central (Exchange Square)' }
  );
  assert.ok(xferSnap, 'Expected BUS<->MTR transfer to snap to nearest MTR exit');
  assert.ok(['B1', 'B2', 'D'].includes(xferSnap.exitObj.ref), `Expected transfer exit B1, B2 or D, got ${xferSnap.exitObj.ref}`);
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
  const html = readAppBundle();
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
  const html = readAppBundle();
  const planner = readPlannerBundle();
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

  const html = readAppBundle();
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
  const mapSrc = readMapBundle();
  assert.ok(mapSrc.includes('function highlightPlannerMapLeg'), 'map.js must export highlightPlannerMapLeg');
  assert.ok(mapSrc.includes('xferMapLegPolylines.push'), 'map.js must track leg polylines for click-to-highlight sync');

  // 3. index.html includes TD GMB /eta/route-stop/ fallback and Share Trip CSS
  const html = readAppBundle();
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

test('planner.js & index.html: deduplicates opposite-side stops in Settings Hub Picker, promotes labeled Plan tab, updates companion links, fixes iOS standalone top bar, and wires 3-step onboarding', () => {
  const rendered = { listHtml: '' };
  const fakeInput = { value: 'Lo uk' };
  const fakeList = {
    set innerHTML(v: string) { rendered.listHtml = v; },
    get innerHTML() { return rendered.listHtml; },
  };
  const { ctx } = loadHardcodeAndPlannerSandbox({
    document: {
      getElementById: (id: string) => {
        if (id === 'commutePickerSearchInput') return fakeInput;
        if (id === 'commutePickerList') return fakeList;
        return null;
      },
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
      addEventListener: () => {},
    },
    activeCommutePickerSlot: 'hub_home',
    lastKnownPos: { lat: 22.2448, lon: 113.9720 },
    buildNearbyStopsFast: () => {},
    getPlannerHubDirectory: () => [],
    getStopName: (s: any) => s.stopName_e,
    getStopDistrictTag: (s: any) => s._testDist || '',
    formatStopDistance: () => '',
    escapeHtml: (s: any) => String(s || ''),
    escapeJsAttr: (s: any) => String(s || ''),
    allStops: [
      { stopKey: 'NLB_SL_A', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: '22.2392', longitude: '113.9665', _testDist: 'South Lantau', routeNos: new Set(['4', '3M', '1', 'A35']) },
      { stopKey: 'NLB_SL_B', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: '22.2393', longitude: '113.9666', _testDist: 'South Lantau', routeNos: new Set(['3M', '2', '1', 'N35']) },
      { stopKey: 'KMB_KL_A', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: '22.4320', longitude: '114.0850', _testDist: 'Kowloon', routeNos: new Set(['54', '251B']) },
      { stopKey: 'KMB_KL_B', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: '22.4322', longitude: '114.0852', _testDist: 'Kowloon', routeNos: new Set(['54', '251B', '251M', '917']) },
      { stopKey: 'MTRB_YL_A', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: '22.4440', longitude: '113.9980', _testDist: 'Yuen Long', routeNos: new Set(['K65', 'K65A']) },
      { stopKey: 'MTRB_YL_B', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', latitude: '22.4447', longitude: '113.9983', _testDist: 'Yuen Long', routeNos: new Set(['K65', 'K65A']) },
    ],
    nearbyStopsList: [],
  });

  ctx.renderCommutePickerList();
  const matches = rendered.listHtml.match(/<span>Lo Uk Tsuen<\/span>/g) || [];
  assert.equal(matches.length, 3, `Expected 3 deduplicated Lo Uk Tsuen rows (1 per district), got ${matches.length}`);
  assert.ok(rendered.listHtml.includes('1, 2, 3M, 4, A35, N35'), 'Merged South Lantau stop must combine naturally-sorted route numbers');
  assert.ok(rendered.listHtml.includes('54, 251B, 251M, 917'), 'Merged Kowloon stop must combine all routes');
  assert.ok(
    rendered.listHtml.indexOf('South Lantau') < rendered.listHtml.indexOf('Yuen Long') &&
    rendered.listHtml.indexOf('Yuen Long') < rendered.listHtml.indexOf('Kowloon'),
    'Deduplicated stops must be sorted closest-first'
  );

  const html = readAppBundle();
  assert.ok(html.includes('class="app-switcher-item app-switcher-plan" id="topXferBtn"'), 'Route Planner must be promoted to a labeled top-bar Plan tab');
  assert.ok(html.includes('data-i18n="planApp">Plan</span>') && html.includes("planApp: '規劃'"), 'Plan tab must have EN/ZH labels');
  assert.ok(html.includes('html.ios-standalone .app-switcher') && html.includes('calc(env(safe-area-inset-top) + 14px)'), 'iOS standalone PWA must clear the status-bar whiteout frost zone');
  assert.ok(html.includes('function triggerIosStandaloneTopBarReflow()'), 'index.html must include post-load iOS standalone compositor reflow');
  assert.ok(
    html.includes('id="aboutModal"') &&
    html.includes('id="settingAboutRow"') &&
    html.includes('HK Property (樓)') &&
    html.includes('HK Sundry (曬衫)') &&
    html.includes('https://hksundry.pages.dev') &&
    html.includes('HK Layer (著衫)') &&
    html.includes('https://hklayer.pages.dev') &&
    html.includes("openCompanionAppAtCurrentStop('sundry')"),
    'About subpage in Settings must include updated HK Property, HK Sundry (hksundry.pages.dev), and HK Layer ecosystem links'
  );
  assert.ok(html.includes('ONBOARDING_SEEN_KEY') && html.includes('maybeShowFirstVisitOnboarding') && html.includes('openPlannerFromTutorial'), 'First-use visual onboarding carousel with Skip/Next/Open Planner must be wired');
});

test('index.html: detects client device language on landing and renders MTR-style 7-slide HK-landmark visual tutorial', () => {
  const html = readAppBundle();

  const detectMatch = html.match(/function detectClientDeviceLang\(navObj\) \{[\s\S]*?\n\}/);
  const svgFnMatch = html.match(/function buildTutorialSlideSvg\(stepIdx, isZh\) \{[\s\S]*?\n\}/);
  const stepSecMatch = html.match(/function computeSegmentStepSeconds\([\s\S]*?\n\}/);
  assert.ok(detectMatch, 'detectClientDeviceLang must exist in index.html');
  assert.ok(svgFnMatch, 'buildTutorialSlideSvg must exist in index.html');
  assert.ok(stepSecMatch, 'computeSegmentStepSeconds must exist in index.html');

  const sandbox: any = {
    userLangPref: 'auto',
    navigator: { languages: ['en-US'], language: 'en-US' },
    getCorridorLiveStatusAt: () => ({ status: 'SMOOTH', speedKmh: 70 }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${detectMatch[0]}\n${svgFnMatch[0]}\n${stepSecMatch[0]}`, sandbox);

  // 1. Client device language detection on landing
  assert.equal(sandbox.detectClientDeviceLang({ languages: ['zh-HK', 'en-HK'], language: 'zh-HK' }), 'zh');
  assert.equal(sandbox.detectClientDeviceLang({ languages: ['yue-Hant-HK'], language: 'yue-Hant-HK' }), 'zh');
  assert.equal(sandbox.detectClientDeviceLang({ languages: ['zh-TW'], language: 'zh-TW' }), 'zh');
  assert.equal(sandbox.detectClientDeviceLang({ languages: ['zh-CN'] }), 'zh');
  assert.equal(sandbox.detectClientDeviceLang({ languages: ['en-GB', 'zh-HK'], language: 'en-GB' }), 'en');
  assert.equal(sandbox.detectClientDeviceLang({ languages: ['en-US'], language: 'en-US' }), 'en');
  assert.equal(sandbox.detectClientDeviceLang({ language: 'zh-Hant-HK' }), 'zh');

  // 2. All 7 priority-ranked HK-landmark visual picture slides in EN & ZH
  const expectedEn = [
    'Mong Kok',
    'SOGO Causeway Bay',
    'Stops & ETA ›',
    'Saved Stops',
    'TST Star Ferry Pier',
    'Language',
    'Add to Home Screen',
  ];
  const expectedZh = [
    '旺角',
    '崇光百貨 (銅鑼灣)',
    '站點班次 ›',
    '已收藏車站',
    '尖沙咀天星碼頭',
    '語言',
    '加入主畫面',
  ];
  for (let i = 0; i < 7; i++) {
    const svgEn = sandbox.buildTutorialSlideSvg(i, false);
    const svgZh = sandbox.buildTutorialSlideSvg(i, true);
    assert.ok(svgEn.startsWith('<svg viewBox="0 0 340 276"'), `Slide ${i} EN must render crisp 340x276 SVG`);
    assert.ok(svgZh.startsWith('<svg viewBox="0 0 340 276"'), `Slide ${i} ZH must render crisp 340x276 SVG`);
    assert.ok(svgEn.includes(expectedEn[i]), `Slide ${i} EN visual must include "${expectedEn[i]}"`);
    assert.ok(svgZh.includes(expectedZh[i]), `Slide ${i} ZH visual must include "${expectedZh[i]}"`);
    assert.ok(!/Lo Uk Tsuen|Pui O|羅屋村|貝澳/.test(svgEn + svgZh), `Slide ${i} must use mainstream HK landmarks instead of village defaults`);
  }

  // Slide 2 visual must illustrate directional road speed & live road camera thumbnail
  const slide2En = sandbox.buildTutorialSlideSvg(1, false);
  const slide2Zh = sandbox.buildTutorialSlideSvg(1, true);
  assert.ok(slide2En.includes('Road Cam') && slide2En.includes('Your side 68 km/h'), 'Slide 2 EN must depict Road Cam and directional smooth speed');
  assert.ok(slide2Zh.includes('路面實拍') && slide2Zh.includes('前路暢順 68 km/h'), 'Slide 2 ZH must depict 路面實拍 and directional smooth speed');

  // 3. Structural & interactive checks (Picture-First, Minimal Text)
  assert.ok(!html.includes('onboard-step-points'), 'Old bullet-list text wall must be removed');
  assert.ok(!html.includes('onboard-step-desc'), 'Old paragraph text wall must be removed');
  assert.ok(!html.includes('onboard-step-row') && !html.includes('onboard-steps-list'), '3-row prose checklist must be removed for picture-first onboarding');
  assert.ok(html.includes('TUTORIAL_SLIDE_COUNT = 7'), 'Must have 7 priority-ranked tutorial slides');
  assert.ok(html.includes('onboard-rank-pill') && html.includes('tutorialSlideCue'), 'Tutorial must include priority pill & single short cue line');
  assert.ok(html.includes('openMapFromTutorial') && html.includes('openPlannerFromTutorial'), 'Tutorial must link into Planner and Map');
  assert.ok(html.includes('attachTutorialSwipeGestures'), 'Must support mobile touch swipe navigation');
  assert.ok(html.includes("params.get('autostart') === '1'"), 'Must support ?autostart=1 bypass for testing');

  // 4. South Lantau rural NLB segment speed calibration (11 stops, ~4.0 km Sun Wai Tsuen -> Mui Wo Market ~11-12m)
  const ruralSec11Stops = 11 * sandbox.computeSegmentStepSeconds('BUS', 'NLB', 4.0 / 11, false, 22.248, 113.988);
  assert.ok(ruralSec11Stops >= 580 && ruralSec11Stops <= 760, `Expected 11-stop 4km South Lantau ride ~10-12.5m, got ${(ruralSec11Stops / 60).toFixed(1)}m`);
});

test('planner.js: keeps 3M (19m live) above 1 (59m sched) without false merge and clarifies Stops & ETA + Live ETA labels', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const makeBusCand = (routeNo: string, headwayMins: number, totalMins: number, score: number, sigType1: string) => ({
    group: { key: `NLB_${routeNo}___Mui_Wo_Ferry_Pier`, routeNo, company: 'NLB', mode: 'BUS', headwayMins },
    boardStopObj: { stopName_e: 'Sun Wai Tsuen' },
    alightStopObj: { stopName_e: 'Mui Wo Market' },
    totalMins,
    fareHkd: 3.7,
    disruptionScore: score,
    sigType1,
    parallelRoutes: [],
  });

  // 1. Pre-ETA static order: NLB 1 (headway 12m) ranks ahead of 3M (headway 20m) and collapses safely for placeholder view
  const route1Pre = makeBusCand('1', 12, 16, 17, 'SCHED');
  const route3MPre = makeBusCand('3M', 20, 19, 20, 'SCHED');
  const preCollapsed = sb.collapseParallelDirectRoutes([route1Pre, route3MPre], false, 'NOW', 'BEST');
  assert.equal(preCollapsed.length, 1);
  assert.deepEqual([...preCollapsed[0].parallelRoutes], ['3M']);

  // 2. Post-ETA live resolution: 3M arrives in 8m (19m total LIVE), 1 is 37m away (59m total SCHED)
  const route1Post = makeBusCand('1', 12, 59, 60, 'SCHED');
  const route3MPost = makeBusCand('3M', 20, 19, 19, 'LIVE');
  const postCollapsed = sb.collapseParallelDirectRoutes([route1Post, route3MPost], true, 'NOW', 'BEST');
  assert.equal(postCollapsed[0].group.routeNo, '3M', '3M at 19m must rank #1 over 1 at 59m');
  assert.deepEqual([...postCollapsed[0].parallelRoutes], [], 'Must NOT merge 59m Route 1 as a parallel substitute onto 19m 3M');
  assert.equal(postCollapsed.length, 2);

  // 3. Truly concurrent arrivals within 5m & $2.5 fare still collapse cleanly into "3M / 1"
  const route1Concurrent = makeBusCand('1', 12, 22, 23, 'LIVE');
  const concurrentCollapsed = sb.collapseParallelDirectRoutes([route1Concurrent, route3MPost], true, 'NOW', 'BEST');
  assert.equal(concurrentCollapsed.length, 1);
  assert.equal(concurrentCollapsed[0].group.routeNo, '3M');
  assert.deepEqual([...concurrentCollapsed[0].parallelRoutes], ['1']);

  // 4. buildFromToEdgeRequestSpec must keep both 1 and 3M in spec.directRoutes (no premature collapse)
  const stops = [
    { stopKey: 'SWT', stopId: 'SWT', stopName_e: 'Sun Wai Tsuen', latitude: '22.2448', longitude: '113.9720', seq: 1, fare: '3.7' },
    { stopKey: 'MWM', stopId: 'MWM', stopName_e: 'Mui Wo Market', latitude: '22.2646', longitude: '113.9978', seq: 2, fare: '0' },
  ];
  const g1 = { key: 'NLB_1_O', routeNo: '1', company: 'NLB', mode: 'BUS', orig_e: 'Tai O', dest_e: 'Mui Wo', headwayMins: 12, maxFare: 3.7, routeIds: ['NLB_1_O'], _stops: stops };
  const g3m = { key: 'NLB_3M_O', routeNo: '3M', company: 'NLB', mode: 'BUS', orig_e: 'Tung Chung', dest_e: 'Mui Wo', headwayMins: 20, maxFare: 3.7, routeIds: ['NLB_3M_O'], _stops: stops };
  const sbSpec = loadHardcodeAndPlannerSandbox({
    groupedRoutes: [g1, g3m],
    routeStopsCache: { NLB_1_O: stops, NLB_3M_O: stops },
    routeMapIndex: new Map([['NLB_1_O', g1], ['NLB_3M_O', g3m]]),
    allStops: stops,
    stopMapIndex: new Map([['SWT', stops[0]], ['MWM', stops[1]]]),
    initRouteMapFast: () => {},
    isParallelRailTerminusPair: () => false,
    isAirportOrPortZone: () => false,
    isLantauOrAirportZone: () => true,
    computeSegmentStepSeconds: () => 600,
    isRouteActiveAtPlannerTime: () => true,
  });
  sbSpec.ctx.userCommuteProfile = {
    home: { stopKey: 'SWT', stopName_e: 'Sun Wai Tsuen', lat: 22.2448, lon: 113.9720 },
    work: { stopKey: 'MWM', stopName_e: 'Mui Wo Market', lat: 22.2646, lon: 113.9978 },
  };
  const spec = sbSpec.buildFromToEdgeRequestSpec(new Date('2026-11-23T21:40:00+08:00'));
  assert.ok(spec, 'buildFromToEdgeRequestSpec should resolve routes');
  const directNos = [...spec.directRoutes.map((d: any) => d.group.routeNo)].sort();
  assert.deepEqual(directNos, ['1', '3M'], 'Both NLB 1 and 3M must remain uncollapsed until live ETAs resolve');

  // 5. Planner signal labels and action buttons distinguish "Real-time" (no-wrap) from "Stops & ETA ›"
  sb.ctx.currentLang = 'en';
  const liveTagEn = sb.formatLegSignalTagHtml('LIVE');
  assert.ok(liveTagEn.includes('Real-time') && liveTagEn.includes('white-space:nowrap'), `Expected non-wrapping Real-time tag, got: ${liveTagEn}`);
  assert.ok(!liveTagEn.includes('Live ETA'), 'Jargon Live ETA must be replaced with Real-time');
  assert.ok(sb.formatLegSignalTagHtml('SCHED').includes('Scheduled'));
  sb.ctx.currentLang = 'zh';
  const liveTagZh = sb.formatLegSignalTagHtml('LIVE');
  assert.ok(liveTagZh.includes('實時') && liveTagZh.includes('white-space:nowrap'), `Expected non-wrapping 實時 tag, got: ${liveTagZh}`);
  assert.ok(sb.formatLegSignalTagHtml('SCHED').includes('預計班次'));

  const plannerSrc = readPlannerBundle();
  assert.ok(!plannerSrc.includes('Live ETA'), 'public/planner.js must not contain Live ETA jargon');
  assert.ok(plannerSrc.includes("'Stops & ETA ›'") && plannerSrc.includes("'站點班次 ›'"), 'Planner leg button must say Stops & ETA ›');
  assert.ok(!plannerSrc.includes("'Live ›'") && !plannerSrc.includes("'實時 ›'"), 'Ambiguous Live › button label must be removed');
});

function loadUnpackedBusIndexForTest() {
  const db = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));
  const dict: any[] = Array.isArray(db.stopsDict) ? db.stopsDict : [];
  const routeStopsCache: Record<string, any[]> = {};
  const groupedRoutes = db.groupedRoutes || [];
  const routeMapIndex = new Map<string, any>();
  const ridCompany = new Map<string, string>();
  for (const g of groupedRoutes) {
    for (const rid of g.routeIds || []) {
      routeMapIndex.set(rid, g);
      ridCompany.set(rid, g.company || 'BUS');
    }
  }

  const stopMapIndex = new Map<string, any>();
  for (const [rid, items] of Object.entries<any>(db.routeStopsCache || {})) {
    const company = ridCompany.get(rid) || 'BUS';
    const g = routeMapIndex.get(rid);
    routeStopsCache[rid] = (items || []).map((item: any, idx: number) => {
      if (Array.isArray(item) && dict[item[0]]) {
        const d = dict[item[0]];
        const stopId = String(d[0] ?? '');
        const stopKey = `${company}_${stopId}`;
        const st: any = {
          stopId,
          stopKey,
          stopName_e: String(d[1] ?? ''),
          name_tc: String(d[2] ?? ''),
          latitude: Number(d[3] || 0).toFixed(6),
          longitude: Number(d[4] || 0).toFixed(6),
          seq: idx + 1,
          fare: String(item[1] ?? '0'),
        };
        if (item[2] !== undefined && item[2] !== null && item[2] !== '') st.fareHol = String(item[2]);
        if (d[5]) st.mtrCode = d[5];
        if (d[6]) st.lrtCode = d[6];
        if (d[7]) st.mtrLine = d[7];
        if (d[8]) st.lrtLine = d[8];
        let existing = stopMapIndex.get(stopKey);
        if (!existing) {
          existing = { ...st, routeNos: new Set<string>() };
          stopMapIndex.set(stopKey, existing);
        }
        if (g?.routeNo) existing.routeNos.add(String(g.routeNo));
        return st;
      }
      return item;
    }).filter(Boolean);
  }
  return {
    db,
    groupedRoutes,
    routeStopsCache,
    routeMapIndex,
    allStops: Array.from(stopMapIndex.values()),
    stopMapIndex,
  };
}

test('hardcode.js: NLB 1 & NLB 3M two-way sectional fare badge & driver notice only appear before final leg', () => {
  const { hasStopTwoWaySectionalFare, resolveBusLegNetFare } = loadHardcodeAndPlannerSandbox();
  const unpacked = loadUnpackedBusIndexForTest();

  const findGroup = (routeNo: string, destPattern: RegExp) =>
    unpacked.groupedRoutes.find((g: any) => g.company === 'NLB' && g.routeNo === routeNo && destPattern.test(String(g.dest_e || '')));

  // 1. NLB 3M -> Mui Wo: two-way sectional only up to Shek Mun Kap Road, NOT after Shek Mun Kap
  const g3mToMw = findGroup('3M', /Mui Wo/i);
  assert.ok(g3mToMw, 'NLB 3M to Mui Wo must exist in bus_index.min.json');
  const s3mToMw = unpacked.routeStopsCache[g3mToMw.routeIds[0]];
  const smkOutIdx = s3mToMw.findIndex((s: any) => /Shek Mun Kap/i.test(s.stopName_e));
  assert.ok(smkOutIdx >= 5, `Expected Shek Mun Kap along 3M -> Mui Wo, got idx ${smkOutIdx}`);
  assert.equal(hasStopTwoWaySectionalFare(g3mToMw, s3mToMw, 0, false), true, '3M -> Mui Wo terminus needs two-way section');
  assert.equal(hasStopTwoWaySectionalFare(g3mToMw, s3mToMw, smkOutIdx, false), true, '3M -> Mui Wo at Shek Mun Kap still has sectional tiers');
  for (let i = smkOutIdx + 1; i < s3mToMw.length; i++) {
    assert.equal(
      hasStopTwoWaySectionalFare(g3mToMw, s3mToMw, i, false),
      false,
      `3M -> Mui Wo stop ${i + 1}. ${s3mToMw[i].stopName_e} after Shek Mun Kap must NOT show driver notice`
    );
  }

  // 2. NLB 3M -> Tung Chung: fares auto-reduce along the route, so NO stop (including Lo Uk Tsuen) needs 2-way driver notice
  const g3mToTc = findGroup('3M', /Tung Chung/i);
  assert.ok(g3mToTc, 'NLB 3M to Tung Chung must exist in bus_index.min.json');
  const s3mToTc = unpacked.routeStopsCache[g3mToTc.routeIds[0]];
  const loUk3mTcIdx = s3mToTc.findIndex((s: any) => /Lo Uk Tsuen/i.test(s.stopName_e));
  assert.ok(loUk3mTcIdx >= 0, 'Lo Uk Tsuen must exist on 3M -> Tung Chung');
  for (let i = 0; i < s3mToTc.length; i++) {
    assert.equal(
      hasStopTwoWaySectionalFare(g3mToTc, s3mToTc, i, false),
      false,
      `3M -> Tung Chung stop ${i + 1}. ${s3mToTc[i].stopName_e} must NOT show 2-way driver notice`
    );
  }

  // 3. NLB 1 -> Mui Wo: final leg from Lo Uk Tsuen onward must NOT show 2-way notice or rebate
  const g1ToMw = findGroup('1', /Mui Wo/i);
  assert.ok(g1ToMw, 'NLB 1 to Mui Wo must exist in bus_index.min.json');
  const s1ToMw = unpacked.routeStopsCache[g1ToMw.routeIds[0]];
  const loUk1MwIdx = s1ToMw.findIndex((s: any) => /Lo Uk Tsuen/i.test(s.stopName_e));
  assert.ok(loUk1MwIdx > 20, `Expected Lo Uk Tsuen around stop 38 on NLB 1 -> Mui Wo, got idx ${loUk1MwIdx}`);
  assert.equal(hasStopTwoWaySectionalFare(g1ToMw, s1ToMw, 0, false), true, 'NLB 1 at Tai O terminus still needs driver notice');
  for (let i = loUk1MwIdx; i < s1ToMw.length; i++) {
    assert.equal(
      hasStopTwoWaySectionalFare(g1ToMw, s1ToMw, i, false),
      false,
      `NLB 1 -> Mui Wo final leg stop ${i + 1}. ${s1ToMw[i].stopName_e} must NOT show driver notice`
    );
  }
  const fareLoUkToMw = resolveBusLegNetFare(g1ToMw, s1ToMw[loUk1MwIdx], s1ToMw[s1ToMw.length - 1], s1ToMw, false);
  assert.equal(fareLoUkToMw.rebateAmount, 0, 'NLB 1 Lo Uk Tsuen -> Mui Wo must not claim a 2-way sectional rebate');

  // 4. NLB 1 -> Tai O: Lo Uk Tsuen STILL needs driver notice ($11.9 full fare vs cheaper village stops)
  const g1ToTo = findGroup('1', /Tai O/i);
  assert.ok(g1ToTo, 'NLB 1 to Tai O must exist in bus_index.min.json');
  const s1ToTo = unpacked.routeStopsCache[g1ToTo.routeIds[0]];
  const loUk1ToIdx = s1ToTo.findIndex((s: any) => /Lo Uk Tsuen/i.test(s.stopName_e));
  assert.ok(loUk1ToIdx >= 5);
  assert.equal(hasStopTwoWaySectionalFare(g1ToTo, s1ToTo, loUk1ToIdx, false), true, 'NLB 1 -> Tai O at Lo Uk Tsuen still requires telling driver');
});

test('planner.js: Lo Uk Tsuen -> Airport MTR Station at 23:29 eliminates S1 -> AEL overshoot-and-backtrack loop', () => {
  const unpacked = loadUnpackedBusIndexForTest();
  const html = readAppBundle();
  const stepSecMatch = html.match(/function computeSegmentStepSeconds\([\s\S]*?\n\}/);
  assert.ok(stepSecMatch, 'computeSegmentStepSeconds must exist in index.html');
  const stepCtx: any = { getCorridorLiveStatusAt: () => ({ status: 'SMOOTH', speedKmh: 70 }) };
  vm.createContext(stepCtx);
  vm.runInContext(stepSecMatch[0], stepCtx);

  const sb = loadHardcodeAndPlannerSandbox({
    groupedRoutes: unpacked.groupedRoutes,
    routeStopsCache: unpacked.routeStopsCache,
    routeMapIndex: unpacked.routeMapIndex,
    allStops: unpacked.allStops,
    stopMapIndex: unpacked.stopMapIndex,
    getStopsForGroup: (g: any) => unpacked.routeStopsCache[g?.routeIds?.[0]] || [],
    initRouteMapFast: () => {},
    isParallelRailTerminusPair: () => false,
    isAirportOrPortZone: (la: number, lo: number, n = '') =>
      (la >= 22.29 && la <= 22.33 && lo >= 113.89 && lo <= 113.96) || /airport|asiaworld|機場|博覽館/i.test(n),
    isLantauOrAirportZone: () => true,
    isRouteActiveAtPlannerTime: () => true,
    computeSegmentStepSeconds: stepCtx.computeSegmentStepSeconds,
  });

  const loUk = unpacked.allStops.find((s: any) => s.stopKey === 'NLB_4969E3B1DFC2')
    || unpacked.allStops.find((s: any) => /Lo Uk Tsuen/i.test(s.stopName_e) && Number(s.latitude) < 22.26);
  const airportMtr = unpacked.allStops.find((s: any) => s.stopKey === 'MTR_AIR')
    || unpacked.allStops.find((s: any) => s.stopId === 'AIR' || /Airport Station/i.test(s.stopName_e));
  assert.ok(loUk && airportMtr, 'Must find Lo Uk Tsuen and Airport MTR Station in bus_index.min.json');

  sb.ctx.userCommuteProfile = {
    home: { stopKey: loUk.stopKey, stopName_e: loUk.stopName_e, lat: parseFloat(loUk.latitude), lon: parseFloat(loUk.longitude) },
    work: { stopKey: airportMtr.stopKey, stopName_e: airportMtr.stopName_e, lat: parseFloat(airportMtr.latitude), lon: parseFloat(airportMtr.longitude) },
  };
  sb.ctx.xferTimeMode = 'DEPART';
  sb.ctx.xferSortPref = 'BEST';

  const spec = sb.buildFromToEdgeRequestSpec(new Date('2026-11-23T23:29:00+08:00'));
  assert.ok(spec, 'Should resolve routes from Lo Uk Tsuen to Airport MTR Station');

  const chains = (spec.transferCorridors || []).map((c: any) => String(c.chainKey || ''));
  const hasLoop = chains.some((ch: string) => /S1>MTR_AEL/.test(ch));
  assert.equal(hasLoop, false, `Must never suggest S1>MTR_AEL overshoot+backtrack loop, got: ${chains.join(', ')}`);
  const has3mS1 = chains.some((ch: string) => /NLB_3M>(CTB|LWB)_S1$/.test(ch));
  assert.equal(has3mS1, true, `Expected direct 3M>S1 transfer option, got: ${chains.join(', ')}`);
});

test('hardcode.js: Tuesday 08:04 AM South Lantau NLB 1 & NLB 4 to Mui Wo at Lo Uk Tsuen report Seats (LOW) even on 46m headway gap', () => {
  const { LoadFactorEngine } = loadHardcodeAndPlannerSandbox();
  const tue0804 = new Date(2026, 10, 24, 8, 4, 0); // Tuesday 08:04 AM HKT

  const g1Mw = { company: 'NLB', routeNo: '1', mode: 'BUS', headwayMins: 12, orig_e: 'Tai O', dest_e: 'Mui Wo Ferry Pier' };
  const g4Mw = { company: 'NLB', routeNo: '4', mode: 'BUS', headwayMins: 20, orig_e: 'Tong Fuk', dest_e: 'Mui Wo Ferry Pier' };

  const load1Live = LoadFactorEngine.inferBusLoad({
    group: g1Mw,
    stopIdx: 37,
    totalStops: 52,
    obsHeadwaySec: 2760, // 08:17 -> 09:03 46m gap seen in screenshot
    schedHeadwaySec: 720,
    isSched: false,
    dateObj: tue0804,
    isHoliday: false,
  });
  const load1Sched = LoadFactorEngine.inferBusLoad({
    group: g1Mw,
    stopIdx: 37,
    totalStops: 52,
    obsHeadwaySec: 2760,
    schedHeadwaySec: 720,
    isSched: true,
    dateObj: tue0804,
    isHoliday: false,
  });
  const load4Live = LoadFactorEngine.inferBusLoad({
    group: g4Mw,
    stopIdx: 12,
    totalStops: 25,
    obsHeadwaySec: 2340,
    schedHeadwaySec: 1200,
    isSched: false,
    dateObj: tue0804,
    isHoliday: false,
  });

  assert.equal(load1Live.tier, 'LOW', `Tuesday 08:04 NLB 1 live must be Seats/LOW (got ${load1Live.pct}% ${load1Live.labelEn})`);
  assert.equal(load1Sched.tier, 'LOW', `Tuesday 08:04 NLB 1 sched must be Seats/LOW (got ${load1Sched.pct}% ${load1Sched.labelEn})`);
  assert.equal(load4Live.tier, 'LOW', `Tuesday 08:04 NLB 4 live must be Seats/LOW (got ${load4Live.pct}% ${load4Live.labelEn})`);
});

test("index.html: versioned onboarding 'Don't show again' persists for current guide version, re-pops on guide update, and removes duplicate About guide button", () => {
  const html = readAppBundle();
  assert.ok(html.includes('id="tutorialDontShowCheckbox"'), 'Tutorial modal must render Dont show again checkbox');
  assert.ok(!html.includes('id="aboutResetGuideBtn"'), 'Duplicate Visual Guide button in About modal must be removed');

  const mCookieConsts = html.match(/const TUTORIAL_CONTENT_VERSION = [\s\S]*?const TUTORIAL_SLIDE_COUNT = 7;/);
  const mFns = html.match(/function setOnboardingDismissedCookie[\s\S]*?function hasOnboardingDismissedCookie[\s\S]*?\}\n\}/);
  const mMaybe = html.match(/function maybeShowFirstVisitOnboarding[\s\S]*?\n\}/);
  assert.ok(mCookieConsts && mFns && mMaybe, 'Versioned onboarding cookie helpers must exist in index.html');

  const store = new Map<string, string>();
  let cookieJar = '';
  let modalOpenedCount = 0;
  const sb: any = {
    URLSearchParams,
    window: { location: { search: '' } },
    document: {
      get cookie() { return cookieJar; },
      set cookie(val: string) {
        const kv = String(val).split(';')[0];
        if (/max-age=0/i.test(val)) {
          cookieJar = '';
        } else {
          cookieJar = kv;
        }
      },
      getElementById: () => ({ style: { display: 'none' } }),
    },
    SafeStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
    },
    openTutorialModal: () => { modalOpenedCount += 1; },
  };
  vm.createContext(sb);
  vm.runInContext(`${mCookieConsts[0]}\n${mFns[0]}\n${mMaybe[0]}`, sb);

  // 1. Fresh user sees onboarding automatically once
  sb.maybeShowFirstVisitOnboarding(false);
  assert.equal(modalOpenedCount, 1);

  // 2. User ticks "Don't show again until guide updates" -> stores versioned cookie
  sb.setOnboardingDismissedCookie(true);
  assert.ok(cookieJar.includes('transit_onboarding_dismissed='));
  assert.equal(sb.hasOnboardingDismissedCookie(), true);

  // 3. Clearing localStorage still honors cookie for the SAME guide version
  store.clear();
  assert.equal(sb.hasOnboardingDismissedCookie(), true);
  sb.maybeShowFirstVisitOnboarding(false);
  assert.equal(modalOpenedCount, 1, 'Cookie must keep onboarding dismissed for the same guide version');

  // 4. When TUTORIAL_CONTENT_VERSION bumps to a new edition, hasOnboardingDismissedCookie(newVer) is false (re-pops once!)
  assert.equal(sb.hasOnboardingDismissedCookie('2026-12-01'), false, 'Bumping tutorial version must re-show guide even if user dismissed old version');
});

test('worker.js: parses HKSAR strategic road CSV, valid-only speed XML lanes, UTF-16LE TD cameras, and traffic_live payload', async () => {
  const csvSample = [
    'AID_ID_Number,District,Road_EN,Road_TC,Latitude,Longitude,Direction,Rotation',
    'AID03101,Tuen Mun,Tuen Mun Rd [AID03101],屯門公路 [AID03101],22.3712,113.9721,North Bound,32',
    'AID03102,Tuen Mun,Tuen Mun Rd,屯門公路,22.3714,113.9723,South Bound,212',
    'BADROW,Nowhere,Invalid,無效,99.9,0,East,90',
  ].join('\n');

  const xmlSample = `<?xml version="1.0" encoding="UTF-8"?>
    <raw_speed_volume_list>
      <date>2026-11-24</date>
      <period_to>08:45:00</period_to>
      <detectors>
        <detector>
          <detector_id>AID03101</detector_id>
          <lanes>
            <lane><lane_id>Fast</lane_id><speed>72</speed><occupancy>14</occupancy><volume>18</volume><valid>Y</valid></lane>
            <lane><lane_id>Slow</lane_id><speed>64</speed><occupancy>22</occupancy><volume>12</volume><valid>Y</valid></lane>
            <lane><lane_id>Broken</lane_id><speed>0</speed><occupancy>99</occupancy><volume>0</volume><valid>N</valid></lane>
          </lanes>
        </detector>
        <detector>
          <detector_id>AID03102</detector_id>
          <lanes>
            <lane><lane_id>Fast</lane_id><speed>20</speed><occupancy>88</occupancy><volume>25</volume><valid>Y</valid></lane>
            <lane><lane_id>Slow</lane_id><speed>24</speed><occupancy>92</occupancy><volume>21</volume><valid>Y</valid></lane>
          </lanes>
        </detector>
      </detectors>
    </raw_speed_volume_list>`;

  const camTsvText = [
    'key\tdistrict\troad_type\tdescription\teasting\tnorthing\tlatitude\tlongitude\turl',
    'TM105F\tTuen Mun\tMajor Road\tTuen Mun Rd near Siu Lam [TM105F]\t814500\t825100\t22.3715\t113.9722\thttps://tdcctv.data.one.gov.hk/TM105F.JPG',
  ].join('\n');
  // Encode camTsvText as UTF-16LE with FF FE BOM (matches HKSAR TD camera TSV encoding)
  const utf16Bytes = new Uint8Array(2 + camTsvText.length * 2);
  utf16Bytes[0] = 0xFF;
  utf16Bytes[1] = 0xFE;
  for (let i = 0; i < camTsvText.length; i++) {
    const code = camTsvText.charCodeAt(i);
    utf16Bytes[2 + i * 2] = code & 0xFF;
    utf16Bytes[2 + i * 2 + 1] = (code >> 8) & 0xFF;
  }

  const mockFetch = async (url: string) => {
    const u = String(url);
    const mkRes = (bodyText: string, buf?: ArrayBuffer) => ({
      ok: true,
      status: 200,
      text: async () => bodyText,
      arrayBuffer: async () => buf || new ArrayBuffer(0),
      clone() { return this; },
    });
    if (u.includes('traffic_speed_volume_occ_info.csv')) return mkRes(csvSample);
    if (u.includes('traffic_speed_volume_occ_info-slp.csv')) return mkRes('AID_ID_Number,District,Road_EN,Road_TC,Latitude,Longitude,Direction,Rotation\n');
    if (u.includes('Traffic_Camera_Locations_En.csv')) return mkRes('', utf16Bytes.buffer);
    if (u.includes('rawSpeedVol-all.xml')) return mkRes(xmlSample);
    if (u.includes('rawSpeedVol_SLP-all.xml')) return mkRes('<raw_speed_volume_list></raw_speed_volume_list>');
    return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };

  const w = loadWorkerSandbox({ fetch: mockFetch });

  assert.equal(w.classifyDetectorCongestion(68, 18), 'SMOOTH');
  assert.equal(w.classifyDetectorCongestion(38, 42), 'SLOW');
  assert.equal(w.classifyDetectorCongestion(22, 90), 'JAMMED');
  assert.equal(w.classifyDetectorCongestion(34, 65), 'JAMMED');

  const meta = w.parseStrategicDetectorCsv(csvSample);
  assert.equal(meta.size, 2);
  assert.equal(meta.get('AID03101').roadEn, 'Tuen Mun Rd');
  assert.equal(meta.get('AID03101').rot, 32);

  const parsedXml = w.parseRawSpeedVolXml(xmlSample);
  assert.equal(parsedXml.capturedAt, '2026-11-24 08:45:00');
  assert.equal(parsedXml.liveMap.get('AID03101').speed, 68, 'Must average only valid=Y lanes (72 & 64 -> 68)');
  assert.equal(parsedXml.liveMap.get('AID03101').vol, 30);

  const decodedCam = w.decodeTextBufferAuto(utf16Bytes.buffer);
  const cams = w.parseTrafficCameraCsv(decodedCam);
  assert.equal(cams.length, 1);
  assert.equal(cams[0].key, 'TM105F');
  assert.equal(cams[0].desc, 'Tuen Mun Rd near Siu Lam');

  const res = await w.onRequest({ request: { method: 'GET', url: 'https://example.com/api/worker?action=traffic_live' } });
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.stats.total, 2);
  assert.equal(json.stats.smooth, 1);
  assert.equal(json.stats.jammed, 1);
  const nb = json.detectors.find((d: any) => d.id === 'AID03101');
  const sb = json.detectors.find((d: any) => d.id === 'AID03102');
  assert.equal(nb.tier, 'SMOOTH');
  assert.equal(nb.camKey, 'TM105F', 'Detector must link closest TD snapshot camera');
  assert.equal(sb.tier, 'JAMMED');
});

test('hardcode.js & planner.js: directional road inference distinguishes smooth bus side from jammed opposite carriageway', () => {
  const sb = loadHardcodeAndPlannerSandbox();

  // Model E36 Northbound from Tung Chung -> TM-CLK Tunnel -> Tuen Mun / Yuen Long (bearings ~20-40 deg)
  const e36Stops = [
    { stopKey: 'KMB_YTC', stopName_e: 'Yu Tung Court', latitude: '22.2840', longitude: '113.9410' },
    { stopKey: 'KMB_TMCLK', stopName_e: 'Tuen Mun - Chek Lap Kok Tunnel', latitude: '22.3450', longitude: '113.9630' },
    { stopKey: 'KMB_YLC', stopName_e: 'Yuen Long (West)', latitude: '22.4440', longitude: '114.0220' },
  ];

  const b1 = sb.computeBearingDeg(22.2840, 113.9410, 22.3450, 113.9630);
  const b2 = sb.computeBearingDeg(22.3450, 113.9630, 22.4440, 114.0220);
  assert.ok(b1 > 10 && b1 < 40, `Expected NNE bearing toward TM-CLK, got ${b1}`);
  assert.ok(b2 > 20 && b2 < 50, `Expected NE bearing toward Yuen Long, got ${b2}`);
  assert.equal(Math.round(sb.angularDiffDeg(355, 5)), 10);

  const detectors = [
    // Bus direction (Northbound ~32 deg) — smooth 68 km/h
    { id: 'AID_NB1', lat: 22.3465, lon: 113.9640, rot: 32, spd: 68, occ: 18, tier: 'SMOOTH', roadEn: 'TM-CLK Link', roadTc: '屯赤連接路', camKey: 'TM105F' },
    // Opposite bound (~210 deg) — jammed 22 km/h (passenger saw jam across median)
    { id: 'AID_SB1', lat: 22.3466, lon: 113.9642, rot: 210, spd: 22, occ: 92, tier: 'JAMMED', roadEn: 'TM-CLK Link', roadTc: '屯赤連接路', camKey: 'TM105F' },
  ];

  const sumEn = sb.getDirectionalRoadSummary(e36Stops, 0, detectors, false, 14);
  assert.ok(sumEn, 'Expected directional road summary');
  assert.equal(sumEn.tone, 'smooth', 'Same-direction traffic is smooth despite opposite-side jam');
  assert.equal(sumEn.modeRec, 'TAKE_BUS');
  assert.ok(sumEn.headline.includes('Traffic clear ahead') && !/Take Bus|Switch to MTR/i.test(sumEn.headline), `Unexpected EN headline: ${sumEn.headline}`);
  assert.ok(!sumEn.detail.includes('Opp. bound jammed'), `Forward summary must NOT inject Opp. bound jammed: ${sumEn.detail}`);

  const sumZh = sb.getDirectionalRoadSummary(e36Stops, 0, detectors, true, 14);
  assert.ok(sumZh.headline.includes('前路暢通') && !/可乘巴士|改乘港鐵/.test(sumZh.headline), `Unexpected ZH headline: ${sumZh.headline}`);
  assert.ok(!sumZh.detail.includes('對面線塞車'), `Forward ZH summary must NOT inject opposite-bound jam: ${sumZh.detail}`);

  // Opposite scenario: bus's OWN direction ahead is jammed (19 km/h, 94% occ -> severe jam, neutral traffic signal without assumptive MTR advice)
  const jammedDetectors = [
    { id: 'AID_NB_JAM', lat: 22.3465, lon: 113.9640, rot: 28, spd: 19, occ: 94, tier: 'JAMMED', roadEn: 'Tuen Mun Rd', roadTc: '屯門公路', camKey: 'TM108F' },
  ];
  const jammedSum = sb.getDirectionalRoadSummary(e36Stops, 0, jammedDetectors, false, 14);
  assert.equal(jammedSum.tone, 'jammed');
  assert.equal(jammedSum.modeRec, 'SWITCH_MTR');
  assert.ok(jammedSum.headline.includes('Jammed on Tuen Mun Rd (+15m)') && !/Switch to MTR/i.test(jammedSum.headline), `Unexpected jammed headline: ${jammedSum.headline}`);
  assert.ok(jammedSum.detail.includes('TD Sensor · High conf.') && !/km\/h/i.test(jammedSum.detail), `Unexpected jammed detail: ${jammedSum.detail}`);

  // Planner leg inline road badge when live detectors loaded
  sb.ctx.window.__LIVE_TRAFFIC_DETECTORS__ = detectors;
  const gE36 = { key: 'KMB_E36_O', mode: 'BUS', company: 'KMB', routeNo: 'E36', _stops: e36Stops };
  const legRoadHtml = sb.buildPlannerLegRoadTrafficTagHtml(gE36, e36Stops[0], e36Stops[2], false);
  assert.ok(legRoadHtml.includes('68 km/h') && !legRoadHtml.includes('~68 km/h') && legRoadHtml.includes('planner-sig-road-smooth'), `Expected clean smooth road badge without tilde in planner leg, got: ${legRoadHtml}`);

  // False expressway rejection: NLB 3M starting at Tung Chung Station -> Fu Tung Plaza -> Tung Chung Rd
  // MUST NOT match nearby North Lantau Highway near Tung Chung (N)
  const nlb3mLocalStops = [
    { stopKey: 'NLB_TC', stopName_e: 'Tung Chung Station Bus Terminus', latitude: '22.2895', longitude: '113.9415' },
    { stopKey: 'NLB_FT', stopName_e: 'Fu Tung Plaza', latitude: '22.2877', longitude: '113.9432' },
    { stopKey: 'NLB_YT', stopName_e: 'Yu Tung Court', latitude: '22.2842', longitude: '113.9410' },
    { stopKey: 'NLB_LM', stopName_e: 'Lung Tseng Tau', latitude: '22.2788', longitude: '113.9388' },
  ];
  const nlhDet = [
    { id: 'AID_NLH_TC', lat: 22.2908, lon: 113.9438, rot: 120, spd: 100, occ: 1, tier: 'SMOOTH', roadEn: 'North Lantau Highway near Tung Chung (N) - Eastbound (2)', roadTc: '北大嶼山公路近東涌(北)', camKey: 'NLH01F' }
  ];
  const falseMatch = sb.getDirectionalRoadSummary(nlb3mLocalStops, 0, nlhDet, false, 8);
  assert.equal(falseMatch, null, 'Local Tung Chung Rd bus (NLB 3M) must NEVER falsely attach North Lantau Highway expressway detector');
});

test('hardcode.js & planner.js: GPS coordinate paste (DMS & decimal), BULLETPROOF rail-vs-3-bus ranking, durable Home/Work cookies, and fast non-blocking boot', () => {
  const sb = loadHardcodeAndPlannerSandbox();

  // 1. GPS Coordinate parser (Google Maps DMS + Decimal + out-of-HK rejection)
  const dms = sb.parseHkGpsCoordinates(`22°26'24.1"N 114°03'42.6"E`);
  assert.ok(dms, 'Must parse Google Maps DMS coordinate string');
  assert.ok(Math.abs(dms.lat - 22.440028) < 0.0005, `Unexpected DMS lat: ${dms.lat}`);
  assert.ok(Math.abs(dms.lon - 114.061833) < 0.0005, `Unexpected DMS lon: ${dms.lon}`);

  const dec = sb.parseHkGpsCoordinates('22.4400, 114.0618');
  assert.ok(dec && Math.abs(dec.lat - 22.44) < 0.0001 && Math.abs(dec.lon - 114.0618) < 0.0001);
  assert.equal(sb.parseHkGpsCoordinates('40.7128, -74.0060'), null, 'Out-of-HK coordinates must be rejected');
  assert.equal(sb.parseHkGpsCoordinates('Kam Tin Rd'), null, 'Plain text must not parse as GPS');

  // 2. BULLETPROOF (Best) ranking: 3M > TCL > TML > Walk 10m (99m) beats slower 3M > E36 > 72 (111m)
  sb.ctx.xferSortPref = 'BULLETPROOF';
  const railRouteScore = sb.computeDisruptionAdjustedScore(
    99,
    [
      { group: { mode: 'BUS', company: 'NLB', routeNo: '3M', headwayMins: 15 }, stopsCount: 16 },
      { group: { mode: 'MTR', company: 'MTR', routeNo: 'TCL', headwayMins: 5 }, stopsCount: 4 },
      { group: { mode: 'MTR', company: 'MTR', routeNo: 'TML', headwayMins: 4 }, stopsCount: 3 },
    ],
    0,
    600,
    ['TUC', 'NAC'],
    40.3,
    [],
    60,
    { egressWalkDistM: 750, queryDate: new Date('2026-11-24T13:15:00+08:00') }
  );
  const threeBusScore = sb.computeDisruptionAdjustedScore(
    111,
    [
      { group: { mode: 'BUS', company: 'NLB', routeNo: '3M', headwayMins: 15 }, stopsCount: 16 },
      { group: { mode: 'BUS', company: 'KMB', routeNo: 'E36', headwayMins: 20 }, stopsCount: 14 },
      { group: { mode: 'BUS', company: 'GMB', routeNo: '72', headwayMins: 8 }, stopsCount: 8 },
    ],
    0,
    60,
    [],
    31.6,
    [],
    60,
    { egressWalkDistM: 75, queryDate: new Date('2026-11-24T13:15:00+08:00') }
  );
  assert.ok(
    railRouteScore < threeBusScore,
    `Expected faster rail-core 3M>TCL>TML (score=${railRouteScore.toFixed(1)}) to outrank slower 3-bus 3M>E36>72 (score=${threeBusScore.toFixed(1)})`
  );

  // 3. SavedHubsManager durable cookie backup survives localStorage clear
  let hubCookie = '';
  const memStore = new Map<string, string>();
  const sbHubs = loadHardcodeAndPlannerSandbox({
    SafeStorage: {
      getItem: (k: string) => memStore.get(k) ?? null,
      setItem: (k: string, v: string) => memStore.set(k, String(v)),
      removeItem: (k: string) => memStore.delete(k),
    },
    document: {
      get cookie() { return hubCookie; },
      set cookie(val: string) {
        const kv = String(val).split(';')[0];
        if (/max-age=0/i.test(val)) hubCookie = '';
        else hubCookie = kv;
      },
      getElementById: () => null,
      addEventListener: () => {},
    },
    stripPlatformCodeFromDisplay: (s: string) => String(s || ''),
  });
  sbHubs.SavedHubsManager.setHub('home', { stopKey: 'NLB_LOUK', stopName_e: 'Lo Uk Tsuen', name_tc: '羅屋村', lat: 22.2422, lon: 113.9721 });
  assert.ok(hubCookie.includes('transit_hw_hubs_v1='), 'Setting Home stop must write durable transit_hw_hubs_v1 cookie');
  memStore.clear();
  const recovered = sbHubs.SavedHubsManager.getHubs();
  assert.equal(recovered.home?.stopKey, 'NLB_LOUK', 'Home stop must recover cleanly from cookie when localStorage is wiped');

  // 4. Fast PWA boot: no render-blocking unpkg Leaflet <link>/<script> in index.html, decision modal present
  const html = readAppBundle();
  assert.ok(!/<script[^>]+src=["']https:\/\/unpkg\.com\/leaflet/i.test(html), 'Must NOT have render-blocking unpkg.com Leaflet <script> in <head>');
  assert.ok(!/<link[^>]+href=["']https:\/\/unpkg\.com\/leaflet/i.test(html), 'Must NOT have render-blocking unpkg.com Leaflet <link> in <head>');
  assert.ok(html.includes('window.ensureLeafletLoaded'), 'Must define async multi-CDN ensureLeafletLoaded');
  assert.ok(html.includes('id="trafficDecisionModal"') && html.includes('window.openTrafficDecisionModal'), 'Must include uncropped Traffic Decision & Road Cam modal');
});

test('hardcode.js: findOppositeDirectionGroup swaps NLB 3M, NLB 1, KMB, and LWB E36 both ways while rejecting single-direction routes', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const db = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));
  const groups = db.groupedRoutes;
  assert.ok(Array.isArray(groups) && groups.length > 500, 'bus_index.min.json must contain groupedRoutes');

  // 1. NLB 3M: Mui Wo Ferry Pier <-> Tung Chung Station Bus Terminus (no _O/_I in routeIds!)
  const nlb3mToMw = groups.find((g: any) => g.company === 'NLB' && g.routeNo === '3M' && /Mui Wo/i.test(g.dest_e));
  const nlb3mToTc = groups.find((g: any) => g.company === 'NLB' && g.routeNo === '3M' && /Tung Chung/i.test(g.dest_e));
  assert.ok(nlb3mToMw && nlb3mToTc, 'bus_index.min.json must contain both NLB 3M directions');

  const swapFromMw = sb.findOppositeDirectionGroup(nlb3mToMw, groups);
  assert.equal(swapFromMw?.key, nlb3mToTc.key, 'Swapping NLB 3M (To Mui Wo) must switch to Tung Chung Station Bus Terminus');

  const swapFromTc = sb.findOppositeDirectionGroup(nlb3mToTc, groups);
  assert.equal(swapFromTc?.key, nlb3mToMw.key, 'Swapping NLB 3M (To Tung Chung) must switch back to Mui Wo Ferry Pier');

  // Also test destination-based fallback even when tdBound is stripped!
  const strippedMw = { ...nlb3mToMw, tdBound: undefined };
  const strippedTc = { ...nlb3mToTc, tdBound: undefined };
  assert.equal(sb.findOppositeDirectionGroup(strippedMw, [strippedMw, strippedTc])?.key, strippedTc.key);
  assert.equal(sb.findOppositeDirectionGroup(strippedTc, [strippedMw, strippedTc])?.key, strippedMw.key);

  // 2. NLB 1: Mui Wo <-> Tai O
  const nlb1ToTaiO = groups.find((g: any) => g.company === 'NLB' && g.routeNo === '1' && /Tai O/i.test(g.dest_e));
  const nlb1ToMw = groups.find((g: any) => g.company === 'NLB' && g.routeNo === '1' && /Mui Wo/i.test(g.dest_e));
  assert.ok(nlb1ToTaiO && nlb1ToMw, 'bus_index.min.json must contain both NLB 1 directions');
  assert.equal(sb.findOppositeDirectionGroup(nlb1ToTaiO, groups)?.key, nlb1ToMw.key);
  assert.equal(sb.findOppositeDirectionGroup(nlb1ToMw, groups)?.key, nlb1ToTaiO.key);

  // 3. Explicit _O / _I route (LWB E36)
  const e36Air = groups.find((g: any) => g.routeNo === 'E36' && /Airport/i.test(g.dest_e));
  const e36Phr = groups.find((g: any) => g.routeNo === 'E36' && /Pat Heung/i.test(g.dest_e));
  assert.ok(e36Air && e36Phr, 'bus_index.min.json must contain both E36 directions');
  assert.equal(sb.findOppositeDirectionGroup(e36Air, groups)?.key, e36Phr.key);
  assert.equal(sb.findOppositeDirectionGroup(e36Phr, groups)?.key, e36Air.key);

  // 4. Genuine single-direction / circular route with only one group returns null
  const circularOnly = { key: 'KMB_999C_O', mode: 'BUS', company: 'KMB', routeNo: '999C', orig_e: 'Central', dest_e: 'Central (Circular)', routeIds: ['KMB_999C_O_1'] };
  assert.equal(sb.findOppositeDirectionGroup(circularOnly, [circularOnly]), null);
});

test('hardcode.js: detects curved Tuen Mun highway jams between two far-apart E36 stops and approaching jams upstream of Stop 16', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const db = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));

  // Load real LWB E36 -> Airport stops from bus_index.min.json
  const e36ToAirport = db.groupedRoutes.find((g: any) => g.routeNo === 'E36' && /Airport/i.test(g.dest_e));
  assert.ok(e36ToAirport, 'bus_index.min.json must contain E36 To Airport');
  const rawStops = db.routeStopsCache[e36ToAirport.routeIds[0]];
  assert.ok(Array.isArray(rawStops) && rawStops.length > 16, 'Expected full E36 stop list');
  const stops = rawStops.map((entry: any) => {
    const idx = Array.isArray(entry) ? entry[0] : entry;
    const s = db.stopsDict[idx];
    return { stopKey: `S_${s[0]}`, stopName_e: s[1], name_tc: s[2], latitude: String(s[3]), longitude: String(s[4]) };
  });

  const ylParkIdx = stops.findIndex((s: any) => /Yuen Long Park/i.test(s.stopName_e));
  const tmClkIdx = stops.findIndex((s: any) => /Tuen Mun.*Chek Lap Kok.*Tunnel/i.test(s.stopName_e));
  assert.ok(ylParkIdx >= 0 && tmClkIdx === ylParkIdx + 1, `Expected Yuen Long Park immediately before TM-CLK Tunnel BBI (got ${ylParkIdx} -> ${tmClkIdx})`);

  // Realistic TD detectors in Tuen Mun along E36's curved path between Stop 15 (Yuen Long Park) & Stop 16 (TM-CLK Tunnel BBI):
  // - Wong Chu Road westbound (near Yau Oi, ~1.1 km off straight chord, heading 252 deg) -> JAMMED 18 km/h
  // - Tuen Mun Road northbound opposite bound (heading 42 deg) -> SMOOTH 72 km/h
  // - North Lantau Highway / TM-CLK ahead of Stop 16 (heading 186 deg) -> SMOOTH 90 km/h
  const detectors = [
    {
      id: 'AID_TM_WCR_WB',
      lat: 22.3852,
      lon: 113.9722,
      rot: 252,
      spd: 18,
      occ: 88,
      tier: 'JAMMED',
      roadEn: 'Wong Chu Road (Tuen Mun)',
      roadTc: '皇珠路 (屯門)',
      camKey: 'TM112F'
    },
    {
      id: 'AID_TM_TMR_NB',
      lat: 22.3925,
      lon: 113.9768,
      rot: 42,
      spd: 72,
      occ: 16,
      tier: 'SMOOTH',
      roadEn: 'Tuen Mun Road Northbound',
      roadTc: '屯門公路北行',
      camKey: 'TM105F'
    },
    {
      id: 'AID_TMCLK_SB',
      lat: 22.3270,
      lon: 113.9445,
      rot: 186,
      spd: 90,
      occ: 4,
      tier: 'SMOOTH',
      roadEn: 'Tuen Mun - Chek Lap Kok Tunnel',
      roadTc: '屯門赤鱲角隧道',
      camKey: 'TM120F'
    }
  ];

  // 1. At Stop 15 (Yuen Long Park): detects the Tuen Mun jam BETWEEN Yuen Long Park -> TM-CLK Tunnel BBI
  const sumAtYlParkEn = sb.getDirectionalRoadSummary(stops, ylParkIdx, detectors, false, 8);
  assert.ok(sumAtYlParkEn, 'Expected traffic summary at Yuen Long Park');
  assert.equal(sumAtYlParkEn.tone, 'jammed', 'Must catch curved Wong Chu Road jam between Stop 15 and Stop 16');
  assert.equal(sumAtYlParkEn.isApproaching, false);
  assert.equal(sumAtYlParkEn.focusDet?.id, 'AID_TM_WCR_WB');
  assert.ok(sumAtYlParkEn.betweenLabel.includes('Yuen Long Park') && sumAtYlParkEn.betweenLabel.includes('Tuen Mun'), `Expected between-stops label, got: ${sumAtYlParkEn.betweenLabel}`);
  assert.ok(sumAtYlParkEn.detail.includes('Wong Chu Road'), `Expected road name in detail, got: ${sumAtYlParkEn.detail}`);

  const sumAtYlParkZh = sb.getDirectionalRoadSummary(stops, ylParkIdx, detectors, true, 8);
  assert.ok(sumAtYlParkZh.betweenLabel.includes('之間'), `Expected Chinese between-stops label, got: ${sumAtYlParkZh.betweenLabel}`);

  // 2. At Stop 16 (TM-CLK Tunnel BBI): strict forward-only lookahead must match ONLY the downstream TM-CLK tunnel (90 km/h)
  // and NEVER pull the upstream Wong Chu Road jam located behind Stop 16!
  const sumAtBbiEn = sb.getDirectionalRoadSummary(stops, tmClkIdx, detectors, false, 8);
  assert.ok(sumAtBbiEn, 'Expected forward-only summary at TM-CLK Tunnel BBI');
  assert.equal(sumAtBbiEn.tone, 'smooth', 'Waiting at TM-CLK BBI must reflect only smooth road AHEAD, never upstream jam behind stop');
  assert.equal(sumAtBbiEn.isApproaching, false);
  assert.equal(sumAtBbiEn.focusDet?.id, 'AID_TMCLK_SB');

  const sumAtBbiZh = sb.getDirectionalRoadSummary(stops, tmClkIdx, detectors, true, 8);
  assert.equal(sumAtBbiZh.isApproaching, false);
  assert.equal(sumAtBbiZh.focusDet?.id, 'AID_TMCLK_SB');

  // 3. Opposite-direction-only detector in Tuen Mun MUST NOT trigger a false same-direction jam or inject an Opp. bound banner
  const oppOnlyDetectors = [
    { id: 'AID_TM_OPP_JAM', lat: 22.3925, lon: 113.9768, rot: 42, spd: 14, occ: 95, tier: 'JAMMED', roadEn: 'Tuen Mun Road Northbound', roadTc: '屯門公路北行', camKey: 'TM105F' }
  ];
  const oppOnlySum = sb.getDirectionalRoadSummary(stops, ylParkIdx, oppOnlyDetectors, false, 8);
  assert.equal(oppOnlySum, null, 'Opposite-bound-only Tuen Mun jam must NOT produce a forward traffic banner');
  const oppOnlyRaw = sb.inferDirectionalRoadTrafficForStops(stops, ylParkIdx, oppOnlyDetectors, 8);
  assert.equal(oppOnlyRaw.sameSide, null, 'Opposite-bound-only detector must not populate sameSide');
  assert.equal(oppOnlyRaw.oppSide?.status, 'JAMMED', 'Opposite-bound detector remains available in oppSide for camera switching');
});

test('map.js: slim clickable traffic arrows (20-22px inside 32x32 hit area), zoom-15 smooth hiding, left-hand lane separation, and N/S/E/W bound badges', () => {
  const mapCode = readMapBundle();
  const addedPolylines: any[] = [];
  const addedMarkers: any[] = [];
  const fakeLayerGroup = {
    addTo() { return this; },
    clearLayers() { addedPolylines.length = 0; addedMarkers.length = 0; },
    hasLayer() { return false; },
  };
  const modalCalls: any[] = [];
  const ctx: any = {
    window: {
      trafficLayerEnabled: true,
      openTrafficDecisionModal: (detId: string, oppId: string, segNote: string, isApp: boolean) => {
        modalCalls.push({ detId, oppId, segNote, isApp });
      },
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: string) => String(s ?? ''),
    escapeJsAttr: (s: string) => String(s ?? ''),
    L: {
      layerGroup: () => fakeLayerGroup,
      polyline: (latlngs: any, opts: any) => {
        const handlers: Record<string, Function> = {};
        const obj = { latlngs, opts, popupFn: null as any, tooltip: '', handlers, addTo() { addedPolylines.push(obj); return obj; }, bindTooltip(t: string) { obj.tooltip = t; return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; }, on(ev: string, fn: Function) { handlers[ev] = fn; return obj; } };
        return obj;
      },
      divIcon: (opts: any) => opts,
      marker: (latlng: any, opts: any) => {
        const handlers: Record<string, Function> = {};
        const obj = { latlng, opts, popupFn: null as any, tooltip: '', handlers, addTo() { addedMarkers.push(obj); return obj; }, bindTooltip(t: string) { obj.tooltip = t; return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; }, on(ev: string, fn: Function) { handlers[ev] = fn; return obj; } };
        return obj;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(mapCode, ctx);

  // 1. Directional bound classifier cleanly distinguishes N, S, E, W in EN & ZH with distinct badge colors
  const nb = ctx.window.classifyTrafficBoundMeta(12, '', false);
  const sb = ctx.window.classifyTrafficBoundMeta(195, '', false);
  const eb = ctx.window.classifyTrafficBoundMeta(92, '', true);
  const wb = ctx.window.classifyTrafficBoundMeta(268, '', true);
  assert.equal(nb.shortLabel, 'N');
  assert.equal(nb.fullLabel, 'Northbound');
  assert.equal(sb.shortLabel, 'S');
  assert.equal(sb.fullLabel, 'Southbound');
  assert.notEqual(nb.badgeBg, sb.badgeBg, 'Northbound and Southbound must have distinct badge colors');
  assert.equal(eb.shortLabel, '東');
  assert.equal(wb.shortLabel, '西');

  // 2. Render opposing Northbound (SMOOTH) & Southbound (JAMMED) detectors at the EXACT same coordinate at zoom 14
  ctx.window.__LIVE_TRAFFIC_DETECTORS__ = [
    { id: 'TMR_NB', lat: 22.3925, lon: 113.9768, rot: 15, spd: 72, occ: 16, tier: 'SMOOTH', roadEn: 'Tuen Mun Road', roadTc: '屯門公路', dir: 'Northbound', camKey: 'TM105F' },
    { id: 'TMR_SB', lat: 22.3925, lon: 113.9768, rot: 195, spd: 18, occ: 88, tier: 'JAMMED', roadEn: 'Tuen Mun Road', roadTc: '屯門公路', dir: 'Southbound', camKey: 'TM105F' },
  ];
  const fakeMapZ14 = {
    getBounds: () => ({ isValid: () => true, pad: () => ({ contains: () => true }) }),
    getZoom: () => 14,
  };
  ctx.window.renderTrafficOverlayOnMap(fakeMapZ14, true);

  // At zoom 14 (< 15), smooth flow renders ONLY as a clean left-hand offset road stripe while JAMMED renders the clickable arrow badge
  assert.equal(addedPolylines.length, 4, 'Both carriageways must still draw left-hand offset road stripes (2 casings + 2 flow lines)');
  assert.equal(addedMarkers.length, 1, 'Below zoom 15, smooth arrow badges must be hidden so only JAMMED/SLOW bottleneck arrows show');
  const sbMarkerZ14 = addedMarkers[0];
  assert.deepEqual(Array.from(sbMarkerZ14.opts.icon.iconSize), [32, 32], 'Slim 20-22px badge must sit inside transparent 32x32 hit area');
  assert.ok(sbMarkerZ14.opts.icon.html.includes('width="22"'), 'Jammed chevron SVG should be compact 22px');
  assert.ok(sbMarkerZ14.opts.icon.html.includes('>S<') && sbMarkerZ14.opts.icon.html.includes('#7C3AED'), 'Southbound arrow must display distinct S badge');
  assert.ok(sbMarkerZ14.opts.zIndexOffset <= 150, `Traffic arrow zIndexOffset (${sbMarkerZ14.opts.zIndexOffset}) must stay strictly below stop markers (320)`);

  // Physically offset opposite bounds onto left-hand HK carriageways so polylines do NOT stack identically
  const sbLine = addedPolylines[1]; // flowLine for SB
  const nbLine = addedPolylines[3]; // flowLine for NB
  const sbMidLon = (sbLine.latlngs[0][1] + sbLine.latlngs[1][1]) / 2;
  const nbMidLon = (nbLine.latlngs[0][1] + nbLine.latlngs[1][1]) / 2;
  assert.ok(Math.abs(sbMidLon - nbMidLon) > 0.0004, `Expected opposite carriageways to be laterally separated on map (dMidLon=${Math.abs(sbMidLon - nbMidLon)})`);

  // 3. At zoom 16, both opposing tips sit >52px apart so BOTH Southbound JAMMED and Northbound SMOOTH arrows render cleanly
  const fakeMapZ16 = {
    getBounds: () => ({ isValid: () => true, pad: () => ({ contains: () => true }) }),
    getZoom: () => 16,
  };
  ctx.window.renderTrafficOverlayOnMap(fakeMapZ16, true);
  assert.equal(addedMarkers.length, 2, 'At zoom 16 (>52px separation), both JAMMED SB and SMOOTH NB directional arrows render');
  const sbMarker = addedMarkers[0];
  const nbMarker = addedMarkers[1];
  assert.ok(nbMarker.opts.icon.html.includes('width="20"'), 'Smooth chevron SVG should be compact 20px');
  assert.ok(nbMarker.opts.icon.html.includes('>N<') && nbMarker.opts.icon.html.includes('#1D4ED8'), 'Northbound arrow must display distinct N badge');
  const dMarkerLat = Math.abs(sbMarker.latlng[0] - nbMarker.latlng[0]);
  assert.ok(dMarkerLat > 0.001, `Expected N/S arrow tips to be well separated for easy tapping (dMarkerLat=${dMarkerLat})`);

  // Bottleneck marker (JAMMED SB) must NOT bind duplicate Leaflet popup — clicking opens Verdict & Cam modal directly
  assert.equal(sbMarker.popupFn, null, 'Bottleneck marker must NOT bind redundant white Leaflet popup');
  assert.equal(typeof sbMarker.handlers.click, 'function', 'Bottleneck marker must bind click handler to open Verdict & Cam modal');
  sbMarker.handlers.click({});
  assert.equal(modalCalls.length, 1);
  assert.equal(modalCalls[0].detId, 'TMR_SB');
  assert.equal(modalCalls[0].oppId, 'TMR_NB', 'Direct bottleneck modal click should include opposite-bound detector ID');

  // Smooth browse-map marker retains clean popup with Northbound pill and no raw compass degree artifact
  const nbPopup = nbMarker.popupFn();
  assert.ok(nbPopup.includes('↑ Northbound') && nbPopup.includes('#1D4ED8'), 'Northbound popup must show Northbound pill');
  assert.ok(!nbPopup.includes('°'), 'Popup must strip raw compass degree telemetry artifacts');
});

test('hardcode.js, map.js & worker.js: road-snapped E36 polyline strictly matches YLH highway detectors (<=60m, ±30°) and rejects off-corridor Castle Peak Rd / LRT cameras', () => {
  const sb = loadHardcodeAndPlannerSandbox();

  // E36 stops: 11. TM-CLK Tunnel BBI -> 12. Fung Chi Tsuen (Pat Heung bound)
  const stops = [
    { stopId: 'E36_10', stopName_e: 'Yu Tung Court', latitude: '22.2882', longitude: '113.9436' },
    { stopId: 'E36_11', stopName_e: 'Tuen Mun Chek Lap Kok Tunnel BBI', latitude: '22.3716', longitude: '113.9636' },
    { stopId: 'E36_12', stopName_e: 'Fung Chi Tsuen', latitude: '22.4455', longitude: '114.0172' },
    { stopId: 'E36_13', stopName_e: 'Yuen Long Plaza', latitude: '22.4447', longitude: '114.0243' },
  ];

  // Road-snapped polyline along Lung Fu Rd -> Wong Chu Rd -> Yuen Long Highway (YLH) -> Shap Pat Heung Int -> Fung Chi Tsuen
  const e36RoadPolyline = [
    [22.2882, 113.9436],
    [22.3716, 113.9636],
    [22.3835, 113.9665],
    [22.3968, 113.9722],
    [22.4150, 113.9870],
    [22.4290, 113.9975], // YLH eastbound (~45° NE)
    [22.4385, 114.0075], // YLH approaching Shap Pat Heung Int (~45° NE)
    [22.4430, 114.0135],
    [22.4455, 114.0172],
    [22.4447, 114.0243],
  ];

  const detectors = [
    // Off-corridor Castle Peak Rd / Hung Shui Kiu LRT stop (~550m west of YLH) — MUST BE REJECTED
    {
      id: 'TDSCPRHSK10004',
      lat: 22.4342,
      lon: 113.9921,
      rot: 45,
      spd: 35,
      occ: 6,
      tier: 'SLOW',
      roadEn: 'Castle Peak Rd-Hung Shui Kiu near Hung Shui Kiu Light Rail Stop - Northbound',
      roadTc: '青山公路-洪水橋近洪水橋輕鐵站 - 北行',
      camKey: 'TDSCPRHSK10004',
    },
    // Off-corridor Tuen Mun Road near San Hui Market (~450m east of polyline) — MUST BE REJECTED when road-snapped
    {
      id: 'TDS90048',
      lat: 22.3962,
      lon: 113.9774,
      rot: 15,
      spd: 35,
      occ: 32,
      tier: 'SLOW',
      roadEn: 'Tuen Mun Road near San Hui Market - Northbound',
      roadTc: '屯門公路近新墟街市 - 北行',
      camKey: 'TDS90048',
    },
    // True on-corridor YLH detector right on the road-snapped polyline (~15m away, bearing ~45° aligned)
    {
      id: 'TDS90067',
      lat: 22.4338,
      lon: 114.0025,
      rot: 46,
      spd: 82,
      occ: 12,
      tier: 'SMOOTH',
      roadEn: 'YLH/Shap Pat Heung Int - Eastbound (1)',
      roadTc: '元朗公路近十八鄉交匯處 - 東行 (1)',
      camKey: 'TDS90067',
    },
    // Opposite-bound jammed detector on YLH (~180° opposite) — must be surfaced ONLY as oppSide
    {
      id: 'TDS90068',
      lat: 22.4337,
      lon: 114.0027,
      rot: 226,
      spd: 14,
      occ: 91,
      tier: 'JAMMED',
      roadEn: 'YLH/Shap Pat Heung Int - Westbound (1)',
      roadTc: '元朗公路近十八鄉交匯處 - 西行 (1)',
      camKey: 'TDS90068',
    },
  ];

  // 0. Cross-tunnel lookahead cap: at Yu Tung Court (Lantau, startIdx=0), MUST NOT cross TM-CLKL subsea tunnel into Tuen Mun/Yuen Long
  assert.equal(sb.getDirectionalRoadSummary(stops, 0, detectors, false, 8, e36RoadPolyline), null, 'Lantau stop before TM-CLKL tunnel must NOT leak Tuen Mun / Yuen Long highway alerts');

  // 1. At TM-CLK Tunnel BBI (startIdx=1) with road-snapped polyline: strictly locks onto TDS90067 (YLH) and preserves opposite-bound jam callout
  const sumRoadSnapped = sb.getDirectionalRoadSummary(stops, 1, detectors, false, 8, e36RoadPolyline);
  assert.ok(sumRoadSnapped, 'Expected road-snapped summary');
  assert.equal(sumRoadSnapped.tone, 'smooth', 'On-corridor YLH is smooth (82 km/h); off-corridor slow detectors must NOT poison verdict');
  assert.equal(sumRoadSnapped.focusDet?.id, 'TDS90067', `Must select on-corridor YLH detector TDS90067, got ${sumRoadSnapped.focusDet?.id}`);
  assert.equal(sumRoadSnapped.oppDet?.id, 'TDS90068', 'Must retain opposite-bound YLH jam callout');

  // 2. Even WITHOUT road-snapped polyline (before async fetch completes), Castle Peak Rd / LRT detector is strictly excluded on highway/BBI spans
  const onlyCprAndYlh = [detectors[0], detectors[2]];
  const sumFallback = sb.getDirectionalRoadSummary(stops, 1, onlyCprAndYlh, false, 8, null);
  assert.ok(sumFallback, 'Expected fallback summary');
  assert.equal(sumFallback.focusDet?.id, 'TDS90067', 'Fallback corridor matcher must also reject TDSCPRHSK10004 Castle Peak Rd LRT detector on highway BBI span');

  // 3. Worker hygiene: bus_geom action wired and sole export preserved
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  assert.ok(workerSrc.includes("action === 'bus_geom'"), 'worker.js must handle action=bus_geom');
  const exportLines = workerSrc.split('\n').filter((l) => /^\s*export\b/.test(l));
  assert.equal(exportLines.length, 1, 'worker.js must keep exactly one export (onRequest)');
});

test('planner.js: Leave Now retains 0-min walk-buffer earlier departures and Earlier/Later switcher cascades transfer & arrival times', async () => {
  const tNow = Date.now();
  const tclDeps = [
    tNow + 1 * 60000,  // 1 min away (inside 2-min walk buffer — catchable if already at platform)
    tNow + 5 * 60000,  // 5 min away (default walk-buffered selection)
    tNow + 11 * 60000, // 11 min away (later train)
  ];
  const tmlDeps = [
    tNow + 22 * 60000, // connects with +1m TCL (arr Nam Cheong +19m + 2m xfer = +21m)
    tNow + 26 * 60000, // connects with +5m TCL (arr Nam Cheong +23m + 2m xfer = +25m)
    tNow + 32 * 60000, // connects with +11m TCL (arr Nam Cheong +29m + 2m xfer = +31m)
  ];

  const sb = loadHardcodeAndPlannerSandbox({
    xferTimeMode: 'NOW',
    navigator: { onLine: true },
    getHongKongNow: (ms = tNow) => {
      const shifted = new Date(ms + 8 * 3600000);
      return {
        getHours: () => shifted.getUTCHours(),
        getMinutes: () => shifted.getUTCMinutes(),
        getDay: () => shifted.getUTCDay(),
      };
    },
    fetchEtaRaw: async (group: any) => {
      if (group.routeNo === 'TCL') {
        return tclDeps.map((ms) => ({ targetMs: ms, isSched: false, loadEstimate: { tier: 'HIGH', labelEn: 'Packed' } }));
      }
      return tmlDeps.map((ms) => ({ targetMs: ms, isSched: false, loadEstimate: { tier: 'MED', labelEn: 'Moderate' } }));
    },
  });

  const tclGroup = { key: 'MTR_TCL_O', mode: 'MTR', company: 'MTR', routeNo: 'TCL', headwayMins: 6 };
  const tmlGroup = { key: 'MTR_TML_O', mode: 'MTR', company: 'MTR', routeNo: 'TML', headwayMins: 4 };
  const accessWalkSec = 120; // 2 min walk -> earliestBoardMs = tNow + 2m

  const w1 = await sb.ctx.window.resolveLiveOrStaticLegWindow(tclGroup, 'MTR_STN_TUC', tNow + accessWalkSec * 1000, 18 * 60, { mtrCode: 'TUC', stopName_e: 'Tung Chung' }, true, { mtrCode: 'NAC' });
  assert.equal(w1.candidateDeps.length, 3, 'Must retain 08:34, 08:38, and 08:44 departures');
  assert.equal(w1.selectedDepIdx, 1, 'Default selection must still respect 2-min walk buffer (08:38)');
  assert.equal(w1.depMs, tclDeps[1]);

  const card: any = {
    type: 'XFER',
    key: 'XFER_0',
    item: {
      leg1Group: tclGroup,
      leg2Group: tmlGroup,
      accessWalkSec,
      egressWalkSec: 120,
      xfer1BufSec: 120,
      candidateDeps1: w1.candidateDeps,
      selectedDepIdx1: w1.selectedDepIdx,
      candidateDeps2: tmlDeps.map((ms) => ({ depMs: ms, effDriveSec: 18 * 60, isLive: true, signalType: 'LIVE' })),
      headwaySec2: 240,
      liveDep1Ms: tclDeps[1],
      liveDep2Ms: tmlDeps[1],
      liveArrMs: tmlDeps[1] + 20 * 60000,
      totalMins: 46,
      xferStopNodes: [{ leg1DriveSec: 18 * 60, leg2DriveSec: 18 * 60, walkSec: 60 }],
      leg3Options: [],
    },
  };

  // Tap "< Earlier": switches TCL +5m -> +1m, cascades TML +26m -> +22m, marks Board now, saves 4 mins
  const steppedEarlier = sb.ctx.window.recalculatePlannerCardForFirstLegDep(card, 0, tNow);
  assert.equal(steppedEarlier, true);
  assert.equal(card.item.selectedDepIdx1, 0);
  assert.equal(card.item.liveDep1Ms, tclDeps[0]);
  assert.equal(card.item.liveDep2Ms, tmlDeps[0], 'TML connection at Nam Cheong must cascade earlier');
  assert.equal(card.item.isBoardNowRush, true, 'Picking train inside walk buffer must flag Board now');
  assert.equal(card.item.totalMins, 42, 'Total duration must drop from 46m to 42m');

  // Tap "Later >" twice: moves to +11m TCL -> +32m TML
  assert.equal(sb.ctx.window.recalculatePlannerCardForFirstLegDep(card, 2, tNow), true);
  assert.equal(card.item.liveDep1Ms, tclDeps[2]);
  assert.equal(card.item.liveDep2Ms, tmlDeps[2]);
  assert.equal(card.item.isBoardNowRush, false);
});

test('index.html: Saved Bookmarks cleanly truncates long destinations with .route-dest-name ellipsis and compact B/T labels', () => {
  const html = readAppBundle();
  assert.ok(html.includes('.route-dest-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'), 'Must define flex-safe ellipsis on .route-dest-name');
  assert.ok(html.includes('<span class="route-dest-name">${escapeHtml(compactDest)}</span>'), 'renderFavList must wrap destination name inside .route-dest-name');
  assert.ok(html.includes('#favList .route-eta-col'), 'Saved bookmarks list must tighten column widths for narrow mobile viewports');

  const fnMatch = html.match(/function formatCompactBookmarkDest[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'formatCompactBookmarkDest helper must exist in index.html');
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext(fnMatch[0], ctx);

  assert.equal(ctx.formatCompactBookmarkDest('Tung Chung Station Bus Terminus', false), 'Tung Chung Station B/T');
  assert.equal(ctx.formatCompactBookmarkDest('Tuen Mun Public Transport Interchange', false), 'Tuen Mun PTI');
  assert.equal(ctx.formatCompactBookmarkDest('東涌站巴士總站', true), '東涌站總站');
});

test('map.js: route-scoped traffic filtering hides off-route & opposite-smooth detectors, enforces >=52px arrow spacing, and keeps stop markers above traffic arrows', () => {
  const mapCode = readMapBundle();
  const addedPolylines: any[] = [];
  const addedMarkers: any[] = [];
  const fakeLayerGroup = {
    addTo() { return this; },
    clearLayers() { addedPolylines.length = 0; addedMarkers.length = 0; },
    hasLayer() { return false; },
  };
  const fakeDetailMap = {
    getBounds: () => ({ isValid: () => true, pad: () => ({ contains: () => true }) }),
    getZoom: () => 15,
  };
  const ctx: any = {
    window: { trafficLayerEnabled: true, mapInstance: fakeDetailMap },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: string) => String(s ?? ''),
    escapeJsAttr: (s: string) => String(s ?? ''),
    // Mirror hardcode.js return shape ({ distKm, t }) so object-unwrapping is covered
    pointToSegmentDistanceKm: (pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number) => {
      const cosLat = Math.max(0.2, Math.cos(((aLat + bLat) / 2) * Math.PI / 180));
      const ax = aLon * 111.32 * cosLat, ay = aLat * 110.574;
      const bx = bLon * 111.32 * cosLat, by = bLat * 110.574;
      const px = pLon * 111.32 * cosLat, py = pLat * 110.574;
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const rawT = lenSq > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
      const t = Math.max(0, Math.min(1, rawT));
      return { distKm: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t: rawT };
    },
    L: {
      layerGroup: () => fakeLayerGroup,
      polyline: (latlngs: any, opts: any) => {
        const handlers: Record<string, Function> = {};
        const obj = { latlngs, opts, popupFn: null as any, tooltip: '', handlers, addTo() { addedPolylines.push(obj); return obj; }, bindTooltip(t: string) { obj.tooltip = t; return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; }, on(ev: string, fn: Function) { handlers[ev] = fn; return obj; } };
        return obj;
      },
      divIcon: (opts: any) => opts,
      marker: (latlng: any, opts: any) => {
        const handlers: Record<string, Function> = {};
        const obj = { latlng, opts, popupFn: null as any, tooltip: '', handlers, addTo() { addedMarkers.push(obj); return obj; }, bindTooltip(t: string) { obj.tooltip = t; return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; }, on(ev: string, fn: Function) { handlers[ev] = fn; return obj; } };
        return obj;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(mapCode, ctx);
  ctx.window.mapInstance = fakeDetailMap;

  // Active E36 road-snapped highway corridor (southwest-bound ~225° along YLH)
  const e36ToAirportCoords = [
    [22.4440, 114.0140],
    [22.4385, 114.0075],
    [22.4290, 113.9975],
    [22.4150, 113.9870],
  ];
  ctx.window._setDetailCorridorMetaForTest({
    groupKey: 'LWB_E36_O',
    mode: 'BUS',
    isBusRoute: true,
    isRoadSnapped: true,
    coords: e36ToAirportCoords,
  });

  ctx.window.__LIVE_TRAFFIC_DETECTORS__ = [
    // 1. Off-route Kong Sham Western Highway (~3km away) — MUST BE HIDDEN
    { id: 'KSWH_OFF', lat: 22.4450, lon: 113.9720, rot: 200, spd: 80, occ: 10, tier: 'SMOOTH', roadEn: 'Kong Sham Western Highway' },
    // 2. Off-route Castle Peak Rd Hung Shui Kiu (~550m away) — MUST BE HIDDEN even if SLOW
    { id: 'CPR_OFF', lat: 22.4342, lon: 113.9921, rot: 225, spd: 32, occ: 25, tier: 'SLOW', roadEn: 'Castle Peak Rd - Hung Shui Kiu' },
    // 3. On-corridor YLH opposite direction (NE ~45°), SMOOTH — MUST BE HIDDEN
    { id: 'YLH_OPP_SMOOTH', lat: 22.4338, lon: 114.0025, rot: 45, spd: 84, occ: 11, tier: 'SMOOTH', roadEn: 'YLH Eastbound' },
    // 4. On-corridor YLH opposite direction (NE ~45°), JAMMED — MUST STAY VISIBLE (bottleneck warning)
    { id: 'YLH_OPP_JAM', lat: 22.4215, lon: 113.9920, rot: 38, spd: 12, occ: 92, tier: 'JAMMED', roadEn: 'YLH Eastbound Jam' },
    // 5. Dense caterpillar chain of 4 same-direction detectors on YLH (~60m apart = ~14px at zoom 15) — ONLY 1 (prioritizing SLOW) should render an arrow!
    { id: 'YLH_SAME_1', lat: 22.4338, lon: 114.0025, rot: 225, spd: 82, occ: 12, tier: 'SMOOTH', roadEn: 'YLH Westbound 1' },
    { id: 'YLH_SAME_2_SLOW', lat: 22.4334, lon: 114.0021, rot: 225, spd: 28, occ: 55, tier: 'SLOW', roadEn: 'YLH Westbound Slow' },
    { id: 'YLH_SAME_3', lat: 22.4330, lon: 114.0017, rot: 225, spd: 80, occ: 14, tier: 'SMOOTH', roadEn: 'YLH Westbound 3' },
    { id: 'YLH_SAME_4', lat: 22.4326, lon: 114.0013, rot: 225, spd: 81, occ: 13, tier: 'SMOOTH', roadEn: 'YLH Westbound 4' },
    // 6. On-corridor same-direction SMOOTH well separated (~1.8km down YLH, >350px away) — renders cleanly at zoom 15
    { id: 'YLH_SAME_FAR', lat: 22.4412, lon: 114.0108, rot: 225, spd: 85, occ: 9, tier: 'SMOOTH', roadEn: 'YLH Westbound Far' },
  ];

  // Filter verification (route-scoped: strictly <=150m, same travel direction only, off-route & opposite-bound excluded)
  const filtered = ctx.window.filterTrafficDetectorsForMap(
    ctx.window.__LIVE_TRAFFIC_DETECTORS__,
    fakeDetailMap,
    { isBusRoute: true, isRoadSnapped: true, hasHighwaySpan: true, coords: e36ToAirportCoords },
    ''
  );
  const keptIds = filtered.map((x: any) => x.det.id);
  assert.ok(!keptIds.includes('KSWH_OFF'), 'Off-route Kong Sham Western Hwy must be filtered out on E36 route map');
  assert.ok(!keptIds.includes('CPR_OFF'), 'Off-route Castle Peak Rd must be filtered out on E36 route map');
  assert.ok(!keptIds.includes('YLH_OPP_SMOOTH'), 'Opposite-direction SMOOTH detector on active corridor must be hidden');
  assert.ok(!keptIds.includes('YLH_OPP_JAM'), 'Opposite-direction detector must not clutter active route map (surfaced in Verdict & Cam modal)');
  assert.ok(keptIds.includes('YLH_SAME_2_SLOW') && keptIds.includes('YLH_SAME_FAR'), 'Same-direction corridor detectors must be retained for subtle road-flow stripes');

  // Render at zoom 15 on active bus route:
  // - Smooth detectors (YLH_SAME_FAR, YLH_SAME_1/3/4) draw subtle road stripes ONLY (ZERO smooth arrow badges even at zoom 15!)
  // - Only the worst same-direction bottleneck (YLH_SAME_2_SLOW) renders a marker (1 marker total, <= 2 max)
  ctx.window.renderTrafficOverlayOnMap(fakeDetailMap, true);
  assert.equal(addedMarkers.length, 1, `Expected 1 bottleneck-only marker (YLH_SAME_2_SLOW) with zero smooth badges on route view, got ${addedMarkers.length}`);
  assert.ok(addedPolylines.length >= 4, 'Subtle left-hand offset road-flow stripes must still render along the corridor');

  const tooltipTexts = addedMarkers.map((m: any) => m.tooltip);
  assert.ok(tooltipTexts.some((t: string) => t.includes('YLH Westbound Slow')), 'Prioritized SLOW bottleneck must render on route map');
  assert.ok(!tooltipTexts.some((t: string) => t.includes('YLH Westbound Far')), 'Smooth-flow detectors must NEVER render circle/arrow badges on active bus route view');
  assert.equal(addedMarkers[0].popupFn, null, 'Route bottleneck marker must NOT bind a duplicate Leaflet popup');

  // Verify every traffic arrow zIndexOffset sits strictly below numbered stop markers (320 / 650)
  for (const m of addedMarkers) {
    assert.ok(m.opts.zIndexOffset <= 140, `Expected traffic arrow zIndexOffset <= 140, got ${m.opts.zIndexOffset}`);
  }
  assert.ok(mapCode.includes('zIndexOffset: isAct ? 650 : (isExit ? 620 : 320)'), 'Stop markers must sit at zIndexOffset 320 (normal) / 620 (exit) / 650 (active) strictly above traffic arrows');
});

test('Decision-first Transit: zero off-route clutter (<=2 bottlenecks on route map), 3-tier Bus-vs-MTR verdicts, and E36 Tuen Mun Rd (TDS90048) + YLH (TDS90067) worst-bottleneck ranking rejecting CPR-*', () => {
  const sb = loadHardcodeAndPlannerSandbox();

  // --- AC 2: 3-tier plain-English & ZH Neutral Traffic Signal Verdicts (no assumptive MTR directives) ---
  const dMinor = sb.synthesizeTrafficDecision({
    status: 'SLOW', avgSpd: 38, minSpd: 38, maxOcc: 32, estDelayMins: 4,
    worstDet: { id: 'TDS90048', spd: 38, occ: 32, tier: 'SLOW', roadEn: 'Tuen Mun Road near San Hui Market - Northbound', roadTc: '屯門公路近新墟街市 - 北行' }
  }, null, false);
  assert.equal(dMinor.modeRec, 'TAKE_BUS');
  assert.equal(dMinor.verdictEn, 'Slower flow · Tuen Mun Road (+2–5m)');

  const dMod = sb.synthesizeTrafficDecision({
    status: 'SLOW', avgSpd: 26, minSpd: 26, maxOcc: 58, estDelayMins: 8,
    worstDet: { id: 'TDS90048', spd: 26, occ: 58, tier: 'SLOW', roadEn: 'Tuen Mun Road near San Hui Market - Northbound', roadTc: '屯門公路近新墟街市 - 北行' }
  }, null, false);
  assert.equal(dMod.modeRec, 'MTR_FASTER');
  assert.equal(dMod.verdictEn, 'Slow traffic on Tuen Mun Road (+8m)');

  const dSevere = sb.synthesizeTrafficDecision({
    status: 'JAMMED', avgSpd: 12, minSpd: 12, maxOcc: 88, estDelayMins: 15,
    worstDet: { id: 'TDS90048', spd: 12, occ: 88, tier: 'JAMMED', roadEn: 'Tuen Mun Road near San Hui Market - Northbound', roadTc: '屯門公路近新墟街市 - 北行' }
  }, null, false);
  assert.equal(dSevere.modeRec, 'SWITCH_MTR');
  assert.equal(dSevere.verdictEn, 'Jammed on Tuen Mun Road (+15m)');
  assert.ok(dSevere.verdictTc.includes('擠塞') && dSevere.verdictTc.includes('屯門公路') && !dSevere.verdictTc.includes('改乘港鐵'));

  // --- AC 3: E36 (TM-CLK Tunnel BBI -> Fung Chi Tsuen) keeps BOTH Tuen Mun Road (TDS90048) & YLH (TDS90067),
  // rejects Castle Peak Rd (TDSCPRHSK10004 / CPR-*), and surfaces whichever main carriageway is slower/more delayed ---
  const e36Stops = [
    { stopId: 'E36_10', stopName_e: 'Yu Tung Court', latitude: '22.2882', longitude: '113.9436' },
    { stopId: 'E36_11', stopName_e: 'Tuen Mun Chek Lap Kok Tunnel BBI', latitude: '22.3716', longitude: '113.9636' },
    { stopId: 'E36_12', stopName_e: 'Fung Chi Tsuen', latitude: '22.4455', longitude: '114.0172' },
    { stopId: 'E36_13', stopName_e: 'Yuen Long Plaza', latitude: '22.4447', longitude: '114.0243' },
  ];
  // Realistic road-snapped polyline along TM-CLK -> Lung Fu Rd -> Tuen Mun Road (through San Hui Market) -> YLH (Shap Pat Heung Int) -> Fung Chi Tsuen
  const e36RealPolyline = [
    [22.2882, 113.9436],
    [22.3716, 113.9636],
    [22.3860, 113.9720],
    [22.3930, 113.9765], // Tuen Mun Road approaching San Hui Market (~15° NNE)
    [22.4000, 113.9784], // Tuen Mun Road past San Hui Market (~15° NNE)
    [22.4150, 113.9870],
    [22.4290, 113.9975], // YLH eastbound (~45° NE)
    [22.4385, 114.0075], // YLH Shap Pat Heung Int (~45° NE)
    [22.4455, 114.0172],
    [22.4447, 114.0243],
  ];

  // Case A: Castle Peak Rd jammed at 8 km/h (MUST BE REJECTED), Tuen Mun Rd slow at 38 km/h, YLH smooth at 82 km/h -> TDS90048 wins!
  const detCaseA = [
    { id: 'TDSCPRHSK10004', lat: 22.4342, lon: 113.9921, rot: 45, spd: 8, occ: 95, tier: 'JAMMED', roadEn: 'Castle Peak Rd-Hung Shui Kiu near Hung Shui Kiu Light Rail Stop - Northbound', camKey: 'TDSCPRHSK10004' },
    { id: 'TDS90048', lat: 22.3965, lon: 113.9775, rot: 15, spd: 38, occ: 32, tier: 'SLOW', roadEn: 'Tuen Mun Road near San Hui Market - Northbound', roadTc: '屯門公路近新墟街市 - 北行', camKey: 'TDS90048' },
    { id: 'TDS90067', lat: 22.4338, lon: 114.0025, rot: 46, spd: 82, occ: 12, tier: 'SMOOTH', roadEn: 'YLH/Shap Pat Heung Int - Eastbound (1)', roadTc: '元朗公路近十八鄉交匯處 - 東行 (1)', camKey: 'TDS90067' },
  ];
  const sumA = sb.getDirectionalRoadSummary(e36Stops, 1, detCaseA, false, 8, e36RealPolyline);
  assert.equal(sumA.focusDet?.id, 'TDS90048', 'When TMR is slower than YLH, TDS90048 must win while CPR-* is rejected');
  assert.equal(sumA.headline, 'Slower flow · Tuen Mun Road (+2–5m)');

  // Case B: Tuen Mun Rd slow at 38 km/h, YLH severely jammed at 11 km/h -> TDS90067 wins with neutral Jammed signal!
  const detCaseB = [
    detCaseA[0],
    detCaseA[1],
    { ...detCaseA[2], spd: 11, occ: 90, tier: 'JAMMED' },
  ];
  const sumB = sb.getDirectionalRoadSummary(e36Stops, 1, detCaseB, false, 8, e36RealPolyline);
  assert.equal(sumB.focusDet?.id, 'TDS90067', 'When YLH is jammed worse than TMR, TDS90067 must win');
  assert.equal(sumB.modeRec, 'SWITCH_MTR');
  assert.ok(sumB.headline.includes('Jammed on Yuen Long Highway (+15m)') && !/Switch to MTR/i.test(sumB.headline), `Unexpected YLH severe jam headline: ${sumB.headline}`);

  // --- AC 1: Zoomed-out E36 map hides Sha Tin / Ma On Shan / Tsuen Wan off-route badges and caps route bottlenecks to <= 2 ---
  const mapCode = readMapBundle();
  const addedMarkers: any[] = [];
  const fakeLayerGroup = { addTo() { return this; }, clearLayers() { addedMarkers.length = 0; }, hasLayer() { return false; } };
  const fakeDetailMap = { getBounds: () => ({ isValid: () => true, pad: () => ({ contains: () => true }) }), getZoom: () => 11 };
  const fakeBrowseMap = { getBounds: () => ({ isValid: () => true, pad: () => ({ contains: () => true }) }), getZoom: () => 12 };
  const mapCtx: any = {
    window: { trafficLayerEnabled: true },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: string) => String(s ?? ''),
    escapeJsAttr: (s: string) => String(s ?? ''),
    isOffCorridorLocalArterialDetector: sb.isOffCorridorLocalArterialDetector,
    pointToSegmentDistanceKm: sb.pointToSegmentDistanceKm,
    L: {
      layerGroup: () => fakeLayerGroup,
      polyline: () => ({ addTo() { return this; }, bindTooltip() { return this; }, bindPopup() { return this; }, on() { return this; } }),
      divIcon: (opts: any) => opts,
      marker: (latlng: any, opts: any) => {
        const handlers: Record<string, Function> = {};
        const obj = { latlng, opts, popupFn: null as any, tooltip: '', handlers, addTo() { addedMarkers.push(obj); return obj; }, bindTooltip(t: string) { obj.tooltip = t; return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; }, on(ev: string, fn: Function) { handlers[ev] = fn; return obj; } };
        return obj;
      },
    },
  };
  vm.createContext(mapCtx);
  vm.runInContext(mapCode, mapCtx);
  mapCtx.window.mapInstance = fakeDetailMap;
  mapCtx.window.browseMapInstance = fakeBrowseMap;
  mapCtx.window._setDetailCorridorMetaForTest({
    groupKey: 'LWB_E36_I',
    mode: 'BUS',
    isBusRoute: true,
    hasHighwaySpan: true,
    isRoadSnapped: true,
    coords: e36RealPolyline,
  });

  mapCtx.window.__LIVE_TRAFFIC_DETECTORS__ = [
    // Off-route regional jams in Sha Tin, Ma On Shan, Tsuen Wan — MUST BE 100% HIDDEN on E36 route map
    { id: 'ST_JAM', lat: 22.3820, lon: 114.1950, rot: 30, spd: 10, occ: 92, tier: 'JAMMED', roadEn: 'Sha Tin Road' },
    { id: 'MOS_JAM', lat: 22.4240, lon: 114.2320, rot: 40, spd: 12, occ: 88, tier: 'JAMMED', roadEn: 'Ma On Shan Bypass' },
    { id: 'TW_SLOW', lat: 22.3700, lon: 114.1150, rot: 90, spd: 28, occ: 50, tier: 'SLOW', roadEn: 'Tsuen Wan Road' },
    // Parallel Castle Peak Rd — MUST BE HIDDEN
    detCaseA[0],
    // 3 well-separated on-corridor bottlenecks on E36 (only top 2 worst should render!)
    { id: 'TDS90048', lat: 22.3965, lon: 113.9775, rot: 15, spd: 14, occ: 85, tier: 'JAMMED', roadEn: 'Tuen Mun Road near San Hui Market - Northbound' },
    { id: 'E36_MID_SLOW', lat: 22.3720, lon: 113.9638, rot: 18, spd: 34, occ: 40, tier: 'SLOW', roadEn: 'Lung Fu Road' },
    { id: 'TDS90067', lat: 22.4338, lon: 114.0025, rot: 46, spd: 22, occ: 68, tier: 'SLOW', roadEn: 'YLH/Shap Pat Heung Int - Eastbound (1)' },
  ];

  // Zoom 11 route view: zero Sha Tin / Ma On Shan / Tsuen Wan / Castle Peak Rd badges, and capped at <= 2 worst bottlenecks
  mapCtx.window.renderTrafficOverlayOnMap(fakeDetailMap, true);
  assert.ok(addedMarkers.length >= 1 && addedMarkers.length <= 2, `Route view must render at most 2 worst bottlenecks, got ${addedMarkers.length}`);
  const routeTips = addedMarkers.map((m: any) => m.tooltip).join(' | ');
  assert.ok(!routeTips.includes('Sha Tin') && !routeTips.includes('Ma On Shan') && !routeTips.includes('Tsuen Wan') && !routeTips.includes('Castle Peak'), `Off-route regional/local badges leaked onto E36 route map: ${routeTips}`);
  assert.ok(routeTips.includes('Tuen Mun Road'), 'Worst bottleneck (Tuen Mun Road 14 km/h) must be visible on route map');
  assert.ok(addedMarkers.every((m: any) => m.popupFn === null && typeof m.handlers.click === 'function'), 'Route bottleneck markers must open Verdict & Cam modal directly without white Leaflet popups');

  // General browse map (no active bus route selected) still shows regional Sha Tin / Ma On Shan / Tsuen Wan bottlenecks
  mapCtx.window.renderTrafficOverlayOnMap(fakeBrowseMap, true);
  const browseTips = addedMarkers.map((m: any) => m.tooltip).join(' | ');
  assert.ok(browseTips.includes('Sha Tin') || browseTips.includes('Ma On Shan'), 'General browse map must still display regional traffic markers when no route is selected');
});

test('index.html & map.js: desktop Pointer Events drag resize on #mapSheetHandle (zero text selection) and direct Verdict & Cam click with stripped 250"/250° telemetry artifacts', () => {
  const html = readAppBundle();
  const mapCode = readMapBundle();

  // 1. Verify CSS grab/grabbing, touch-action: none, and user-select suppression in index.html
  assert.ok(html.includes('.map-sheet-handle {') && html.includes('cursor: grab;') && html.includes('touch-action: none;') && html.includes('user-select: none;'), 'Sheet handle must enforce grab cursor, touch-action: none, and user-select: none');
  assert.ok(html.includes('.map-sheet-handle.is-dragging { cursor: grabbing; }'), 'Dragging state must switch cursor to grabbing');
  assert.ok(html.includes('body.map-sheet-dragging, body.map-sheet-dragging * { user-select: none !important;'), 'Body drag class must prevent accidental text highlight across the stop list');

  // 2. Simulate desktop mouse pointer drag on #mapSheetHandle with setPointerCapture
  const handleListeners: Record<string, Function[]> = {};
  const capturedIds: number[] = [];
  const releasedIds: number[] = [];
  const handleClasses = new Set<string>();
  const bodyClasses = new Set<string>();
  let invalidateCount = 0;

  const fakeHandle: any = {
    _dragBound: false,
    classList: {
      add: (c: string) => handleClasses.add(c),
      remove: (c: string) => handleClasses.delete(c),
    },
    setPointerCapture: (id: number) => capturedIds.push(id),
    hasPointerCapture: (id: number) => capturedIds.includes(id) && !releasedIds.includes(id),
    releasePointerCapture: (id: number) => releasedIds.push(id),
    addEventListener: (ev: string, fn: Function) => {
      if (!handleListeners[ev]) handleListeners[ev] = [];
      handleListeners[ev].push(fn);
    },
  };
  const fakeMapContainer: any = {
    offsetHeight: 280,
    style: { height: '35dvh', transition: '' },
  };
  const addedMarkers: any[] = [];
  const addedPolylines: any[] = [];
  const openedModals: any[] = [];
  const fakeLayerGroup = { addTo() { return this; }, clearLayers() { addedMarkers.length = 0; addedPolylines.length = 0; }, hasLayer() { return false; } };
  const fakeDetailMap: any = {
    getBounds: () => ({ isValid: () => true, pad: () => ({ contains: () => true }) }),
    getZoom: () => 14,
    invalidateSize: () => { invalidateCount++; },
  };

  const ctx: any = {
    window: {
      innerHeight: 800,
      trafficLayerEnabled: true,
      mapInstance: fakeDetailMap,
      openTrafficDecisionModal: (detId: string, oppId: string, segNote: string, isApp: boolean) => {
        openedModals.push({ detId, oppId, segNote, isApp });
      },
    },
    document: {
      readyState: 'complete',
      body: {
        classList: {
          add: (c: string) => bodyClasses.add(c),
          remove: (c: string) => bodyClasses.delete(c),
        },
      },
      getElementById: (id: string) => {
        if (id === 'mapSheetHandle') return fakeHandle;
        if (id === 'map-container') return fakeMapContainer;
        return null;
      },
      addEventListener: () => {},
    },
    requestAnimationFrame: (cb: Function) => { cb(); return 1; },
    cancelAnimationFrame: () => {},
    setTimeout: (cb: Function) => { cb(); return 1; },
    clearTimeout: () => {},
    currentLang: 'en',
    escapeHtml: (s: string) => String(s ?? ''),
    escapeJsAttr: (s: string) => String(s ?? ''),
    L: {
      layerGroup: () => fakeLayerGroup,
      polyline: (latlngs: any, opts: any) => {
        const handlers: Record<string, Function> = {};
        const obj = { latlngs, opts, popupFn: null as any, tooltip: '', handlers, addTo() { addedPolylines.push(obj); return obj; }, bindTooltip(t: string) { obj.tooltip = t; return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; }, on(ev: string, fn: Function) { handlers[ev] = fn; return obj; } };
        return obj;
      },
      divIcon: (opts: any) => opts,
      marker: (latlng: any, opts: any) => {
        const handlers: Record<string, Function> = {};
        const obj = { latlng, opts, popupFn: null as any, tooltip: '', handlers, addTo() { addedMarkers.push(obj); return obj; }, bindTooltip(t: string) { obj.tooltip = t; return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; }, on(ev: string, fn: Function) { handlers[ev] = fn; return obj; } };
        return obj;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(mapCode, ctx);
  ctx.window.mapInstance = fakeDetailMap;

  // Verify unified Pointer Events were bound automatically on #mapSheetHandle
  assert.ok(handleListeners.pointerdown?.length === 1 && handleListeners.pointermove?.length === 1 && handleListeners.pointerup?.length === 1 && handleListeners.pointercancel?.length === 1, 'Must bind pointerdown, pointermove, pointerup, and pointercancel on #mapSheetHandle');

  // Drag down by +180px using desktop primary mouse button
  let preventedDown = false;
  let preventedMove = false;
  handleListeners.pointerdown[0]({ pointerId: 7, pointerType: 'mouse', button: 0, clientY: 300, preventDefault: () => { preventedDown = true; }, target: { closest: () => null } });
  assert.equal(preventedDown, true, 'pointerdown must call preventDefault() to block text selection');
  assert.deepEqual(capturedIds, [7], 'pointerdown must capture pointerId via setPointerCapture');
  assert.ok(handleClasses.has('is-dragging') && bodyClasses.has('map-sheet-dragging'), 'Dragging classes must be active during drag');

  handleListeners.pointermove[0]({ pointerId: 7, clientY: 480, preventDefault: () => { preventedMove = true; } });
  assert.equal(preventedMove, true, 'pointermove must call preventDefault()');
  assert.equal(fakeMapContainer.style.height, '460px', 'Dragging down 180px from 280px must smoothly expand map to 460px');

  // Extreme downward drag clamps to 74dvh (592px at 800px viewport)
  handleListeners.pointermove[0]({ pointerId: 7, clientY: 950, preventDefault: () => {} });
  assert.equal(fakeMapContainer.style.height, '592px', 'Map height must clamp to 74% viewport height');
  fakeMapContainer.offsetHeight = 592;

  handleListeners.pointerup[0]({ pointerId: 7, clientY: 950 });
  assert.deepEqual(releasedIds, [7], 'pointerup must release pointer capture');
  assert.ok(!handleClasses.has('is-dragging') && !bodyClasses.has('map-sheet-dragging'), 'Dragging classes must be cleaned up on pointerup');
  assert.ok(invalidateCount >= 2, 'Leaflet map size must be invalidated during/after drag');

  // Clicking inside #mapSheetToggleBtn ("Map" pill) must be ignored by pointer drag so tap-to-toggle works cleanly
  let togglePrevented = false;
  handleListeners.pointerdown[0]({ pointerId: 8, pointerType: 'mouse', button: 0, clientY: 300, preventDefault: () => { togglePrevented = true; }, target: { closest: (sel: string) => sel === '#mapSheetToggleBtn' ? {} : null } });
  assert.equal(togglePrevented, false, 'Map pill click must pass through without initiating drag');

  // 3. Verify sanitizeBottleneckLabel strips raw trailing telemetry artifacts like 250", 250°, · 250°
  assert.equal(
    ctx.window.sanitizeBottleneckLabel('Yuen Long Highway near Kong Sham Western Highway - Westbound (1) 250"'),
    'Yuen Long Highway near Kong Sham Western Highway - Westbound (1)'
  );
  assert.equal(
    ctx.window.sanitizeBottleneckLabel('Yuen Long Highway - Westbound (1) · 250°'),
    'Yuen Long Highway - Westbound (1)'
  );
  assert.equal(ctx.window.sanitizeBottleneckLabel('38% occ · 250°'), '38% occ');
  assert.equal(ctx.window.sanitizeBottleneckLabel('Tuen Mun Road (250")'), 'Tuen Mun Road');

  // 4. Clicking a route bottleneck marker opens Verdict & Cam modal directly without any duplicate white popup
  ctx.window._setDetailCorridorMetaForTest({
    groupKey: 'LWB_E36_O',
    mode: 'BUS',
    isBusRoute: true,
    hasHighwaySpan: true,
    isRoadSnapped: true,
    coords: [[22.4440, 114.0140], [22.4330, 114.0020], [22.4150, 113.9870]],
  });
  ctx.window.__LIVE_TRAFFIC_DETECTORS__ = [
    { id: 'YLH_WB_JAM', lat: 22.4330, lon: 114.0020, rot: 250, spd: 19, occ: 38, tier: 'JAMMED', roadEn: 'Yuen Long Highway near Kong Sham Western Highway - Westbound (1) 250"', roadTc: '元朗公路近港深西部公路 - 西行 (1) 250"', camKey: 'YL102F' },
    { id: 'YLH_EB_OPP', lat: 22.4331, lon: 114.0021, rot: 70, spd: 82, occ: 12, tier: 'SMOOTH', roadEn: 'Yuen Long Highway - Eastbound', camKey: 'YL102F' },
  ];
  ctx.window.renderTrafficOverlayOnMap(fakeDetailMap, true);

  assert.equal(addedMarkers.length, 1, 'Expected single worst bottleneck marker on E36');
  const jamMarker = addedMarkers[0];
  assert.equal(jamMarker.popupFn, null, 'Bottleneck marker must NOT bind a duplicate white popup card');
  assert.ok(!jamMarker.tooltip.includes('250"') && !jamMarker.tooltip.includes('250°'), `Bottleneck tooltip must strip 250"/250° telemetry artifacts, got: ${jamMarker.tooltip}`);
  assert.ok(jamMarker.tooltip.includes('Yuen Long Highway near Kong Sham Western Highway - Westbound (1)'), `Tooltip should keep clean road label, got: ${jamMarker.tooltip}`);

  // Clicking the bottleneck marker opens openTrafficDecisionModal directly for that detector
  let stopPropCalled = false;
  jamMarker.handlers.click({ originalEvent: { stopPropagation: () => { stopPropCalled = true; } } });
  assert.equal(stopPropCalled, true, 'Bottleneck click must stop propagation');
  assert.equal(openedModals.length, 1, 'Clicking bottleneck marker must open Verdict & Cam modal directly');
  assert.equal(openedModals[0].detId, 'YLH_WB_JAM');
  assert.equal(openedModals[0].oppId, 'YLH_EB_OPP');
});

test('PWA update mechanism: public/sw.js SKIP_WAITING lifecycle, Settings Force Update App, automatic update toast, and zero header clutter', async () => {
  const html = readAppBundle();
  const swCode = fs.readFileSync('public/sw.js', 'utf8');
  const headersTxt = fs.readFileSync('public/_headers', 'utf8');

  // 1. Verify Service Worker immediately calls skipWaiting() in install, purges all outdated caches before clients.claim() in activate, keeps SKIP_WAITING message, and bypasses live APIs
  const installBlock = swCode.match(/addEventListener\('install'[\s\S]*?\n\}\);/)?.[0] || '';
  const installCodeOnly = installBlock.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const activateBlock = swCode.match(/addEventListener\('activate'[\s\S]*?\n\}\);/)?.[0] || '';
  assert.ok(installBlock.length > 0, 'public/sw.js must register install listener');
  assert.ok(installCodeOnly.includes('self.skipWaiting()'), 'install handler must immediately call self.skipWaiting() for silent PWA auto-updates');
  assert.ok(activateBlock.includes('k !== CACHE_NAME') && activateBlock.includes('caches.delete(k)') && activateBlock.indexOf('caches.delete') < activateBlock.indexOf('self.clients.claim()'), 'activate handler must purge all outdated cache keys before calling self.clients.claim()');
  assert.ok(swCode.includes("data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')") && swCode.includes('self.skipWaiting()'), 'public/sw.js must retain SKIP_WAITING message handling');
  assert.ok(swCode.includes("url.pathname.startsWith('/api/')") && swCode.includes('/version.json') && swCode.includes('/sw.js'), 'public/sw.js must bypass cache for live APIs, version.json, and sw.js');
  assert.ok(headersTxt.includes('/sw.js') && headersTxt.includes('no-cache, no-store, must-revalidate'), 'public/_headers must prevent caching of /sw.js');

  // 2. Verify Settings modal App Version & Update control, meta tag, and zero extra buttons in main top header
  assert.ok(html.includes('<meta name="app-build-version" content="'), 'index.html must expose build timestamp via app-build-version meta tag');
  assert.ok(html.includes('id="settingsAppUpdateCard"') && html.includes('id="settingBuildVersionText"') && html.includes('id="forceUpdateAppBtn"'), 'Settings modal must include App Version & Update section and Force Update App button');
  const headerSlice = html.match(/<div class="app-switcher">[\s\S]*?<\/div>\s*\n\s*<!--/)?.[0] || '';
  assert.ok(headerSlice.length > 0 && !headerSlice.includes('forceUpdateApp') && !headerSlice.includes('pwaUpdate'), 'Main top navigation bar must remain uncluttered with zero extra update buttons/badges');

  // 3. Extract and execute getAppBuildVersion, forceUpdateApp, and initPwaUpdateLifecycle in VM sandbox
  const fnBlockMatch = html.match(/function getAppBuildVersion\(\)[\s\S]*?window\.initPwaUpdateLifecycle = function initPwaUpdateLifecycle[\s\S]*?\n\};/);
  assert.ok(fnBlockMatch, 'Must find PWA update lifecycle functions in index.html');

  const elements: Record<string, any> = {
    forceUpdateAppBtn: { disabled: false, innerText: '↻ Force Update App' },
    pwaUpdateToast: {
      classes: new Set<string>(),
      attrs: {} as Record<string, string>,
      classList: {
        add(c: string) { elements.pwaUpdateToast.classes.add(c); },
        remove(c: string) { elements.pwaUpdateToast.classes.delete(c); },
      },
      setAttribute(k: string, v: string) { elements.pwaUpdateToast.attrs[k] = v; },
    },
    pwaUpdateToastText: { innerText: '' },
    pwaUpdateActionPill: { innerText: '' },
    pwaUpdateApplyBtn: { disabled: false },
  };

  let reloadCount = 0;
  let unregisteredIds: string[] = [];
  let deletedCaches: string[] = [];

  const ctx: any = {
    APP_VERSION: '2026-11-25 17:53 HKT',
    currentLang: 'en',
    triggerHaptic: () => {},
    caches: {
      keys: async () => ['transit-hk-shell-old', 'transit-hk-shell-cur'],
      delete: async (k: string) => { deletedCaches.push(k); return true; },
    },
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [
          { unregister: async () => { unregisteredIds.push('sw-1'); return true; } },
          { unregister: async () => { unregisteredIds.push('sw-2'); return true; } },
        ],
      },
    },
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      querySelector: (sel: string) => sel === 'meta[name="app-build-version"]'
        ? { getAttribute: () => '2026-11-25 17:53 HKT' }
        : null,
      getElementById: (id: string) => elements[id] || null,
      addEventListener: () => {},
    },
    window: {
      location: { reload: () => { reloadCount++; } },
      addEventListener: () => {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fnBlockMatch[0], ctx);

  // Verify build version reader
  assert.equal(ctx.getAppBuildVersion(), '2026-11-25 17:53 HKT');

  // Verify Force Update App unregisters all SWs, clears all caches, and triggers hard reload
  await ctx.window.forceUpdateApp();
  assert.deepEqual(unregisteredIds, ['sw-1', 'sw-2'], 'forceUpdateApp must unregister all active Service Workers');
  assert.deepEqual(deletedCaches, ['transit-hk-shell-old', 'transit-hk-shell-cur'], 'forceUpdateApp must clear all Cache Storage keys');
  assert.equal(reloadCount, 1, 'forceUpdateApp must trigger window.location.reload()');

  // 4. Test SW lifecycle: First-ever install (controller === null) must NOT show toast or auto-reload
  reloadCount = 0;
  const firstInstallListeners: Record<string, Function> = {};
  const firstRegListeners: Record<string, Function> = {};
  const firstSw: any = {
    controller: null,
    addEventListener: (ev: string, fn: Function) => { firstInstallListeners[ev] = fn; },
    register: async () => ({
      waiting: null,
      installing: null,
      addEventListener: (ev: string, fn: Function) => { firstRegListeners[ev] = fn; },
    }),
  };
  const firstReg = await ctx.window.initPwaUpdateLifecycle(firstSw);
  assert.ok(firstReg, 'initPwaUpdateLifecycle must resolve registration');
  firstInstallListeners.controllerchange?.();
  assert.equal(reloadCount, 0, 'First-ever SW controllerclaim must NOT reload page');
  assert.equal(elements.pwaUpdateToast.classes.has('show'), false, 'First-ever SW install must NOT show update toast');

  // 5. Test SW lifecycle: Active controller + updatefound -> installed waiting -> silent auto-apply SKIP_WAITING -> controllerchange reload once (no manual button prompt!)
  const swListeners: Record<string, Function> = {};
  const regListeners: Record<string, Function> = {};
  const workerListeners: Record<string, Function> = {};
  const postedMsgs: any[] = [];
  const newWorker: any = {
    scriptURL: 'https://example.com/sw.js?v=silent1',
    state: 'installing',
    postMessage: (m: any) => postedMsgs.push(m),
    addEventListener: (ev: string, fn: Function) => { workerListeners[ev] = fn; },
  };
  const activeReg: any = {
    waiting: null,
    installing: null,
    addEventListener: (ev: string, fn: Function) => { regListeners[ev] = fn; },
  };
  const activeSw: any = {
    controller: { id: 'old-controller' },
    addEventListener: (ev: string, fn: Function) => { swListeners[ev] = fn; },
    register: async (url: string, opts: any) => {
      assert.equal(url, 'sw.js');
      assert.equal(opts?.updateViaCache, 'none');
      return activeReg;
    },
  };

  const rawIndexHtml = fs.readFileSync('index.html', 'utf8');
  assert.ok(!rawIndexHtml.includes('pwaUpdateApplyBtn') && !rawIndexHtml.includes('pwaUpdateDismissBtn'),
    'index.html must eliminate manual reload/dismiss buttons on PWA update toast');

  await ctx.window.initPwaUpdateLifecycle(activeSw);
  activeReg.installing = newWorker;
  regListeners.updatefound();
  assert.equal(elements.pwaUpdateToast.classes.has('show'), false, 'Toast must stay hidden while worker is still installing');
  assert.equal(postedMsgs.length, 0, 'Must not post SKIP_WAITING while still installing');

  // Transition worker to installed (entering waiting state while old controller is active):
  // silently posts SKIP_WAITING automatically with zero required button presses!
  newWorker.state = 'installed';
  workerListeners.statechange();
  assert.equal(postedMsgs.length, 1, 'New installed worker must silently auto-post SKIP_WAITING with zero manual clicks');
  assert.equal(postedMsgs[0]?.type, 'SKIP_WAITING', 'Silent update must post SKIP_WAITING to waiting worker');
  assert.equal(reloadCount, 0, 'Must wait for controllerchange before reloading');

  swListeners.controllerchange();
  swListeners.controllerchange(); // second fire must be ignored
  assert.equal(reloadCount, 1, 'controllerchange must reload silently exactly once');
});

test('SmartReturnManager & index.html: tight Quick Return confidence threshold (Home anchor or 3+ time-window trips), distance & 20m-vs-5m guardrails, and Settings toggle clean-plate OFF default', () => {
  const html = readAppBundle();

  // 1. Settings modal has Quick Return Suggestions toggle and main header stays untouched
  const settingsSlice = html.slice(html.indexOf('id="settingsModal"'), html.indexOf('id="aboutModal"'));
  assert.ok(settingsSlice.includes('id="quickReturnToggleRow"'), 'Settings modal must include Quick Return Suggestions toggle row');
  assert.ok(settingsSlice.includes('role="switch"') && settingsSlice.includes('aria-checked="false"'), 'Quick Return toggle must default to aria-checked="false"');
  assert.ok(settingsSlice.includes('Quick Return Suggestions'), 'Settings toggle must display "Quick Return Suggestions"');
  assert.ok(settingsSlice.includes('onclick="toggleQuickReturnSuggestions()"'), 'Settings toggle must invoke toggleQuickReturnSuggestions()');

  const headerSlice = html.slice(html.indexOf('<div class="app-switcher">'), html.indexOf('<!-- 1. MAIN VIEW -->'));
  assert.ok(headerSlice.length > 0 && !headerSlice.includes('quickReturnToggle') && !headerSlice.includes('Quick Return'), 'Main top header must remain untouched without Quick Return buttons');

  // 2. Build realistic E36 scenario (Hong Lok Road <-> Tung Chung / Airport, Yu Tung Court vs Tung Chung Fire Station)
  const stopHongLok = { stopKey: 'LWB_HONGLOK', stopName_e: 'Hong Lok Road', name_tc: '康樂路', latitude: 22.4443, longitude: 114.0272, mode: 'BUS' };
  const stopTcFire = { stopKey: 'NLB_TCFIRE', stopName_e: 'Tung Chung Fire Station, Shun Tung Road', name_tc: '東涌消防局, 順東路', latitude: 22.28603, longitude: 113.941057, mode: 'BUS' };
  const stopYuTung = { stopKey: 'LWB_YUTUNG', stopName_e: 'Yu Tung Court', name_tc: '裕東苑', latitude: 22.28690, longitude: 113.94180, mode: 'BUS' };
  const stopAirport = { stopKey: 'LWB_AIRPORT', stopName_e: 'Airport (Ground Transportation Centre)', name_tc: '機場(地面運輸中心)', latitude: 22.3145, longitude: 113.9366, mode: 'BUS' };

  const e36Out = { key: 'LWB_E36_O', routeNo: 'E36', company: 'LWB', mode: 'BUS', routeIds: ['LWB_E36_O_1'], dest_e: 'Airport', dest_tc: '機場' };
  const e36In = { key: 'LWB_E36_I', routeNo: 'E36', company: 'LWB', mode: 'BUS', routeIds: ['LWB_E36_I_1'], dest_e: 'Pat Heung Road', dest_tc: '八鄉路' };

  const stopsByGroup: Record<string, any[]> = {
    LWB_E36_O: [stopHongLok, stopYuTung, stopAirport],
    LWB_E36_I: [stopAirport, stopYuTung, stopHongLok],
  };

  const memStore: Record<string, string> = {};
  const sb = loadHardcodeAndPlannerSandbox({
    groupedRoutes: [e36Out, e36In],
    getStopsForGroup: (g: any) => stopsByGroup[g?.key] || [],
    SafeStorage: {
      getItem: (k: string) => (Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null),
      setItem: (k: string, v: string) => { memStore[k] = String(v); },
    },
    bookmarkedStops: [],
    stripPlatformCodeFromDisplay: (s: string) => String(s || ''),
    isCircularRoute: () => false,
    document: { cookie: '', addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] },
  });
  const sr = sb.SmartReturnManager;
  const hubs = sb.SavedHubsManager;

  // Helper timestamps in HKT (UTC+8): e.g., 2026-11-25 19:07 HKT = 11:07 UTC
  const hktMs = (day: number, hour: number, min: number) => Date.UTC(2026, 10, day, hour - 8, min, 0);
  const now1907 = hktMs(25, 19, 7);
  const outbound1700 = hktMs(25, 17, 0); // 2h07m earlier -> passes 45m–12h dwell gate

  // User standing ~61m south of Tung Chung Fire Station (~135m from Yu Tung Court)
  const userNearTcFire = { lat: 22.28550, lon: 113.94105, hasLiveFix: true, acc: 15 };
  // User standing right beside Yu Tung Court (~25m away)
  const userNearYuTung = { lat: 22.28675, lon: 113.94170, hasLiveFix: true, acc: 15 };

  // A. Clean Plate Default: OFF when no Home stop is saved
  assert.equal(sr.isEnabled(), false, 'Quick Return Suggestions must default to OFF when no Home stop/route is saved');
  sr.recordInboundTrip(e36Out, stopHongLok, stopsByGroup.LWB_E36_O, outbound1700);
  assert.equal(sr.evaluateCandidate(userNearYuTung, { centerStop: stopYuTung }, now1907), null, 'Must not trigger when clean-plate default is OFF');

  // B. User turns toggle ON, but only 1 tap (one-off trip) -> STILL SUPPRESSED (high-confidence gate)
  sr.setEnabled(true);
  assert.equal(sr.isEnabled(), true);
  assert.equal(sr.evaluateCandidate(userNearYuTung, { centerStop: stopYuTung }, now1907), null, 'Single one-off trip must NEVER trigger Quick Return');

  // Rapid repeated taps within 10 minutes in one sitting must deduplicate to 1 trip, not 3
  sr.recordInboundTrip(e36In, stopYuTung, stopsByGroup.LWB_E36_I, hktMs(22, 19, 0));
  sr.recordInboundTrip(e36In, stopYuTung, stopsByGroup.LWB_E36_I, hktMs(22, 19, 4));
  sr.recordInboundTrip(e36In, stopYuTung, stopsByGroup.LWB_E36_I, hktMs(22, 19, 8));
  assert.equal(sr.countTripsInTimeWindow(e36In, now1907), 1, 'Repeated taps within 30 mins must deduplicate into 1 trip');
  // Re-record today's outbound trip as latest trip
  sr.recordInboundTrip(e36Out, stopHongLok, stopsByGroup.LWB_E36_O, outbound1700);
  assert.equal(sr.evaluateCandidate(userNearYuTung, { centerStop: stopYuTung }, now1907), null, 'Only 1 return trip logged -> must remain suppressed');

  // Log 2 more distinct evening trips on E36 return (total = 3 in ~19:00 window)
  sr.recordInboundTrip(e36In, stopYuTung, stopsByGroup.LWB_E36_I, hktMs(23, 18, 45));
  sr.recordInboundTrip(e36In, stopYuTung, stopsByGroup.LWB_E36_I, hktMs(24, 19, 30));
  sr.recordInboundTrip(e36Out, stopHongLok, stopsByGroup.LWB_E36_O, outbound1700);
  assert.equal(sr.countTripsInTimeWindow(e36In, now1907), 3, '3 distinct sessions in ±2h window must count as 3');

  // Outside time-of-day window (e.g., 11:00 HKT vs 19:00 logged trips) -> suppressed!
  const outbound0900 = hktMs(25, 9, 0);
  const now1100 = hktMs(25, 11, 0);
  sr.recordInboundTrip(e36Out, stopHongLok, stopsByGroup.LWB_E36_O, outbound0900);
  assert.equal(sr.evaluateCandidate(userNearYuTung, { centerStop: stopYuTung }, now1100), null, '3+ trips in evening window must NOT trigger at 11:00 AM');

  // Inside similar time-of-day window (19:07 HKT) AND standing right at Yu Tung Court -> triggers!
  sr.recordInboundTrip(e36Out, stopHongLok, stopsByGroup.LWB_E36_O, outbound1700);
  const candRepeat = sr.evaluateCandidate(userNearYuTung, { centerStop: stopYuTung }, now1907);
  assert.ok(candRepeat && candRepeat.returnGroup.key === 'LWB_E36_I' && candRepeat.confidenceReason === 'REPEAT_HISTORY', '3+ logged return trips in similar time window at active stop must pass');

  // C. Distance Guardrail: Exact screenshot scenario (active stop = Tung Chung Fire Station ~59m vs boarding stop = Yu Tung Court ~174m)
  const candFarther = sr.evaluateCandidate(userNearTcFire, { centerStop: stopTcFire }, now1907);
  assert.equal(candFarther, null, 'Must suppress Quick Return when boarding stop (Yu Tung Court) is farther away than active stop group (Tung Chung Fire Station)');

  // D. Explicit Home Anchor: Reset history & pref to clean plate, save Home Stop = Hong Lok Road
  memStore[sr.historyStorageKey] = '[]';
  memStore[sr.prefStorageKey] = '';
  assert.equal(sr.isEnabled(), false, 'Before saving Home stop, clean-plate default is OFF');
  hubs.setHub('home', stopHongLok, 'BUS', true);
  assert.equal(sr.isEnabled(), true, 'Saving an explicit Home stop enables Quick Return default unless manually turned OFF');
  sr.recordInboundTrip(e36Out, stopHongLok, stopsByGroup.LWB_E36_O, outbound1700);
  const candHome = sr.evaluateCandidate(userNearYuTung, { centerStop: stopYuTung }, now1907);
  assert.ok(candHome && candHome.confidenceReason === 'HOME_ANCHOR', 'Explicit Home stop anchor allows Quick Return back to Home even with 0 repeat logs');

  // Explicit Settings OFF overrides saved Home anchor
  sr.setEnabled(false);
  assert.equal(sr.isEnabled(), false);
  assert.equal(sr.evaluateCandidate(userNearYuTung, { centerStop: stopYuTung }, now1907), null, 'Manual Settings OFF must suppress Quick Return even when Home stop is saved');

  // E. Imminent Departure & Wait-Time Guardrail (>20m wait while closer frequent routes arrive within <=5m)
  const srEta29m = { targetMs: now1907 + 29 * 60000, groupKey: 'LWB_E36_I' };
  const srEta12m = { targetMs: now1907 + 12 * 60000, groupKey: 'LWB_E36_I' };
  const localImminent = [
    { targetMs: now1907 + 1 * 60000, distM: 61, groupKey: 'LWB_E31_O' },
    { targetMs: now1907 + 2 * 60000, distM: 73, groupKey: 'NLB_38_O' },
  ];
  const localSlowOnly = [
    { targetMs: now1907 + 14 * 60000, distM: 61, groupKey: 'LWB_E31_O' },
  ];

  const sup29m = sr.shouldSuppressByWaitTime(srEta29m, localImminent, 127, now1907);
  assert.equal(sup29m.suppress, true, 'Must suppress 29m (>20m) Quick Return when closer routes at current stop arrive within 5m');

  const keep12m = sr.shouldSuppressByWaitTime(srEta12m, localImminent, 127, now1907);
  assert.equal(keep12m.suppress, false, 'Must NOT suppress 12m (<=20m) Quick Return');

  const keep29mNoImminent = sr.shouldSuppressByWaitTime(srEta29m, localSlowOnly, 127, now1907);
  assert.equal(keep29mNoImminent.suppress, false, 'Must NOT suppress 29m Quick Return if no closer route arrives within 5m');
});

test('Architecture Update 1: Cross-Tunnel & 5km Lookahead Cap blocks Lantau -> Tuen Mun Wong Chu Rd leakage at E36 Stop 8 while preserving TM-CLKL BBI Stop 11', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const db = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));
  const e36PatHeung = db.groupedRoutes.find((g: any) => g.routeNo === 'E36' && /Pat Heung/i.test(g.dest_e));
  assert.ok(e36PatHeung, 'bus_index.min.json must contain E36 To Pat Heung Road');
  const rawStops = db.routeStopsCache[e36PatHeung.routeIds[0]];
  const stops = rawStops.map((entry: any) => {
    const idx = Array.isArray(entry) ? entry[0] : entry;
    const s = db.stopsDict[idx];
    return { stopKey: `S_${s[0]}`, stopName_e: s[1], name_tc: s[2], latitude: String(s[3]), longitude: String(s[4]) };
  });

  const stop8Idx = stops.findIndex((s: any) => /Tung Chung Cable Car/i.test(s.stopName_e));
  const stop11Idx = stops.findIndex((s: any) => /Tuen Mun.*Chek Lap Kok.*Tunnel/i.test(s.stopName_e));
  assert.ok(stop8Idx >= 0 && stop11Idx > stop8Idx, `Expected Tung Chung Cable Car before TM-CLKL BBI (${stop8Idx} < ${stop11Idx})`);

  const wongChuDetectors = [
    {
      id: 'TDSLFR10003',
      lat: 22.3849,
      lon: 113.9721,
      rot: 65,
      spd: 34,
      occ: 36,
      tier: 'SLOW',
      roadEn: 'Wong Chu Road near Tuen Mun Heung Sze Wui Road - Eastbound',
      roadTc: '皇珠路近屯門鄉事會路 - 東行',
      camKey: 'TDSLFR10003',
    },
  ];

  // Stop 8 (Tung Chung Cable Car Terminal on Lantau) MUST NOT pull Wong Chu Road across TM-CLKL subsea tunnel
  const atStop8 = sb.getDirectionalRoadSummary(stops, stop8Idx, wongChuDetectors, false, 8);
  assert.equal(atStop8, null, 'Stop 8 on Lantau must NOT pull Tuen Mun Wong Chu Road alerts across TM-CLKL tunnel');

  // Stop 11 (TM-CLKL Tunnel BBI itself) DOES see Wong Chu Road on its immediate departing leg
  const atStop11 = sb.getDirectionalRoadSummary(stops, stop11Idx, wongChuDetectors, false, 8);
  assert.ok(atStop11 && atStop11.focusDet?.id === 'TDSLFR10003', 'Stop 11 (TM-CLKL Tunnel BBI) must still surface Wong Chu Road ahead');

  // Strict 5km lookahead cap on normal multi-stop urban corridor (detectors > 5km downroute excluded)
  const urbanStops = Array.from({ length: 12 }, (_, i) => ({
    stopKey: `U_${i}`,
    stopName_e: `Nathan Road Stop ${i + 1}`,
    latitude: String(22.300 + i * 0.009), // ~1.0 km per stop -> 11 km total
    longitude: '114.1715',
  }));
  const detAt3Km = { id: 'URB_3KM', lat: 22.327, lon: 114.1715, rot: 0, spd: 18, occ: 85, tier: 'JAMMED', roadEn: 'Nathan Road (3km)', camKey: 'K101F' };
  const detAt8Km = { id: 'URB_8KM', lat: 22.372, lon: 114.1715, rot: 0, spd: 8, occ: 98, tier: 'JAMMED', roadEn: 'Nathan Road (8km)', camKey: 'K109F' };

  const onlyFar = sb.getDirectionalRoadSummary(urbanStops, 0, [detAt8Km], false, 12, null, 5000);
  assert.equal(onlyFar, null, 'Detector 8km ahead on urban route must be excluded by 5km maxLookaheadMeters cap');

  const bothUrban = sb.getDirectionalRoadSummary(urbanStops, 0, [detAt3Km, detAt8Km], false, 12, null, 5000);
  assert.equal(bothUrban?.focusDet?.id, 'URB_3KM', 'Detector within 5km must be selected while 8km detector is ignored');
});

test('Architecture Update 1B: Floating Back to Stop pill appears when panning >300m away from active stop and pans back cleanly', () => {
  const mapCode = readMapBundle();
  const html = readAppBundle();
  assert.ok(html.includes('id="detailBackToStopPill"') && html.includes('returnToActiveDetailStop()'), 'index.html must include top-center #detailBackToStopPill button');

  const pillEl = { style: { display: 'none' }, innerText: '', setAttribute() {} };
  let mapCenter = { lat: 22.3690, lng: 113.9476 };
  const setViewCalls: any[] = [];
  let closedPopups = 0;
  let closedModal = 0;

  const fakeDetailMap = {
    getCenter: () => mapCenter,
    getZoom: () => 15,
    once() {},
    setView(coords: [number, number], zoom: number) {
      mapCenter = { lat: coords[0], lng: coords[1] };
      setViewCalls.push({ coords, zoom });
    },
    closePopup() { closedPopups++; },
    getBounds: () => ({ isValid: () => true, pad: () => ({ contains: () => true }) }),
  };

  const ctx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [
        { id: 'TDS90048', lat: 22.3965, lon: 113.9775, rot: 15, spd: 14, occ: 88, tier: 'JAMMED', roadEn: 'Tuen Mun Road' },
      ],
      closeTrafficDecisionModal() { closedModal++; },
    },
    document: {
      getElementById: (id: string) => (id === 'detailBackToStopPill' ? pillEl : null),
    },
    isValidRailOrFerryCoord: (la: number, lo: number) => Number.isFinite(la) && Number.isFinite(lo) && la > 22 && la < 23 && lo > 113 && lo < 115,
    currentLang: 'en',
    currentView: 'detail',
    detailRouteGroup: { key: 'LWB_E36_O', mode: 'BUS', routeNo: 'E36' },
    detailExpandedStopIdx: 10,
    getStopsForGroup: () => Array.from({ length: 12 }, (_, i) => ({
      stopName_e: i === 10 ? 'Tuen Mun Chek Lap Kok Tunnel BBI' : `Stop ${i + 1}`,
      latitude: i === 10 ? '22.3690' : String(22.28 + i * 0.005),
      longitude: i === 10 ? '113.9476' : '113.9420',
    })),
    escapeHtml: (s: string) => String(s ?? ''),
    L: {
      layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }),
      polyline: () => ({ addTo() { return this; }, bindTooltip() { return this; }, on() { return this; } }),
      divIcon: (o: any) => o,
      marker: () => ({ addTo() { return this; }, bindTooltip() { return this; }, openTooltip() {}, on() { return this; } }),
    },
    console,
    Math,
    Number,
    String,
    Array,
    Map,
    Set,
    setTimeout: (fn: any) => fn(),
    clearTimeout: () => {},
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(mapCode, ctx);
  ctx.mapInstance = fakeDetailMap;
  ctx.window.mapInstance = fakeDetailMap;

  // Pan to detector ~4.3km away from Stop 11 -> pill MUST show "↩ Back to Stop 11"
  ctx.focusTrafficDetectorOnDetailMap(22.3965, 113.9775, 'TDS90048');
  assert.equal(pillEl.style.display, 'inline-flex', 'Back to Stop pill must appear after panning >300m away');
  assert.equal(pillEl.innerText, '↩ Back to Stop 11', 'Pill text must dynamically reflect active stop sequence 11');

  // Tap pill -> pans back to Stop 11, closes popup/modal, hides pill
  ctx.returnToActiveDetailStop();
  assert.equal(pillEl.style.display, 'none', 'Pill must auto-hide after returning to active stop');
  assert.ok(closedPopups >= 1 && closedModal >= 1, 'Returning to stop must close open popup and camera modal');
  const lastView = setViewCalls[setViewCalls.length - 1];
  assert.ok(Math.abs(lastView.coords[0] - 22.3690) < 0.001 && Math.abs(lastView.coords[1] - 113.9476) < 0.001, 'Map must pan back to Stop 11 coordinates');
});

test('Architecture Update 2: Route-Level Speed Digital Twin GeoJSON colors (#16a34a/#f59e0b/#dc2626 + #3b82f6 local fallback), thin dark casing, and Worker speedMapGeoJson + cameras', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const getTrafficSpeedColorHex = sb.ctx.window.getTrafficSpeedColorHex;
  const buildRouteSpeedGeoJson = sb.ctx.window.buildRouteSpeedGeoJson;

  // Exact speed color thresholds
  assert.equal(getTrafficSpeedColorHex(12), '#dc2626');
  assert.equal(getTrafficSpeedColorHex(19.9), '#dc2626');
  assert.equal(getTrafficSpeedColorHex(20), '#f59e0b');
  assert.equal(getTrafficSpeedColorHex(40), '#f59e0b');
  assert.equal(getTrafficSpeedColorHex(40.1), '#16a34a');
  assert.equal(getTrafficSpeedColorHex(85), '#16a34a');
  assert.equal(getTrafficSpeedColorHex(null), '#3b82f6');

  // Build route speed GeoJSON along a northbound highway with 1 jammed, 1 slow, 1 smooth, and 1 opposite-bound detector
  const coords = [
    [22.3700, 113.9600],
    [22.3850, 113.9600],
    [22.4000, 113.9600],
    [22.4250, 113.9600],
  ];
  const dets = [
    { id: 'D_JAM', lat: 22.3740, lon: 113.9601, rot: 0, spd: 14, tier: 'JAMMED', roadEn: 'Highway South' },
    { id: 'D_SLOW', lat: 22.3920, lon: 113.9601, rot: 2, spd: 32, tier: 'SLOW', roadEn: 'Highway Mid' },
    { id: 'D_FAST', lat: 22.4220, lon: 113.9601, rot: 358, spd: 78, tier: 'SMOOTH', roadEn: 'Highway North' },
    // Opposite bound jammed detector right next to D_FAST -> must be rejected by direction check!
    { id: 'D_OPP', lat: 22.4220, lon: 113.9600, rot: 180, spd: 9, tier: 'JAMMED', roadEn: 'Highway North SB' },
  ];
  const fc = buildRouteSpeedGeoJson(coords, dets, { isRoadSnapped: true });
  assert.equal(fc.type, 'FeatureCollection');
  assert.ok(fc.features.length >= 4, 'Expected multiple distinct speed-colored LineString segments');
  const colors = new Set(fc.features.map((f: any) => f.properties.color));
  assert.ok(colors.has('#dc2626') && colors.has('#f59e0b') && colors.has('#16a34a') && colors.has('#3b82f6'), `Expected all 4 speed/local colors, got ${[...colors].join(',')}`);
  const oppUsed = fc.features.some((f: any) => f.properties.detectorId === 'D_OPP');
  assert.equal(oppUsed, false, 'Opposite-direction detector must NOT color the active route polyline');

  // Verify map.js renders thin dark casing (#1e293b weight 7.5) underneath live speed-colored GeoJSON (weight 5, round caps)
  const mapCode = readMapBundle();
  const polyCalls: any[] = [];
  const geoJsonCalls: any[] = [];
  const mCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: dets,
      buildRouteSpeedGeoJson,
    },
    document: { getElementById: () => null },
    L: {
      layerGroup: (items: any[] = []) => ({ _items: items, addTo() { return this; }, clearLayers() {} }),
      polyline: (c: any, opts: any) => { polyCalls.push({ c, opts }); return { addTo() { return this; } }; },
      geoJSON: (data: any, opts: any) => { geoJsonCalls.push({ data, opts }); return { addTo() { return this; } }; },
    },
    console, Math, Number, String, Array, Map, Set,
  };
  vm.createContext(mCtx);
  vm.runInContext(mapCode, mCtx);
  mCtx.buildDetailBusPolylineLayer(coords, [], 0, '#FF3B30');
  assert.ok(polyCalls.some(p => p.opts?.color === '#0f172a' && p.opts?.weight === 7 && p.opts?.opacity === 0.85), 'Route speed polyline must render high-contrast dark casing (#0f172a, weight 7, opacity 0.85)');
  assert.equal(geoJsonCalls.length, 1, 'Route speed polyline must use L.geoJSON for speed-colored segments');
  const sampleStyle = geoJsonCalls[0].opts.style(fc.features[0]);
  assert.equal(sampleStyle.weight, 4.5);
  assert.equal(sampleStyle.opacity, 0.92);
  assert.equal(sampleStyle.dashArray, null);
  assert.equal(sampleStyle.lineCap, 'round');
  assert.equal(sampleStyle.lineJoin, 'round');

  // Verify worker.js returns speedMapGeoJson + cameras, keeps 60m-320m 2-point links, and keeps sole export
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  assert.ok(workerSrc.includes('speedMapGeoJson') && workerSrc.includes('buildWorkerSpeedMapGeoJson'), 'worker.js must expose speedMapGeoJson');
  assert.ok(workerSrc.includes('if (dKm < 0.06 || dKm > 0.32) continue;'), 'worker.js must keep 60m-320m 2-point links and drop long hillside-cutting chords');
  assert.ok(workerSrc.includes('cameras: cameras.length') && workerSrc.includes('      cameras,'), 'worker.js traffic_live must expose active TD cameras array');
  const exportLines = workerSrc.split('\n').filter((l) => /^\s*export\b/.test(l));
  assert.equal(exportLines.length, 1, 'worker.js must keep exactly one export (onRequest)');
});

test('Architecture Update 3: Global Map View Traffic Toggle at bottomright, <350m ramp stub cleanup, high-zoom lane centering, and stop restore when OFF', () => {
  const mapCode = readMapBundle();
  const addedControls: any[] = [];
  const addedToBrowseMap = new Set<any>();
  const clusterMarkers: any[] = [];
  const geoJsonLayers: any[] = [];
  const casingPolylines: any[] = [];

  let mockZoom = 15;
  const fakeBrowseMap: any = {
    addControl(ctrl: any) { addedControls.push(ctrl); ctrl.onAdd(this); },
    hasLayer(l: any) { return addedToBrowseMap.has(l); },
    removeLayer(l: any) { addedToBrowseMap.delete(l); },
    getCenter: () => ({ lat: 22.4447, lng: 114.0243 }),
    getBounds: () => ({
      isValid: () => true,
      pad: () => ({ contains: () => true }),
      contains: () => true,
      getSouth: () => 22.40,
      getNorth: () => 22.48,
      getWest: () => 113.98,
      getEast: () => 114.06,
    }),
    getZoom: () => mockZoom,
    on() {},
  };

  const directCamMarkers: any[] = [];
  const makeGroup = () => ({
    _layers: [] as any[],
    addTo() { addedToBrowseMap.add(this); return this; },
    addLayer(l: any) {
      this._layers.push(l);
      if (l?.opts?.icon?.className === 'global-traffic-cam-icon') directCamMarkers.push(l);
      return this;
    },
    clearLayers() {
      this._layers.forEach((l: any) => {
        const idx = directCamMarkers.indexOf(l);
        if (idx >= 0) directCamMarkers.splice(idx, 1);
      });
      this._layers.length = 0;
    },
  });

  const fakeCluster = {
    _markers: clusterMarkers,
    addTo() { addedToBrowseMap.add(this); return this; },
    addLayer(l: any) { clusterMarkers.push(l); return this; },
    clearLayers() { clusterMarkers.length = 0; },
  };

  const initialStopMarker = { id: 'stop1' };
  addedToBrowseMap.add(initialStopMarker);

  const ctx: any = {
    window: {
      __LIVE_TRAFFIC_DETECTORS__: [
        { id: 'AID1', lat: 22.3965, lon: 113.9775, rot: 15, spd: 16, occ: 85, tier: 'JAMMED', color: '#dc2626', roadEn: 'Tuen Mun Road' },
        { id: 'AID2', lat: 22.4338, lon: 114.0025, rot: 45, spd: 80, occ: 10, tier: 'SMOOTH', color: '#16a34a', roadEn: 'Yuen Long Highway' },
      ],
      __LIVE_TRAFFIC_CAMERAS__: [
        { key: 'TM105F', lat: 22.3965, lon: 113.9775, desc: 'Tuen Mun Rd - Northbound', region: 'TM', url: 'https://tdcctv.data.one.gov.hk/TM105F.JPG' },
        { key: 'YL102F', lat: 22.4440, lon: 114.0220, desc: 'Yuen Long Hwy - Eastbound', region: 'YL', url: 'https://tdcctv.data.one.gov.hk/YL102F.JPG' },
      ],
      __LIVE_TRAFFIC_SPEED_GEOJSON__: {
        type: 'FeatureCollection',
        features: [
          // 220m valid 2-point arterial link (60m - 320m) -> MUST BE KEPT
          { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113.9770, 22.3950], [113.9775, 22.3969]] }, properties: { color: '#dc2626', spd: 16, rot: 14, id: 'AID1', roadEn: 'Tuen Mun Road', rawCoords: [[113.9770, 22.3950], [113.9775, 22.3969]] } },
          // 560m long 2-point straight chord -> MUST BE FILTERED OUT (> 320m hillside-cutting chord)
          { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113.998, 22.442], [113.999, 22.447]] }, properties: { color: '#16a34a', spd: 55, rot: 11, id: 'LONG_CHORD', roadEn: 'Tuen Mun Road near Tai Lam', rawCoords: [[113.998, 22.442], [113.999, 22.447]] } },
          // 3-point curved polyline > 400m -> MUST BE KEPT (coords.length >= 3)
          { type: 'Feature', geometry: { type: 'LineString', coordinates: [[114.001, 22.432], [114.003, 22.434], [114.005, 22.436]] }, properties: { color: '#16a34a', spd: 80, rot: 45, id: 'AID2', roadEn: 'Yuen Long Highway', rawCoords: [[114.001, 22.432], [114.003, 22.434], [114.005, 22.436]] } },
        ],
      },
      syncTrafficToggleButtonsUI() {},
    },
    document: { getElementById: () => null },
    isValidRailOrFerryCoord: (la: number, lo: number) => Number.isFinite(la) && Number.isFinite(lo),
    getStopName: (s: any) => s.stopName_e || '',
    getBaseStopNameKey: (s: any) => String(s?.stopName_e || '').toLowerCase(),
    cleanFerryLabel: (s: string) => String(s || ''),
    buildBrowseMapActionPopupHtml: () => '<div>stop</div>',
    currentLang: 'en',
    activeAppMode: 'BUS',
    allStops: [
      { stopKey: 'KMB_S1', mode: 'BUS', stopName_e: 'Yuen Long Plaza', latitude: '22.4447', longitude: '114.0243', routeNos: new Set(['E36']) },
    ],
    escapeHtml: (s: string) => String(s ?? ''),
    escapeJsAttr: (s: string) => String(s ?? ''),
    L: {
      Control: {
        extend(def: any) {
          return function(this: any) {
            Object.assign(this, def);
            this.addTo = (m: any) => { m.addControl(this); return this; };
          };
        },
      },
      DomUtil: {
        create(_tag: string, cls: string) {
          return { className: cls, id: '', type: '', innerHTML: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, addEventListener() {} };
        },
      },
      DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {}, stop() {}, on() {} },
      layerGroup: () => makeGroup(),
      markerClusterGroup: () => fakeCluster,
      geoJSON: (fc: any, opts: any) => { geoJsonLayers.push({ fc, opts }); return { addTo(g: any) { g.addLayer(this); return this; } }; },
      polyline: (c: any, opts: any) => { casingPolylines.push({ c, opts }); return { addTo(g: any) { g.addLayer(this); return this; } }; },
      divIcon: (o: any) => o,
      circleMarker: (ll: any, opts: any) => ({ ll, opts, bindTooltip() { return this; }, bindPopup() { return this; }, addTo() { addedToBrowseMap.add(this); return this; } }),
      marker: (ll: any, opts: any) => ({ ll, opts, bindTooltip() { return this; }, bindPopup() { return this; }, on() { return this; }, addTo(g: any) { g?.addLayer?.(this); return this; } }),
    },
    console, Math, Number, String, Array, Map, Set,
  };
  vm.createContext(ctx);
  vm.runInContext(mapCode, ctx);

  // Wire mock browseMapInstance and pre-populate an active bus stop marker
  ctx.browseMapInstance = fakeBrowseMap;
  ctx.window.browseMapInstance = fakeBrowseMap;
  ctx.activeBrowseMarkersByKey.set('KMB_S1', initialStopMarker);

  // Attach custom Leaflet control -> MUST be positioned at bottomright above GPS/+/-
  ctx.attachGlobalTrafficControlToBrowseMap(fakeBrowseMap);
  assert.equal(addedControls.length, 1, 'Must attach custom Leaflet L.Control for Global Traffic Toggle');
  assert.equal(addedControls[0].options?.position, 'bottomright', 'Global Traffic control must be positioned at bottomright');
  assert.equal(ctx.window.globalTrafficLayerEnabled, false, 'Global traffic toggle must default to OFF so stops browse normally');

  // High-zoom lane offset reduction check (z >= 15 uses tight 1.5m offset vs 2.5m at z < 15)
  assert.equal(ctx.window.getGlobalTrafficLaneOffsetMeters(15), 1.5, 'High zoom (z >= 15) must use tight 1.5m HK keep-left offset');
  assert.equal(ctx.window.getGlobalTrafficLaneOffsetMeters(13), 2.5, 'Lower zoom (z < 15) must use 2.5m HK keep-left offset');
  assert.ok(ctx.window.getGlobalTrafficLaneOffsetMeters(15) < ctx.window.getGlobalTrafficLaneOffsetMeters(13), 'High zoom offset must be strictly tighter than z13');

  // Overview zoom (z=12) -> ZERO camera markers and ZERO numbered cluster bubbles
  mockZoom = 12;
  ctx.toggleGlobalTrafficLayer(true);
  assert.equal(ctx.window.globalTrafficLayerEnabled, true);
  assert.equal(ctx.activeBrowseMarkersByKey.size, 0, 'Turning Global Traffic ON must immediately hide all bus stop markers');
  assert.equal(addedToBrowseMap.has(initialStopMarker), false, 'Bus stop marker must be removed from browseMapInstance while Global Traffic is ON');
  assert.equal(geoJsonLayers.length, 2, 'Global Traffic ON must render 2 L.geoJSON layers (5px dark casing + 3px speed-colored lines)');
  assert.equal(geoJsonLayers[1].fc.features.length, 2, 'Long >320m 2-point chord must be filtered out while keeping valid 60-320m 2-point link and >=3-point polyline');
  assert.ok(!geoJsonLayers[1].fc.features.some((f: any) => f.properties.id === 'LONG_CHORD'), 'LONG_CHORD (>320m 2-point) must be stripped');
  const casingStyle = typeof geoJsonLayers[0].opts.style === 'function' ? geoJsonLayers[0].opts.style(geoJsonLayers[0].fc.features[0]) : geoJsonLayers[0].opts.style;
  assert.equal(casingStyle.color, '#0f172a', 'Global Traffic casing GeoJSON must use dark slate casing (#0f172a)');
  assert.equal(casingStyle.weight, 6.5, 'Global Traffic casing weight must be 6.5px');
  const topStyle = geoJsonLayers[1].opts.style(geoJsonLayers[1].fc.features[0]);
  assert.equal(topStyle.color, '#ef4444', 'Global Traffic speed GeoJSON must apply vivid congested color (#ef4444)');
  assert.equal(topStyle.weight, 4.5, 'Global Traffic TD top stroke weight must be 4.5px');
  assert.equal(topStyle.opacity, 0.92, 'Global Traffic TD top stroke opacity must be 0.92');
  assert.equal(topStyle.dashArray, null, 'Global Traffic TD top stroke must be solid (dashArray null)');
  assert.equal(clusterMarkers.length, 0, 'Global Traffic must NEVER use numbered L.markerClusterGroup bubbles');
  assert.equal(directCamMarkers.length, 0, 'Overview zoom (z=12 < 14) must render ZERO camera markers');

  // Zoom in (z=15 >= 14) -> individual directional cameras appear directly (still zero cluster bubbles)
  mockZoom = 15;
  ctx.renderGlobalTrafficDashboard(fakeBrowseMap);
  assert.equal(clusterMarkers.length, 0, 'Zoomed-in cameras must render directly without numbered cluster bubbles');
  assert.equal(directCamMarkers.length, 2, 'Zoomed-in view (z=15 >= 14) must plot individual viewport TD cameras');

  // Calling renderBrowseMapVisiblePins() while Global Traffic is ON must keep bus stops hidden
  ctx.renderBrowseMapVisiblePins();
  assert.equal(ctx.activeBrowseMarkersByKey.size, 0, 'Bus stops must remain hidden during pan/zoom while Global Traffic is ON');

  // Toggle OFF -> clears global traffic + cameras and restores bus stops
  ctx.toggleGlobalTrafficLayer(false);
  assert.equal(ctx.window.globalTrafficLayerEnabled, false);
  assert.equal(directCamMarkers.length, 0, 'Turning Global Traffic OFF must clear cameras');
  assert.equal(ctx.activeBrowseMarkersByKey.size, 1, 'Turning Global Traffic OFF must immediately restore bus stop markers');
});

test('Architecture Update 4: GPS Direction Toggle clusters paired same-name stops within 200m (Sun Wai Tsuen 88m poles) and reads tdBound for NLB & GMB routes', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const collectDirectionClusterStops = sb.ctx.window.collectDirectionClusterStops;
  const db = JSON.parse(fs.readFileSync('public/bus_index.min.json', 'utf8'));
  const html = readAppBundle();

  // 1. Verify extractRouteBoundCode in index.html checks tdBound BEFORE routeIds / key
  const fnMatch = html.match(/function extractRouteBoundCode\(group\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'index.html must define extractRouteBoundCode');
  const fnCtx: any = {};
  vm.createContext(fnCtx);
  vm.runInContext(fnMatch[0], fnCtx);

  const nlb3mO = db.groupedRoutes.find((g: any) => g.company === 'NLB' && g.routeNo === '3M' && g.tdBound === 'O');
  const nlb3mI = db.groupedRoutes.find((g: any) => g.company === 'NLB' && g.routeNo === '3M' && g.tdBound === 'I');
  assert.ok(nlb3mO && nlb3mI, 'bus_index.min.json must contain both O and I bounds of NLB 3M');
  assert.equal(fnCtx.extractRouteBoundCode(nlb3mO), 'O', 'NLB 3M outbound must resolve to bound O');
  assert.equal(fnCtx.extractRouteBoundCode(nlb3mI), 'I', 'NLB 3M inbound must resolve to bound I via tdBound');

  // 2. Real Sun Wai Tsuen paired stops (88m apart, opposite sides of South Lantau Rd)
  const allStops = db.stopsDict.map((s: any, idx: number) => ({
    stopKey: `S_${idx}`,
    stopId: String(s[0]),
    mode: 'BUS',
    stopName_e: s[1],
    name_tc: s[2],
    latitude: String(s[3]),
    longitude: String(s[4]),
  }));
  const swtPoleA = allStops.find((s: any) => s.stopName_e === 'Sun Wai Tsuen' && s.stopId === '13');
  const swtPoleB = allStops.find((s: any) => s.stopName_e === 'Sun Wai Tsuen' && s.stopId === '260');
  assert.ok(swtPoleA && swtPoleB, 'bus_index.min.json must contain both Sun Wai Tsuen poles (13 & 260)');

  const cluster = collectDirectionClusterStops(allStops, swtPoleA, 'BUS', 0.20, { refLat: 22.2435, refLon: 113.9781 });
  const ids = cluster.map((s: any) => s.stopId);
  assert.ok(ids.includes('13') && ids.includes('260'), `Expected Sun Wai Tsuen 200m direction cluster to include both poles 13 & 260, got ${ids.join(',')}`);

  // 3. Name normalization pairs suffixed opposite-side stops within 200m and excludes >200m stops
  const synthStops = [
    { stopKey: 'A', mode: 'BUS', stopName_e: 'Yuen Long Plaza (YL101)', name_tc: '元朗廣場', latitude: '22.4447', longitude: '114.0243' },
    { stopKey: 'B', mode: 'BUS', stopName_e: 'Yuen Long Plaza (Opposite)', name_tc: '元朗廣場 (對面)', latitude: '22.4455', longitude: '114.0243' },
    { stopKey: 'C', mode: 'BUS', stopName_e: 'Yuen Long Plaza', name_tc: '元朗廣場', latitude: '22.4480', longitude: '114.0243' },
  ];
  const synthCluster = collectDirectionClusterStops(synthStops, synthStops[0], 'BUS', 0.20);
  assert.deepEqual(Array.from(synthCluster, (s: any) => s.stopKey), ['A', 'B'], 'Must cluster same-name opposite stop within 200m and reject >200m stop');
});

test('Traffic Update 1: Strict 12km forward-only route-polyline lookahead isolates E36 Stop 17 from Tuen Mun cameras, allows E36 Stop 8 downstream highway match, and keeps S1/3M isolated', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const {
    getDirectionalRoadSummary,
    sliceForwardPolylineFromStop,
  } = sb.ctx.window;

  // Simulated E36 -> Airport corridor: Tuen Mun (Stops 0..2) -> TM-CLK Tunnel (Stop 3) -> Tung Chung Fire Station (Stop 4, analogous to Stop 17) -> Airport (Stops 5..6)
  const e36ToAirportStops = [
    { lat: 22.4445, lon: 114.0240, name: 'Yuen Long Plaza' },
    { lat: 22.3908, lon: 113.9720, name: 'Wong Chu Road' },
    { lat: 22.3712, lon: 113.9635, name: 'Tuen Mun-Chek Lap Kok Tunnel Interchange' },
    { lat: 22.3168, lon: 113.9490, name: 'HZMB HK Port Portal' },
    { lat: 22.2925, lon: 113.9410, name: 'Tung Chung Fire Station' }, // Stop 17 equivalent (index 4)
    { lat: 22.2965, lon: 113.9315, name: 'Cathay City' },
    { lat: 22.3155, lon: 113.9360, name: 'Airport Ground Transportation Centre' },
  ];
  const e36ToAirportPoly = e36ToAirportStops.map((s) => [s.lat, s.lon]);

  // Detectors & cameras ONLY exist upstream (Tuen Mun / Wong Chu Rd) — nothing ahead of Tung Chung Fire Station toward Airport
  const upstreamOnlyDetectors = [
    {
      id: 'TDS_WONGCHU_SB',
      lat: 22.3880,
      lon: 113.9708,
      roadEn: 'Wong Chu Road - Southbound',
      roadTc: '皇珠路 - 南行',
      spd: 14,
      rot: 205,
      occ: 72,
      camKey: 'TM101F',
    },
    {
      id: 'TDS_TMCLK_SB',
      lat: 22.3500,
      lon: 113.9575,
      roadEn: 'Tuen Mun-Chek Lap Kok Tunnel Road - Southbound',
      roadTc: '屯門赤鱲角隧道公路 - 南行',
      spd: 26,
      rot: 196,
      occ: 48,
      camKey: 'TM202F',
    },
  ];
  const upstreamCameras = [
    { key: 'TM101F', lat: 22.3880, lon: 113.9708, desc: 'Wong Chu Road near Tuen Mun Road - Southbound', dir: 'SB' },
    { key: 'TM202F', lat: 22.3500, lon: 113.9575, desc: 'Tuen Mun-Chek Lap Kok Tunnel Portal - Southbound', dir: 'SB' },
  ];

  // 1. E36 Stop 17 (Tung Chung Fire Station -> Airport): MUST NOT pull Tuen Mun / Wong Chu Rd cameras from behind!
  const stop17Res = getDirectionalRoadSummary(
    e36ToAirportStops,
    4,
    upstreamOnlyDetectors,
    false,
    40,
    e36ToAirportPoly,
    12000,
    upstreamCameras
  );
  assert.equal(stop17Res, null, 'E36 at Tung Chung Fire Station (Stop 17) must NEVER match upstream Tuen Mun/Wong Chu Rd detectors or cameras');

  // 2. sliceForwardPolylineFromStop from Stop 17 must strictly exclude upstream Tuen Mun coordinates
  const fwdPolyFromStop17 = sliceForwardPolylineFromStop(e36ToAirportPoly, e36ToAirportStops, 4, 12.0);
  assert.ok(fwdPolyFromStop17.length >= 2, 'Forward slice from Stop 17 must retain remaining route toward Airport');
  assert.ok(
    fwdPolyFromStop17.every((pt: [number, number]) => pt[0] < 22.33),
    'Forward slice from Stop 17 must never include upstream Tuen Mun / Wong Chu Rd points (lat > 22.33)'
  );

  // 3. E36 -> Pat Heung Road at Stop 8 (Tung Chung Cable Car Terminal): forward polyline crosses TM-CLK (~7.5km ahead)
  const e36ToPatHeungStops = [
    { lat: 22.2896, lon: 113.9388, stopName_e: 'Tung Chung Cable Car Terminal', name_tc: '東涌纜車站' },
    { lat: 22.2925, lon: 113.9410, stopName_e: 'Tung Chung Fire Station', name_tc: '東涌消防局' },
    { lat: 22.3168, lon: 113.9490, stopName_e: 'HZMB HK Port Portal', name_tc: '港珠澳大橋香港口岸' },
    { lat: 22.3712, lon: 113.9635, stopName_e: 'Tuen Mun-Chek Lap Kok Tunnel Interchange', name_tc: '屯門赤鱲角隧道轉車站' },
    { lat: 22.4445, lon: 114.0240, stopName_e: 'Yuen Long Plaza', name_tc: '元朗廣場' },
  ];
  const e36ToPatHeungPoly = e36ToPatHeungStops.map((s) => [s.lat, s.lon]);
  const nbDetectors = [
    {
      id: 'TDS_TMCLK_NB',
      lat: 22.3500,
      lon: 113.9575,
      roadEn: 'Tuen Mun-Chek Lap Kok Tunnel Road - Northbound',
      roadTc: '屯門赤鱲角隧道公路 - 北行',
      spd: 22,
      rot: 15,
      occ: 58,
      camKey: 'TM202N',
    },
  ];
  const nbCameras = [
    { key: 'TM202N', lat: 22.3500, lon: 113.9575, desc: 'Tuen Mun-Chek Lap Kok Tunnel - Northbound', dir: 'NB' },
  ];
  const stop8Res = getDirectionalRoadSummary(
    e36ToPatHeungStops,
    0,
    nbDetectors,
    false,
    40,
    e36ToPatHeungPoly,
    12000,
    nbCameras
  );
  assert.ok(stop8Res && stop8Res.focusDet, 'E36 at Tung Chung Cable Car Terminal must match downstream TM-CLK northbound telemetry within 12km');
  assert.equal(stop8Res.focusDet.id, 'TDS_TMCLK_NB');
  assert.equal(stop8Res.focusDet.camKey, 'TM202N');
  assert.equal(stop8Res.isApproaching, false);

  // 4. Local routes (S1 Tung Chung <-> Airport, NLB 3M Mui Wo <-> Tung Chung) stay 100% isolated from TM-CLK highway sensors
  const localS1Stops = [
    { lat: 22.2896, lon: 113.9410, stopName_e: 'Tung Chung Station' },
    { lat: 22.2955, lon: 113.9310, stopName_e: 'Cathay City' },
    { lat: 22.3155, lon: 113.9360, stopName_e: 'Airport' },
  ];
  const localS1Res = getDirectionalRoadSummary(
    localS1Stops,
    0,
    nbDetectors.concat(upstreamOnlyDetectors),
    false,
    40,
    localS1Stops.map((s) => [s.lat, s.lon]),
    12000,
    nbCameras.concat(upstreamCameras)
  );
  assert.equal(localS1Res, null, 'Local route S1 must remain 100% isolated from TM-CLK / Tuen Mun detectors');
});

test('Traffic Update 4: Camera modal wraps 2-line titles, shows explicit EB/WB/NB/SB badge, and resolves live metrics for EB cameras like TDS90061', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const {
    extractCardinalDirectionMeta,
    findNearestMatchingDetectorForCamera,
  } = sb.ctx.window;
  const html = readAppBundle();

  // 1. Modal CSS & HTML must allow 2-line title wrap (no single-line nowrap truncation) and render .traffic-dir-badge
  assert.match(html, /\.traffic-modal-title\s*\{[\s\S]*-webkit-line-clamp:\s*2[\s\S]*white-space:\s*normal/, 'Modal title CSS must allow 2-line wrap');
  assert.match(html, /\.traffic-dir-badge\s*\{/, 'Modal CSS must style explicit .traffic-dir-badge');
  assert.match(html, /class="traffic-modal-title"[^>]*id="trafficModalTitle"/, 'Modal title element must use .traffic-modal-title class');
  assert.match(html, /function _buildTrafficModalSubHtml/, 'index.html must format explicit EB/WB/NB/SB badge next to timestamp');

  // 2. extractCardinalDirectionMeta extracts EB/WB/NB/SB cleanly across EN and ZH descriptions
  assert.equal(extractCardinalDirectionMeta('Yuen Long Highway near Hung Tin Road - Eastbound (2)', false)?.code, 'EB');
  assert.equal(extractCardinalDirectionMeta('Yuen Long Highway near Hung Tin Road - Westbound', false)?.code, 'WB');
  assert.equal(extractCardinalDirectionMeta('屯門赤鱲角隧道公路 - 北行', true)?.code, 'NB');
  assert.equal(extractCardinalDirectionMeta('吐露港公路南行', true)?.code, 'SB');

  // 3. TDS90061 (EB Yuen Long Highway, null own speed) must match nearby EB Yuen Long Highway sensor TDS90062
  //    and reject closer opposite-direction WB sensor TDS91045 and off-road Castle Peak Road sensor
  const camTDS90061 = {
    key: 'TDS90061',
    lat: 22.43618,
    lon: 114.0062,
    desc: 'Yuen Long Highway near Hung Tin Road - Eastbound (2)',
    dir: 'EB',
    spd: null,
  };
  const liveDetectors = [
    {
      id: 'TDS91045',
      lat: 22.4368,
      lon: 114.0042, // ~219m away, OPPOSITE direction (WB) -> must reject!
      roadEn: 'Yuen Long Highway near Hung Tin Road - Westbound',
      roadTc: '元朗公路近洪天路 - 西行',
      spd: 74,
      rot: 252,
    },
    {
      id: 'CP_OFFROAD',
      lat: 22.4352,
      lon: 114.0066, // ~115m away, DIFFERENT road (Castle Peak Rd) -> must reject in favor of same-road EB!
      roadEn: 'Castle Peak Road - Hung Shui Kiu - Eastbound',
      roadTc: '青山公路 - 洪水橋段 - 東行',
      spd: 31,
      rot: 72,
    },
    {
      id: 'TDS90062_FAR',
      lat: 22.4384,
      lon: 114.0098, // ~445m downstream -> must be rejected by tightened <=85m divided-highway camera binding!
      roadEn: 'Yuen Long Highway near Tong Yan San Tsuen - Eastbound',
      roadTc: '元朗公路近唐人新村 - 東行',
      spd: 65,
      rot: 72,
    },
    {
      id: 'TDS90062',
      lat: 22.43635,
      lon: 114.00675, // ~63m downstream (<=85m divided highway), SAME road + SAME direction (EB) -> must match!
      roadEn: 'Yuen Long Highway near Tong Yan San Tsuen - Eastbound',
      roadTc: '元朗公路近唐人新村 - 東行',
      spd: 68,
      rot: 72,
    },
  ];
  const matched = findNearestMatchingDetectorForCamera(camTDS90061, liveDetectors);
  assert.ok(matched, 'TDS90061 EB must resolve a nearby <=85m live TD speed detector');
  assert.equal(matched.id, 'TDS90062', 'TDS90061 EB must match same-road EB sensor TDS90062 within <=85m and never opposite WB TDS91045');
  assert.equal(matched.spd, 68);
  const farOnlyMatch = findNearestMatchingDetectorForCamera(camTDS90061, liveDetectors.filter((d: any) => d.id !== 'TDS90062'));
  assert.equal(farOnlyMatch, null, 'Camera must NOT attach a mismatched >85m detector (445m away)');
});

test('Commuter Update 1: iOS PWA controllerchange strictly requires sw-user-reload sessionStorage flag, suppresses duplicate toasts, and shows loading skeleton during isHydratingInitialData', async () => {
  const html = readAppBundle();
  const swCode = fs.readFileSync('public/sw.js', 'utf8');

  // 1. sw.js calls skipWaiting() immediately in install and also retains SKIP_WAITING message handling
  const installBlock = swCode.match(/addEventListener\('install'[\s\S]*?\n\}\);/)?.[0] || '';
  const installCodeOnly = installBlock.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(installCodeOnly.includes('self.skipWaiting()'), 'sw.js install must immediately call self.skipWaiting()');
  assert.ok(swCode.includes("data.type === 'SKIP_WAITING'") && swCode.includes('self.skipWaiting()'), 'sw.js must honor SKIP_WAITING message');

  // 2. index.html tracks isHydratingInitialData and renders .boot-skeleton-wrap instead of No bus / No stops during boot
  assert.ok(html.includes('let isHydratingInitialData = true;') && html.includes('renderBootLoadingSkeletonHtml'), 'index.html must track isHydratingInitialData and provide skeleton renderer');
  assert.ok(html.includes('if (isHydratingInitialData && !window.__INITIAL_STOPS_GPS_RESOLVED__)'), 'renderMainNearby must show loading skeleton instead of empty text during initial hydration');

  // 3. Run PWA update lifecycle in VM with explicit sessionStorage mock
  const fnBlockMatch = html.match(/function getAppBuildVersion\(\)[\s\S]*?window\.initPwaUpdateLifecycle = function initPwaUpdateLifecycle[\s\S]*?\n\};/);
  assert.ok(fnBlockMatch, 'Must extract PWA update lifecycle functions');

  const ssMap = new Map<string, string>();
  const mockSessionStorage = {
    getItem: (k: string) => (ssMap.has(k) ? ssMap.get(k)! : null),
    setItem: (k: string, v: string) => { ssMap.set(k, String(v)); },
    removeItem: (k: string) => { ssMap.delete(k); },
  };
  let toastShowCalls = 0;
  const elements: Record<string, any> = {
    pwaUpdateToast: {
      classes: new Set<string>(),
      attrs: {} as Record<string, string>,
      classList: {
        add(c: string) { if (c === 'show') toastShowCalls++; elements.pwaUpdateToast.classes.add(c); },
        remove(c: string) { elements.pwaUpdateToast.classes.delete(c); },
      },
      setAttribute(k: string, v: string) { elements.pwaUpdateToast.attrs[k] = v; },
    },
    pwaUpdateToastText: { innerText: '' },
    pwaUpdateApplyBtn: { disabled: false },
  };

  let reloadCount = 0;
  const ctx: any = {
    APP_VERSION: '2026-11-26 19:30 HKT',
    currentLang: 'en',
    sessionStorage: mockSessionStorage,
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      querySelector: () => null,
      getElementById: (id: string) => elements[id] || null,
      addEventListener: () => {},
    },
    window: {
      sessionStorage: mockSessionStorage,
      location: { reload: () => { reloadCount++; } },
      addEventListener: () => {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fnBlockMatch[0], ctx);

  const swListeners: Record<string, Function> = {};
  const regListeners: Record<string, Function> = {};
  const postedMsgs: any[] = [];
  const waitingWorker: any = {
    scriptURL: 'https://example.com/sw.js?v=2',
    state: 'installed',
    postMessage: (m: any) => postedMsgs.push(m),
    addEventListener: () => {},
  };
  const activeSw: any = {
    controller: { id: 'existing-controller' },
    addEventListener: (ev: string, fn: Function) => { swListeners[ev] = fn; },
    register: async () => ({
      waiting: waitingWorker,
      installing: null,
      addEventListener: (ev: string, fn: Function) => { regListeners[ev] = fn; },
    }),
  };

  await ctx.window.initPwaUpdateLifecycle(activeSw);
  assert.equal(toastShowCalls, 0, 'Silent PWA auto-update must not show a manual button-prompt toast');
  assert.equal(postedMsgs.length, 1, 'Waiting worker must silently receive SKIP_WAITING automatically on init');
  assert.equal(postedMsgs[0]?.type, 'SKIP_WAITING');
  assert.equal(mockSessionStorage.getItem('sw-user-reload'), '1', 'Silent auto-apply must arm sw-user-reload=1 before controllerchange');

  // Duplicate update trigger for the same worker in the same session must be suppressed
  const secondShow = ctx.window.showPwaUpdateToast(waitingWorker);
  assert.equal(secondShow, false, 'Duplicate update application in same session must be suppressed');
  assert.equal(postedMsgs.length, 1, 'SKIP_WAITING must not be posted twice for the same worker');

  // controllerchange with sw-user-reload=1 deletes flag and reloads cleanly once
  swListeners.controllerchange();
  assert.equal(reloadCount, 1, 'controllerchange with sw-user-reload=1 must reload once');
  assert.equal(mockSessionStorage.getItem('sw-user-reload'), null, 'sw-user-reload must be deleted immediately before reload');

  // Unprompted iOS controllerchange WITHOUT sw-user-reload flag must NEVER trigger reload
  swListeners.controllerchange();
  assert.equal(reloadCount, 1, 'Unprompted controllerchange without sw-user-reload=1 must NEVER trigger reload');
});

test('Commuter Updates 2 & 3: Directional camera bearingDeg & FOV cones on Global/Route Maps, clickable 350m corridor cameras, Traffic & Cams toggle, and dashed slate-blue unmonitored roads', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const mapSrc = readMapBundle();
  const html = readAppBundle();
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');

  // 1. Verify Route Map toggle button label updated to Traffic & Cams ON / Traffic & Cams
  assert.ok(html.includes('🚦 Traffic &amp; Cams ON') || html.includes('🚦 Traffic & Cams ON'), 'Route map button must show Traffic & Cams ON');
  assert.ok(html.includes("'🚦 Traffic & Cams ON'") && html.includes("'🚦 Traffic & Cams'"), 'syncTrafficToggleButtonsUI must toggle Traffic & Cams ON / Traffic & Cams');

  // 2. Verify worker computes bearingDeg for cameras and keeps strictly 1 export
  assert.ok(workerSrc.includes('function computeCameraBearingDegWorker') && workerSrc.includes('bearingDeg'), 'worker.js must compute bearingDeg for every camera');
  const workerExports = workerSrc.split('\n').filter((l) => /^\s*export\b/.test(l));
  assert.equal(workerExports.length, 1, 'functions/api/worker.js must maintain strictly one export');

  // 3. Load map.js helpers in sandbox to test resolveCameraBearingDeg, buildDirectionalCameraDivIcon, neutral unmonitored GeoJSON, and 350m route cameras
  const markersAdded: any[] = [];
  const geoJsonStyles: any[] = [];
  const modalOpenedCams: any[] = [];
  const mockMap: any = {
    getZoom: () => 15,
    getBounds: () => ({ pad: () => ({ contains: () => true }), contains: () => true }),
    latLngToContainerPoint: (ll: [number, number]) => ({ x: ll[1] * 10000, y: ll[0] * 10000 }),
    removeLayer: () => {},
    on: () => {},
  };
  const makeMockLayer = () => ({
    addTo: () => makeMockLayer(),
    addLayer: () => {},
    clearLayers: () => {},
    bindTooltip: () => makeMockLayer(),
    bindPopup: () => makeMockLayer(),
    on: function (ev: string, fn: Function) { (this as any)._handlers = (this as any)._handlers || {}; (this as any)._handlers[ev] = fn; return this; },
    bringToFront: () => {},
  });
  sb.ctx.L = {
    layerGroup: (arr?: any[]) => ({ ...makeMockLayer(), _layers: arr || [] }),
    polyline: () => makeMockLayer(),
    divIcon: (opts: any) => opts,
    marker: (latlng: any, opts: any) => {
      const m: any = { latlng, opts, _handlers: {}, addTo: () => { markersAdded.push(m); return m; }, bindTooltip: () => m, bindPopup: () => m, on: (ev: string, fn: Function) => { m._handlers[ev] = fn; return m; } };
      return m;
    },
    geoJSON: (gj: any, opts: any) => {
      (gj.features || []).forEach((f: any) => {
        if (typeof opts?.style === 'function') geoJsonStyles.push({ feat: f, style: opts.style(f) });
      });
      return makeMockLayer();
    },
  };
  sb.ctx.window.L = sb.ctx.L;
  sb.ctx.window.mapInstance = mockMap;
  sb.ctx.window.trafficLayerEnabled = true;
  sb.ctx.window.openTrafficCameraModal = (c: any) => modalOpenedCams.push(c);
  sb.ctx.currentLang = 'en';
  sb.ctx.escapeHtml = (s: any) => String(s ?? '');
  sb.ctx.calculateDistanceKm = sb.ctx.window.calculateDistanceKm;

  vm.runInContext(mapSrc, sb.ctx);

  // 4. Test bearingDeg resolution across paired detector, explicit bound, and standalone roundabout/portal cameras
  const dets = [
    { id: 'TDS90061', camKey: 'TDS90061', lat: 22.4362, lon: 114.0062, rot: 74, spd: 68, roadEn: 'Yuen Long Highway - Eastbound' },
    { id: 'TM_DET1', lat: 22.3820, lon: 113.9680, rot: 185, spd: 52, roadEn: 'Wong Chu Road - Southbound' },
  ];
  const brgPaired = sb.ctx.window.resolveCameraBearingDeg({ key: 'TDS90061', lat: 22.4362, lon: 114.0062, desc: 'Yuen Long Highway - Eastbound' }, dets);
  assert.equal(brgPaired, 74, 'Paired detector rot must be used directly');

  const brgBoundOnly = sb.ctx.window.resolveCameraBearingDeg({ key: 'WB_CAM', lat: 22.2800, lon: 114.1500, desc: 'Connaught Road Central - Westbound' }, []);
  assert.equal(brgBoundOnly, 270, 'Westbound camera description must resolve to 270 deg');

  // Standalone roundabout & portal cameras without a bound use verified overrides (TC002F: 225°, TC001F: 20°)
  const tc002f = { key: 'TC002F', lat: 22.3735, lon: 113.9555, desc: 'Lung Mun Rd Roundabout near TM-CLKL' };
  const tc001f = { key: 'TC001F', lat: 22.3135, lon: 113.9480, desc: 'TM-CLK Tunnel Southern Portal' };
  const brgTC002F = sb.ctx.window.resolveCameraBearingDeg(tc002f, dets);
  const brgTC001F = sb.ctx.window.resolveCameraBearingDeg(tc001f, dets);
  assert.equal(brgTC002F, 225, `TC002F must use verified SW Lung Fu Rd azimuth 225°, got ${brgTC002F}°`);
  assert.equal(brgTC001F, 20, `TC001F must use verified NNE Southern Portal azimuth 20°, got ${brgTC001F}°`);

  // Verify directional SVG 36px 45° radar FOV cone icon renders with exact transform:rotate(deg)
  const iconObj = sb.ctx.window.buildDirectionalCameraDivIcon(tc002f, brgTC002F, false, true);
  assert.ok(iconObj.html.includes(`transform:rotate(${brgTC002F}deg)`), 'Camera marker SVG cone/arrow must rotate to bearingDeg');
  assert.ok(iconObj.html.includes('cam-fov-svg') && iconObj.html.includes('A36 36') && iconObj.html.includes('rgba(37, 99, 235, 0.28)'), 'Camera marker must include 36px 45° radar FOV cone SVG path');

  // 5. Verify busspeed.js BUS_EST Green (#16a34a, NEVER Blue #3b82f6 or route-brand Red #FF3B30/#ef4444) on TD-blind segments whenever Traffic Overlay is ON
  const sampleRouteCoords = [
    [22.3712, 113.9562], // Lung Mun Rd Roundabout (TD-blind -> BUS_EST)
    [22.3735, 113.9555],
    [22.3820, 113.9680], // Wong Chu Rd (monitored by TM_DET1)
    [22.3850, 113.9720],
  ];
  sb.ctx.window.buildDetailBusPolylineLayer = sb.ctx.buildDetailBusPolylineLayer;
  sb.ctx.buildDetailBusPolylineLayer(sampleRouteCoords, [], 0, '#FF3B30');
  const busEstStyles = geoJsonStyles.filter((x) => x.feat.properties.source === 'BUS_EST');
  const blueStyles = geoJsonStyles.filter((x) => x.style.color === '#3b82f6');
  const monitoredStyles = geoJsonStyles.filter((x) => x.feat.properties.source === 'TD');
  assert.equal(blueStyles.length, 0, 'Detail bus polyline must NEVER paint Blue #3b82f6 when Traffic Overlay is ON');
  assert.ok(busEstStyles.length > 0, 'Route with TD-blind roundabout segment must emit BUS_EST feature from busspeed.js');
  assert.equal(busEstStyles[0].style.color, '#16a34a', 'TD-blind segment must use BUS_EST Smooth Green (#16a34a) when Traffic Overlay is ON, NEVER Blue or Red');
  assert.equal(busEstStyles[0].style.dashArray, null, 'BUS_EST segment must render as a solid line (no dashed MTR style)');
  assert.equal(busEstStyles[0].style.weight, 4.5, 'BUS_EST route line weight must be 4.5');
  assert.equal(busEstStyles[0].style.opacity, 0.88, 'BUS_EST route line opacity must be 0.88');
  if (monitoredStyles.length > 0) {
    assert.equal(monitoredStyles[0].style.dashArray, null, 'Monitored live speed segment must stay solid');
    assert.equal(monitoredStyles[0].style.weight, 4.5, 'Monitored live TD segment weight must be 4.5');
    assert.equal(monitoredStyles[0].style.opacity, 0.92, 'Monitored live TD segment opacity must be 0.92');
  }

  // 6. Verify Route Map renders clickable directional camera markers within <= 120m of forward route corridor (e.g. TC002F) and excludes distant cameras
  sb.ctx.window.mapInstance = mockMap;
  sb.ctx.window.__LIVE_TRAFFIC_DETECTORS__ = dets;
  sb.ctx.window.__LIVE_TRAFFIC_CAMERAS__ = [
    tc002f,
    { key: 'FAR_CAM', lat: 22.2800, lon: 114.2200, desc: 'Chai Wan Rd - Eastbound' },
  ];
  vm.runInContext(`
    currentDetailCorridorMeta = {
      isBusRoute: true,
      isRoadSnapped: true,
      hasHighwaySpan: true,
      coords: ${JSON.stringify(sampleRouteCoords)},
      forwardCameraCoords: ${JSON.stringify(sampleRouteCoords)},
      bboxes: [{ minLat: 22.36, maxLat: 22.39, minLon: 113.94, maxLon: 113.98 }]
    };
    renderTrafficOverlayOnMap(window.mapInstance, true);
  `, sb.ctx);
  const tc002fMarker = markersAdded.find((m) => String(m.opts?.icon?.html || '').includes('data-cam-key="TC002F"'));
  const farCamMarker = markersAdded.find((m) => String(m.opts?.icon?.html || '').includes('data-cam-key="FAR_CAM"'));
  assert.ok(tc002fMarker, 'TC002F within 120m of forward route corridor must render as a directional camera marker on Route Map');
  assert.equal(farCamMarker, undefined, 'Distant camera >120m away must NOT render on Route Map');
  tc002fMarker._handlers.click?.({});
  assert.equal(modalOpenedCams.length, 1, 'Clicking route camera marker must invoke openTrafficCameraModal');
  assert.equal(modalOpenedCams[0].key, 'TC002F');
});

test('Commuter Update 4: Graceful Video Lost pixel detection (no OCR) & strict worker cam_img key allowlist', () => {
  const html = readAppBundle();
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');

  // 1. Verify worker cam_img proxy strictly validates key format against SSRF
  assert.ok(workerSrc.includes("if (action === 'cam_img') return handleCameraImageProxy(url);"), 'worker.js must route action=cam_img');
  assert.ok(workerSrc.includes('/^[A-Z0-9_-]{3,16}$/i'), 'worker.js cam_img proxy must enforce strict camera key allowlist');

  // 2. Extract detectVideoLostFromPixels from index.html and test synthetic HKSAR TD frames
  const fnMatch = html.match(/function detectVideoLostFromPixels\(rgba, width, height\)[\s\S]*?window\.detectVideoLostFromPixels = detectVideoLostFromPixels;/);
  assert.ok(fnMatch, 'Must find detectVideoLostFromPixels in index.html');
  const ctx: any = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fnMatch[0], ctx);
  const detect = ctx.window.detectVideoLostFromPixels;

  const W = 64, H = 48;
  // Case A: Classic HKSAR TD black "Video Lost" frame (pure black + small centered white text band)
  const blackLost = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isCenterText = (y >= 21 && y <= 26 && x >= 18 && x <= 46 && (x % 3 === 0));
      const v = isCenterText ? 240 : 6;
      blackLost[i] = v; blackLost[i + 1] = v; blackLost[i + 2] = v; blackLost[i + 3] = 255;
    }
  }
  const resBlackLost = detect(blackLost, W, H);
  assert.equal(resBlackLost.isVideoLost, true, 'Black HKSAR TD Video Lost placeholder with centered white text must be flagged');

  // Case B: Uniform flat-gray "Feed Unavailable" slate
  const grayLost = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isCenterText = (y >= 22 && y <= 25 && x >= 20 && x <= 44 && (x % 2 === 0));
      const v = isCenterText ? 235 : 96;
      grayLost[i] = v; grayLost[i + 1] = v; grayLost[i + 2] = v; grayLost[i + 3] = 255;
    }
  }
  const resGrayLost = detect(grayLost, W, H);
  assert.equal(resGrayLost.isVideoLost, true, 'Uniform flat-gray placeholder slate must be flagged as Video Lost');

  // Case C: Real daytime highway image (sky top, greenery/buildings sides, asphalt + vehicles bottom)
  const liveDay = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (y < 14) { liveDay[i] = 150 + (x % 20); liveDay[i + 1] = 190; liveDay[i + 2] = 235; }
      else if (x < 12 || x > 52) { liveDay[i] = 55; liveDay[i + 1] = 110 + (y % 25); liveDay[i + 2] = 60; }
      else { const road = 75 + ((x * 7 + y * 5) % 60); liveDay[i] = road; liveDay[i + 1] = road; liveDay[i + 2] = road + 5; }
      liveDay[i + 3] = 255;
    }
  }
  const resDay = detect(liveDay, W, H);
  assert.equal(resDay.isVideoLost, false, 'Real daytime highway camera frame must pass as live');

  // Case D: Real nighttime highway image (dark sky, warm amber streetlights, bright headlights & road gradient)
  const liveNight = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isLamp = (y === 6 || y === 10) && (x % 11 === 0);
      const isRoadGlow = y >= 28;
      if (isLamp) { liveNight[i] = 255; liveNight[i + 1] = 210; liveNight[i + 2] = 110; }
      else if (isRoadGlow) { liveNight[i] = 48 + (x % 35); liveNight[i + 1] = 44 + (y % 25); liveNight[i + 2] = 38; }
      else { liveNight[i] = 18 + (x % 14); liveNight[i + 1] = 24 + (y % 18); liveNight[i + 2] = 45 + (y % 20); }
      liveNight[i + 3] = 255;
    }
  }
  const resNight = detect(liveNight, W, H);
  assert.equal(resNight.isVideoLost, false, 'Real nighttime highway camera frame must NOT trigger false Video Lost');
});

test('Camera FOV & Corridor Geometry Fix: Verified azimuth overrides, speed-link tangent snapping, 36px 45° radar cone, Hermite smoothing, non-crossing carriageways, and road-snapped ~150m route corridor', () => {
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  const mapSrc = readMapBundle();
  const sb = loadHardcodeAndPlannerSandbox();

  // 1. Verify worker.js verified azimuths & speed-link tangent snapping in VM
  const workerHelpersMatch = workerSrc.match(/function _extractRoadCoreWorker\([\s\S]*?function buildWorkerSpeedMapGeoJson\([\s\S]*?\n\}/);
  assert.ok(workerHelpersMatch, 'worker.js must define _extractRoadCoreWorker, VERIFIED_CAMERA_AZIMUTHS, speed-link tangent builder, and buildWorkerSpeedMapGeoJson');
  const haversineMatch = workerSrc.match(/function haversineKmWorker\([\s\S]*?\n\}/);
  const classifyMatch = workerSrc.match(/function classifyDetectorCongestion\([\s\S]*?\n\}/);
  const workerCtx: any = { Math, Number, String, Array, Map, Set, Object, isFinite };
  vm.createContext(workerCtx);
  vm.runInContext(`${haversineMatch ? haversineMatch[0] : ''}\n${classifyMatch ? classifyMatch[0] : ''}\n${workerHelpersMatch[0]}`, workerCtx);

  const expectedOverrides: Record<string, number> = {
    TC003F: 175,
    TC002F: 225,
    TC001F: 20,
    NL128F: 75,
    NL126F: 255,
    NL206F: 205,
  };

  // Real North Lantau Highway detectors (EB & WB near Tung Chung Eastern Interchange)
  const nlhDetectors = [
    { id: 'AID08118', lat: 22.294631, lon: 113.955298, roadEn: 'North Lantau Highway - Westbound', spd: 95, rot: 225, dir: 'WB' },
    { id: 'AID08119', lat: 22.29239, lon: 113.95294, roadEn: 'North Lantau Highway - Westbound', spd: 92, rot: 235, dir: 'WB' },
    { id: 'AID08120', lat: 22.290244, lon: 113.94986, roadEn: 'North Lantau Highway - Westbound', spd: 90, rot: 250, dir: 'WB' },
    { id: 'AID08121', lat: 22.289695, lon: 113.944664, roadEn: 'North Lantau Highway - Westbound', spd: 88, rot: 270, dir: 'WB' },
    { id: 'AID08203', lat: 22.28945, lon: 113.94468, roadEn: 'North Lantau Highway - Eastbound', spd: 91, rot: 82, dir: 'EB' },
    { id: 'AID08204', lat: 22.29009, lon: 113.94989, roadEn: 'North Lantau Highway - Eastbound', spd: 94, rot: 68, dir: 'EB' },
  ];

  const speedLinkTangents = workerCtx.buildSpeedLinkTangentsWorker(nlhDetectors);
  for (const [camKey, expectedDeg] of Object.entries(expectedOverrides)) {
    const got = workerCtx.computeCameraBearingDegWorker(
      { key: camKey, lat: 22.3646, lon: 113.9478, desc: `${camKey} test camera` },
      nlhDetectors,
      [],
      speedLinkTangents
    );
    assert.equal(got, expectedDeg, `worker.js must resolve verified override ${camKey} -> ${expectedDeg}°, got ${got}°`);
  }

  // Directional camera without verified override must snap to nearest matching TD speed-link tangent (~82° EB on NLH)
  const snappedEbBearing = workerCtx.computeCameraBearingDegWorker(
    { key: 'NL999F', lat: 22.2898, lon: 113.9473, desc: 'North Lantau Highway near Tung Chung - Eastbound' },
    nlhDetectors,
    [],
    speedLinkTangents
  );
  assert.ok(snappedEbBearing >= 70 && snappedEbBearing <= 88, `Directional EB camera near NLH must snap to EB speed-link tangent (~82°), got ${snappedEbBearing}°`);

  // Worker speed map emits 60-320m 2-point links cleanly (excluding >320m hillside chords);
  // short gaps (320-600m) with same speed tier are bridged in filterAndOffsetGlobalSpeedGeoJson at ~0.55 opacity.
  const closeNlhDetectors = [
    { id: 'AID_S1', lat: 22.28960, lon: 113.94466, roadEn: 'North Lantau Highway - Eastbound', spd: 90, rot: 82, dir: 'EB' },
    { id: 'AID_S2', lat: 22.28988, lon: 113.94690, roadEn: 'North Lantau Highway - Eastbound', spd: 92, rot: 82, dir: 'EB' }, // ~233m
    { id: 'AID_W1', lat: 22.29010, lon: 113.94690, roadEn: 'North Lantau Highway - Westbound', spd: 88, rot: 262, dir: 'WB' },
    { id: 'AID_W2', lat: 22.28982, lon: 113.94466, roadEn: 'North Lantau Highway - Westbound', spd: 86, rot: 262, dir: 'WB' }, // ~233m
  ];
  const detMetaMap = new Map([...nlhDetectors, ...closeNlhDetectors].map((d) => [d.id, d]));
  const liveMap = new Map([...nlhDetectors, ...closeNlhDetectors].map((d) => [d.id, { speed: d.spd, occ: 18 }]));
  const workerGeo = workerCtx.buildWorkerSpeedMapGeoJson(detMetaMap, liveMap);
  assert.ok(!workerGeo.features.some((f: any) => f.properties.id === 'AID08118' && f.properties.toId === 'AID08120'), 'Worker speed GeoJSON must skip leapfrogging chord');
  assert.ok(workerGeo.features.length >= 2, 'Worker speed GeoJSON must keep valid 60m-320m EB and WB links');
  for (const feat of workerGeo.features) {
    assert.ok(feat.properties.lenM >= 60 && feat.properties.lenM <= 320, `Worker 2-point link must be 60m-320m, got ${feat.properties.lenM}m`);
  }

  // 2. Load map.js in sandbox to verify client camera icon, overrides, strictly parallel non-crossing links, and no raw chords on detail route map
  const detailOverlayPolylines: any[] = [];
  const mockMap: any = {
    getZoom: () => 16,
    getBounds: () => ({ pad: () => ({ contains: () => true }), contains: () => true }),
    latLngToContainerPoint: (ll: [number, number]) => ({ x: ll[1] * 10000, y: ll[0] * 10000 }),
    removeLayer: () => {},
    on: () => {},
  };
  const makeMockLayer = () => ({
    addTo: () => makeMockLayer(),
    addLayer: () => {},
    clearLayers: () => {},
    bindTooltip: () => makeMockLayer(),
    bindPopup: () => makeMockLayer(),
    on: () => makeMockLayer(),
    bringToFront: () => {},
  });
  sb.ctx.L = {
    layerGroup: (arr?: any[]) => ({ ...makeMockLayer(), _layers: arr || [] }),
    polyline: (coords: any, opts: any) => { detailOverlayPolylines.push({ coords, opts }); return makeMockLayer(); },
    divIcon: (opts: any) => opts,
    marker: () => makeMockLayer(),
    geoJSON: () => makeMockLayer(),
  };
  sb.ctx.window.L = sb.ctx.L;
  sb.ctx.window.mapInstance = mockMap;
  sb.ctx.window.trafficLayerEnabled = true;
  sb.ctx.window.__LIVE_TRAFFIC_DETECTORS__ = nlhDetectors;
  sb.ctx.window.__LIVE_TRAFFIC_SPEED_GEOJSON__ = workerGeo;
  sb.ctx.currentLang = 'en';
  sb.ctx.escapeHtml = (s: any) => String(s ?? '');
  sb.ctx.calculateDistanceKm = sb.ctx.window.calculateDistanceKm;

  vm.runInContext(mapSrc, sb.ctx);

  // Check all 6 verified overrides in map.js resolveCameraBearingDeg
  for (const [camKey, expectedDeg] of Object.entries(expectedOverrides)) {
    const got = sb.ctx.window.resolveCameraBearingDeg({ key: camKey, lat: 22.3646, lon: 113.9478, desc: `${camKey}` }, nlhDetectors);
    assert.equal(got, expectedDeg, `map.js resolveCameraBearingDeg must honor verified override ${camKey} -> ${expectedDeg}°, got ${got}°`);
  }

  // Check 80x80 36px 45° radar FOV cone SVG spec
  const iconSpec = sb.ctx.window.buildDirectionalCameraDivIcon({ key: 'TC003F', desc: 'TM-CLK Tunnel Northern Portal' }, 175, false, true);
  assert.deepEqual(Array.from(iconSpec.iconSize), [80, 80], 'Camera icon must use 80x80 size');
  assert.deepEqual(Array.from(iconSpec.iconAnchor), [40, 40], 'Camera icon must anchor at center [40, 40]');
  assert.ok(iconSpec.html.includes('transform:rotate(175deg)'), 'TC003F FOV cone must rotate to 175deg');
  assert.ok(iconSpec.html.includes('A36 36') && iconSpec.html.includes('fill="rgba(37, 99, 235, 0.28)"') && iconSpec.html.includes('stroke="#2563eb"') && iconSpec.html.includes('stroke-width="1.5"'), 'FOV cone must match 36px radius, rgba(37, 99, 235, 0.28) fill, and 1.5px #2563eb border');

  // Check vivid Global Map speed color palette & tight keep-left offsets (1.5m at z>=15, 2.5m at z<15)
  assert.equal(sb.ctx.window.getGlobalTrafficSpeedColorHex(65), '#22c55e', 'Smooth traffic must use #22c55e');
  assert.equal(sb.ctx.window.getGlobalTrafficSpeedColorHex(35), '#f59e0b', 'Moderate traffic must use #f59e0b');
  assert.equal(sb.ctx.window.getGlobalTrafficSpeedColorHex(15), '#ef4444', 'Congested traffic must use #ef4444');
  assert.equal(sb.ctx.window.getGlobalTrafficLaneOffsetMeters(16), 1.5);
  assert.equal(sb.ctx.window.getGlobalTrafficLaneOffsetMeters(14), 2.5);

  // Check strictly parallel 2-point links (NO Hermite bending!) + opposite-carriageway non-crossing guard
  const crossingGeo = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'TMR_WB', roadEn: 'Tuen Mun Road - Westbound', spd: 58, rot: 263, rotA: 250, rotB: 270 },
        geometry: { type: 'LineString', coordinates: [[113.9800, 22.3712], [113.9778, 22.3709]] }, // ~228m
      },
      {
        type: 'Feature',
        properties: { id: 'TMR_EB', roadEn: 'Tuen Mun Road - Eastbound', spd: 60, rot: 83, rotA: 80, rotB: 70 },
        geometry: { type: 'LineString', coordinates: [[113.9778, 22.37105], [113.9800, 22.37105]] }, // ~226m, intentionally crosses WB!
      },
    ],
  };
  const parallelGeo = sb.ctx.filterAndOffsetGlobalSpeedGeoJson(crossingGeo, 16, []);
  assert.equal(parallelGeo.features.length, 2, 'Both parallel carriageways should be retained after keep-left separation');
  assert.equal(parallelGeo.features[0].geometry.coordinates.length, 2, '2-point TD speed links must stay strictly 2-point straight parallel lines (NO Hermite bending)');
  assert.equal(
    sb.ctx._polylinesIntersect2D(parallelGeo.features[0].geometry.coordinates, parallelGeo.features[1].geometry.coordinates),
    false,
    'Opposite-direction WB and EB lines must NEVER cross over each other after keep-left separation'
  );

  // Check Route Detail Map uses ~150m road-snapped slicing and NEVER draws raw 2-point TD chords on top
  const longHighwayCoords: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    longHighwayCoords.push([22.2895 + i * 0.0006, 113.9445 + i * 0.0011]);
  }
  const routeSpeedGeo = sb.ctx.window.buildRouteSpeedGeoJson(longHighwayCoords, nlhDetectors, '#3b82f6');
  assert.ok(routeSpeedGeo && routeSpeedGeo.features.length >= 1, 'Route speed GeoJSON must slice along the road-snapped route polyline');
  sb.ctx.window.__LAST_DETAIL_SPEED_GEOJSON__ = routeSpeedGeo;
  detailOverlayPolylines.length = 0;
  vm.runInContext(`
    currentDetailCorridorMeta = {
      isBusRoute: true,
      isRoadSnapped: true,
      hasHighwaySpan: true,
      coords: ${JSON.stringify(longHighwayCoords)},
      bboxes: [{ minLat: 22.28, maxLat: 22.30, minLon: 113.94, maxLon: 113.96 }]
    };
    renderTrafficOverlayOnMap(window.mapInstance, true);
  `, sb.ctx);
  assert.equal(detailOverlayPolylines.length, 0, 'Route Detail Map must NEVER draw raw 2-point TD speed chords over the active road-snapped route speed corridor');
});

test('Global Camera Orientation, Full-Frame Camera Modal & 7-App HK Ecosystem Links in About Modal', () => {
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  const mapSrc = readMapBundle();
  const html = readAppBundle();
  const sb = loadHardcodeAndPlannerSandbox();

  // 1. Verify worker.js exact-detector priority & same-road curved-highway matching (fixes TDS90070, TDS91054, AID01129, AID01134)
  const workerHelpersMatch = workerSrc.match(/function _extractRoadCoreWorker\([\s\S]*?function buildWorkerSpeedMapGeoJson\([\s\S]*?\n\}/);
  assert.ok(workerHelpersMatch, 'worker.js must define camera bearing helpers');
  const haversineMatch = workerSrc.match(/function haversineKmWorker\([\s\S]*?\n\}/);
  const classifyMatch = workerSrc.match(/function classifyDetectorCongestion\([\s\S]*?\n\}/);
  const workerCtx: any = { Math, Number, String, Array, Map, Set, Object, isFinite };
  vm.createContext(workerCtx);
  vm.runInContext(`${haversineMatch ? haversineMatch[0] : ''}\n${classifyMatch ? classifyMatch[0] : ''}\n${workerHelpersMatch[0]}`, workerCtx);

  const curvedHighwayDetectors = [
    // Real Yuen Long Highway near Pok Oi Interchange (runs NNE ~25-30° EB and SSW ~195-205° WB!)
    { id: 'TDS90070', lat: 22.44653, lon: 114.03987, roadEn: 'Yuen Long Highway near Pok Oi Interchange - Eastbound (2)', spd: 62, rot: 30, dir: 'EB', camKey: 'TDS90070' },
    { id: 'TDS90071', lat: 22.44880, lon: 114.04110, roadEn: 'Yuen Long Highway near Pok Oi Interchange - Eastbound (3)', spd: 65, rot: 28, dir: 'EB', camKey: 'TDS90071' },
    { id: 'TDS91054', lat: 22.44551, lon: 114.03951, roadEn: 'Yuen Long Highway near Pok Oi Interchange - Westbound (2)', spd: 70, rot: 200, dir: 'WB', camKey: 'TDS91054' },
    { id: 'TDS91053', lat: 22.44320, lon: 114.03870, roadEn: 'Yuen Long Highway near Pok Oi Interchange - Westbound (1)', spd: 68, rot: 198, dir: 'WB', camKey: 'TDS91053' },
    // Sha Tin Road curved NB (~80°) and Tolo Highway curved NB (~310°)
    { id: 'AID01129', lat: 22.3821, lon: 114.1982, roadEn: 'Sha Tin Road - Northbound', spd: 70, rot: 80, dir: 'NB', camKey: 'AID01129' },
    { id: 'AID01134', lat: 22.4310, lon: 114.1950, roadEn: 'Tolo Highway - Northbound', spd: 82, rot: 310, dir: 'NB', camKey: 'AID01134' },
  ];
  const tangents = workerCtx.buildSpeedLinkTangentsWorker(curvedHighwayDetectors);

  const wEb = workerCtx.computeCameraBearingDegWorker(
    { key: 'TDS90070', lat: 22.44653, lon: 114.03987, desc: 'Yuen Long Highway near Pok Oi Interchange - Eastbound (2)' },
    curvedHighwayDetectors,
    [],
    tangents
  );
  const wWb = workerCtx.computeCameraBearingDegWorker(
    { key: 'TDS91054', lat: 22.44551, lon: 114.03951, desc: 'Yuen Long Highway near Pok Oi Interchange - Westbound (2)' },
    curvedHighwayDetectors,
    [],
    tangents
  );
  const wStNb = workerCtx.computeCameraBearingDegWorker(
    { key: 'AID01129', lat: 22.3821, lon: 114.1982, desc: 'Sha Tin Road - Northbound' },
    curvedHighwayDetectors,
    [],
    tangents
  );
  const wToloNb = workerCtx.computeCameraBearingDegWorker(
    { key: 'AID01134', lat: 22.4310, lon: 114.1950, desc: 'Tolo Highway - Northbound' },
    curvedHighwayDetectors,
    [],
    tangents
  );
  assert.ok(wEb >= 18 && wEb <= 40, `worker.js TDS90070 must align NNE along Yuen Long Hwy (~26-30°), NOT due East 90° (got ${wEb}°)`);
  assert.ok(wWb >= 185 && wWb <= 212, `worker.js TDS91054 must align SSW along Yuen Long Hwy (~198-200°), NOT due West 270° (got ${wWb}°)`);
  assert.equal(wStNb, 80, `worker.js AID01129 curved NB must use exact detector rot 80° (got ${wStNb}°)`);
  assert.equal(wToloNb, 310, `worker.js AID01134 curved NB must use exact detector rot 310° (got ${wToloNb}°)`);

  // Non-AID camera on the same curved highway with explicit "- Eastbound" must match same-road EB link tangent even though 28° is >55° from 90°!
  const wGenericCurvedEb = workerCtx.computeCameraBearingDegWorker(
    { key: 'YL999F', lat: 22.4472, lon: 114.0402, desc: 'Yuen Long Highway near Pok Oi Interchange - Eastbound' },
    curvedHighwayDetectors,
    [],
    tangents
  );
  assert.ok(wGenericCurvedEb >= 18 && wGenericCurvedEb <= 40, `worker.js curved same-road EB camera must follow highway tangent (~26-30°), got ${wGenericCurvedEb}°`);

  // 2. Verify map.js resolveCameraBearingDeg matches the exact same curved-highway accuracy
  sb.ctx.L = {
    layerGroup: () => ({ addTo: () => ({}), addLayer: () => {}, clearLayers: () => {} }),
    polyline: () => ({ addTo: () => ({}) }),
    divIcon: (opts: any) => opts,
    marker: () => ({ addTo: () => ({}), bindTooltip: () => ({}), on: () => ({}) }),
    geoJSON: () => ({ addTo: () => ({}) }),
  };
  sb.ctx.window.L = sb.ctx.L;
  sb.ctx.window.__LIVE_TRAFFIC_DETECTORS__ = curvedHighwayDetectors;
  sb.ctx.window.__LIVE_TRAFFIC_SPEED_GEOJSON__ = workerCtx.buildWorkerSpeedMapGeoJson(
    new Map(curvedHighwayDetectors.map((d) => [d.id, d])),
    new Map(curvedHighwayDetectors.map((d) => [d.id, { speed: d.spd, occ: 10 }]))
  );
  sb.ctx.currentLang = 'en';
  sb.ctx.escapeHtml = (s: any) => String(s ?? '');
  sb.ctx.calculateDistanceKm = sb.ctx.window.calculateDistanceKm;
  vm.runInContext(mapSrc, sb.ctx);

  const mEb = sb.ctx.window.resolveCameraBearingDeg(
    { key: 'TDS90070', lat: 22.44653, lon: 114.03987, desc: 'Yuen Long Highway near Pok Oi Interchange - Eastbound (2)' },
    curvedHighwayDetectors
  );
  const mWb = sb.ctx.window.resolveCameraBearingDeg(
    { key: 'TDS91054', lat: 22.44551, lon: 114.03951, desc: 'Yuen Long Highway near Pok Oi Interchange - Westbound (2)' },
    curvedHighwayDetectors
  );
  assert.ok(mEb >= 18 && mEb <= 40, `map.js TDS90070 must align NNE along Yuen Long Hwy (~26-30°), got ${mEb}°`);
  assert.ok(mWb >= 185 && mWb <= 212, `map.js TDS91054 must align SSW along Yuen Long Hwy (~198-200°), got ${mWb}°`);

  // 3. Verify About modal contains the curated 4 HK public ecosystem companion app links & preserves companion GPS hooks (excluding self-referential Transit HK, HKFX, and private/redirect apps)
  const aboutStart = html.indexOf('id="aboutModal"');
  const aboutEnd = html.indexOf('id="tutorialModal"');
  assert.ok(aboutStart > 0 && aboutEnd > aboutStart, 'Must locate #aboutModal block in index.html');
  const aboutSlice = html.slice(aboutStart, aboutEnd);
  const expectedEcosystemUrls = [
    'https://hklayer.pages.dev',
    'https://hksundry.pages.dev',
    'https://hkproperty.pages.dev',
    'https://hkmpf.pages.dev',
  ];
  for (const url of expectedEcosystemUrls) {
    assert.ok(aboutSlice.includes(`href="${url}"`), `#aboutModal must include curated ecosystem link ${url}`);
  }
  const excludedEcosystemStrings = [
    'https://hkway.pages.dev',
    'https://hkfx.pages.dev',
    'HKFX (外匯)',
    'https://hkfleet.pages.dev',
    'https://modelsignal.pages.dev',
    'https://boat-eg5.pages.dev',
    'https://pearl-marine.pages.dev',
    'https://hkpast.pages.dev',
    'https://redalert.pages.dev',
    'ModelSignal FX',
    'Aero-Marine',
    'Pulse HK',
    'HK Past 1889',
  ];
  for (const forbidden of excludedEcosystemStrings) {
    assert.ok(!aboutSlice.includes(forbidden), `#aboutModal must NOT include removed/private/redirect app ${forbidden}`);
  }
  assert.ok(aboutSlice.includes('HK Layer (著衫)'), '#aboutModal must display HK Layer (著衫)');
  assert.ok(aboutSlice.includes('HK Sundry (曬衫)'), '#aboutModal must display HK Sundry (曬衫)');
  assert.ok(aboutSlice.includes('HK MPF (強積金)'), '#aboutModal must display HK MPF (強積金)');
  assert.ok(aboutSlice.includes("openCompanionAppAtCurrentStop('property')"), '#aboutModal must preserve HK Property GPS hook');
  assert.ok(aboutSlice.includes("openCompanionAppAtCurrentStop('sundry')"), '#aboutModal must preserve HK Sundry hook');

  // 4. Verify full-frame uncropped camera view CSS (no forced 4/3 letterbox or dark #0F172A backdrop) & opposite-carriageway 1-tap switcher
  const camFrameCss = html.match(/\.traffic-cam-frame\s*\{[\s\S]*?\}/);
  assert.ok(camFrameCss, 'Must locate .traffic-cam-frame CSS rule');
  assert.ok(!/aspect-ratio\s*:\s*4\s*\/\s*3/i.test(camFrameCss[0]), '.traffic-cam-frame must NOT force 4/3 aspect-ratio black letterbox');
  assert.ok(!/#0F172A/i.test(camFrameCss[0]), '.traffic-cam-frame must NOT paint dark #0F172A letterbox bars');
  assert.ok(html.includes('switchToOppositeTrafficCamera('), 'Traffic modal must allow 1-tap switching to opposite carriageway camera');
  assert.ok(html.includes('.global-traffic-cam-marker.cam-selected'), 'Map camera markers must style active selected camera highlight');
});

test('Issues 1-4: Zoom-Gated Global Cameras, Upstream Jam & Time-Decay Corridor Ranking, Short-Gap Bridging, Forward-Only Exit Clamp & Road Ahead Chip, and Separate Bus Speed Layer', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const mapSrc = readMapBundle();
  const html = readAppBundle();

  // --- Issue 2: Upstream Jam Before Stop + Time-to-Reach Decay Ranking + HK Time-of-Day Context ---
  const getHongKongTimeOfDayContext = sb.ctx.window.getHongKongTimeOfDayContext;
  const computeTimeToReachDecayWeight = sb.ctx.window.computeTimeToReachDecayWeight;
  const getDirectionalRoadSummary = sb.ctx.window.getDirectionalRoadSummary;

  // Verify time-to-reach decay weights (0-15m -> 1.0x, 15-30m -> 0.65x, >30m or >15km -> 0.3x)
  assert.equal(computeTimeToReachDecayWeight(5, 1.5), 1.0, 'Immediate jam (5 min) must get 1.0x weight');
  assert.equal(computeTimeToReachDecayWeight(22, 9.0), 0.65, 'Mid-distance jam (22 min) must get 0.65x weight');
  assert.equal(computeTimeToReachDecayWeight(36, 12.0), 0.3, 'Far jam (>30 min) must get 0.3x weight');
  assert.equal(computeTimeToReachDecayWeight(18, 16.5), 0.3, 'Far jam (>15 km) must get 0.3x weight');

  // Verify HK time-of-day context (UTC+8): Mon 08:30 HKT = AM Peak, Mon 23:15 HKT = Late Evening dissipating, Sun 14:00 HKT = Weekend
  const monAmPeakMs = Date.UTC(2026, 10, 23, 0, 30, 0); // Mon 08:30 HKT
  const monLateMs = Date.UTC(2026, 10, 23, 15, 15, 0);  // Mon 23:15 HKT
  const sunMidMs = Date.UTC(2026, 10, 22, 6, 0, 0);     // Sun 14:00 HKT
  assert.equal(getHongKongTimeOfDayContext(monAmPeakMs).period, 'AM_PEAK');
  assert.equal(getHongKongTimeOfDayContext(monAmPeakMs).trend, 'BUILDING');
  assert.equal(getHongKongTimeOfDayContext(monLateMs).period, 'LATE_NIGHT');
  assert.equal(getHongKongTimeOfDayContext(monLateMs).trend, 'DISSIPATING');
  assert.equal(getHongKongTimeOfDayContext(sunMidMs).period, 'WEEKEND');

  // Build synthetic northbound corridor with:
  // - Stop 0 (origin, 22.300), Stop 1 (boarding stop, 22.318 = 2.0km), Stop 2 (22.340 = +2.4km), Stop 3 (exit stop, 22.365 = +5.2km), Stop 4 (far terminus, 22.520 = +22.4km)
  const corridorStops = [
    { stopKey: 'S0', stopName_e: 'Airport Cargo', latitude: '22.3000', longitude: '114.0000' },
    { stopKey: 'S1', stopName_e: 'Tung Chung Cable Car', latitude: '22.3180', longitude: '114.0000' },
    { stopKey: 'S2', stopName_e: 'North Lantau BBI', latitude: '22.3400', longitude: '114.0000' },
    { stopKey: 'S3', stopName_e: 'Tuen Mun Road Portal', latitude: '22.3650', longitude: '114.0000' },
    { stopKey: 'S4', stopName_e: 'Yuen Long Terminus', latitude: '22.5200', longitude: '114.0000' },
  ];
  const corridorPoly: [number, number][] = [];
  for (let lat = 22.300; lat <= 22.5201; lat += 0.004) {
    corridorPoly.push([Number(lat.toFixed(4)), 114.0000]);
  }
  const corridorDets = [
    // Upstream jam 1.1km BEFORE Stop 1 (inside 0-2.5km approaching window)
    { id: 'DET_UP', lat: 22.3080, lon: 114.0001, rot: 0, spd: 14, occ: 78, tier: 'JAMMED', roadEn: 'Tat Tung Road Approach', camKey: 'CAM_UP' },
    // Immediate downstream bottleneck 1.8km AHEAD of Stop 1 (~3 min away, 1.0x weight)
    { id: 'DET_NEAR', lat: 22.3340, lon: 114.0001, rot: 0, spd: 22, occ: 62, tier: 'SLOW', roadEn: 'Shun Long Road', camKey: 'CAM_NEAR' },
    // Far downstream minor jam 20km AHEAD of Stop 1 (>15km -> 0.3x weight, must NOT outrank DET_NEAR)
    { id: 'DET_FAR', lat: 22.5000, lon: 114.0001, rot: 0, spd: 18, occ: 55, tier: 'JAMMED', roadEn: 'Yuen Long Highway Far', camKey: 'CAM_FAR' },
  ];
  const corridorCams = [
    { key: 'CAM_UP', lat: 22.3080, lon: 114.0001, desc: 'Tat Tung Rd - Northbound', bearingDeg: 0 },
    { key: 'CAM_AHEAD_650', lat: 22.3238, lon: 114.0001, desc: 'Shun Long Rd Entrance - Northbound', bearingDeg: 0 },
    { key: 'CAM_OPP', lat: 22.3240, lon: 114.0001, desc: 'Shun Long Rd - Southbound', bearingDeg: 180 },
    { key: 'CAM_FAR_BEYOND_EXIT', lat: 22.4500, lon: 114.0001, desc: 'Yuen Long Hwy Mid - Northbound', bearingDeg: 0 },
  ];

  const sumFull = getDirectionalRoadSummary(corridorStops, 1, corridorDets, false, 40, corridorPoly, 28000, corridorCams, { nowMs: monLateMs });
  assert.ok(sumFull, 'Must return directional road summary');
  assert.ok(sumFull.approaching && sumFull.approaching.detectorId === 'DET_UP', 'Must detect upstream Jam Before Stop within 0-2.5km');
  assert.ok(sumFull.aheadCam && sumFull.aheadCam.key === 'CAM_AHEAD_650', 'Must expose nearest forward Road Ahead camera excluding opposite-bound and upstream cameras');
  assert.ok(Array.isArray(sumFull.rankedBottlenecks) && sumFull.rankedBottlenecks.length >= 2, 'Must return ranked segment-by-segment bottlenecks');
  const nearIdx = sumFull.rankedBottlenecks.findIndex((r: any) => r.detectorId === 'DET_NEAR');
  const farIdx = sumFull.rankedBottlenecks.findIndex((r: any) => r.detectorId === 'DET_FAR');
  assert.ok(nearIdx >= 0 && farIdx >= 0 && nearIdx < farIdx, 'Immediate 1.8km bottleneck (1.0x) must outrank distant 20km jam (0.3x)');
  const farRow = sumFull.rankedBottlenecks[farIdx];
  assert.ok(farRow && farRow.isFarAhead && farRow.timeDecayWeight === 0.3, 'Far downstream jam must be discounted (0.3x) and flagged isFarAhead');

  // Exit stop clamp (clamped to Stop 3) -> MUST exclude DET_FAR and CAM_FAR_BEYOND_EXIT beyond Stop 3
  const sumClamped = getDirectionalRoadSummary(corridorStops, 1, corridorDets, false, 40, corridorPoly, 28000, corridorCams, { exitStopIdx: 3, nowMs: monAmPeakMs });
  assert.ok(!sumClamped.rankedBottlenecks.some((r: any) => r.detectorId === 'DET_FAR'), 'Clamping Exit to Stop 3 must exclude downstream bottlenecks past Stop 3');
  assert.equal(sumClamped.timeOfDayContext.period, 'AM_PEAK', 'Summary must include HK time-of-day context');

  // --- Issue 3A: Short-gap bridging (<=600m same-tier at ~0.55 opacity) vs >600m / mismatched-tier uncolored ---
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      busSpeedLayerEnabled: false,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __LIVE_TRAFFIC_CAMERAS__: [],
      sliceForwardPolylineFromStop: sb.ctx.window.sliceForwardPolylineFromStop,
      pointToSegmentDistanceKm: sb.ctx.window.pointToSegmentDistanceKm,
      inferBusApiSegmentSpeeds: sb.ctx.window.inferBusApiSegmentSpeeds,
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: any) => String(s ?? ''),
    calculateDistanceKm: sb.ctx.window.calculateDistanceKm,
    L: {
      layerGroup: (arr: any[] = []) => ({ _layers: arr, addTo() { return this; }, addLayer(l: any) { this._layers.push(l); }, clearLayers() { this._layers.length = 0; } }),
      polyline: (c: any, opts: any) => ({ c, opts, addTo(g: any) { g?.addLayer?.(this); return this; }, bindTooltip() { return this; } }),
      divIcon: (o: any) => o,
      marker: (ll: any, opts: any) => ({ ll, opts, addTo(g: any) { g?.addLayer?.(this); return this; }, bindTooltip() { return this; }, on() { return this; } }),
      geoJSON: () => ({ addTo() { return this; } }),
    },
    console, Math, Number, String, Array, Map, Set,
  };
  vm.createContext(mapCtx);
  vm.runInContext(mapSrc, mapCtx);

  const bridgeDets = [
    // Pair 1: 450m apart, same road, same direction, BOTH SMOOTH -> MUST bridge at opacity 0.55
    { id: 'B1', lat: 22.3500, lon: 114.0000, rot: 0, spd: 62, tier: 'SMOOTH', roadEn: 'Castle Peak Road' },
    { id: 'B2', lat: 22.3540, lon: 114.0000, rot: 0, spd: 66, tier: 'SMOOTH', roadEn: 'Castle Peak Road' },
    // Pair 2: 450m apart, same road, MISMATCHED tier (SMOOTH vs CONGESTED) -> MUST NOT bridge
    { id: 'M1', lat: 22.3800, lon: 114.0200, rot: 0, spd: 60, tier: 'SMOOTH', roadEn: 'Tolo Highway' },
    { id: 'M2', lat: 22.3840, lon: 114.0200, rot: 0, spd: 12, tier: 'JAMMED', roadEn: 'Tolo Highway' },
    // Pair 3: 780m apart (> 600m), same tier -> MUST NOT bridge
    { id: 'G1', lat: 22.4100, lon: 114.0400, rot: 0, spd: 70, tier: 'SMOOTH', roadEn: 'Fanling Highway' },
    { id: 'G2', lat: 22.4170, lon: 114.0400, rot: 0, spd: 72, tier: 'SMOOTH', roadEn: 'Fanling Highway' },
  ];
  const bridgedFc = mapCtx.filterAndOffsetGlobalSpeedGeoJson({ type: 'FeatureCollection', features: [] }, 14, bridgeDets);
  assert.equal(bridgedFc.features.length, 1, 'Only the <=600m same-road same-tier gap should be bridged');
  assert.equal(bridgedFc.features[0].properties.isGapBridge, true);
  assert.equal(bridgedFc.features[0].properties.opacity, 0.55);

  // --- Issue 3C: Forward-only route camera filter (<=120m, <=55deg, 1.0 opacity <=8km vs 0.55 opacity >8km, no upstream cams) ---
  const routeMarkers: any[] = [];
  const detailMockMap: any = {
    getZoom: () => 15,
    getBounds: () => ({ pad: () => ({ contains: () => true }), contains: () => true }),
    latLngToContainerPoint: (ll: [number, number]) => ({ x: ll[1] * 10000, y: ll[0] * 10000 }),
    removeLayer: () => {},
    on: () => {},
  };
  mapCtx.L.marker = (ll: any, opts: any) => {
    const m: any = { ll, opts, addTo() { routeMarkers.push(m); return m; }, bindTooltip() { return m; }, on() { return m; } };
    return m;
  };
  mapCtx.window.mapInstance = detailMockMap;
  mapCtx.window.__LIVE_TRAFFIC_DETECTORS__ = corridorDets;
  mapCtx.window.__LIVE_TRAFFIC_CAMERAS__ = [
    { key: 'CAM_BEHIND', lat: 22.3050, lon: 114.0000, desc: 'Airport Behind - Northbound', bearingDeg: 0 }, // upstream behind Stop 1
    { key: 'CAM_NEAR_FWD', lat: 22.3300, lon: 114.0001, desc: 'Forward 1.3km - Northbound', bearingDeg: 0 }, // <=120m, <=8km -> opacity 1.0
    { key: 'CAM_FAR_FWD', lat: 22.4150, lon: 114.0001, desc: 'Forward 10.8km - Northbound', bearingDeg: 0 }, // <=120m, >8km -> opacity 0.55
    { key: 'CAM_WRONG_DIR', lat: 22.3360, lon: 114.0001, desc: 'Opposite - Southbound', bearingDeg: 180 }, // >55deg -> excluded
    { key: 'CAM_TOO_WIDE', lat: 22.3450, lon: 114.0028, desc: 'Side Road 280m - Northbound', bearingDeg: 0 }, // >120m -> excluded
  ];
  const fwdSlice = sb.ctx.window.sliceForwardPolylineFromStop(corridorPoly, corridorStops, 1, 45.0, null);
  mapCtx.currentDetailCorridorMeta = {
    isBusRoute: true,
    isRoadSnapped: true,
    hasHighwaySpan: true,
    coords: corridorPoly,
    forwardCoords: fwdSlice,
    forwardCameraCoords: fwdSlice,
  };
  mapCtx.renderTrafficOverlayOnMap(detailMockMap, true);
  const camMarkers = routeMarkers.filter(m => m.opts?.icon?.className === 'global-traffic-cam-icon');
  const findCam = (k: string) => camMarkers.find(m => String(m.opts?.icon?.html || '').includes(`data-cam-key="${k}"`));
  assert.equal(findCam('CAM_BEHIND'), undefined, 'Upstream camera behind expanded boarding stop must NEVER render');
  assert.equal(findCam('CAM_WRONG_DIR'), undefined, 'Opposite-direction camera (>55 deg) must NEVER render');
  assert.equal(findCam('CAM_TOO_WIDE'), undefined, 'Off-corridor camera (>120 m) must NEVER render');
  assert.ok(findCam('CAM_NEAR_FWD'), 'Forward camera within 8 km must render');
  assert.equal(findCam('CAM_NEAR_FWD').opts.opacity, 1.0, 'Forward camera <= 8 km must have 1.0 opacity');
  assert.ok(findCam('CAM_FAR_FWD'), 'Forward camera > 8 km must render');
  assert.equal(findCam('CAM_FAR_FWD').opts.opacity, 0.55, 'Forward camera > 8 km must have 0.55 opacity');

  // --- Issue 4: Separate API-Driven Bus Speed Layer & TD Gap Filling ---
  const inferBusApiSegmentSpeeds = sb.ctx.window.inferBusApiSegmentSpeeds;
  const t0 = Date.UTC(2026, 10, 23, 2, 0, 0);
  // Stop 0 -> Stop 1: 2.0 km in 10 min (isolated single slow span -> downgraded from Red to MODERATE/SMOOTH)
  // Stop 1 -> Stop 2: 2.44 km highway span in 2.5 min (minus dwell => ~64 km/h SMOOTH)
  const busEtas = {
    0: [{ eta: new Date(t0).toISOString() }],
    1: [{ eta: new Date(t0 + 10 * 60000).toISOString() }],
    2: [{ eta: new Date(t0 + 12.5 * 60000).toISOString() }],
  };
  const busSegs = inferBusApiSegmentSpeeds(corridorStops.slice(0, 3), busEtas, corridorPoly, { tdDetectors: [], nowMs: t0 });
  assert.equal(busSegs.length, 2, 'Must infer speed for both stop-to-stop spans from live bus ETAs');
  assert.equal(busSegs[1].tier, 'SMOOTH', `Fast highway bus span (~64 km/h) must classify as SMOOTH, got ${busSegs[1].speedKmh} km/h (${busSegs[1].tier})`);
  assert.equal(busSegs[0].source, 'BUS_API');
  assert.equal(busSegs[0].coveredByTd, false);

  // Verify unified Traffic toggle (no separate Bus Speed button), decluttered single status bar, and Exit/Road Ahead chips in index.html
  assert.ok(!html.includes('id="detailMapBusSpeedBtn"') && !mapSrc.includes('browseMapBusSpeedBtn'),
    'Separate Bus Speed map toggle buttons (#detailMapBusSpeedBtn / #browseMapBusSpeedBtn) must be merged into single Traffic toggle');
  assert.ok(html.includes('id="detailMapTrafficBtn"') && html.includes('toggleTrafficLayerOverlay()'), 'Detail map must expose unified Traffic toggle button');
  assert.ok(html.includes('class="stop-exit-pill') && html.includes('toggleDetailExitStop('), 'Downstream stop rows must include compact 1-tap Exit pill button');
  assert.ok(html.includes('class="traffic-ahead-cam-chip"') && html.includes('Road Ahead'), 'Expanded stop traffic card must include compact Road Ahead camera chip');
  assert.ok(!html.includes('traffic-segment-list') && !html.includes('traffic-segment-row') && !html.includes('traffic-approaching-strip'),
    'Expanded bus stop card must remove .traffic-segment-list, .traffic-segment-row, and .traffic-approaching-strip completely');
});

test('Dedicated busspeed.js Calibration, Rural 1.45x Winding Factor, >=2 Consecutive Live Slow Span Red Rule, Multi-Operator Global Corridor Deduplication, and Clean Single Status Bar', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const busSpeedEngine: any = bsWindow.BusSpeedEngine;
  assert.ok(busSpeedEngine, 'public/busspeed.js must export window.BusSpeedEngine');
  const html = readAppBundle();
  const mapSrc = readMapBundle();
  const t0 = Date.UTC(2026, 10, 27, 1, 15, 0);

  // 1. Empty new-town road (Yu Tung Rd / Tung Chung Waterfront Rd):
  // Terminus departure (Yat Tung Estate -> Yu Tung Rd, 450m, 3 min rounded ETA) + short urban hop (420m, 2 min rounded ETA)
  // MUST classify as SMOOTH — NEVER false red congestion!
  const yuTungStops = [
    { stopKey: 'YT0', stopName_e: 'Yat Tung Estate Bus Terminus', latitude: '22.2810', longitude: '113.9350' },
    { stopKey: 'YT1', stopName_e: 'Mun Tung Estate, Yu Tung Road', latitude: '22.2830', longitude: '113.9388' },
    { stopKey: 'YT2', stopName_e: 'Yu Nga Court, Tung Chung Waterfront Road', latitude: '22.2862', longitude: '113.9412' },
  ];
  const yuTungEtas = {
    0: [{ eta: new Date(t0).toISOString(), seq: 1 }],
    1: [{ eta: new Date(t0 + 180000).toISOString(), seq: 1 }],
    2: [{ eta: new Date(t0 + 300000).toISOString(), seq: 1 }],
  };
  const yuTungSegs = busSpeedEngine.inferBusApiSegmentSpeeds(yuTungStops, yuTungEtas, null, { tdDetectors: [], nowMs: t0 });
  assert.equal(yuTungSegs.length, 2, 'Must produce calibrated segments for Yu Tung Rd');
  assert.notEqual(yuTungSegs[0].tier, 'CONGESTED', `Terminus departure on empty Yu Tung Rd must NOT be false RED, got ${yuTungSegs[0].tier} (${yuTungSegs[0].speedKmh} km/h)`);
  assert.equal(yuTungSegs[1].tier, 'SMOOTH', `Short 2-min rounded urban hop on empty Waterfront Rd must be SMOOTH, got ${yuTungSegs[1].tier} (${yuTungSegs[1].speedKmh} km/h)`);

  // 1b. Fast 1-min (60s) 490m urban hop must NOT inflate to unrealistic 60-75 km/h on local roads
  const fastUrbanEtas = {
    0: [{ eta: new Date(t0).toISOString(), seq: 1 }],
    1: [{ eta: new Date(t0 + 60000).toISOString(), seq: 1 }],
  };
  const fastUrbanSegs = busSpeedEngine.inferBusApiSegmentSpeeds(
    [
      { stopKey: 'KP0', stopName_e: 'Ko Po Tsuen', latitude: '22.4350', longitude: '114.0580' },
      { stopKey: 'KP1', stopName_e: 'Ha Ko Po Tsuen', latitude: '22.4392', longitude: '114.0570' },
    ],
    fastUrbanEtas,
    null,
    { tdDetectors: [], nowMs: t0 }
  );
  assert.equal(fastUrbanSegs[0].tier, 'SMOOTH');
  assert.ok(fastUrbanSegs[0].speedKmh <= 40, `Fast 1-min 490m urban hop must stay realistically capped (<= 40 km/h), got ${fastUrbanSegs[0].speedKmh} km/h`);

  // 2. Scheduled timetable-only ETAs (including fetchEtaRaw's { targetMs, isSched: true } shape) must NEVER create false delays
  const schedEtas = {
    0: [{ targetMs: t0, rawTargetMs: t0, isSched: true, noGPS: 1 }],
    1: [{ targetMs: t0 + 480000, rawTargetMs: t0 + 480000, isSched: true, noGPS: 1 }],
    2: [{ targetMs: t0 + 960000, rawTargetMs: t0 + 960000, isSched: true, noGPS: 1 }],
  };
  const schedSegs = busSpeedEngine.inferBusApiSegmentSpeeds(yuTungStops, schedEtas, null, { tdDetectors: [], nowMs: t0 });
  assert.equal(schedSegs.length, 2);
  assert.equal(schedSegs[0].tier, 'SMOOTH', 'Scheduled-only ETAs must never fabricate red/amber jams');
  assert.equal(schedSegs[1].tier, 'SMOOTH', 'Consecutive scheduled-only ETAs must never fabricate red/amber jams');
  assert.equal(schedSegs[0].isScheduledOnly, true);
  assert.equal(schedSegs[0].isBottleneck, false);

  // 3. Rural/winding corridors (South Lantau Rd to Pui O & Mui Wo, Tung Chung Rd, Tai O, Sai Kung, Shek O):
  // a) Must apply 1.45x winding-road distance factor when unsnapped
  // b) Must parse fetchEtaRaw's { targetMs, rawTargetMs, isSched: false } format for NLB/CTB/GMB!
  // c) Isolated single slow rural span must stay Green (SMOOTH) — NEVER Red (CONGESTED)
  // d) 2 consecutive slow/congested live spans on South Lantau Rd DO flag Red (CONGESTED)
  const southLantauStops = [
    { stopKey: 'SL0', stopName_e: 'Mui Wo Ferry Pier, South Lantau Road', latitude: '22.2646', longitude: '114.0015' },
    { stopKey: 'SL1', stopName_e: 'Pui O, South Lantau Road', latitude: '22.2435', longitude: '113.9785' },
    { stopKey: 'SL2', stopName_e: 'Lo Uk Tsuen, South Lantau Road', latitude: '22.2422', longitude: '113.9710' },
    { stopKey: 'SL3', stopName_e: 'San Shek Wan, South Lantau Road', latitude: '22.2385', longitude: '113.9615' },
  ];
  assert.equal(busSpeedEngine.isRuralWindingCorridor(southLantauStops[0], southLantauStops[1]), true);
  assert.equal(busSpeedEngine.isRuralWindingCorridor({ stopName_e: 'Sai Kung Town' }, { stopName_e: 'Clear Water Bay' }), true);
  assert.equal(busSpeedEngine.isRuralWindingCorridor({ stopName_e: 'Shek O Bus Terminus' }, { stopName_e: 'Shek O Road' }), true);

  // Single isolated slow span on South Lantau Rd (using NLB fetchEtaRaw targetMs objects) -> stays SMOOTH (not Red!)
  const slIsolatedEtas = {
    0: [{ targetMs: t0, rawTargetMs: t0, isSched: false, noGPS: 0 }],
    1: [{ targetMs: t0 + 360000, rawTargetMs: t0 + 360000, isSched: false, noGPS: 0 }], // ~3.3km straight * 1.45 = ~4.8km in 6m => SMOOTH
    2: [{ targetMs: t0 + 840000, rawTargetMs: t0 + 840000, isSched: false, noGPS: 0 }], // single slow 8-min span
    3: [{ targetMs: t0 + 960000, rawTargetMs: t0 + 960000, isSched: false, noGPS: 0 }], // fast 2-min next span
  };
  const slIsolatedSegs = busSpeedEngine.inferBusApiSegmentSpeeds(southLantauStops, slIsolatedEtas, null, { tdDetectors: [], nowMs: t0 });
  assert.equal(slIsolatedSegs.length, 3, 'Must parse fetchEtaRaw targetMs objects for NLB routes');
  assert.ok(slIsolatedSegs[0].roadDistKm > 4.2, `Unsnapped South Lantau Rd span must apply 1.45x winding factor (>4.2km), got ${slIsolatedSegs[0].roadDistKm}km`);
  assert.equal(slIsolatedSegs[0].tier, 'SMOOTH', `Normal South Lantau Rd flow must be SMOOTH, got ${slIsolatedSegs[0].tier}`);
  assert.equal(slIsolatedSegs[1].tier, 'SMOOTH', `Isolated single slow rural span without a 2nd consecutive slow span must stay SMOOTH (never Red), got ${slIsolatedSegs[1].tier}`);

  // Single-bus slow spans cap at MODERATE (Amber, NEVER Red) without a live TD detector
  const slSingleBusSlowEtas = {
    0: [{ targetMs: t0, rawTargetMs: t0, isSched: false, noGPS: 0 }],
    1: [{ targetMs: t0 + 360000, rawTargetMs: t0 + 360000, isSched: false, noGPS: 0 }], // smooth
    2: [{ targetMs: t0 + 960000, rawTargetMs: t0 + 960000, isSched: false, noGPS: 0 }], // 10 min crawl (1 bus)
    3: [{ targetMs: t0 + 1680000, rawTargetMs: t0 + 1680000, isSched: false, noGPS: 0 }], // 12 min crawl (1 bus)
  };
  const slSingleBusSegs = busSpeedEngine.inferBusApiSegmentSpeeds(southLantauStops, slSingleBusSlowEtas, null, { tdDetectors: [], nowMs: t0 });
  assert.equal(slSingleBusSegs[1].tier, 'MODERATE', `Single-bus slow span must cap at MODERATE (Amber), got ${slSingleBusSegs[1].tier}`);
  assert.equal(slSingleBusSegs[2].tier, 'MODERATE', `Single-bus slow span must cap at MODERATE (Amber), got ${slSingleBusSegs[2].tier}`);

  // Verified severe multi-bus stall (< 8 km/h across >= 2 consecutive live buses) on consecutive rural spans -> flags Red (CONGESTED)
  const slMultiBusStallEtas = {
    0: [
      { targetMs: t0, rawTargetMs: t0, isSched: false, noGPS: 0, etaSeq: 1 },
      { targetMs: t0 + 900000, rawTargetMs: t0 + 900000, isSched: false, noGPS: 0, etaSeq: 2 },
    ],
    1: [
      { targetMs: t0 + 360000, rawTargetMs: t0 + 360000, isSched: false, noGPS: 0, etaSeq: 1 },
      { targetMs: t0 + 1260000, rawTargetMs: t0 + 1260000, isSched: false, noGPS: 0, etaSeq: 2 },
    ],
    2: [
      { targetMs: t0 + 1020000, rawTargetMs: t0 + 1020000, isSched: false, noGPS: 0, etaSeq: 1 }, // 11 min (~6.4 km/h)
      { targetMs: t0 + 1920000, rawTargetMs: t0 + 1920000, isSched: false, noGPS: 0, etaSeq: 2 }, // 11 min (~6.4 km/h)
    ],
    3: [
      { targetMs: t0 + 1920000, rawTargetMs: t0 + 1920000, isSched: false, noGPS: 0, etaSeq: 1 }, // 15 min (~6.2 km/h)
      { targetMs: t0 + 2820000, rawTargetMs: t0 + 2820000, isSched: false, noGPS: 0, etaSeq: 2 }, // 15 min (~6.2 km/h)
    ],
  };
  const slConsecSegs = busSpeedEngine.inferBusApiSegmentSpeeds(southLantauStops, slMultiBusStallEtas, null, { tdDetectors: [], nowMs: t0 });
  assert.equal(slConsecSegs[1].isVerifiedMultiBusStall, true, '2 consecutive buses < 8 km/h must mark isVerifiedMultiBusStall=true');
  assert.equal(slConsecSegs[1].tier, 'CONGESTED', `Verified multi-bus stall on South Lantau Rd span 1 must be CONGESTED, got ${slConsecSegs[1].tier}`);
  assert.equal(slConsecSegs[2].tier, 'CONGESTED', `Verified multi-bus stall on South Lantau Rd span 2 must be CONGESTED, got ${slConsecSegs[2].tier}`);

  // 3b. Global corridor selector: removes tight maxRoutes=8 cap, selects >8 distinct corridors across KMB/LWB/CTB/NLB/GMB,
  // deduplicates overlapping routes on the exact same road stretch, and skips routes fully covered by TD detectors!
  const wideBounds = {
    contains: ([la, lo]: [number, number]) => la >= 22.20 && la <= 22.45 && lo >= 113.85 && lo <= 114.25
  };
  const multiCorridorPool: any[] = [];
  const ops = ['KMB', 'LWB', 'CTB', 'NLB', 'GMB'];
  for (let c = 0; c < 12; c++) {
    const baseLat = 22.22 + c * 0.015;
    const co = ops[c % ops.length];
    const st = [
      { stopKey: `C${c}_0`, stopName_e: `Corridor ${c} A`, latitude: String(baseLat), longitude: '114.0000' },
      { stopKey: `C${c}_1`, stopName_e: `Corridor ${c} B`, latitude: String(baseLat), longitude: '114.0120' },
      { stopKey: `C${c}_2`, stopName_e: `Corridor ${c} C`, latitude: String(baseLat), longitude: '114.0240' },
    ];
    multiCorridorPool.push({ key: `${co}_${100 + c}_O`, routeNo: String(100 + c), company: co, bound: 'O', mode: 'BUS', routeIds: [`${co}_${100 + c}_O`], stops: st });
    // Add an overlapping duplicate route on the exact same road stretch!
    multiCorridorPool.push({ key: `${co}_${200 + c}_O`, routeNo: String(200 + c), company: co, bound: 'O', mode: 'BUS', routeIds: [`${co}_${200 + c}_O`], stops: st });
  }
  // Place TD detectors covering Corridor 0 completely
  const tdCovDets = [
    { id: 'TD_C0_1', lat: 22.22, lon: 114.0060, rot: 90, spd: 60 },
    { id: 'TD_C0_2', lat: 22.22, lon: 114.0180, rot: 90, spd: 60 },
  ];
  const pickedCorridors = busSpeedEngine.selectGlobalBusSpeedRoutes(multiCorridorPool, wideBounds, (g: any) => g.stops, undefined, tdCovDets);
  assert.equal(pickedCorridors.length, 11, `Must select all 11 distinct unmonitored corridors (skipping TD-covered corridor 0 & deduplicating 12 overlaps), got ${pickedCorridors.length}`);
  assert.ok(pickedCorridors.length > 8, 'Must NOT be bottlenecked by legacy maxRoutes = 8 cap');
  const pickedOps = new Set(pickedCorridors.map((p: any) => p.operator));
  assert.ok(pickedOps.has('KMB') && pickedOps.has('CTB') && pickedOps.has('NLB') && pickedOps.has('GMB'), 'Must cover KMB/LWB, CTB, NLB, and GMB corridors');

  // 4. Strict TD Ground-Truth Priority on Conflict (Castle Peak Rd-Ping Shan 70 km/h GREEN beats slower Bus API ETA!)
  const pingShanStops = [
    { stopKey: 'PS0', stopName_e: 'Tong Yan San Tsuen, Castle Peak Road - Ping Shan', latitude: '22.4418', longitude: '114.0110' },
    { stopKey: 'PS1', stopName_e: 'Ping Shan, Castle Peak Road - Ping Shan', latitude: '22.4438', longitude: '114.0030' },
  ];
  const pingShanPoly = [
    [22.4418, 114.0110],
    [22.4428, 114.0070],
    [22.4438, 114.0030],
  ];
  const pingShanTdDetector = [{
    id: 'TDSCPRPS20003',
    lat: 22.4428,
    lon: 114.0070,
    spd: 70,
    occ: 0,
    tier: 'SMOOTH',
    rot: 285,
    roadEn: 'Castle Peak Road - Ping Shan',
    roadTc: '青山公路－屏山段',
    camKey: 'NL126',
  }];
  const pingShanCam = [{
    key: 'NL126',
    lat: 22.4428,
    lon: 114.0070,
    desc: 'Castle Peak Road - Ping Shan near Tong Yan San Tsuen Playground',
    bearingDeg: 285,
  }];
  const slowBusConflictEtas = {
    0: [{ eta: new Date(t0).toISOString() }],
    1: [{ eta: new Date(t0 + 270000).toISOString() }],
  };
  const resolvedSegs = busSpeedEngine.inferBusApiSegmentSpeeds(pingShanStops, slowBusConflictEtas, pingShanPoly, {
    tdDetectors: pingShanTdDetector,
    tdCameras: pingShanCam,
    nowMs: t0,
  });
  assert.equal(resolvedSegs.length, 1);
  assert.equal(resolvedSegs[0].source, 'TD', 'TD ground truth MUST override Bus API on conflict');
  assert.equal(resolvedSegs[0].tier, 'SMOOTH', 'Castle Peak Rd-Ping Shan 70 km/h TD detector must force SMOOTH green');
  assert.equal(resolvedSegs[0].speedKmh, 70);
  assert.equal(resolvedSegs[0].tdConflictResolved, true);
  assert.equal(resolvedSegs[0].camKey, 'NL126');

  // 5. Unified 3-tier Stop-by-Stop Segment Builder: Tier 1 (TD) > Tier 2 (BUS_API) > Tier 3 (CAM_ONLY)
  const fourStops = [
    { stopKey: 'A', stopName_e: 'Stop A', latitude: '22.3000', longitude: '114.1000' },
    { stopKey: 'B', stopName_e: 'Stop B', latitude: '22.3060', longitude: '114.1000' },
    { stopKey: 'C', stopName_e: 'Stop C', latitude: '22.3120', longitude: '114.1000' },
    { stopKey: 'D', stopName_e: 'Stop D', latitude: '22.3180', longitude: '114.1000' },
  ];
  const fourPoly = [[22.3000, 114.1000], [22.3060, 114.1000], [22.3120, 114.1000], [22.3180, 114.1000]];
  const fourDets = [{ id: 'DET_AB', lat: 22.3030, lon: 114.1000, spd: 64, occ: 12, tier: 'SMOOTH', rot: 0, roadEn: 'Corridor A-B', camKey: 'CAM_AB' }];
  const fourCams = [
    { key: 'CAM_AB', lat: 22.3030, lon: 114.1000, desc: 'Cam A-B', bearingDeg: 0 },
    { key: 'CAM_CD', lat: 22.3150, lon: 114.1000, desc: 'Cam C-D', bearingDeg: 0 },
  ];
  const fourBusSegs = [
    { fromIdx: 0, toIdx: 1, speedKmh: 12, tier: 'CONGESTED', roadDistKm: 0.67, deltaSec: 210, expectedKmh: 35 },
    { fromIdx: 1, toIdx: 2, speedKmh: 28, tier: 'SMOOTH', roadDistKm: 0.67, deltaSec: 110, expectedKmh: 30 },
  ];
  const timeline = busSpeedEngine.buildStopByStopSegmentTraffic(fourStops, fourPoly, fourDets, fourCams, fourBusSegs);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].source, 'TD', 'Span 0->1 must pick Tier 1 TD over Bus API');
  assert.equal(timeline[0].speedKmh, 64);
  assert.equal(timeline[0].camKey, 'CAM_AB');
  assert.equal(timeline[1].source, 'BUS_API', 'Span 1->2 must pick Tier 2 BUS_API when no TD sensor');
  assert.equal(timeline[1].speedKmh, 28);
  assert.equal(timeline[2].source, 'BUS_EST', 'Span 2->3 must emit BUS_EST with preserved camera when no TD sensor or live ETA exists');
  assert.equal(timeline[2].camKey, 'CAM_CD');

  // 5b. Strict TD ground-truth suppression (~100m, ±45°) against BOTH TD speed links and TD detectors:
  // Same-direction TD speed link within 100m & <=45° MUST suppress BUS_API; opposite direction (180°) or >100m MUST NOT suppress.
  const busSpanCoords = [[22.3200, 114.1700], [22.3240, 114.1700]]; // Northbound (0°)
  const tdLinkSameDir = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[114.1704, 22.3205], [114.1704, 22.3235]] }, // ~41m east, Northbound (0°)
      properties: { id: 'LINK_NB', spd: 58, tier: 'SMOOTH', rot: 0, roadEn: 'Nathan Road NB' }
    }]
  };
  const tdLinkOppDir = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[114.1704, 22.3235], [114.1704, 22.3205]] }, // ~41m east, Southbound (180°)
      properties: { id: 'LINK_SB', spd: 20, tier: 'CONGESTED', rot: 180, roadEn: 'Nathan Road SB' }
    }]
  };
  const tdLinkTooFar = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[114.1720, 22.3205], [114.1720, 22.3235]] }, // ~206m east (>100m), Northbound
      properties: { id: 'LINK_FAR', spd: 60, tier: 'SMOOTH', rot: 0, roadEn: 'Parallel Road NB' }
    }]
  };
  assert.equal(busSpeedEngine.isSegmentCoveredByTdGroundTruth(busSpanCoords, [], tdLinkSameDir), true,
    'Same-direction TD speed link within ~100m and ±45° must mark stretch covered by TD ground truth');
  assert.equal(busSpeedEngine.isSegmentCoveredByTdGroundTruth(busSpanCoords, [], tdLinkOppDir), false,
    'Opposite-direction TD speed link (180°) must NOT suppress northbound BUS_API stretch');
  assert.equal(busSpeedEngine.isSegmentCoveredByTdGroundTruth(busSpanCoords, [], tdLinkTooFar), false,
    'TD speed link >100m away must NOT suppress BUS_API stretch');

  // Verify map.js _drawBusSpeedSegmentsIntoLayer discards TD-covered BUS_API segments and draws unmonitored BUS_API
  // segments with translucent dashed stroke (opacity 0.62, dashArray '8, 6', weight 4)
  const drawnPolylines: any[] = [];
  const drawMapCtx: any = {
    window: {
      globalTrafficLayerEnabled: true,
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __LIVE_TRAFFIC_SPEED_GEOJSON__: tdLinkSameDir,
      isSegmentCoveredByTdGroundTruth: busSpeedEngine.isSegmentCoveredByTdGroundTruth,
      getBusSpeedLayerColorHex: busSpeedEngine.getBusSpeedColorHex,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: any) => String(s ?? ''),
    calculateDistanceKm: (a1: number, o1: number, a2: number, o2: number) => Math.hypot((a2 - a1) * 111.32, (o2 - o1) * 102.5),
    L: {
      layerGroup: () => ({ addLayer() {}, clearLayers() {} }),
      polyline: (coords: any, opts: any) => {
        const p = { coords, opts, addTo() { drawnPolylines.push(p); return p; }, bindTooltip() { return p; } };
        return p;
      },
    },
    console, Math, Number, String, Array, Map, Set,
  };
  vm.createContext(drawMapCtx);
  vm.runInContext(mapSrc, drawMapCtx);
  const drawnCount = drawMapCtx._drawBusSpeedSegmentsIntoLayer([
    // Covered by tdLinkSameDir within 41m & 0° -> MUST be discarded!
    { fromIdx: 0, toIdx: 1, tier: 'CONGESTED', speedKmh: 10, color: '#dc2626', source: 'BUS_API', isRoadSnapped: true, coords: busSpanCoords },
    // Unmonitored South Lantau corridor -> MUST draw translucent dashed (opacity 0.62, dashArray '8, 6', weight 4)!
    { fromIdx: 1, toIdx: 2, tier: 'SMOOTH', speedKmh: 42, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, coords: [[22.2435, 113.9785], [22.2428, 113.9745], [22.2422, 113.9710]] },
  ], drawMapCtx.L.layerGroup(), 'NLB 3M', new Map());
  assert.equal(drawnCount, 1, 'TD-covered BUS_API segment must be discarded while unmonitored South Lantau segment draws');
  const mainBusStroke = drawnPolylines.find(p => p.opts?.color === '#16a34a');
  assert.ok(mainBusStroke, 'Unmonitored BUS_API polyline must be drawn in tier green (#16a34a)');
  assert.equal(mainBusStroke.opts.opacity, 0.62, 'BUS_API polyline must use translucent opacity 0.62');
  assert.equal(mainBusStroke.opts.dashArray, '8, 6', 'BUS_API polyline must use dashed stroke dashArray "8, 6"');
  assert.equal(mainBusStroke.opts.weight, 4, 'BUS_API polyline must use weight 4');

  // 6. Verify index.html & map.js unified Traffic toggle & visual distinction rules:
  // - Single unified Traffic toggle (zero separate Bus Speed buttons)
  // - Solid TD lines (weight 4.5, opacity 0.92, dashArray null) vs translucent dashed BUS_API lines (weight 4, opacity 0.62, dashArray '8, 6')
  // - Solid-filled TD stop-row pills (.source-td) with exact km/h vs translucent dashed BUS_API pills (.source-bus-api) with coarse flow labels
  // - Single status bar (zero .traffic-segment-list / .traffic-segment-row / .traffic-approaching-strip)
  // - Hollow white stop circles suppressed while unified Traffic overlay is ON
  assert.ok(html.includes('<script src="busspeed.js"></script>'), 'index.html must load busspeed.js');
  assert.ok(!html.includes('detailMapBusSpeedBtn') && !mapSrc.includes('browseMapBusSpeedBtn'),
    'Separate Bus Speed buttons must be removed in favor of single unified Traffic toggle');
  assert.ok(html.includes('.stop-seg-speed-pill.source-td') && html.includes('.stop-seg-speed-pill.source-bus-api { border-width: 1px; border-style: dashed; }'),
    'index.html must visually distinguish solid .source-td badges from translucent 1px dashed .source-bus-api badges');
  assert.ok(!html.includes('traffic-approaching-strip') && !html.includes('traffic-segment-list') && !html.includes('traffic-segment-row'),
    'index.html must not contain cluttered .traffic-approaching-strip, .traffic-segment-list, or .traffic-segment-row');
  assert.ok(html.includes("'Clear'") && html.includes("'Slow'") && html.includes("'Jammed'") && !html.includes('~${Math.round(seg.speedKmh)} km/h · ${srcTag}'),
    'BUS_API stop-row pills must show coarse Clear/Slow/Jammed labels instead of ~XX km/h');
  assert.ok(mapSrc.includes('const flowWeight = 4.5;') && mapSrc.includes('opacity: feat?.properties?.isGapBridge ? 0.55 : 0.92,'),
    'Global TD ground-truth polylines must render solid at weight 4.5 and opacity 0.92');
  assert.ok(mapSrc.includes('if (window.globalTrafficLayerEnabled)') && mapSrc.includes('renderGlobalBusSpeedOverlay(window.browseMapInstance);'),
    'Unified Global Traffic toggle must jointly drive TD lines + Bus Speed gap-fill and suppress hollow white stop circles');
  assert.ok(mapSrc.includes('_globalBusStretchDedupKey') && mapSrc.includes('BATCH_SIZE = 5'),
    'map.js must deduplicate overlapping stretches and batch Global Bus Speed fetches cleanly');
});

test('Hard Spatial Mutex & Micro-Step Aggregation: 40-60m subdivision, 100m TD suppression (including undivided urban roads), and 60m x 45deg Directional Road-Cell Occupancy Grid', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  // 1. Subdivide a 500m polyline into ~40-60m micro-steps
  const roadLine: [number, number][] = [
    [22.3750, 113.9720],
    [22.3750, 113.9769], // ~502m due east
  ];
  const steps = engine.subdividePolylineMicroSteps(roadLine, 50);
  assert.ok(steps.length >= 8 && steps.length <= 13, `Expected ~10 micro-steps of 40-60m, got ${steps.length}`);
  steps.forEach((st: any) => {
    const lenM = Number(st.lenM);
    assert.ok(lenM >= 35 && lenM <= 65, `Micro-step length must stay within ~40-60m band, got ${lenM.toFixed(1)}m`);
  });

  // 2. Point-to-Segment TD Suppression on undivided urban roads (Castle Peak Rd - Castle Peak Bay, Hoi Wing Rd, Siu Lun St, Ping Ha Rd):
  // TD solid link covers ONLY the western half (113.9720 -> 113.9742, westbound) while BUS_API runs eastbound across the full 500m.
  // Micro-steps within 100m of the TD link MUST be dropped cleanly (even opposite bearing on undivided urban road!),
  // while the unmonitored eastern half (> 100m beyond TD end) survives cleanly!
  assert.equal(engine.isUndividedUrbanRoad('Castle Peak Road - Castle Peak Bay', '青山公路－青山灣段'), true);
  assert.equal(engine.isUndividedUrbanRoad('Hoi Wing Road', '海榮路'), true);
  assert.equal(engine.isUndividedUrbanRoad('Siu Lun Street', '兆麟街'), true);
  assert.equal(engine.isUndividedUrbanRoad('Ping Ha Road', '屏廈路'), true);
  assert.equal(engine.isUndividedUrbanRoad('Tuen Mun Road', '屯門公路'), false);

  const tdPartialGeo = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[113.9742, 22.3750], [113.9720, 22.3750]] }, // Westbound on undivided Castle Peak Rd - Castle Peak Bay
      properties: { id: 'TDSCPR_CPB', roadEn: 'Castle Peak Road - Castle Peak Bay', roadTc: '青山公路－青山灣段', spd: 46, rot: 270 },
    }],
  };
  const partialSeg = {
    company: 'KMB', routeNo: '52X', fromIdx: 0, toIdx: 1, fromSeq: 1, toSeq: 2,
    tier: 'SMOOTH', speedKmh: 30, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
    allowRed: false, smoothMinKmh: 17, moderateMinKmh: 10.5, expectedKmh: 26,
    coords: roadLine,
  };
  const partialAgg = engine.aggregateBusMicroStepsToCorridors([partialSeg], [], tdPartialGeo, { targetStepM: 50, tdMaxDistKm: 0.10, tdMaxAngDeg: 45 });
  assert.ok(partialAgg.stats.suppressedByTdMicroSteps >= 4, `Expected >=4 western micro-steps suppressed by TD within 100m, got ${partialAgg.stats.suppressedByTdMicroSteps}`);
  assert.equal(partialAgg.corridors.length, 1, 'Unmonitored eastern portion beyond TD boundary must survive as ONE clean corridor');
  const minSurvivingLon = Math.min(...partialAgg.corridors[0].coords.map((p: number[]) => p[1]));
  assert.ok(minSurvivingLon >= 113.9748, `BUS_API dashed line must stop cleanly >100m away from TD link end (113.9742), got minLon=${minSurvivingLon}`);

  // 3. Directional Road-Cell Occupancy Grid (~60m x 45°):
  // - 3 overlapping same-direction routes on the exact same road (28 km/h green, 25 km/h green, 9 km/h single-span red without allowRed)
  //   MUST merge into ONE single clean corridor using median speed (25 km/h -> Green #16a34a), ZERO stacked multi-color lines!
  // - Opposite carriageway (westbound, 270°) MUST remain distinct (preserving HK keep-left opposite carriageways)!
  // - Single slow span without allowRed MUST cap at MODERATE (amber), never Red!
  const unmonitoredEB: [number, number][] = [[22.2430, 113.9600], [22.2430, 113.9640]];
  const unmonitoredWB: [number, number][] = [[22.2430, 113.9640], [22.2430, 113.9600]];
  const multiRouteSegs = [
    { company: 'NLB', routeNo: '3M', tier: 'SMOOTH', speedKmh: 28, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, allowRed: false, coords: unmonitoredEB },
    { company: 'NLB', routeNo: '11', tier: 'SMOOTH', speedKmh: 25, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, allowRed: false, coords: unmonitoredEB },
    { company: 'NLB', routeNo: '23', tier: 'CONGESTED', speedKmh: 9, color: '#dc2626', source: 'BUS_API', isRoadSnapped: true, allowRed: false, coords: unmonitoredEB },
    // Opposite carriageway (single isolated slow span -> allowRed=false MUST cap at MODERATE amber, NOT Red!)
    { company: 'NLB', routeNo: '1', tier: 'CONGESTED', speedKmh: 8, color: '#dc2626', source: 'BUS_API', isRoadSnapped: true, allowRed: false, coords: unmonitoredWB },
  ];
  const gridAgg = engine.aggregateBusMicroStepsToCorridors(multiRouteSegs, [], null, { targetStepM: 50 });
  assert.equal(gridAgg.corridors.length, 2, `Expected exactly 2 corridors (1 merged EB + 1 opposite WB), got ${gridAgg.corridors.length}`);
  const ebCorr = gridAgg.corridors.find((c: any) => c.coords[0][1] < c.coords[c.coords.length - 1][1]);
  const wbCorr = gridAgg.corridors.find((c: any) => c.coords[0][1] > c.coords[c.coords.length - 1][1]);
  assert.ok(ebCorr && wbCorr, 'Directional occupancy grid must keep EB and WB carriageways distinct');
  assert.equal(ebCorr.tier, 'SMOOTH', `Median of [28, 25, 9] = 25 km/h must output ONE clean SMOOTH green corridor, got ${ebCorr.tier} (${ebCorr.speedKmh} km/h)`);
  assert.equal(ebCorr.routeCount, 3, 'Merged EB corridor must aggregate all 3 overlapping routes');
  assert.equal(wbCorr.tier, 'MODERATE', `Single isolated slow span (allowRed=false) must NOT render Red; expected MODERATE, got ${wbCorr.tier}`);
  assert.notEqual(wbCorr.color, '#dc2626', 'Isolated slow span must never render red');
});

test('South Lantau / NLB Corridor Coverage, Zoom Persistence (z11-16), and Scheduled Fallback Guardrails', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const t0 = Date.UTC(2026, 10, 27, 4, 0, 0);

  // 1. Lantau-wide zoom (z12): 45 dense Tung Chung routes MUST NOT crowd out South Lantau NLB routes (1, 2, 3M, 4, 11, 23, A35),
  // AND both directions of NLB routes (distinguished by tdBound 'O'/'I' when group.bound is undefined) MUST both be selected!
  const lantauPool: any[] = [];
  for (let i = 0; i < 45; i++) {
    const off = (i % 15) * 0.0007;
    lantauPool.push({
      mode: 'BUS', company: 'LWB', routeNo: `E${100 + i}`, bound: 'O', routeIds: [`LWB_E${100 + i}_O_1`],
      stops: [
        { stopKey: `TC_${i}_0`, stopName_e: 'Tung Chung Station', latitude: String(22.288 + off), longitude: '113.940' },
        { stopKey: `TC_${i}_1`, stopName_e: 'Yu Tung Road', latitude: String(22.288 + off), longitude: '113.948' },
      ],
    });
  }
  const nlbPriorityNos = ['1', '2', '3M', '4', '11', '23', 'A35'];
  nlbPriorityNos.forEach((rNo, idx) => {
    const slat = 22.238 + idx * 0.0012;
    lantauPool.push(
      {
        mode: 'BUS', company: 'NLB', routeNo: rNo, tdBound: 'O', routeIds: [`NLB_${idx * 2 + 1}`], dest_e: 'Mui Wo Ferry Pier',
        stops: [
          { stopKey: `SL_${rNo}_O0`, stopName_e: 'Tong Fuk, South Lantau Road', latitude: String(slat), longitude: '113.930' },
          { stopKey: `SL_${rNo}_O1`, stopName_e: 'Cheung Sha, South Lantau Road', latitude: String(slat + 0.002), longitude: '113.955' },
          { stopKey: `SL_${rNo}_O2`, stopName_e: 'Pui O, South Lantau Road', latitude: String(slat + 0.005), longitude: '113.978' },
          { stopKey: `SL_${rNo}_O3`, stopName_e: 'Mui Wo Ferry Pier', latitude: String(slat + 0.012), longitude: '114.001' },
        ],
      },
      {
        mode: 'BUS', company: 'NLB', routeNo: rNo, tdBound: 'I', routeIds: [`NLB_${idx * 2 + 2}`], dest_e: 'Tung Chung Town Centre',
        stops: [
          { stopKey: `SL_${rNo}_I0`, stopName_e: 'Mui Wo Ferry Pier', latitude: String(slat + 0.012), longitude: '114.001' },
          { stopKey: `SL_${rNo}_I1`, stopName_e: 'Pui O, South Lantau Road', latitude: String(slat + 0.005), longitude: '113.978' },
          { stopKey: `SL_${rNo}_I2`, stopName_e: 'Cheung Sha, South Lantau Road', latitude: String(slat + 0.002), longitude: '113.955' },
          { stopKey: `SL_${rNo}_I3`, stopName_e: 'Tong Fuk, South Lantau Road', latitude: String(slat), longitude: '113.930' },
        ],
      }
    );
  });
  const lantauWideBounds = {
    getSouth: () => 22.21, getNorth: () => 22.32, getWest: () => 113.86, getEast: () => 114.04,
    contains: ([la, lo]: [number, number]) => la >= 22.21 && la <= 22.32 && lo >= 113.86 && lo <= 114.04,
  };
  const pickedWide = engine.selectGlobalBusSpeedRoutes(lantauPool, lantauWideBounds, (g: any) => g.stops, 20);
  const pickedNlb3M = pickedWide.filter((p: any) => p.operator === 'NLB' && p.group.routeNo === '3M');
  assert.equal(pickedNlb3M.length, 2, `Both O and I directions of NLB 3M must be preserved via tdBound, got ${pickedNlb3M.length}`);
  nlbPriorityNos.forEach((rNo) => {
    assert.ok(pickedWide.some((p: any) => p.operator === 'NLB' && p.group.routeNo === rNo),
      `Priority South Lantau NLB route ${rNo} must not be crowded out by Tung Chung at z11-13`);
  });

  // 2. Zoomed-in viewport (z15) cutting across the MIDDLE of Pui O -> Mui Wo span where BOTH stop endpoints lie OUTSIDE the viewport box:
  // selectGlobalBusSpeedRoutes & aggregateBusMicroStepsToCorridors MUST intersect/clip instead of dropping!
  const zoomedMidBox = {
    getSouth: () => 22.245, getNorth: () => 22.249, getWest: () => 113.984, getEast: () => 113.993,
    contains: ([la, lo]: [number, number]) => la >= 22.245 && la <= 22.249 && lo >= 113.984 && lo <= 113.993,
  };
  const singleLongNlb = [lantauPool.find((g) => g.company === 'NLB' && g.routeNo === '3M' && g.tdBound === 'O')];
  const pickedZoomed = engine.selectGlobalBusSpeedRoutes(singleLongNlb, zoomedMidBox, (g: any) => g.stops, 10);
  assert.equal(pickedZoomed.length, 1, 'z15 zoomed viewport intersecting mid-span must NOT drop NLB 3M when endpoints extend outside viewport');
  const zoomedAgg = engine.aggregateBusMicroStepsToCorridors([{
    company: 'NLB', routeNo: '3M', tier: 'SMOOTH', speedKmh: 38, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
    coords: [[22.2430, 113.9780], [22.2500, 114.0010]],
  }], [], null, { bounds: zoomedMidBox, targetStepM: 50, boundsPadFrac: 0.05 });
  assert.ok(zoomedAgg.corridors.length >= 1, 'Micro-step viewport clipper must keep intersecting South Lantau micro-steps at z15');

  // 3. NLB scheduled/headway interval fallback (Green/Yellow ONLY, NEVER Red) + never fabricate speeds when ETA data is missing
  const slStops = singleLongNlb[0].stops;
  const slPoly = slStops.map((s: any) => [parseFloat(s.latitude), parseFloat(s.longitude)]);
  const schedOnlySlowEtas = {
    0: [{ eta: new Date(t0 + 2 * 60000).toISOString(), isSched: true }],
    1: [{ eta: new Date(t0 + 18 * 60000).toISOString(), isSched: true }], // very slow scheduled interval
    2: [{ eta: new Date(t0 + 34 * 60000).toISOString(), isSched: true }],
  };
  const schedSegs = engine.inferBusApiSegmentSpeeds(slStops, schedOnlySlowEtas, slPoly, {
    company: 'NLB', routeNo: '3M', allowNlbScheduledFallback: true, allowSparseBridge: true, nowMs: t0,
  });
  assert.ok(schedSegs.length >= 1, 'NLB sparse scheduled ETA fallback must produce headway-inferred coverage');
  schedSegs.forEach((s: any) => {
    assert.equal(s.isScheduledFallback, true);
    assert.notEqual(s.tier, 'CONGESTED', 'NLB scheduled fallback must NEVER emit CONGESTED / Red');
    assert.notEqual(s.color, '#dc2626', 'NLB scheduled fallback must strictly be Green or Yellow only');
  });

  const missingEtas = { 0: [{ eta: new Date(t0 + 3 * 60000).toISOString() }] }; // only 1 stop has ETA
  const noFabricated = engine.inferBusApiSegmentSpeeds(slStops, missingEtas, slPoly, {
    company: 'NLB', routeNo: '3M', allowNlbScheduledFallback: true, nowMs: t0,
  });
  assert.equal(noFabricated.length, 0, 'Must NEVER fabricate speeds when live/scheduled ETA pairs are missing');

  // 4. Zoom/pan persistence in map.js: already-rendered Bus-API segments stay visible immediately (atomic swap, zero blanking!)
  const mapSrc = readMapBundle();
  let activeLayerCount = 0;
  let everZeroDuringRefresh = false;
  const mockMap: any = {
    _zoom: 12,
    getZoom: () => mockMap._zoom,
    getBounds: () => lantauWideBounds,
    addLayer: () => { activeLayerCount++; },
    removeLayer: () => { activeLayerCount = Math.max(0, activeLayerCount - 1); if (activeLayerCount === 0) everZeroDuringRefresh = true; },
  };
  const mapCtx: any = {
    window: {
      globalTrafficLayerEnabled: true,
      trafficLayerEnabled: true,
      browseMapInstance: mockMap,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __LIVE_TRAFFIC_SPEED_GEOJSON__: null,
      BusSpeedEngine: engine,
      aggregateBusMicroStepsToCorridors: engine.aggregateBusMicroStepsToCorridors,
      selectGlobalBusSpeedRoutes: engine.selectGlobalBusSpeedRoutes,
      inferBusApiSegmentSpeeds: engine.inferBusApiSegmentSpeeds,
      isSegmentCoveredByTdGroundTruth: engine.isSegmentCoveredByTdGroundTruth,
      getBusSpeedLayerColorHex: engine.getBusSpeedColorHex,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: any) => String(s ?? ''),
    L: {
      layerGroup: () => ({
        _layers: [] as any[],
        addLayer(l: any) { this._layers.push(l); },
        eachLayer(fn: any) { this._layers.forEach(fn); },
        clearLayers() { this._layers.length = 0; },
        addTo(m: any) { m.addLayer(this); return this; },
      }),
      polyline: (c: any, opts: any) => ({
        coords: c, options: opts,
        addTo(g: any) { g.addLayer(this); return this; },
        bindTooltip() { return this; },
        bringToFront() { return this; },
      }),
    },
    setTimeout, clearTimeout, console, Math, Date, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(mapSrc, mapCtx);
  mapCtx.window.globalTrafficLayerEnabled = true;
  mapCtx.window.__GLOBAL_BUS_SPEED_SEGMENTS_BY_ROUTE__.set('NLB|3M|O|1', {
    ts: Date.now(),
    routeLabel: 'NLB 3M',
    segs: [{
      company: 'NLB', routeNo: '3M', tier: 'SMOOTH', speedKmh: 38, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
      coords: [[22.2430, 113.9780], [22.2500, 114.0010]],
    }],
  });
  mapCtx.renderGlobalBusSpeedOverlay(mockMap);
  assert.equal(activeLayerCount, 1, 'Initial render must mount Bus-API layer group');
  everZeroDuringRefresh = false;
  mockMap._zoom = 15;
  mapCtx.renderGlobalBusSpeedOverlay(mockMap);
  assert.equal(everZeroDuringRefresh, false, 'Zoom/pan refresh must NEVER blank/drop rendered Bus-API layer to 0 before swapping in the new layer');
  assert.equal(activeLayerCount, 1, 'Exactly one atomic Bus-API layer group must remain mounted after zoom refresh');
});

test('Side-Road <=45m Highway Leakage Blocking (Kam Ho Rd / Castle Peak Rd), Terminus Exclusion, Single Source of Truth + Working Details Breakdown, & Vivid Detail Route Z-Order', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const t0 = Date.UTC(2026, 10, 27, 5, 0, 0);

  // 1. Tsing Long Highway (82 km/h) 60m laterally off Kam Ho Road (E36 Stops 24 & 25) MUST be blocked on non-highway side streets!
  const kamHoStops = [
    { stopKey: 'KH22', seq: 22, stopName_e: 'Tai Lam Tunnel Bus Interchange', name_tc: '大欖隧道轉車站', latitude: '22.4180', longitude: '114.0630' },
    { stopKey: 'KH23', seq: 23, stopName_e: 'Pat Heung Road', name_tc: '八鄉路', latitude: '22.4290', longitude: '114.0640' },
    { stopKey: 'KH24', seq: 24, stopName_e: 'Kam Ho Road (Stop 24)', name_tc: '錦河路', latitude: '22.4330', longitude: '114.0645' },
    { stopKey: 'KH25', seq: 25, stopName_e: 'Kam Ho Road (Stop 25)', name_tc: '錦河路', latitude: '22.4368', longitude: '114.0645' },
    { stopKey: 'KH26', seq: 26, stopName_e: 'Pat Heung Road Bus Terminus', name_tc: '八鄉路總站', latitude: '22.4402', longitude: '114.0645' },
  ];
  const kamHoPoly = kamHoStops.map((s) => [parseFloat(s.latitude), parseFloat(s.longitude)]);
  const tsingLongDet = [{
    id: 'TDSTLH10001',
    lat: 22.4349,
    lon: 114.0651, // ~62m east of Kam Ho Road
    rot: 0,
    spd: 82,
    occ: 12,
    tier: 'SMOOTH',
    roadEn: 'Tsing Long Highway Northbound',
    roadTc: '青朗公路北行',
    camKey: 'NL301',
  }];
  // Even if placed 25m away, road-name incompatibility + expressway blocking MUST block Tsing Long Highway on Kam Ho Rd!
  const tsingLongCloseDet = [{ ...tsingLongDet[0], lon: 114.0647 }];
  const kamHoMatch = engine.matchTdGroundTruthForSpan(
    [[22.4330, 114.0645], [22.4368, 114.0645]],
    tsingLongCloseDet,
    [],
    { fromStop: kamHoStops[2], toStop: kamHoStops[3] }
  );
  assert.equal(kamHoMatch.hasTd, false, 'Tsing Long Highway (82 km/h) must NEVER leak onto Kam Ho Road Stops 24-25');

  // Same check for Tuen Mun Road / Yuen Long Highway leaking onto Castle Peak Road side street
  const cprStops = [
    { stopKey: 'CPR1', seq: 1, stopName_e: 'San Hui, Castle Peak Road', name_tc: '青山公路新墟', latitude: '22.3980', longitude: '113.9770' },
    { stopKey: 'CPR2', seq: 2, stopName_e: 'Prime View, Castle Peak Road', name_tc: '青山公路景峰', latitude: '22.4025', longitude: '113.9770' },
  ];
  const tmrLeakDet = [{ id: 'TDSTMR_NB', lat: 22.4002, lon: 113.9773, rot: 0, spd: 78, occ: 10, tier: 'SMOOTH', roadEn: 'Tuen Mun Road Northbound', roadTc: '屯門公路北行' }];
  const cprMatch = engine.matchTdGroundTruthForSpan(
    [[22.3980, 113.9770], [22.4025, 113.9770]],
    tmrLeakDet,
    [],
    { fromStop: cprStops[0], toStop: cprStops[1] }
  );
  assert.equal(cprMatch.hasTd, false, 'Tuen Mun Road must NEVER leak onto Castle Peak Road local stops');

  // buildRouteSpeedGeoJson with stops must also reject Tsing Long Highway on Kam Ho Road
  const kamHoGeo = sb.ctx.window.buildRouteSpeedGeoJson(kamHoPoly.slice(2, 4), tsingLongDet, {
    isRoadSnapped: true,
    stops: kamHoStops.slice(2, 4),
    noDataColor: '#FF3B30',
  });
  assert.equal(kamHoGeo.features.some((f: any) => f.properties?.detectorId === 'TDSTLH10001'), false,
    'buildRouteSpeedGeoJson must NOT leak Tsing Long Highway onto Kam Ho Road');

  // 2. Final terminus-approach span (Stop 25 -> Stop 26 Pat Heung Road Bus Terminus) excluded from false "Slow Bus Flow" warnings!
  const kamHoEtas = {
    2: [{ eta: new Date(t0 + 2 * 60000).toISOString() }],
    3: [{ eta: new Date(t0 + 3.4 * 60000).toISOString() }], // ~18 km/h urban SMOOTH (Flowing!)
    4: [{ eta: new Date(t0 + 8.4 * 60000).toISOString() }], // 5 min terminus arrival padding into Pat Heung Rd Terminus (~4.5 km/h raw)!
  };
  const kamHoBusSegs = engine.inferBusApiSegmentSpeeds(kamHoStops, kamHoEtas, kamHoPoly, {
    tdDetectors: tsingLongDet,
    routeNo: 'E36',
    company: 'LWB',
    nowMs: t0,
  });
  const termSpan = kamHoBusSegs.find((s: any) => s.toIdx === 4);
  assert.ok(termSpan, 'Terminus-approach span should be tracked');
  assert.equal(termSpan.isTerminusApproach, true, 'Final span into Pat Heung Road Bus Terminus must be flagged isTerminusApproach');
  assert.equal(termSpan.tier, 'SMOOTH', 'Terminus-approach arrival padding must NOT trigger false Slow/Heavy Bus Flow warning');
  assert.ok(bsWindow.__BUS_SPEED_DEBUG__.skipReasons.some((r: any) => r.reason === 'terminus_span'),
    '__BUS_SPEED_DEBUG__.skipReasons must record terminus_span suppression');

  // 3. Single Source of Truth: stop-row pill (green Flowing at 18 km/h urban) & expanded card banner NEVER contradict!
  const unifiedKamHo = engine.buildStopByStopSegmentTraffic(kamHoStops, kamHoPoly, tsingLongDet, [], kamHoBusSegs, {});
  assert.equal(unifiedKamHo[2].source, 'BUS_API', 'Kam Ho Rd Stop 24->25 must use BUS_API (Tsing Long Hwy blocked)');
  assert.equal(unifiedKamHo[2].tier, 'SMOOTH', 'Stop 24->25 pill must be green Flowing (SMOOTH)');
  const roadSumStop24 = sb.getDirectionalRoadSummary(kamHoStops, 2, tsingLongDet, false, 40, kamHoPoly, 12000, [], {
    busSpeedSegments: kamHoBusSegs,
    unifiedSegments: unifiedKamHo,
  });
  assert.ok(roadSumStop24, 'Expected road summary from unified segment array');
  assert.equal(roadSumStop24.tone, 'smooth', `Expanded card banner MUST match green Flowing pill (smooth), got ${roadSumStop24.tone}: ${roadSumStop24.headline}`);
  assert.ok(Array.isArray(roadSumStop24.stopBreakdownSegments) && roadSumStop24.stopBreakdownSegments.length >= 1,
    'getDirectionalRoadSummary must expose stopBreakdownSegments for inline Details > breakdown');

  // 4. Unified Journey Strip in generateExpandedETAsHtml (replaces legacy vertical breakdown list) + toggleTrafficInlineBreakdown helper intact
  const html = readAppBundle();
  assert.ok(html.includes('unifiedSegments: unifiedSegs'), 'generateExpandedETAsHtml must pass unifiedSegments into getDirectionalRoadSummary');
  assert.ok(html.includes('class="traffic-journey-bar-wrap') && html.includes('traffic-journey-alert-head'),
    'generateExpandedETAsHtml must fold traffic alerts directly into the unified Journey Strip header');
  assert.ok(!html.includes('traffic-segment-list') && !html.includes('traffic-segment-row') && !html.includes('traffic-approaching-strip'),
    'Must preserve decluttered card contract without legacy clutter classes');

  const toggleMatch = html.match(/window\.toggleTrafficInlineBreakdown = function\([\s\S]*?\n\};/);
  assert.ok(toggleMatch, 'index.html must define window.toggleTrafficInlineBreakdown');
  const mockPanel = { style: { display: 'none' } };
  const mockCta = { textContent: 'Details ›' };
  const mockAttrs: Record<string, string> = { 'aria-expanded': 'false' };
  const mockTrigger = {
    setAttribute: (k: string, v: string) => { mockAttrs[k] = v; },
    querySelector: () => mockCta,
  };
  const toggleCtx: any = {
    window: {},
    document: { getElementById: (id: string) => (id === 'traffic-inline-breakdown-2' ? mockPanel : null) },
  };
  vm.createContext(toggleCtx);
  vm.runInContext(toggleMatch[0], toggleCtx);
  const opened = toggleCtx.window.toggleTrafficInlineBreakdown(2, mockTrigger);
  assert.equal(opened, true, 'First tap on Details > must open inline breakdown');
  assert.equal(mockPanel.style.display, 'block');
  assert.equal(mockAttrs['aria-expanded'], 'true');
  assert.equal(mockCta.textContent, 'Details ⌄');
  const closed = toggleCtx.window.toggleTrafficInlineBreakdown(2, mockTrigger);
  assert.equal(closed, false, 'Second tap on Details > must collapse inline breakdown');
  assert.equal(mockPanel.style.display, 'none');
  assert.equal(mockAttrs['aria-expanded'], 'false');

  // 5. buildDetailBusPolylineLayer vivid stroke (weight 4, opacity 0.95) strictly ordered ABOVE #0f172a casing via _bringLayerGroupToFront
  const mapSrc = readMapBundle();
  const frontOrder: string[] = [];
  const zCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [],
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: (items: any[] = []) => ({
        _items: items,
        eachLayer(fn: any) { this._items.forEach(fn); },
      }),
      polyline: (c: any, opts: any) => ({
        coords: c,
        options: { ...opts },
        bringToFront() { frontOrder.push(`poly:${this.options.color}:z${this.options._zRank}`); },
      }),
      geoJSON: (data: any, opts: any) => {
        const subLayers = data.features.map((f: any) => {
          const st = opts.style(f);
          const lyr: any = {
            options: { ...st },
            bindTooltip() {},
            on() {},
            bringToFront() { frontOrder.push(`geo:${this.options.color}:op${this.options.opacity}:w${this.options.weight}:z${this.options._zRank}`); },
          };
          if (opts.onEachFeature) opts.onEachFeature(f, lyr);
          return lyr;
        });
        return { eachLayer(fn: any) { subLayers.forEach(fn); } };
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(zCtx);
  vm.runInContext(mapSrc, zCtx);
  const airportCoords = [[22.3080, 113.9185], [22.3120, 113.9260], [22.3160, 113.9340]];
  const detailLayer = zCtx.buildDetailBusPolylineLayer(airportCoords, [], 0, '#FF3B30');
  zCtx._bringLayerGroupToFront(detailLayer);
  assert.equal(frontOrder.length, 2, 'Expected dark casing + BUS_EST smooth green top stroke');
  assert.ok(frontOrder[0].startsWith('poly:#0f172a:z0'), `Casing (#0f172a, z0) must be brought forward FIRST (underneath), got ${frontOrder[0]}`);
  assert.equal(frontOrder[1], 'geo:#16a34a:op0.88:w4.5:z1', `TD-blind route top stroke MUST paint BUS_EST Smooth Green (#16a34a, opacity 0.88, weight 4.5, z1 — NEVER Blue or Red) LAST on top of casing, got ${frontOrder[1]}`);
});

test('Inspectable __BUS_SPEED_DEBUG__ Telemetry, Viewport TD vs Bus-API Counts, Silent SW Auto-Update & Clean Hardcode Config', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const t0 = Date.UTC(2026, 10, 27, 6, 0, 0);

  // 1. Trigger skip reasons: outside_viewport, covered_by_td, terminus_span, and no_live_eta_pairs
  const viewBounds = {
    getSouth: () => 22.23, getNorth: () => 22.27, getWest: () => 113.94, getEast: () => 114.01,
    contains: ([la, lo]: [number, number]) => la >= 22.23 && la <= 22.27 && lo >= 113.94 && lo <= 114.01,
  };
  const routePool = [
    // Outside viewport (Tsuen Wan) -> outside_viewport
    { mode: 'BUS', company: 'KMB', routeNo: '40', bound: 'O', routeIds: ['KMB_40_O_1'], stops: [
      { stopKey: 'TW1', stopName_e: 'Tsuen Wan', latitude: '22.372', longitude: '114.115' },
      { stopKey: 'TW2', stopName_e: 'Kwai Chung', latitude: '22.365', longitude: '114.125' },
    ] },
    // In viewport (South Lantau)
    { mode: 'BUS', company: 'NLB', routeNo: '3M', tdBound: 'O', routeIds: ['NLB_3M_1'], stops: [
      { stopKey: 'SL1', stopName_e: 'Pui O', latitude: '22.243', longitude: '113.978' },
      { stopKey: 'SL2', stopName_e: 'Mui Wo', latitude: '22.264', longitude: '114.000' },
    ] },
  ];
  engine.selectGlobalBusSpeedRoutes(routePool, viewBounds, (g: any) => g.stops, 10);
  assert.ok(bsWindow.__BUS_SPEED_DEBUG__, 'busspeed.js must populate window.__BUS_SPEED_DEBUG__');
  assert.ok(bsWindow.__BUS_SPEED_DEBUG__.selectedRoutes.length >= 1, '__BUS_SPEED_DEBUG__.selectedRoutes must record selected routes');
  assert.ok(bsWindow.__BUS_SPEED_DEBUG__.skipReasons.some((r: any) => r.reason === 'outside_viewport'),
    '__BUS_SPEED_DEBUG__.skipReasons must log outside_viewport');

  // Empty live ETAs -> no_live_eta_pairs
  engine.inferBusApiSegmentSpeeds(routePool[1].stops, { 0: [] }, [[22.243, 113.978], [22.264, 114.000]], {
    company: 'NLB', routeNo: '3M', nowMs: t0,
  });
  assert.ok(bsWindow.__BUS_SPEED_DEBUG__.skipReasons.some((r: any) => r.reason === 'no_live_eta_pairs'),
    '__BUS_SPEED_DEBUG__.skipReasons must log no_live_eta_pairs');

  // 2. Verify accurate viewport counts of active TD segments vs Bus-API inferred segments via map.js telemetry
  const mapSrc = readMapBundle();
  const mockBrowseMap = {
    getZoom: () => 13,
    getBounds: () => viewBounds,
    addLayer() {},
    removeLayer() {},
  };
  const tdViewportGeo = {
    type: 'FeatureCollection',
    features: [
      // Inside viewport
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113.945, 22.260], [113.952, 22.262]] }, properties: { id: 'TD_IN_1', spd: 65, color: '#22c55e', roadEn: 'North Lantau Link' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113.953, 22.262], [113.960, 22.264]] }, properties: { id: 'TD_IN_2', spd: 58, color: '#22c55e', roadEn: 'North Lantau Link' } },
      // Outside viewport (Kowloon)
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[114.170, 22.310], [114.175, 22.315]] }, properties: { id: 'TD_OUT_1', spd: 32, color: '#f59e0b', roadEn: 'Nathan Road' } },
    ],
  };
  const telCtx: any = {
    window: {
      globalTrafficLayerEnabled: true,
      trafficLayerEnabled: true,
      browseMapInstance: mockBrowseMap,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __LIVE_TRAFFIC_SPEED_GEOJSON__: tdViewportGeo,
      __LAST_GLOBAL_SPEED_GEOJSON__: tdViewportGeo,
      BusSpeedEngine: engine,
      aggregateBusMicroStepsToCorridors: engine.aggregateBusMicroStepsToCorridors,
      getBusSpeedLayerColorHex: engine.getBusSpeedColorHex,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: any) => String(s ?? ''),
    L: {
      layerGroup: () => ({ addLayer() {}, eachLayer() {}, clearLayers() {}, addTo() { return this; } }),
      polyline: () => ({ options: {}, addTo() { return this; }, bindTooltip() { return this; }, bringToFront() { return this; } }),
    },
    setTimeout, clearTimeout, console, Math, Date, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(telCtx);
  vm.runInContext(mapSrc, telCtx);
  telCtx.window.globalTrafficLayerEnabled = true;
  telCtx.window.__GLOBAL_BUS_SPEED_SEGMENTS__ = [
    // Inside viewport, unmonitored South Lantau
    { company: 'NLB', routeNo: '3M', tier: 'SMOOTH', speedKmh: 38, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, coords: [[22.243, 113.978], [22.250, 113.990]] },
    // Covered by TD_IN_1 -> suppressed as covered_by_td!
    { company: 'NLB', routeNo: 'A35', tier: 'SMOOTH', speedKmh: 45, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, coords: [[22.260, 113.945], [22.262, 113.952]] },
  ];
  telCtx._repaintGlobalBusSpeedFromStore(mockBrowseMap);
  const tel = telCtx.window.getTrafficViewportTelemetry(mockBrowseMap);
  assert.equal(tel.trafficEnabled, true);
  assert.equal(tel.activeTdSegments, 2, `Expected 2 active TD segments inside viewport (excluding Kowloon TD_OUT_1), got ${tel.activeTdSegments}`);
  assert.equal(tel.activeBusApiSegments, 1, `Expected 1 active Bus-API corridor inside viewport (after TD suppression), got ${tel.activeBusApiSegments}`);
  assert.ok(tel.suppressedByTdMicroSteps > 0, 'Must accurately track micro-steps suppressed by TD ground truth');
  assert.equal(telCtx.window.__BUS_SPEED_DEBUG__.viewportCounts.activeTdSegments, 2);
  assert.equal(telCtx.window.__BUS_SPEED_DEBUG__.viewportCounts.activeBusApiSegments, 1);

  // Turning Traffic OFF zeroes active viewport counts
  telCtx.window.globalTrafficLayerEnabled = false;
  const telOff = telCtx.window.getTrafficViewportTelemetry(mockBrowseMap);
  assert.equal(telOff.activeTdSegments, 0);
  assert.equal(telOff.activeBusApiSegments, 0);

  // 3. Silent PWA auto-update execution in VM & clean hardcode.js config (no HKFX / hkway.pages.dev)
  const swSrc = fs.readFileSync('public/sw.js', 'utf8');
  const hardcodeSrc = readHardcodeBundle();
  assert.ok(!/\bHKFX\b/i.test(hardcodeSrc), 'public/hardcode.js must not contain HKFX entries');
  assert.ok(!/hkway\.pages\.dev/i.test(hardcodeSrc), 'public/hardcode.js must not contain self-referential hkway.pages.dev entries');

  const swEvents: Record<string, Function> = {};
  const swOrder: string[] = [];
  const deletedCaches: string[] = [];
  const swSelf: any = {
    addEventListener: (ev: string, fn: Function) => { swEvents[ev] = fn; },
    skipWaiting: () => { swOrder.push('skipWaiting'); return Promise.resolve(); },
    clients: { claim: () => { swOrder.push('clients.claim'); return Promise.resolve(); } },
    location: { origin: 'https://dev.hkway.pages.dev' },
  };
  const swSandbox: any = {
    self: swSelf,
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => ['hkway-shell-v1', 'legacy-cache-old', 'hkway-shell-v43-silent-auto-update'],
      delete: async (k: string) => { deletedCaches.push(k); swOrder.push(`delete:${k}`); return true; },
    },
    URL, Promise, Response, console,
  };
  vm.createContext(swSandbox);
  vm.runInContext(swSrc, swSandbox);
  swEvents.install({ waitUntil: () => {} });
  assert.ok(swOrder.includes('skipWaiting'), 'SW install must immediately call self.skipWaiting()');
  let activatePromise: Promise<any> = Promise.resolve();
  swEvents.activate({ waitUntil: (p: Promise<any>) => { activatePromise = p; } });
  return activatePromise.then(() => {
    assert.ok(deletedCaches.includes('hkway-shell-v1') && deletedCaches.includes('legacy-cache-old'),
      `SW activate must purge ALL outdated cache keys, deleted=${deletedCaches.join(',')}`);
    assert.ok(swOrder.indexOf('delete:legacy-cache-old') < swOrder.indexOf('clients.claim'),
      'SW activate must finish purging outdated caches BEFORE calling self.clients.claim()');
    swOrder.length = 0;
    swEvents.message({ data: { type: 'SKIP_WAITING' } });
    assert.ok(swOrder.includes('skipWaiting'), 'SW message listener must retain SKIP_WAITING support');
  });
});

test('Follow-up Fix 1: E36 rejects off-route TMR/Brilliant Garden/Fung Tei/Siu Hong & Kong Sham Western Hwy, enforces <=60m/<=45deg road-snapped matching, fixes Souththbound typo, and renders interactive Board->Terminus journey bar', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  const mapSrc = readMapBundle();
  const html = readAppBundle();

  // 1. E36 off-route leaks (TDS91037 TMR/Brilliant Garden-SB, Fung Tei, Siu Hong & TDS91040 YLH/Kong Sham Western Hwy-WB)
  const e36Stops = [
    { stopKey: 'E36_1', seq: 1, stopName_e: 'Pat Heung Road', name_tc: '八鄉路', latitude: '22.4206', longitude: '114.0625' },
    { stopKey: 'E36_2', seq: 2, stopName_e: 'Kam Ho Road', name_tc: '錦河路', latitude: '22.4249', longitude: '114.0666' },
    { stopKey: 'E36_3', seq: 3, stopName_e: 'Grand Mayfair', name_tc: '柏瓏', latitude: '22.4339', longitude: '114.0623' },
    { stopKey: 'E36_15', seq: 15, stopName_e: 'Yuen Long Park', name_tc: '元朗公園', latitude: '22.4441', longitude: '114.0188' },
    { stopKey: 'E36_16', seq: 16, stopName_e: 'Tuen Mun Chek Lap Kok Tunnel BBI', name_tc: '屯門赤鱲角隧道轉車站', latitude: '22.3686', longitude: '113.9486' },
    { stopKey: 'E36_25', seq: 25, stopName_e: 'Airport', name_tc: '機場地面運輸中心', latitude: '22.3126', longitude: '113.9375' },
  ];
  const offRouteDets = [
    { id: 'TDS91037', lat: 22.4063, lon: 113.9837, rot: 220, spd: 12, occ: 92, tier: 'JAMMED', roadEn: 'TMR/Brilliant Garden-SB (Souththbound)', roadTc: '屯門公路近寶怡花園-南行', camKey: 'TM110F' },
    { id: 'TDS_FT', lat: 22.4110, lon: 113.9790, rot: 220, spd: 14, occ: 88, tier: 'JAMMED', roadEn: 'Tuen Mun Road near Fung Tei - Souththbound', roadTc: '屯門公路近鳳地-南行' },
    { id: 'TDS_SH', lat: 22.4130, lon: 113.9780, rot: 220, spd: 15, occ: 85, tier: 'JAMMED', roadEn: 'Tuen Mun Road near Siu Hong - Southbound', roadTc: '屯門公路近兆康-南行' },
    { id: 'TDS91040', lat: 22.4441, lon: 114.0185, rot: 265, spd: 11, occ: 94, tier: 'JAMMED', roadEn: 'YLH/Kong Sham Western Hwy-WB', roadTc: '元朗公路近港深西部公路-西行', camKey: 'YL102F' },
  ];
  const straightChord = [[22.4441, 114.0188], [22.3686, 113.9486]];
  const chordMatch = engine.matchTdGroundTruthForSpan(straightChord, offRouteDets, [], {
    fromStop: e36Stops[3], toStop: e36Stops[4], isRoadSnapped: false, routeNo: 'E36', stops: e36Stops,
  });
  assert.equal(chordMatch.hasTd, false, 'Bare distant straight chord between Yuen Long Park & TM-CLK BBI must NEVER attach highway detectors');

  // Even on a road-snapped polyline passing directly past those coords, E36 MUST reject TDS91037/TMR/Fung Tei/Siu Hong & TDS91040/Kong Sham Western Hwy!
  const fakeSnappedNearLeaks = [[22.4441, 114.0188], [22.4441, 114.0185], [22.4063, 113.9837], [22.3686, 113.9486]];
  const leakMatch = engine.matchTdGroundTruthForSpan(fakeSnappedNearLeaks, offRouteDets, [], {
    fromStop: e36Stops[3], toStop: e36Stops[4], isRoadSnapped: true, routeNo: 'E36', stops: e36Stops,
  });
  assert.equal(leakMatch.hasTd, false, 'E36 must NEVER attach TDS91037 (TMR/Brilliant Garden/Fung Tei/Siu Hong) or TDS91040 (Kong Sham Western Hwy)');

  const roadSumE36 = sb.getDirectionalRoadSummary(e36Stops, 3, offRouteDets, false, 40, fakeSnappedNearLeaks, 12000, [], { routeNo: 'E36' });
  assert.equal(roadSumE36, null, 'Off-route TMR & Kong Sham Western Hwy jams must NEVER trigger Switch to MTR alerts on E36');

  // 2. <= 60 m highway lateral cap, <= 45 deg bearing alignment, & fork overshoot guard (t > 1.02)
  const hwyPoly = [[22.3600, 114.0600], [22.3650, 114.0600], [22.3700, 114.0600]]; // due North (0°)
  const det85mAway = [{ id: 'TLH_FAR', lat: 22.3650, lon: 114.06085, rot: 0, spd: 72, occ: 10, tier: 'SMOOTH', roadEn: 'Tsing Long Highway NB' }]; // ~87m east (>60m)
  const det55degOff = [{ id: 'TLH_ANG', lat: 22.3650, lon: 114.0601, rot: 55, spd: 72, occ: 10, tier: 'SMOOTH', roadEn: 'Tsing Long Highway NB' }]; // >45°
  const detPastFork = [{ id: 'TLH_FORK', lat: 22.3703, lon: 114.0600, rot: 0, spd: 18, occ: 85, tier: 'JAMMED', roadEn: 'Tsing Long Highway NB' }]; // past end (t > 1.02)
  const detOnRoute = [{ id: 'TLH_OK', lat: 22.3650, lon: 114.0602, rot: 12, spd: 74, occ: 12, tier: 'SMOOTH', roadEn: 'Tsing Long Highway NB' }]; // ~20m, 12°
  assert.equal(engine.matchTdGroundTruthForSpan(hwyPoly, det85mAway, [], { isHighwaySpan: true, isRoadSnapped: true }).hasTd, false, 'Detector >60m laterally off road-snapped highway polyline must be rejected');
  assert.equal(engine.matchTdGroundTruthForSpan(hwyPoly, det55degOff, [], { isHighwaySpan: true, isRoadSnapped: true }).hasTd, false, 'Detector >45° bearing off corridor must be rejected');
  assert.equal(engine.matchTdGroundTruthForSpan(hwyPoly, detPastFork, [], { isHighwaySpan: true, isRoadSnapped: true }).hasTd, false, 'Detector past highway fork/turn-off endpoint (t > 1.02) must be rejected');
  assert.equal(engine.matchTdGroundTruthForSpan(hwyPoly, detOnRoute, [], { isHighwaySpan: true, isRoadSnapped: true }).hasTd, true, 'Verified on-route detector within <=60m and <=45° must match');

  // 3. E36 Stop 2 Kam Ho Road -> Stop 3 Grand Mayfair (~1.35km) must NOT flip isHighwaySpan and pull Tsing Long Highway (113 km/h)
  const kamHoGrandPoly = [[22.4249, 114.0666], [22.4295, 114.0645], [22.4339, 114.0623]];
  const tlh113Det = [{ id: 'TLH_113', lat: 22.4295, lon: 114.0647, rot: 340, spd: 113, occ: 8, tier: 'SMOOTH', roadEn: 'Tsing Long Highway - Northbound' }];
  const kamHoGrandMatch = engine.matchTdGroundTruthForSpan(kamHoGrandPoly, tlh113Det, [], {
    fromStop: e36Stops[1], toStop: e36Stops[2], roadDistKm: 1.35, isRoadSnapped: true, routeNo: 'E36', stops: e36Stops,
  });
  assert.equal(kamHoGrandMatch.hasTd, false, 'Kam Ho Road -> Grand Mayfair must NOT leak Tsing Long Highway 113 km/h');

  // 4. "Souththbound" -> "Southbound" typo fix across busspeed.js, hardcode.js, and map.js
  assert.equal(engine.sanitizeDirectionTypos('Tuen Mun Road - Souththbound'), 'Tuen Mun Road - Southbound');
  assert.equal(sb.ctx._sanitizeDirectionTyposHardcode('Castle Peak Rd - Souththbound'), 'Castle Peak Rd - Southbound');
  const fitBoundsCalls: any[] = [];
  const modalOpened: number[] = [];
  const mapCtx: any = {
    window: {
      __DETAIL_STOP_SEGMENTS__: [{ fromIdx: 3, toIdx: 4, tier: 'SMOOTH', source: 'TD', coords: hwyPoly }],
      openStopSegmentTrafficModal: (idx: number) => modalOpened.push(idx),
    },
    document: { getElementById: () => null },
    L: {
      polyline: (c: any, o: any) => ({ c, o }),
      layerGroup: (items: any[]) => ({ items, addTo() { return this; } }),
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(mapSrc, mapCtx);
  mapCtx.window.mapInstance = {
    fitBounds: (c: any, o: any) => fitBoundsCalls.push({ c, o }),
    removeLayer: () => {},
  };
  assert.equal(mapCtx.sanitizeBottleneckLabel('Tuen Mun Rd - Souththbound'), 'Tuen Mun Rd - Southbound');
  assert.equal(mapCtx.matchDetectorToRouteCorridor(offRouteDets[0], fakeSnappedNearLeaks, true, null, true, 'E36', 'LWB_E36_O').matched, false,
    'map.js matchDetectorToRouteCorridor must reject TDS91037 on E36');
  assert.equal(mapCtx.matchDetectorToRouteCorridor(offRouteDets[3], fakeSnappedNearLeaks, true, null, true, 'E36', 'LWB_E36_O').matched, false,
    'map.js matchDetectorToRouteCorridor must reject TDS91040 on E36');

  // 5. Horizontal Board -> Terminus journey bar in index.html & working focusJourneySegmentOnDetailMap
  assert.ok(html.includes('class="traffic-journey-bar-wrap') && html.includes('class="traffic-journey-bar"') && html.includes('class="traffic-journey-seg tone-'),
    'Expanded stop card must render compact horizontal Board -> Terminus journey bar');
  assert.ok(html.includes('focusJourneySegmentOnDetailMap('), 'Journey bar leg pills must wire to focusJourneySegmentOnDetailMap');
  assert.ok(!html.includes('traffic-segment-list') && !html.includes('traffic-segment-row') && !html.includes('traffic-approaching-strip'),
    'Must keep banned legacy classes absent');
  mapCtx.window.focusJourneySegmentOnDetailMap(3);
  assert.equal(fitBoundsCalls.length, 1, 'Tapping journey bar leg must pan/fit detail map to highlighted segment');
  assert.deepEqual(modalOpened, [3], 'Tapping journey bar leg must inspect segment status/cam modal');
});

test('Follow-up Fix 2: Clean qualitative Flowing/Slow/Heavy pills (no raw car km/h in stop pills), >=40 km/h ALWAYS Flowing (no amber 52 km/h), Math.abs guard, and eta_rounding_artifact', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const html = readAppBundle();
  const mapSrc = readMapBundle();

  // 1. >= 40 km/h on expressways/trunk roads is ALWAYS Flowing (SMOOTH / Green), fixing false amber 52 km/h!
  assert.equal(engine.normalizeTrafficTier('SLOW', 52), 'SMOOTH', '52 km/h tagged SLOW by worker must normalize to SMOOTH');
  assert.equal(engine.normalizeTrafficTier('MODERATE', 40), 'SMOOTH', '40 km/h must normalize to SMOOTH');
  const sum52 = sb.ctx.summarizeDetectorBucket([{ det: { id: 'D52', spd: 52, occ: 42, tier: 'SLOW', roadEn: 'Yuen Long Hwy' }, aheadKm: 1.2 }]);
  assert.equal(sum52.status, 'SMOOTH', '52 km/h detector with 42% occ must classify SMOOTH (Flowing), NEVER amber SLOW');
  assert.equal(sum52.estDelayMins, 0, '52 km/h flowing expressway must report 0 delay');
  assert.equal(sb.ctx._normalizeBottleneckTier('SLOW', 52), 'SMOOTH');

  const mapCtx: any = { window: {}, document: { getElementById: () => null }, console, Math, Number, String, Array, Map, Set, Object };
  vm.createContext(mapCtx);
  vm.runInContext(mapSrc, mapCtx);
  assert.equal(mapCtx.getGlobalTrafficSpeedColorHex(52), '#22c55e', '52 km/h must render green #22c55e');
  assert.equal(mapCtx.getGlobalTrafficSpeedColorHex(40), '#22c55e', '40 km/h must render green #22c55e');

  // 2. Stop-row pills in index.html use clean qualitative labels (Clear / Slow / Jammed) without raw km/h or source jargon
  assert.ok(!html.includes('${Math.round(seg.speedKmh)} km/h · ${srcTag}'), 'Stop-row TD pills must NOT render raw car km/h speeds (73 km/h, 105 km/h, 52 km/h)');
  assert.ok(html.includes("labelTxt = `${dot} ${flowTxt}${seg.camKey ? ' 📷' : ''}`;"), 'Both TD and Bus API stop pills must render clean qualitative labels without source jargon');
  assert.ok(!html.includes('moving at ~${Math.round(opp.spd)} km/h'), 'Ambiguous ~XX km/h text (looks like -59 km/h) must be replaced');
  assert.ok(html.includes('Opposite carriageway is clear.') && html.includes('Opposite carriageway is moving slowly.'), 'Opposite carriageway modal readout must use clean qualitative phrasing without raw km/h clutter');

  // 3. Sub-minute ETA rounding artifact (Δt <= 65s over > 600 m) clamped Flowing + logged as eta_rounding_artifact
  const t0 = Date.UTC(2026, 10, 27, 8, 0, 0);
  const stops = [
    { stopKey: 'S0', stopName_e: 'Stop A', latitude: '22.3500', longitude: '114.0000' },
    { stopKey: 'S1', stopName_e: 'Stop B', latitude: '22.3575', longitude: '114.0000' }, // ~834m (> 600m)
  ];
  const poly = [[22.3500, 114.0000], [22.3525, 114.0000], [22.3550, 114.0000], [22.3575, 114.0000]];
  const roundedEtas = {
    0: [{ eta: new Date(t0 + 2 * 60000).toISOString() }],
    1: [{ eta: new Date(t0 + 3 * 60000).toISOString() }], // Δt = 60s <= 65s over ~834m
  };
  const segs = engine.inferBusApiSegmentSpeeds(stops, roundedEtas, poly, { company: 'KMB', routeNo: '68M', nowMs: t0 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].tier, 'SMOOTH', 'Sub-minute ETA rounding delta (60s over >600m) must classify SMOOTH / Flowing');
  assert.equal(segs[0].isEtaRoundingArtifact, true);
  assert.ok(bsWindow.__BUS_SPEED_DEBUG__.skipReasons.some((r: any) => r.reason === 'eta_rounding_artifact'),
    '__BUS_SPEED_DEBUG__.skipReasons must log eta_rounding_artifact');
});

test('Follow-up Fix 3: Congested standalone TD detector (TDSLFR10002 Wong Chu Rd EB 17 km/h) projects >=250m red road polyline, and unrendered detectors never cause Bus-API mutex blind spots', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const mapSrc = readMapBundle();
  const mapCtx: any = { window: {}, document: { getElementById: () => null }, console, Math, Number, String, Array, Map, Set, Object };
  vm.createContext(mapCtx);
  vm.runInContext(mapSrc, mapCtx);

  const wongChuDet = {
    id: 'TDSLFR10002',
    lat: 22.3872,
    lon: 113.9715,
    rot: 85,
    spd: 17,
    occ: 82,
    tier: 'JAMMED',
    roadEn: 'Wong Chu Road near Hoi Wong Road - Eastbound',
    roadTc: '皇珠路近海皇路 - 東行',
    camKey: 'TM115F',
  };
  const slowDet = {
    id: 'TDS_WCR_SLOW',
    lat: 22.3950,
    lon: 113.9800,
    rot: 90,
    spd: 26,
    occ: 52,
    tier: 'SLOW',
    roadEn: 'Castle Peak Road - Eastbound',
    roadTc: '青山公路 - 東行',
    camKey: 'TM120F',
  };

  // 1. Project congested detectors onto >= 250 m directional polylines when TD Speed Map GeoJSON has a gap
  const projectedGeo = mapCtx.filterAndOffsetGlobalSpeedGeoJson(
    { type: 'FeatureCollection', features: [] },
    15,
    [wongChuDet, slowDet]
  );
  const wongFeat = projectedGeo.features.find((f: any) => f.properties?.id === 'TDSLFR10002');
  const slowFeat = projectedGeo.features.find((f: any) => f.properties?.id === 'TDS_WCR_SLOW');
  assert.ok(wongFeat, 'Standalone congested TD detector TDSLFR10002 (17 km/h) must project onto road polyline');
  assert.equal(wongFeat.properties.isProjectedDetector, true);
  assert.equal(wongFeat.properties.color, '#ef4444', '17 km/h projected detector polyline must render Red (#ef4444)');
  assert.ok(wongFeat.properties.lenM >= 250, `Projected polyline must be >= 250 m, got ${wongFeat.properties.lenM} m`);
  assert.ok(slowFeat && slowFeat.properties.color === '#f59e0b', '26 km/h projected detector polyline must render Amber (#f59e0b)');

  // 2. Unrendered detector point alone (NO rendered TD polyline in speedGeo) MUST NOT suppress Bus-API micro-steps!
  const wongBusSeg = {
    company: 'KMB', routeNo: '59X', tier: 'SMOOTH', speedKmh: 28, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
    coords: [[22.3871, 113.9700], [22.38715, 113.97075], [22.3872, 113.9715], [22.38725, 113.97225], [22.3873, 113.9730]],
  };
  const unrenderedAgg = engine.aggregateBusMicroStepsToCorridors([wongBusSeg], [wongChuDet], { type: 'FeatureCollection', features: [] }, { targetStepM: 50 });
  assert.equal(unrenderedAgg.stats.suppressedByTdMicroSteps, 0, 'Unrendered TD detector point alone must NEVER suppress Bus-API micro-steps');
  assert.ok(unrenderedAgg.corridors.length >= 1, 'Bus-API corridor must remain visible when no rendered TD polyline covers the road');

  // 3. Once the congested detector IS projected into rendered TD GeoJSON, Bus-API micro-steps within 100 m ARE cleanly suppressed!
  const renderedAgg = engine.aggregateBusMicroStepsToCorridors([wongBusSeg], [wongChuDet], projectedGeo, { targetStepM: 50 });
  assert.ok(renderedAgg.stats.suppressedByTdMicroSteps >= 4, 'Rendered projected TD polyline must cleanly suppress overlapping Bus-API micro-steps');
});

test('Follow-up Fix 4: Airport Perimeter operational speeds (20-35 km/h = Flowing Green, Red only if <8 km/h across >=2 consecutive spans) and HZMB Link Road stale/null & viaduct bleed protection', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const mapSrc = readMapBundle();
  const mapCtx: any = { window: {}, document: { getElementById: () => null }, console, Math, Number, String, Array, Map, Set, Object };
  vm.createContext(mapCtx);
  vm.runInContext(mapSrc, mapCtx);

  const t0 = Date.UTC(2026, 10, 27, 9, 0, 0);
  const apStops = [
    { stopKey: 'AP0', stopName_e: 'Chek Lap Kok South Road', name_tc: '赤鱲角南路', latitude: '22.2919', longitude: '113.9284' },
    { stopKey: 'AP1', stopName_e: 'South Perimeter Road, Cathay Pacific Cargo Terminal', name_tc: '南環路國泰貨運站', latitude: '22.2950', longitude: '113.9200' },
    { stopKey: 'AP2', stopName_e: 'Hactl, Chun Wan Road', name_tc: '香港空運貨站駿運路', latitude: '22.2980', longitude: '113.9280' },
    { stopKey: 'AP3', stopName_e: 'Air Mail Centre, Cathay City', name_tc: '空郵中心國泰城', latitude: '22.3020', longitude: '113.9311' },
  ];
  const apProfile = engine.classifyBusRoadClass(0.95, apStops[0], apStops[1]);
  assert.equal(apProfile.roadClass, 'AIRPORT_PERIMETER');
  assert.equal(apProfile.smoothMinKmh, 20);
  assert.equal(apProfile.moderateMinKmh, 8);

  // 1. Operational 22-30 km/h on South Perimeter Road -> MUST be SMOOTH (Flowing Green), NOT Amber!
  const apPoly = [
    [22.2919, 113.9284], [22.2935, 113.9242], [22.2950, 113.9200],
    [22.2965, 113.9240], [22.2980, 113.9280], [22.3000, 113.9295], [22.3020, 113.9311],
  ];
  const normalApEtas = {
    0: [{ eta: new Date(t0 + 1 * 60000).toISOString() }],
    1: [{ eta: new Date(t0 + 3.8 * 60000).toISOString() }], // ~930m in ~168s (~24 km/h moving) -> Flowing Green!
    2: [{ eta: new Date(t0 + 6.5 * 60000).toISOString() }], // ~890m in ~162s (~24 km/h moving) -> Flowing Green!
  };
  const normalApSegs = engine.inferBusApiSegmentSpeeds(apStops, normalApEtas, apPoly, { company: 'LWB', routeNo: 'E36', nowMs: t0 });
  assert.ok(normalApSegs.length >= 2);
  normalApSegs.forEach((s: any) => {
    assert.equal(s.tier, 'SMOOTH', `South Perimeter Road at ${s.speedKmh} km/h must be Flowing Green (SMOOTH), got ${s.tier}`);
  });

  // 2. Single slow 6 km/h span on Airport Perimeter must NOT render Red (requires >=2 consecutive <8 km/h non-terminus spans)
  const singleSlowApEtas = {
    0: [{ eta: new Date(t0 + 1 * 60000).toISOString() }],
    1: [{ eta: new Date(t0 + 12 * 60000).toISOString() }], // ~5.5 km/h single span
    2: [{ eta: new Date(t0 + 14.5 * 60000).toISOString() }], // smooth neighbor
  };
  const singleSlowApSegs = engine.inferBusApiSegmentSpeeds(apStops, singleSlowApEtas, apPoly, { company: 'LWB', routeNo: 'E36', nowMs: t0 });
  assert.notEqual(singleSlowApSegs[0].tier, 'CONGESTED', 'Single slow span on Airport Perimeter must NEVER turn Red');

  // 3. HZMB Hong Kong Link Road stale/null (spd: 0 / null) must NEVER render Red & viaduct must never bleed onto South Perimeter Road
  assert.notEqual(sb.ctx.window.getTrafficSpeedColorHex(0), '#dc2626', 'getTrafficSpeedColorHex(0) must never default to Red');
  assert.notEqual(mapCtx.getGlobalTrafficSpeedColorHex(0), '#ef4444', 'getGlobalTrafficSpeedColorHex(0) must never default to Red');
  const staleHzmbGeo = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113.9200, 22.2950], [113.9240, 22.2950], [113.9280, 22.2950]] }, properties: { id: 'HZMB_0', spd: 0, roadEn: 'HZMB Hong Kong Link Road' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[113.9200, 22.2960], [113.9240, 22.2960], [113.9280, 22.2960]] }, properties: { id: 'HZMB_NULL', spd: null, roadEn: 'HZMB Hong Kong Link Road' } },
    ],
  };
  const filteredHzmb = mapCtx.filterAndOffsetGlobalSpeedGeoJson(staleHzmbGeo, 14, []);
  assert.equal(filteredHzmb.features.length, 0, 'Null or 0 km/h HZMB Hong Kong Link Road features must be dropped, never rendered Red');

  const liveHzmbViaduct = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[113.9200, 22.2950], [113.9240, 22.2950], [113.9280, 22.2950]] },
      properties: { id: 'HZMB_LIVE', spd: 82, rot: 90, roadEn: 'HZMB Hong Kong Link Road Viaduct', roadTc: '港珠澳大橋香港連接路高架' },
    }],
  };
  const groundSouthPerimeterSeg = {
    company: 'LWB', routeNo: 'S1', fromNameEn: 'South Perimeter Road', toNameEn: 'Cathay Pacific Cargo Terminal',
    tier: 'SMOOTH', speedKmh: 28, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
    coords: [[22.2950, 113.9200], [22.2950, 113.9208], [22.2950, 113.9216], [22.2950, 113.9224]],
  };
  const viaductMutexAgg = engine.aggregateBusMicroStepsToCorridors([groundSouthPerimeterSeg], [], liveHzmbViaduct, { targetStepM: 50 });
  assert.equal(viaductMutexAgg.stats.suppressedByTdMicroSteps, 0, 'HZMB elevated viaduct must NOT suppress parallel ground-level South Perimeter Road');
});

test('Follow-up Fix 5: Rejects >120m straight shortcuts in Mui Wo, excludes <=150m departure-terminal layover loops (origin_terminus_span), and merges narrow two-way local roads into one centered line', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const t0 = Date.UTC(2026, 10, 27, 10, 0, 0);

  // 1. Reject/split vertex-to-vertex hop > 120 m lacking intermediate shape points (no diagonal chords across Mui Wo Ferry Pier / Silver River)
  const shortcutPoly = [
    [22.2646, 114.0005],
    [22.2650, 114.0005], // 44m valid road hop
    [22.2672, 114.0022], // ~300m diagonal shortcut across Silver River (>120m!) -> MUST be rejected!
    [22.2676, 114.0022], // 44m valid road hop
  ];
  const steps = engine.subdividePolylineMicroSteps(shortcutPoly, 50, { maxRawHopM: 120 });
  assert.equal(steps.length, 2, `Expected only the 2 valid <=120m hops (shortcut dropped), got ${steps.length}`);
  const shortcutAgg = engine.aggregateBusMicroStepsToCorridors([{
    company: 'NLB', routeNo: '1', fromNameEn: 'Mui Wo Ferry Pier', toNameEn: 'Mui Wo Market',
    tier: 'SMOOTH', speedKmh: 26, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
    coords: shortcutPoly,
  }], [], null, { targetStepM: 50 });
  assert.equal(shortcutAgg.corridors.length, 2, 'Diagonal >120m hop across Silver River must split cleanly into two separate road segments without bridging');

  // 2. Departure-terminal layover loop within 150 m of Mui Wo Ferry Pier excluded from sparse-ETA headway fallback (origin_terminus_span)
  const mwStops = [
    { stopKey: 'MW0', stopName_e: 'Mui Wo Ferry Pier', name_tc: '梅窩碼頭', latitude: '22.2646', longitude: '114.0012' },
    { stopKey: 'MW1', stopName_e: 'Mui Wo Cooked Food Market', name_tc: '梅窩熟食市場', latitude: '22.2653', longitude: '114.0006' }, // ~98m from pier!
    { stopKey: 'MW2', stopName_e: 'Mui Wo Market, Ngan Wan Road', name_tc: '梅窩街市銀灣路', latitude: '22.2674', longitude: '113.9985' },
  ];
  const mwPoly = [[22.2646, 114.0012], [22.2650, 114.0009], [22.2653, 114.0006], [22.2663, 113.9996], [22.2674, 113.9985]];
  const layoverSchedEtas = {
    0: [{ eta: new Date(t0 + 2 * 60000).toISOString(), isSched: true }],
    1: [{ eta: new Date(t0 + 14 * 60000).toISOString(), isSched: true }], // slow layover headway within 150m of origin!
    2: [{ eta: new Date(t0 + 16 * 60000).toISOString(), isSched: true }],
  };
  const mwSegs = engine.inferBusApiSegmentSpeeds(mwStops, layoverSchedEtas, mwPoly, {
    company: 'NLB', routeNo: '1', allowNlbScheduledFallback: true, allowSparseBridge: true, nowMs: t0,
  });
  assert.equal(mwSegs.some((s: any) => s.fromIdx === 0 && s.toIdx === 1), false,
    'Departure-terminal layover loop within 150 m of Mui Wo Ferry Pier must be excluded from sparse-ETA headway fallback');
  assert.ok(bsWindow.__BUS_SPEED_DEBUG__.skipReasons.some((r: any) => r.reason === 'origin_terminus_span'),
    '__BUS_SPEED_DEBUG__.skipReasons must log origin_terminus_span');

  // 3. Narrow two-way local road (Ngan Wan Road / Mui Wo Rural Committee Road): merge opposite bearings (0° vs 180°) into ONE centered corridor!
  const nganWanNB: [number, number][] = [[22.2655, 113.9985], [22.2662, 113.9985], [22.2669, 113.9985], [22.2676, 113.9985]];
  const nganWanSB: [number, number][] = nganWanNB.slice().reverse();
  const narrowAgg = engine.aggregateBusMicroStepsToCorridors([
    { company: 'NLB', routeNo: '1', fromNameEn: 'Ngan Wan Road', toNameEn: 'Mui Wo Market', tier: 'SMOOTH', speedKmh: 28, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, coords: nganWanNB },
    { company: 'NLB', routeNo: '2', fromNameEn: 'Mui Wo Market', toNameEn: 'Ngan Wan Road', tier: 'SMOOTH', speedKmh: 26, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, coords: nganWanSB },
  ], [], null, { targetStepM: 50 });
  assert.equal(narrowAgg.corridors.length, 1, `Narrow two-way Ngan Wan Road opposite bearings must merge into ONE single centered corridor, got ${narrowAgg.corridors.length}`);
  assert.equal(narrowAgg.corridors[0].isCenteredTwoWay, true);
  assert.equal(narrowAgg.corridors[0].routeCount, 2);
});

test('Follow-up Fix 6: Deduplicated operator prefixes in Bus-API tooltips (NLB 1, 2, A35 • Scheduled headway • Flowing) and non-truncating Leaflet .kmb-map-stop-label CSS', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const mapSrc = readMapBundle();
  const html = readAppBundle();

  const boundTooltips: string[] = [];
  const drawCtx: any = {
    window: {
      __LIVE_TRAFFIC_DETECTORS__: [],
      __LAST_GLOBAL_SPEED_GEOJSON__: null,
      __LIVE_TRAFFIC_SPEED_GEOJSON__: null,
      aggregateBusMicroStepsToCorridors: engine.aggregateBusMicroStepsToCorridors,
      getBusSpeedLayerColorHex: engine.getBusSpeedColorHex,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: () => ({ addLayer() {}, clearLayers() {} }),
      polyline: (c: any, o: any) => ({
        c, o,
        addTo() { return this; },
        bindTooltip(txt: string) { boundTooltips.push(txt); return this; },
      }),
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(drawCtx);
  vm.runInContext(mapSrc, drawCtx);

  // 1. Operator prefix deduplication & natural route sorting
  assert.equal(drawCtx.window.formatDeduplicatedRoutesLabel(['NLB 1', 'NLB A35', 'NLB 2']), 'NLB 1, 2, A35');
  assert.equal(drawCtx.window.formatDeduplicatedRoutesLabel(['KMB 52X', 'KMB 61M', 'LWB E36']), 'KMB 52X, 61M · LWB E36');

  // 2. Scheduled headway tooltip renders clean deduplicated qualitative text with zero raw km/h
  const mwRoad: [number, number][] = [[22.2660, 113.9985], [22.2668, 113.9985], [22.2676, 113.9985]];
  drawCtx._drawBusSpeedSegmentsIntoLayer([
    { company: 'NLB', routeNo: '1', fromNameEn: 'Mui Wo Market', toNameEn: 'Ngan Wan Road', tier: 'SMOOTH', speedKmh: 28, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, isScheduledOnly: true, isScheduledFallback: true, coords: mwRoad },
    { company: 'NLB', routeNo: 'A35', fromNameEn: 'Mui Wo Market', toNameEn: 'Ngan Wan Road', tier: 'SMOOTH', speedKmh: 28, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, isScheduledOnly: true, isScheduledFallback: true, coords: mwRoad },
    { company: 'NLB', routeNo: '2', fromNameEn: 'Mui Wo Market', toNameEn: 'Ngan Wan Road', tier: 'SMOOTH', speedKmh: 28, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, isScheduledOnly: true, isScheduledFallback: true, coords: mwRoad },
  ], drawCtx.L.layerGroup(), '', new Map(), { laneOffsetM: 2.5 });

  assert.equal(boundTooltips.length, 1);
  assert.equal(boundTooltips[0], '🚌 NLB 1, 2, A35 • Scheduled headway · Low conf. · Clear',
    `Expected clean deduplicated qualitative tooltip with confidence, got: ${boundTooltips[0]}`);
  assert.ok(!/km\/h/i.test(boundTooltips[0]), 'Bus-API corridor tooltip must use clean qualitative status without raw km/h');

  // 3. .kmb-map-stop-label CSS removes narrow max-width: 220px & text-overflow: ellipsis clipping
  const tooltipRuleMatch = html.match(/\.kmb-map-stop-label\s*\{[^}]+\}/);
  assert.ok(tooltipRuleMatch, '.kmb-map-stop-label CSS rule must exist in index.html');
  assert.ok(!tooltipRuleMatch[0].includes('max-width: 220px'), '.kmb-map-stop-label must remove narrow 220px cap');
  assert.ok(!tooltipRuleMatch[0].includes('text-overflow: ellipsis'), '.kmb-map-stop-label must remove mid-word ellipsis truncation');
  assert.ok(tooltipRuleMatch[0].includes('white-space: normal') && tooltipRuleMatch[0].includes('overflow: visible'),
    '.kmb-map-stop-label must wrap naturally without clipping');
});

test('Tasks 1-3 Regression: Modularized domain scripts in exact 12-script order, 2026-11-27 21:20 HKT timestamp, South Lantau continuity, Wong Chu leakage block, and unified worst-ahead pill/banner', () => {
  // 1. Task 1: External files exist, exact 12-script load order in index.html, no inline main style block, SW precaches all of them
  const rawIndex = fs.readFileSync('index.html', 'utf8');
  const swSrc = fs.readFileSync('public/sw.js', 'utf8');
  const modularAssets = [
    'public/app.css',
    'public/transit-data.js',
    'public/weathercoorelation.js',
    'public/monthly_activity.js',
    'public/hk-people-flow.js',
    'public/mtrsurge.js',
    'public/ferrysurge.js',
    'public/bussurge.js',
    'public/fare-load-engine.js',
    'public/hardcode.js',
    'public/busspeed.js',
    'public/map-traffic-overlay.js',
    'public/map.js',
    'public/commute-hubs.js',
    'public/raptor-cost-engine.js',
    'public/planner.js',
    'public/eta-engine.js',
    'public/onboarding-pwa.js',
    'public/app-ui.js',
  ];
  for (const rel of modularAssets) {
    assert.ok(fs.existsSync(rel) && fs.statSync(rel).size > 1000, `Modularized asset ${rel} must exist and be non-empty`);
  }
  assert.ok(rawIndex.includes('<link rel="stylesheet" href="app.css">'), 'index.html must link external app.css');
  assert.ok(!rawIndex.includes('<style id="transit-unified-fixed-css">'), 'index.html must not contain inline transit-unified-fixed-css block');
  const loadOrder = [
    'transit-data.js',
    'weathercoorelation.js',
    'monthly_activity.js',
    'hk-people-flow.js',
    'mtrsurge.js',
    'ferrysurge.js',
    'bussurge.js',
    'fare-load-engine.js',
    'hardcode.js',
    'busspeed.js',
    'map-traffic-overlay.js',
    'map.js',
    'commute-hubs.js',
    'raptor-cost-engine.js',
    'planner.js',
    'eta-engine.js',
    'onboarding-pwa.js',
    'app-ui.js',
  ];
  let prevPos = -1;
  for (const s of loadOrder) {
    const pos = rawIndex.indexOf(`<script src="${s}"></script>`);
    assert.ok(pos > prevPos, `index.html must load ${s} in exact order`);
    prevPos = pos;
  }
  for (const asset of ['app.css', ...loadOrder]) {
    assert.ok(swSrc.includes(asset), `public/sw.js must precache ${asset}`);
  }

  // 2. Task 2: Build timestamp consistency across version.json, public/version.json, index.html & public/sw.js
  const expectedTs = JSON.parse(fs.readFileSync('version.json', 'utf8')).version;
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} HKT$/.test(expectedTs), `version.json must hold a valid HKT build timestamp, got: ${expectedTs}`);
  assert.ok(rawIndex.includes(expectedTs), `index.html must contain build timestamp ${expectedTs}`);
  assert.ok(swSrc.includes(expectedTs), `public/sw.js must contain build timestamp ${expectedTs}`);
  assert.equal(JSON.parse(fs.readFileSync('public/version.json', 'utf8')).version, expectedTs);
  assert.ok(rawIndex.includes('HK Layer, HK Sundry, HK Property &amp; HK MPF'), 'Settings About subtitle must list the 4 remaining companion apps');

  // 3. Task 3a: Rural South Lantau corridor continuity (180-230m rural vertices stay continuous & adjacent collinear spans merge into 1 polyline)
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  // Two consecutive rural South Lantau Road spans with ~190m vertex spacing (should stay continuous & merge into 1 corridor!)
  const ruralSpan1: [number, number][] = [
    [22.2400, 113.9700],
    [22.2400, 113.9718], // ~185m east
    [22.2400, 113.9736], // ~185m east
  ];
  const ruralSpan2: [number, number][] = [
    [22.2400, 113.9736],
    [22.2400, 113.9755], // ~195m east
    [22.2400, 113.9774], // ~195m east
  ];
  const ruralAgg = engine.aggregateBusMicroStepsToCorridors([
    { company: 'NLB', routeNo: '11', fromSeq: 1, toSeq: 2, fromNameEn: 'Pui O', toNameEn: 'San Shek Wan', tier: 'SMOOTH', speedKmh: 36, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, coords: ruralSpan1 },
    { company: 'NLB', routeNo: '11', fromSeq: 2, toSeq: 3, fromNameEn: 'San Shek Wan', toNameEn: 'Cheung Sha', tier: 'SMOOTH', speedKmh: 38, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true, coords: ruralSpan2 },
  ], [], null, { targetStepM: 50 });
  assert.equal(ruralAgg.corridors.length, 1, `Consecutive rural South Lantau spans with 185-195m vertices must merge into ONE continuous polyline, got ${ruralAgg.corridors.length}`);
  assert.ok(ruralAgg.corridors[0].coords.length >= 12, `Expected subdivided continuous polyline along rural road, got ${ruralAgg.corridors[0].coords.length} vertices`);

  // 4. Task 3b: Distant Tuen Mun detector/camera (Wong Chu Rd near Hoi Wong Rd) NEVER attaches to Yuen Long span (Tai Tong Rd -> Hong Lok Rd)
  const ylSpan = [[22.4442, 114.0272], [22.4443, 114.0258], [22.4444, 114.0244]];
  const wongChuDet = {
    id: 'TDSLFR20001', lat: 22.3836, lon: 113.9688, rot: 255, spd: 28, occ: 55, tier: 'SLOW',
    roadEn: 'Wong Chu Road near Hoi Wong Road - Westbound', roadTc: '皇珠路近海皇路 - 西行', camKey: 'TM115F'
  };
  const wongChuCam = {
    key: 'TM115F', lat: 22.3836, lon: 113.9688, desc: 'Wong Chu Road near Hoi Wong Road', bearingDeg: 255
  };
  const ylMatch = engine.matchTdGroundTruthForSpan(ylSpan, [wongChuDet], [wongChuCam], {
    fromNameEn: 'Tai Tong Road', toNameEn: 'Hong Lok Road', routeNo: 'E36'
  });
  assert.equal(ylMatch.hasTd, false, 'Wong Chu Road detector must NEVER attach to Yuen Long Tai Tong Rd -> Hong Lok Rd span');
  assert.equal(ylMatch.cam, null, 'Wong Chu Road camera must NEVER attach to Yuen Long span');

  // 5. Task 3c: Unified worst-ahead selector ensures stop-row pill and expanded banner read the exact same segment (no Stop 1 mismatch, no ~, no Opp. bound jammed)
  const sb = loadHardcodeAndPlannerSandbox();
  const testStops = [
    { stopKey: 'S0', stopName_e: 'Pat Heung Road', name_tc: '八鄉路', latitude: '22.4270', longitude: '114.0630' },
    { stopKey: 'S1', stopName_e: 'Tai Lam Tunnel', name_tc: '大欖隧道', latitude: '22.4150', longitude: '114.0600' },
    { stopKey: 'S2', stopName_e: 'Tsing Ma Bridge', name_tc: '青馬大橋', latitude: '22.3520', longitude: '114.0740' },
  ];
  const unifiedTestSegs = [
    { fromIdx: 0, toIdx: 1, fromSeq: 1, toSeq: 2, fromNameEn: 'Pat Heung Road', toNameEn: 'Tai Lam Tunnel', source: 'TD', tier: 'SMOOTH', speedKmh: 72, roadEn: 'Tsing Long Highway', roadTc: '青朗公路', detId: 'D1', roadDistKm: 1.5, coords: [[22.4270, 114.0630], [22.4150, 114.0600]] },
    { fromIdx: 1, toIdx: 2, fromSeq: 2, toSeq: 3, fromNameEn: 'Tai Lam Tunnel', toNameEn: 'Tsing Ma Bridge', source: 'TD', tier: 'MODERATE', speedKmh: 28, roadEn: 'Tsing Long Highway', roadTc: '青朗公路', detId: 'D2', roadDistKm: 4.0, coords: [[22.4150, 114.0600], [22.3520, 114.0740]] },
  ];
  const testDets = [
    { id: 'D1', lat: 22.4210, lon: 114.0615, rot: 190, spd: 72, occ: 10, tier: 'SMOOTH', roadEn: 'Tsing Long Highway', roadTc: '青朗公路' },
    { id: 'D2', lat: 22.3835, lon: 114.0670, rot: 170, spd: 28, occ: 55, tier: 'SLOW', roadEn: 'Tsing Long Highway', roadTc: '青朗公路' },
  ];
  const pillPick = sb.ctx.window.selectWorstAheadStopSegment(unifiedTestSegs, testStops, 0, {});
  const bannerSum = sb.getDirectionalRoadSummary(testStops, 0, testDets, false, 40, null, 12000, [], { unifiedSegments: unifiedTestSegs });
  assert.ok(pillPick && bannerSum, 'Both stop-row pill selector and expanded banner summary must resolve');
  assert.equal(pillPick.tier, 'MODERATE', 'Stop 1 pill must reflect worst-ahead MODERATE segment');
  assert.equal(bannerSum.tone, 'slow', 'Expanded banner must match pill tier (slow)');
  assert.equal(bannerSum.leadSegment?.fromIdx, pillPick.fromIdx, 'Banner leadSegment and pill pick must reference the exact same stop span');
  assert.ok(!bannerSum.detail.includes('~'), `Banner detail must not contain tilde prefixes: ${bannerSum.detail}`);
  assert.ok(!bannerSum.detail.includes('Opp. bound jammed'), `Banner detail must not contain Opp. bound jammed: ${bannerSum.detail}`);
});

test('Task 2A: Bus API inferred severity cap (6-17 km/h single-bus caps at Slow Amber, >=18 km/h Clear Green, no tilde) & strict TD Red (<15 km/h or occ>=75%)', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  // 1. Strict TD Red reservation: <15 km/h or occupancy >=75% -> CONGESTED; 16-39 km/h with occ < 75% -> MODERATE
  assert.equal(engine.normalizeTrafficTier('JAMMED', 14, 40), 'CONGESTED', 'TD 14 km/h must classify CONGESTED (Red)');
  assert.equal(engine.normalizeTrafficTier('SLOW', 17, 78), 'CONGESTED', 'TD occ 78% (>=75%) must classify CONGESTED (Red)');
  assert.equal(engine.normalizeTrafficTier('JAMMED', 16, 55), 'MODERATE', 'TD 16 km/h with occ 55% (<75%) must classify MODERATE (Amber), NOT Red');
  assert.equal(sb.ctx._normalizeBottleneckTier('JAMMED', 16, 55), 'MODERATE');
  assert.equal(sb.ctx._normalizeBottleneckTier('SLOW', 17, 75), 'CONGESTED');

  // 2. Single-bus Bus API inferred speeds: Stop 1 Pat Heung Road (6 km/h) & Stop 10 Yau San Street (8 km/h) cap at Slow (Amber)
  const e36Stops = [
    { stopKey: 'PH1', stopName_e: 'Pat Heung Road', name_tc: '八鄉路', latitude: '22.4270', longitude: '114.0630' },
    { stopKey: 'PH2', stopName_e: 'Kam Ho Road', name_tc: '錦河路', latitude: '22.4310', longitude: '114.0580' },
    { stopKey: 'YS10', stopName_e: 'Yau San Street', name_tc: '又新街', latitude: '22.4442', longitude: '114.0315' },
    { stopKey: 'YS11', stopName_e: 'Tai Tong Road', name_tc: '大棠路', latitude: '22.4444', longitude: '114.0272' },
    { stopKey: 'YL12', stopName_e: 'Yuen Long Plaza', name_tc: '元朗廣場', latitude: '22.4446', longitude: '114.0220' },
  ];
  const busSegs = [
    {
      fromIdx: 0, toIdx: 1, fromSeq: 1, toSeq: 2,
      fromNameEn: 'Pat Heung Road', fromNameTc: '八鄉路', toNameEn: 'Kam Ho Road', toNameTc: '錦河路',
      source: 'BUS_API', tier: 'CONGESTED', speedKmh: 6, roadDistKm: 0.65, matchedBusCount: 1, isVerifiedMultiBusStall: false,
      coords: [[22.4270, 114.0630], [22.4290, 114.0605], [22.4310, 114.0580]], isRoadSnapped: true
    },
    {
      fromIdx: 2, toIdx: 3, fromSeq: 10, toSeq: 11,
      fromNameEn: 'Yau San Street', fromNameTc: '又新街', toNameEn: 'Tai Tong Road', toNameTc: '大棠路',
      source: 'BUS_API', tier: 'CONGESTED', speedKmh: 8, roadDistKm: 0.45, matchedBusCount: 1, isVerifiedMultiBusStall: false,
      coords: [[22.4442, 114.0315], [22.4443, 114.0293], [22.4444, 114.0272]], isRoadSnapped: true
    },
    {
      fromIdx: 3, toIdx: 4, fromSeq: 11, toSeq: 12,
      fromNameEn: 'Tai Tong Road', fromNameTc: '大棠路', toNameEn: 'Yuen Long Plaza', toNameTc: '元朗廣場',
      source: 'BUS_API', tier: 'SMOOTH', speedKmh: 24, roadDistKm: 0.55, matchedBusCount: 1, isVerifiedMultiBusStall: false,
      coords: [[22.4444, 114.0272], [22.4445, 114.0246], [22.4446, 114.0220]], isRoadSnapped: true
    },
  ];
  const unified = engine.buildStopByStopSegmentTraffic(e36Stops, null, [], [], busSegs, { routeNo: 'E36' });
  assert.equal(unified[0].tier, 'MODERATE', 'Stop 1 Pat Heung Rd single-bus 6 km/h MUST cap at MODERATE (Amber), NEVER CONGESTED');
  assert.equal(unified[0].color, '#f59e0b', 'Stop 1 Pat Heung Rd single-bus 6 km/h MUST use Amber #f59e0b');
  assert.equal(unified[2].tier, 'MODERATE', 'Stop 10 Yau San St single-bus 8 km/h MUST cap at MODERATE (Amber), NEVER CONGESTED');
  assert.equal(unified[3].tier, 'SMOOTH', '24 km/h (>= 18 km/h) Bus API segment MUST classify SMOOTH (Clear Green)');

  // Expanded banner summary from hardcode.js (no raw km/h clutter; clear source + confidence)
  const sumStop1 = sb.getDirectionalRoadSummary(e36Stops, 0, [], false, 40, null, 12000, [], { unifiedSegments: unified });
  assert.ok(sumStop1, 'Expected road summary for Bus API stop 1');
  assert.equal(sumStop1.tone, 'slow', 'Stop 1 Pat Heung Rd expanded banner must be slow (Amber), NEVER jammed (Red)');
  assert.ok(sumStop1.detail.includes('Bus ETA · Low conf.') && !/km\/h/i.test(sumStop1.detail), `Expected clean Bus ETA · Low conf. label without km/h, got: ${sumStop1.detail}`);
  assert.ok(!sumStop1.detail.includes('~'), `Bus API detail must NEVER include tilde (~): ${sumStop1.detail}`);

  // Map Bus API solid route polyline caps single-bus 6 km/h at Amber #f59e0b and labels cleanly with Bus ETA + confidence (no raw km/h)
  const geoStrokes: any[] = [];
  const drawnTips: string[] = [];
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __DETAIL_BUS_SPEED_SEGMENTS__: busSegs,
      capBusApiTierHardcode: sb.ctx.window.capBusApiTierHardcode,
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
      buildStopByStopSegmentTraffic: engine.buildStopByStopSegmentTraffic,
      computeTrafficConfidence: engine.computeTrafficConfidence,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: (arr: any[] = []) => ({ _arr: arr, addTo() { return this; }, clearLayers() {} }),
      polyline: (c: any, opts: any) => ({ c, opts, addTo() { return this; }, bindTooltip(t: string) { drawnTips.push(t); return this; } }),
      geoJSON: (fc: any, cfg: any) => {
        for (const feat of fc?.features || []) {
          const st = typeof cfg?.style === 'function' ? cfg.style(feat) : {};
          geoStrokes.push({ feat, style: st });
          const lyr: any = { options: {}, bindTooltip(t: string) { drawnTips.push(t); return this; }, on() { return this; } };
          if (typeof cfg?.onEachFeature === 'function') cfg.onEachFeature(feat, lyr);
        }
        return { addTo() { return this; } };
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(readMapBundle(), mapCtx);
  mapCtx.window.__DETAIL_BUS_SPEED_SEGMENTS__ = busSegs;
  mapCtx.buildDetailBusPolylineLayer(busSegs[0].coords, e36Stops, 0, '#FF3B30');
  const busGeoStrokes = geoStrokes.filter((g) => g.feat?.properties?.source === 'BUS_API');
  assert.ok(busGeoStrokes.length >= 1, 'Expected solid GeoJSON BUS_API stroke merged onto detail route polyline');
  assert.equal(busGeoStrokes[0].style.color, '#f59e0b', 'Single-bus 6 km/h map polyline MUST render Amber #f59e0b, NEVER Red');
  assert.equal(busGeoStrokes[0].style.dashArray, null, 'Merged BUS_API route stroke must render solid (dashArray: null)');
  assert.ok(drawnTips.some((t) => t.includes('Bus ETA · Low conf.') && !/km\/h/i.test(t) && !t.includes('~')),
    `Map Bus API tooltip must show Bus ETA · Low conf. without km/h or tilde, got: ${drawnTips.join(' | ')}`);
});

test('Task 2B: Divided-highway <=85m TD snap (E36 TDS91038 62 km/h Green), roundabout/interchange bottleneck preservation, South Lantau 450m gap & Mui Wo <60m stub pruning', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  // 1. E36 divided highway Tuen Mun Road near MTR Siu Hong Station (TDS91038, 62 km/h) placed ~72m laterally off route polyline
  // 0.00065 deg lat is ~72.2 m (> 45 m, > 60 m, <= 85 m!)
  const tmrPoly: [number, number][] = [
    [22.4110, 113.9780],
    [22.4110, 113.9760],
    [22.4110, 113.9740],
    [22.4110, 113.9720],
  ];
  const tds91038 = {
    id: 'TDS91038',
    lat: 22.41165, // ~72m north of southbound centerline
    lon: 113.9750,
    rot: 270, // aligned with westbound/southbound polyline (270°)
    spd: 62,
    occ: 18,
    tier: 'SMOOTH',
    roadEn: 'Tuen Mun Road near MTR Siu Hong Station - Southbound',
    roadTc: '屯門公路近港鐵兆康站 - 南行',
    camKey: 'TM110F',
  };
  const e36HwyStops = [
    { stopKey: 'YL15', stopName_e: 'Yuen Long Park', name_tc: '元朗公園', latitude: '22.4420', longitude: '114.0180' },
    { stopKey: 'TM16', stopName_e: 'Tuen Mun Chek Lap Kok Tunnel BBI', name_tc: '屯門赤鱲角隧道轉車站', latitude: '22.3716', longitude: '113.9636' },
  ];
  const spanMatch = engine.matchTdGroundTruthForSpan(tmrPoly, [tds91038], [], {
    routeNo: 'E36',
    fromStop: e36HwyStops[0],
    toStop: e36HwyStops[1],
    stops: e36HwyStops,
    isRoadSnapped: true,
    isHighwaySpan: true,
  });
  assert.equal(spanMatch.hasTd, true, 'TDS91038 at ~72m (<= 85m) on Tuen Mun Road must snap to E36');
  assert.equal(spanMatch.tdDetId, 'TDS91038');
  assert.equal(spanMatch.tdSpeedKmh, 62);
  assert.equal(spanMatch.tdTier, 'SMOOTH');

  const routeGeo = sb.ctx.window.buildRouteSpeedGeoJson(tmrPoly, [tds91038], {
    isRoadSnapped: true,
    hasHighwaySpan: true,
    routeNo: 'E36',
    noDataColor: '#3b82f6',
  });
  const greenFeat = routeGeo.features.find((f: any) => f.properties.detectorId === 'TDS91038');
  assert.ok(greenFeat, 'buildRouteSpeedGeoJson must snap TDS91038 within <= 85m on divided highway');
  assert.equal(greenFeat.properties.color, '#16a34a', 'TDS91038 (62 km/h) must paint route polyline Green #16a34a');
  assert.equal(greenFeat.properties.speedKmh, 62);

  // Verify buildDetailBusPolylineLayer paints Green (Clear • 62 km/h) tooltip for TDS91038
  const geoTips: string[] = [];
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [tds91038],
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
      isDividedHighwaySnapRoadHardcode: sb.ctx.window.isDividedHighwaySnapRoadHardcode,
      isRoundaboutOrInterchangeDetectorHardcode: sb.ctx.window.isRoundaboutOrInterchangeDetectorHardcode,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: (arr: any[] = []) => ({ _arr: arr }),
      polyline: () => ({ addTo() { return this; } }),
      geoJSON: (data: any, opts: any) => {
        (data.features || []).forEach((f: any) => {
          const lyr: any = { options: {}, bindTooltip(t: string) { geoTips.push(t); return this; }, on() {} };
          if (opts.onEachFeature) opts.onEachFeature(f, lyr);
        });
        return {};
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(readMapBundle(), mapCtx);
  mapCtx.buildDetailBusPolylineLayer(tmrPoly, [], 0, '#FF3B30');
  assert.ok(geoTips.some((t) => t.includes('Clear • 62 km/h')), `Expected Green Clear • 62 km/h tooltip for TDS91038, got: ${geoTips.join(' | ')}`);

  // 2. Roundabout & interchange bottleneck preservation (Au Tau / Pok Oi Roundabout 12 km/h NOT washed out by 63 km/h downstream highway)
  const auTauPoly: [number, number][] = [
    [22.4445, 114.0415], // Au Tau Interchange / Pok Oi Roundabout
    [22.4432, 114.0435],
    [22.4418, 114.0458],
    [22.4402, 114.0480], // Tai Lam Tunnel approach (63 km/h downstream)
  ];
  const auTauJamDet = {
    id: 'TD_AUTAU_RB',
    lat: 22.4445,
    lon: 114.0417,
    rot: 130,
    spd: 12,
    occ: 84,
    tier: 'JAMMED',
    roadEn: 'Au Tau Interchange / Pok Oi Roundabout - Southbound',
    roadTc: '凹頭交匯處 / 博愛迴旋處 - 南行',
  };
  const taiLamFastDet = {
    id: 'TD_TAILAM_FAST',
    lat: 22.4418,
    lon: 114.0458,
    rot: 130,
    spd: 63,
    occ: 16,
    tier: 'SMOOTH',
    roadEn: 'Tsing Long Highway near Tai Lam Tunnel - Southbound',
    roadTc: '青朗公路近大欖隧道 - 南行',
  };
  const rbSpanMatch = engine.matchTdGroundTruthForSpan(auTauPoly, [taiLamFastDet, auTauJamDet], [], {
    isRoadSnapped: true,
    isHighwaySpan: true,
    fromStop: { stopName_e: 'Pok Oi Hospital', name_tc: '博愛醫院' },
    toStop: { stopName_e: 'Tai Lam Tunnel BBI', name_tc: '大欖隧道轉車站' },
  });
  assert.equal(rbSpanMatch.hasTd, true);
  assert.equal(rbSpanMatch.roundaboutBottleneck, true, 'Jammed Au Tau / Pok Oi Roundabout must flag roundaboutBottleneck=true');
  assert.equal(rbSpanMatch.tdDetId, 'TD_AUTAU_RB', 'Downstream 63 km/h highway speed must NOT overwrite jammed roundabout detector');
  assert.equal(rbSpanMatch.tdSpeedKmh, 12);
  assert.equal(rbSpanMatch.tdTier, 'CONGESTED');

  const rbGeo = sb.ctx.window.buildRouteSpeedGeoJson(auTauPoly, [taiLamFastDet, auTauJamDet], {
    isRoadSnapped: true,
    hasHighwaySpan: true,
    noDataColor: '#3b82f6',
  });
  assert.ok(rbGeo.features.some((f: any) => f.properties.detectorId === 'TD_AUTAU_RB' && f.properties.color === '#dc2626'),
    'Localized red roundabout micro-step at Au Tau / Pok Oi Roundabout MUST survive next to 63 km/h downstream highway');

  // Global speed GeoJSON also preserves jammed roundabout micro-step over an overlapping 63 km/h free-flow link
  const freeFlowGlobalGeo = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[114.0410, 22.4449], [114.0422, 22.4440], [114.0435, 22.4430]] },
      properties: { id: 'LINK_FAST', roadEn: 'Tsing Long Highway', spd: 63, occ: 16, rot: 130, tier: 'SMOOTH' },
    }],
  };
  const globalFiltered = mapCtx.filterAndOffsetGlobalSpeedGeoJson(freeFlowGlobalGeo, 14, [auTauJamDet]);
  assert.ok(globalFiltered.features.some((f: any) => f.properties.detectorId === 'TD_AUTAU_RB' && f.properties.color === '#ef4444'),
    'filterAndOffsetGlobalSpeedGeoJson must preserve jammed roundabout bottleneck over free-flow 63 km/h link');

  // 3. Rural South Lantau coastal 450m gap threshold & Mui Wo <60m orphan turnaround stub pruning
  const coastalSpacedCoords: [number, number][] = [
    [22.2435, 113.9785],
    [22.2403, 113.9772], // ~380m hop along South Lantau Road (<= 450m)
    [22.2371, 113.9759], // ~380m hop along South Lantau Road (<= 450m)
  ];
  const muiWoStrayStub: [number, number][] = [
    [22.2640, 114.0020],
    [22.26438, 114.0020], // ~42m isolated turnaround stub in Mui Wo headland/pier bbox (< 60m)
  ];
  const coastalAgg = engine.aggregateBusMicroStepsToCorridors([
    {
      company: 'NLB', routeNo: '11', fromSeq: 1, toSeq: 2,
      fromNameEn: 'Pui O, South Lantau Road', toNameEn: 'Cheung Sha, South Lantau Road',
      tier: 'SMOOTH', speedKmh: 36, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
      coords: coastalSpacedCoords,
    },
    {
      company: 'NLB', routeNo: '1', fromSeq: 1, toSeq: 2,
      fromNameEn: 'Mui Wo Ferry Pier', toNameEn: 'Mui Wo Headland',
      tier: 'SMOOTH', speedKmh: 24, color: '#16a34a', source: 'BUS_API', isRoadSnapped: true,
      coords: muiWoStrayStub,
    },
  ], [], null, { targetStepM: 50 });
  assert.equal(coastalAgg.corridors.length, 1, `Expected 1 continuous South Lantau coastal polyline with Mui Wo <60m stub pruned, got ${coastalAgg.corridors.length}`);
  assert.ok(coastalAgg.corridors[0].coords.length >= 12, '380m South Lantau coastal hops must subdivide continuously with zero dashed gaps');
  assert.ok(coastalAgg.stats.prunedOrphanStubs >= 1, 'Isolated <60m Mui Wo pier/headland stub must be pruned');
});

test('Task 2C: Bottom-sheet pull-up gesture & auto-snap to top detent (expandStop, Details, tap handle) + Map/down-drag split restore', () => {
  const css = fs.readFileSync('public/app.css', 'utf8');
  const appUi = fs.readFileSync('public/app-ui.js', 'utf8');
  const mapCode = readMapBundle();

  // 1. Verify CSS removes #view-detail overflow: hidden lock & #map-container min-height: 170px lock, and adds .sheet-expanded-top
  assert.ok(!/#view-detail\s*\{[^}]*overflow:\s*hidden/.test(css), '#view-detail must NOT have overflow: hidden blocking sheet expansion');
  assert.ok(/#map-container\s*\{[^}]*min-height:\s*0/.test(css), '#map-container must allow shrinking to 0px (no 170px min-height lock)');
  assert.ok(css.includes('#view-detail.sheet-expanded-top #map-container'), 'CSS must define full-top detent collapsing #map-container to 0px');
  assert.ok(/\.map-sheet-handle\s*\{[^}]*touch-action:\s*none/.test(css), '.map-sheet-handle must enforce touch-action: none');
  assert.ok(appUi.includes('window.expandDetailSheetToTop()'), 'app-ui.js must wire expandStop and Details toggle to expandDetailSheetToTop()');

  // 2. Simulate touch pull-up, tap-handle, expandDetailSheetToTop, and Map-button / downward-drag restore
  const handleListeners: Record<string, Function[]> = {};
  const viewClasses = new Set<string>();
  const handleClasses = new Set<string>();
  const bodyClasses = new Set<string>();
  const fakeHandle: any = {
    addEventListener: (ev: string, fn: Function) => { (handleListeners[ev] = handleListeners[ev] || []).push(fn); },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    classList: { add: (c: string) => handleClasses.add(c), remove: (c: string) => handleClasses.delete(c) },
    setAttribute: () => {},
  };
  const fakeMapContainer: any = {
    offsetHeight: 280,
    style: { height: '280px' },
    getBoundingClientRect: () => ({ height: fakeMapContainer.offsetHeight }),
  };
  const fakeViewDetail: any = {
    classList: {
      add: (c: string) => viewClasses.add(c),
      remove: (c: string) => viewClasses.delete(c),
      toggle: (c: string, force?: boolean) => { if (force) viewClasses.add(c); else viewClasses.delete(c); },
      contains: (c: string) => viewClasses.has(c),
    },
  };
  const fakeToggleBtn: any = { innerHTML: '', classList: { toggle: () => {} } };
  const ctx: any = {
    window: { innerHeight: 800, mapInstance: { invalidateSize: () => {} } },
    document: {
      readyState: 'complete',
      body: { classList: { add: (c: string) => bodyClasses.add(c), remove: (c: string) => bodyClasses.delete(c) } },
      getElementById: (id: string) => {
        if (id === 'mapSheetHandle') return fakeHandle;
        if (id === 'map-container') return fakeMapContainer;
        if (id === 'view-detail') return fakeViewDetail;
        if (id === 'mapSheetToggleBtn') return fakeToggleBtn;
        return null;
      },
      addEventListener: () => {},
    },
    requestAnimationFrame: (cb: Function) => { cb(); return 1; },
    cancelAnimationFrame: () => {},
    setTimeout: (cb: Function) => { cb(); return 1; },
    clearTimeout: () => {},
    currentLang: 'en',
    triggerHaptic: () => {},
    L: { layerGroup: () => ({ addTo() { return this; } }), polyline: () => ({ addTo() { return this; } }), divIcon: (o: any) => o, marker: () => ({ addTo() { return this; } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(mapCode, ctx);

  // Verify touch listeners are bound alongside pointer listeners
  assert.ok(handleListeners.touchstart?.length === 1 && handleListeners.touchmove?.length === 1 && handleListeners.touchend?.length === 1,
    'Must bind touchstart, touchmove, and touchend on #mapSheetHandle for reliable mobile sheet drag');

  // Dragging UP via touch (clientY 320 -> 140) snaps smoothly to full-top detent (0px map, .sheet-expanded-top)
  handleListeners.touchstart[0]({ touches: [{ clientY: 320 }], preventDefault: () => {}, target: { closest: () => null } });
  handleListeners.touchmove[0]({ touches: [{ clientY: 140 }], preventDefault: () => {} });
  fakeMapContainer.offsetHeight = parseInt(fakeMapContainer.style.height, 10) || 0;
  handleListeners.touchend[0]({ changedTouches: [{ clientY: 140 }] });
  assert.equal(fakeMapContainer.style.height, '0px', 'Upward pull on sheet handle must snap to full-top detent (height: 0px)');
  assert.equal(viewClasses.has('sheet-expanded-top'), true, 'Full-top detent must add .sheet-expanded-top on #view-detail');

  // Tapping Map button (cycleMapSheetHeight) restores half-screen split map view
  ctx.window.cycleMapSheetHeight();
  assert.equal(viewClasses.has('sheet-expanded-top'), false, 'Map button must restore half-screen split map view from top detent');
  assert.equal(fakeMapContainer.style.height, '35dvh');

  // Auto-snap on expandStop / Details -> expandDetailSheetToTop() snaps to full-top detent
  ctx.window.expandDetailSheetToTop();
  assert.equal(fakeMapContainer.style.height, '0px');
  assert.equal(viewClasses.has('sheet-expanded-top'), true);

  // Downward drag from top detent restores split map view
  fakeMapContainer.offsetHeight = 0;
  handleListeners.pointerdown[0]({ pointerId: 11, pointerType: 'touch', button: 0, clientY: 100, preventDefault: () => {}, target: { closest: () => null } });
  handleListeners.pointermove[0]({ pointerId: 11, clientY: 360, preventDefault: () => {} });
  fakeMapContainer.offsetHeight = parseInt(fakeMapContainer.style.height, 10) || 260;
  handleListeners.pointerup[0]({ pointerId: 11, clientY: 360 });
  assert.equal(viewClasses.has('sheet-expanded-top'), false, 'Downward drag from top detent must restore split map view');
});

test('Unified Traffic Consistency 1: Camera >85m away or on off-route ramp rejects mismatched detector speed while compatible <=85m detector updates both camera tooltip & route polyline', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const findDet = sb.ctx.window.findNearestMatchingDetectorForCamera;
  const buildRouteGeo = sb.ctx.window.buildRouteSpeedGeoJson;

  // Divided highway (Yuen Long Highway EB, heading ~90°)
  const ylhCoords: [number, number][] = [
    [22.4360, 114.0040],
    [22.4360, 114.0065],
    [22.4360, 114.0090],
    [22.4360, 114.0115],
  ];
  const nearDet = {
    id: 'TDS_YLH_NEAR',
    lat: 22.43655, // ~61m north of route centerline (<= 85m divided highway)
    lon: 114.0068,
    rot: 90,
    spd: 62,
    occ: 18,
    tier: 'SMOOTH',
    roadEn: 'Yuen Long Highway near Tong Yan San Tsuen - Eastbound',
    roadTc: '元朗公路近唐人新村 - 東行',
  };
  const farDet = {
    id: 'TDS_YLH_FAR',
    lat: 22.4372, // ~133m north (> 85m divided highway cap)
    lon: 114.0068,
    rot: 90,
    spd: 58,
    occ: 22,
    tier: 'SMOOTH',
    roadEn: 'Yuen Long Highway near Tong Yan San Tsuen - Eastbound',
    roadTc: '元朗公路近唐人新村 - 東行',
  };

  // 1a. Camera >85m from detector (or on diverging off-route ramp) MUST NOT bind a detector speed
  const camNearCorridor = {
    key: 'CAM_YLH_OK',
    lat: 22.4361,
    lon: 114.0066,
    bearingDeg: 90,
    dir: 'Eastbound',
    desc: 'Yuen Long Highway near Tong Yan San Tsuen (Eastbound)',
  };
  const nearDetRamp = {
    id: 'TDS_YLH_NEAR_2',
    lat: 22.43645, // ~50m north of mainline right next to camOnRamp
    lon: 114.0086,
    rot: 90,
    spd: 64,
    occ: 16,
    tier: 'SMOOTH',
    roadEn: 'Yuen Long Highway near Tong Yan San Tsuen - Eastbound',
    roadTc: '元朗公路近唐人新村 - 東行',
  };
  const camOnRamp = {
    key: 'CAM_YLH_RAMP',
    lat: 22.43635,
    lon: 114.0086, // ~205m east of camNearCorridor so de-overlap keeps both markers visible
    bearingDeg: 90,
    dir: 'Eastbound',
    desc: 'Yuen Long Highway slip road off-ramp near Tong Yan San Tsuen (Eastbound)',
  };
  const camFarOffCorridor = {
    key: 'CAM_YLH_FAR',
    lat: 22.43695, // ~105m from route polyline (> 85m divided highway snap, <= 120m visible cam marker)
    lon: 114.0108, // ~225m east of camOnRamp
    bearingDeg: 90,
    dir: 'Eastbound',
    desc: 'Yuen Long Highway near Tong Yan San Tsuen (Eastbound)',
  };
  assert.equal(findDet(camNearCorridor, [farDet], { routeCoords: ylhCoords }), null,
    'Camera must NOT attach >85m detector (133m away) while road polyline has no detector');
  assert.equal(findDet(camOnRamp, [nearDet, nearDetRamp], { routeCoords: ylhCoords }), null,
    'Diverging slip-road/off-ramp camera must NOT inherit mainline highway detector speed');

  // 1b. Non-highway local road enforces <=45m strict radius & <=45deg bearing
  const localCam = {
    key: 'CAM_LOCAL',
    lat: 22.4440,
    lon: 114.0250,
    bearingDeg: 90,
    desc: 'Castle Peak Road - Yuen Long (Eastbound)',
  };
  const localDet60m = {
    id: 'DET_LOCAL_60M',
    lat: 22.44454, // ~60m away (> 45m local cap!)
    lon: 114.0250,
    rot: 90,
    spd: 28,
    roadEn: 'Castle Peak Road - Yuen Long - Eastbound',
  };
  const localDet30m = {
    id: 'DET_LOCAL_30M',
    lat: 22.44427, // ~30m away (<= 45m local cap)
    lon: 114.0250,
    rot: 90,
    spd: 28,
    roadEn: 'Castle Peak Road - Yuen Long - Eastbound',
  };
  assert.equal(findDet(localCam, [localDet60m]), null, 'Local non-highway camera must reject detector >45m away');
  assert.equal(findDet(localCam, [localDet30m])?.id, 'DET_LOCAL_30M', 'Local non-highway camera must match same-road detector <=45m');

  // 1c. Compatible <=85m divided-highway detector updates BOTH camera binding and route polyline
  const okMatch = findDet(camNearCorridor, [nearDet], { routeCoords: ylhCoords });
  assert.equal(okMatch?.id, 'TDS_YLH_NEAR', 'Divided-highway camera within <=85m must bind compatible detector');
  const routeGeoNear = buildRouteGeo(ylhCoords, [nearDet], { isRoadSnapped: true, hasHighwaySpan: true, routeNo: 'E36' });
  assert.ok(routeGeoNear.features.some((f: any) => f.properties?.detectorId === 'TDS_YLH_NEAR' && f.properties?.color === '#16a34a'),
    'Compatible <=85m divided-highway detector must also paint the route polyline Green');
  const routeGeoFar = buildRouteGeo(ylhCoords, [farDet], { isRoadSnapped: true, hasHighwaySpan: true, routeNo: 'E36' });
  assert.ok(routeGeoFar.features.every((f: any) => f.properties?.hasSpeedData === false),
    'Detector >85m away (133m) must leave route polyline unmonitored (consistent with camera rejecting it)');

  // 1d. Map route camera tooltip attaches speed ONLY to <=85m compatible mainline camera, NOT to ramp or >85m camera
  const camTips: Record<string, string> = {};
  const camClicks: Record<string, any> = {};
  const camMarkers: Record<string, any> = {};
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [nearDet, nearDetRamp],
      __LIVE_TRAFFIC_CAMERAS__: [camNearCorridor, camOnRamp, camFarOffCorridor],
      __LAST_DETAIL_SPEED_GEOJSON__: routeGeoNear,
      findNearestMatchingDetectorForCamera: findDet,
      isDividedHighwaySnapRoadHardcode: sb.ctx.window.isDividedHighwaySnapRoadHardcode,
      pointToSegmentDistanceKm: sb.ctx.window.pointToSegmentDistanceKm,
      extractCardinalDirectionMeta: sb.ctx.window.extractCardinalDirectionMeta,
      openTrafficCameraModal: (payload: any) => { camClicks[payload.key] = payload; },
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: any) => String(s ?? ''),
    L: {
      layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }),
      polyline: () => ({ addTo() { return this; }, bindTooltip() { return this; }, on() { return this; }, bindPopup() { return this; } }),
      divIcon: (o: any) => o,
      marker: (_ll: any, opts: any) => {
        const html = String(opts?.icon?.html || '');
        const keyMatch = html.match(/data-cam-key="([^"]+)"/);
        const k = keyMatch ? keyMatch[1] : `m_${Math.random()}`;
        const m: any = {
          addTo() { return this; },
          bindTooltip(t: string) { camTips[k] = t; return this; },
          on(ev: string, fn: any) { if (ev === 'click') m._click = fn; return this; },
        };
        camMarkers[k] = m;
        return m;
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(readMapBundle(), mapCtx);
  mapCtx.window.mapInstance = {
    getZoom: () => 16,
    getBounds: () => ({ pad: () => ({ contains: () => true }) }),
    project: (ll: [number, number]) => ({ x: ll[1] * 100000, y: ll[0] * 100000 }),
    removeLayer() {},
  };
  mapCtx.window._setDetailCorridorMetaForTest({
    groupKey: 'LWB_E36_O',
    routeNo: 'E36',
    isBusRoute: true,
    isRoadSnapped: true,
    coords: ylhCoords,
    forwardCoords: ylhCoords,
    forwardCameraCoords: ylhCoords,
  });
  mapCtx.renderTrafficOverlayOnMap(mapCtx.window.mapInstance, true);
  assert.ok(camMarkers.CAM_YLH_OK && camMarkers.CAM_YLH_RAMP && camMarkers.CAM_YLH_FAR,
    'All 3 spaced route cameras must render independently for tooltip/click checks');
  assert.ok((camTips.CAM_YLH_OK || '').includes('62 km/h'),
    `Compatible <=85m mainline camera tooltip must show 62 km/h, got: ${camTips.CAM_YLH_OK}`);
  assert.ok(!(camTips.CAM_YLH_RAMP || '').includes('km/h'),
    `Diverging ramp camera tooltip must NOT attach mainline detector speed, got: ${camTips.CAM_YLH_RAMP}`);
  assert.ok(!(camTips.CAM_YLH_FAR || '').includes('km/h'),
    `Camera >85m off corridor must NOT attach detector speed, got: ${camTips.CAM_YLH_FAR}`);
  camMarkers.CAM_YLH_OK._click({});
  camMarkers.CAM_YLH_RAMP._click({});
  camMarkers.CAM_YLH_FAR._click({});
  assert.equal(camClicks.CAM_YLH_OK?.suppressDetectorSpeed, false);
  assert.equal(camClicks.CAM_YLH_OK?.matchedDetId, 'TDS_YLH_NEAR');
  assert.equal(camClicks.CAM_YLH_RAMP?.suppressDetectorSpeed, true, 'Ramp camera click must suppress mismatched mainline speed');
  assert.equal(camClicks.CAM_YLH_FAR?.suppressDetectorSpeed, true, 'Far >85m camera click must suppress mismatched speed');

  // 1e. Worker static metadata pre-binding enforces <=0.085km divided highway / <=0.045km local & <=45deg
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  assert.ok(workerSrc.includes('0.085') && workerSrc.includes('0.045') && workerSrc.includes('angDiffDegWorker(det.rot, c.bearingDeg) > 45'),
    'functions/api/worker.js getTrafficStaticMetadata must enforce <=85m divided highway / <=45m local & <=45deg camera pre-binding');
});

test('Unified Traffic Consistency 2: Multi-stop sparse ETA bridging does NOT clone the same speed pill onto intermediate stops (fIdx+1 .. tIdx-1)', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  // Simulate E36 Stops 1-9 (Airport GTC -> Airport Perimeter stops -> Tung Chung Cable Car -> Yu Tung Court -> Terminus)
  const e36AirportToTcStops = [
    { stopName_e: 'Airport (Ground Transportation Centre)', name_tc: '機場（地面運輸中心）', latitude: '22.3155', longitude: '113.9365' },
    { stopName_e: 'Cathay City, Chek Lap Kok South Road', name_tc: '國泰城，赤鱲角南路', latitude: '22.3010', longitude: '113.9340' },
    { stopName_e: 'SuperTerminal 1, South Perimeter Road', name_tc: '超級一號貨站，南環路', latitude: '22.2975', longitude: '113.9310' },
    { stopName_e: 'Air Mail Centre, Chun Wan Road', name_tc: '空郵中心，駿運路', latitude: '22.2950', longitude: '113.9285' },
    { stopName_e: 'Asia Airfreight Terminal, South Perimeter Road', name_tc: '亞洲空運中心，南環路', latitude: '22.2932', longitude: '113.9325' },
    { stopName_e: 'Cathay Pacific Cargo Terminal, South Perimeter Road', name_tc: '國泰貨運站，南環路', latitude: '22.2918', longitude: '113.9365' },
    { stopName_e: 'Airport South Interchange, Chek Lap Kok South Road', name_tc: '機場南交匯處，赤鱲角南路', latitude: '22.2912', longitude: '113.9400' },
    { stopName_e: 'Tung Chung Cable Car Terminal, Tat Tung Road', name_tc: '東涌纜車站，達東路', latitude: '22.2896', longitude: '113.9388' },
    { stopName_e: 'Yu Tung Court, Yu Tung Road', name_tc: '裕東苑，裕東路', latitude: '22.2820', longitude: '113.9425' },
    { stopName_e: 'Pat Heung Road Bus Terminus', name_tc: '八鄉路總站', latitude: '22.4300', longitude: '114.0600' },
  ];

  // Feed a single sparse bridged BUS_API segment spanning stops 0 -> 7 at 13 km/h
  const sparseBridgedSegs = [
    {
      fromIdx: 0,
      toIdx: 7,
      fromSeq: 1,
      toSeq: 8,
      fromNameEn: 'Airport (Ground Transportation Centre)',
      toNameEn: 'Tung Chung Cable Car Terminal',
      source: 'BUS_API',
      tier: 'MODERATE',
      speedKmh: 13,
      roadDistKm: 4.5,
      matchedBusCount: 1,
      isVerifiedMultiBusStall: false,
      coords: [[22.3155, 113.9365], [22.2896, 113.9388]],
    },
  ];
  const timeline = engine.buildStopByStopSegmentTraffic(e36AirportToTcStops, null, [], [], sparseBridgedSegs, { routeNo: 'E36' });
  assert.equal(timeline[0].source, 'BUS_API', 'Origin slot fIdx=0 keeps the bridged BUS_API segment');
  assert.equal(timeline[0].speedKmh, 13);
  for (let m = 1; m <= 6; m++) {
    assert.equal(timeline[m].source, 'BUS_EST',
      `Intermediate stop ${m + 1} MUST NOT clone sparse-bridged 13 km/h BUS_API — must fall through cleanly to BUS_EST`);
    assert.notEqual(timeline[m].speedKmh, 13, `Intermediate stop ${m + 1} must not duplicate bridged 13 km/h`);
    assert.equal(timeline[m].isSyntheticFallback, true);
    assert.equal(timeline[m].allowRed, false);
  }

  // Also verify inferBusApiSegmentSpeeds refuses to sparse-bridge across airport-perimeter <-> non-airport boundary
  const t0 = Date.UTC(2026, 10, 27, 12, 0, 0);
  const etaOnlyAcrossBoundary: Record<number, any[]> = {
    5: [{ eta: new Date(t0 + 60_000).toISOString(), eta_seq: 1 }], // Airport perimeter
    7: [{ eta: new Date(t0 + 420_000).toISOString(), eta_seq: 1 }], // Tung Chung Cable Car (non-airport)
  };
  const inferred = engine.inferBusApiSegmentSpeeds(e36AirportToTcStops, etaOnlyAcrossBoundary, null, {
    routeNo: 'E36',
    company: 'LWB',
    allowSparseBridge: true,
    nowMs: t0,
  });
  assert.ok(!inferred.some((s: any) => s.fromIdx === 5 && s.toIdx === 7),
    'Sparse bridge must NOT jump across airport-perimeter <-> Tung Chung boundary');
});

test('Unified Traffic Consistency 3: Non-terminus TD-blind spans without live ETAs (e.g. E36 Yu Tung Court -> TM-CLK Tunnel BBI) emit BUS_EST capped at SMOOTH/MODERATE with Bus Est. labeling', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  const e36MidStops = [
    { stopName_e: 'Yu Tung Court', name_tc: '裕東苑', latitude: '22.2830', longitude: '113.9430' },
    { stopName_e: 'TM-CLK Tunnel Bus-Bus Interchange', name_tc: '屯門赤鱲角隧道轉車站', latitude: '22.3690', longitude: '113.9580' },
    { stopName_e: 'Yuen Long Plaza', name_tc: '元朗廣場', latitude: '22.4445', longitude: '114.0235' },
    { stopName_e: 'Pat Heung Road Bus Terminus', name_tc: '八鄉路總站', latitude: '22.4300', longitude: '114.0600' },
  ];

  // 1. inferBusApiSegmentSpeeds with includeSyntheticFallback: true emits BUS_EST on non-terminus spans even with empty ETAs
  const synInferred = engine.inferBusApiSegmentSpeeds(e36MidStops, {}, null, {
    routeNo: 'E36',
    company: 'LWB',
    includeSyntheticFallback: true,
  });
  assert.equal(synInferred.length, 3, 'Should emit BUS_EST across all 3 spans including smooth-clamped final terminus approach');
  for (const seg of synInferred) {
    assert.equal(seg.source, 'BUS_EST');
    assert.equal(seg.isSyntheticFallback, true);
    assert.equal(seg.allowRed, false);
    assert.ok(seg.tier === 'SMOOTH' || seg.tier === 'MODERATE', `BUS_EST tier must never be CONGESTED, got ${seg.tier}`);
    assert.equal(seg.speedKmh, 56, `Long highway span (${seg.roadDistKm} km) should use EXPRESSWAY expectedKmh=56`);
  }

  // 2. buildStopByStopSegmentTraffic emits BUS_EST on ALL spans including smooth-clamped final terminus span (zero NONE/blue gaps)
  const unified = engine.buildStopByStopSegmentTraffic(e36MidStops, null, [], [], [], { routeNo: 'E36' });
  assert.equal(unified[0].source, 'BUS_EST', 'Yu Tung Court -> TM-CLK Tunnel BBI must fall back to BUS_EST');
  assert.equal(unified[0].isSyntheticFallback, true);
  assert.equal(unified[0].allowRed, false);
  assert.equal(unified[0].tier, 'SMOOTH');
  assert.equal(unified[0].speedKmh, 56);
  assert.equal(unified[1].source, 'BUS_EST', 'TM-CLK Tunnel BBI -> Yuen Long Plaza must fall back to BUS_EST');
  assert.equal(unified[2].source, 'BUS_EST', 'Final terminus span without TD/ETA falls back to smooth BUS_EST (never NONE/blue)');
  assert.equal(unified[2].tier, 'SMOOTH');
  assert.equal(unified[2].isTerminusApproach, true);

  // 3. Expanded summary & breakdown label BUS_EST cleanly as "Road Est. · Low conf." (zero km/h clutter)
  const sum = sb.getDirectionalRoadSummary(e36MidStops, 0, [], false, 40, null, 12000, [], { unifiedSegments: unified });
  assert.ok(sum, 'Expected road summary driven by BUS_EST');
  assert.equal(sum.tone, 'smooth', 'BUS_EST must never produce jammed (Red) tone');
  assert.equal(sum.confidence, 'LOW');
  assert.equal(sum.isSimulatedSource, true);
  assert.ok(sum.detail.includes('Road Est. · Low conf.') && !/km\/h/i.test(sum.detail), `Summary detail must display Road Est. · Low conf. without km/h, got: ${sum.detail}`);

  // 4. UI templates in public/app-ui.js and public/eta-engine.js handle BUS_EST with subtle dotted pill styling, journey bar, and plain-English modal source
  const appUiSrc = fs.readFileSync('public/app-ui.js', 'utf8');
  const etaSrc = fs.readFileSync('public/eta-engine.js', 'utf8');
  assert.ok(appUiSrc.includes('source-bus-est') && appUiSrc.includes("'Estimated from Road Flow'"),
    'public/app-ui.js must style BUS_EST stop pills with source-bus-est and show plain-English Road Flow source in tap modal');
  assert.ok(etaSrc.includes("seg.source === 'BUS_EST'"),
    'public/eta-engine.js must render BUS_EST segments in the horizontal Journey Strip');
});

test('Unified Traffic Consistency 4: buildRouteSpeedGeoJson & buildDetailBusPolylineLayer paint BUS_API CONGESTED Red, MODERATE Amber, BUS_API/BUS_EST SMOOTH Green, and Blue only as last-resort fallback', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const stops = [
    { seq: 14, stopName_e: 'Shui Pin Wai Estate', name_tc: '水邊圍邨', latitude: '22.4440', longitude: '114.0180' },
    { seq: 15, stopName_e: 'Yuen Long Plaza', name_tc: '元朗廣場', latitude: '22.4440', longitude: '114.0220' },
    { seq: 16, stopName_e: 'Tung Lok Street', name_tc: '同樂街', latitude: '22.4440', longitude: '114.0260' },
    { seq: 17, stopName_e: 'Kuk Ting Street', name_tc: '谷亭街', latitude: '22.4440', longitude: '114.0300' },
    { seq: 18, stopName_e: 'Yoho Mall I', name_tc: '形點 I', latitude: '22.4440', longitude: '114.0340' },
    { seq: 19, stopName_e: 'Pat Heung Road Bus Terminus', name_tc: '八鄉路總站', latitude: '22.4440', longitude: '114.0380' },
  ];
  const polyCoords: [number, number][] = stops.map((s) => [parseFloat(s.latitude), parseFloat(s.longitude)]);
  const stopSegments = [
    {
      fromIdx: 0, toIdx: 1, fromSeq: 14, toSeq: 15,
      fromNameEn: 'Shui Pin Wai Estate', toNameEn: 'Yuen Long Plaza',
      source: 'BUS_API', tier: 'CONGESTED', speedKmh: 7, matchedBusCount: 2, isVerifiedMultiBusStall: true, allowRed: true,
      coords: [polyCoords[0], polyCoords[1]],
    },
    {
      fromIdx: 1, toIdx: 2, fromSeq: 15, toSeq: 16,
      fromNameEn: 'Yuen Long Plaza', toNameEn: 'Tung Lok Street',
      source: 'BUS_API', tier: 'MODERATE', speedKmh: 12, matchedBusCount: 1, isVerifiedMultiBusStall: false, allowRed: false,
      coords: [polyCoords[1], polyCoords[2]],
    },
    {
      fromIdx: 2, toIdx: 3, fromSeq: 16, toSeq: 17,
      fromNameEn: 'Tung Lok Street', toNameEn: 'Kuk Ting Street',
      source: 'BUS_API', tier: 'SMOOTH', speedKmh: 28, matchedBusCount: 2, isVerifiedMultiBusStall: false, allowRed: false,
      coords: [polyCoords[2], polyCoords[3]],
    },
    {
      fromIdx: 3, toIdx: 4, fromSeq: 17, toSeq: 18,
      fromNameEn: 'Kuk Ting Street', toNameEn: 'Yoho Mall I',
      source: 'BUS_EST', tier: 'SMOOTH', speedKmh: 56, isSyntheticFallback: true, allowRed: false,
      coords: [polyCoords[3], polyCoords[4]],
    },
    {
      fromIdx: 4, toIdx: 5, fromSeq: 18, toSeq: 19,
      fromNameEn: 'Yoho Mall I', toNameEn: 'Pat Heung Road Bus Terminus',
      source: 'NONE', tier: 'NONE', speedKmh: null,
      coords: [polyCoords[4], polyCoords[5]],
    },
  ];

  // 1. Direct buildRouteSpeedGeoJson check
  const fc = sb.ctx.window.buildRouteSpeedGeoJson(polyCoords, [], {
    isRoadSnapped: true,
    stops,
    stopSegments,
    noDataColor: '#3b82f6',
  });
  const byFromIdx = new Map<number, any>();
  for (const f of fc.features) {
    if (f.properties?.fromIdx !== null && f.properties?.fromIdx !== undefined) {
      byFromIdx.set(f.properties.fromIdx, f.properties);
    }
  }
  assert.equal(byFromIdx.get(0)?.color, '#dc2626', 'Verified multi-bus stall BUS_API (7 km/h) must paint Red #dc2626');
  assert.equal(byFromIdx.get(0)?.source, 'BUS_API');
  assert.equal(byFromIdx.get(1)?.color, '#f59e0b', 'Single-bus slow BUS_API (12 km/h) must paint Amber #f59e0b');
  assert.equal(byFromIdx.get(2)?.color, '#16a34a', 'Smooth BUS_API (28 km/h) must paint Green #16a34a');
  assert.equal(byFromIdx.get(3)?.color, '#16a34a', 'Synthetic BUS_EST (56 km/h) must paint Green #16a34a');
  assert.equal(byFromIdx.get(3)?.source, 'BUS_EST');
  const blueFallbackFeats = fc.features.filter((f: any) => f.properties?.hasSpeedData === false);
  assert.equal(blueFallbackFeats.length, 1, 'Only the final NONE terminus span should fall back to Blue #3b82f6');
  assert.equal(blueFallbackFeats[0].properties.color, '#3b82f6');

  // 2. buildDetailBusPolylineLayer renders solid colors & tooltips matching Bus API / Bus Est. / fallback
  const styledFeats: any[] = [];
  const tips: string[] = [];
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __DETAIL_STOP_SEGMENTS__: stopSegments,
      capBusApiTierHardcode: sb.ctx.window.capBusApiTierHardcode,
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: (arr: any[] = []) => ({ _arr: arr, addTo() { return this; }, clearLayers() {} }),
      polyline: (c: any, opts: any) => ({ c, opts, addTo() { return this; }, bindTooltip(t: string) { tips.push(t); return this; } }),
      geoJSON: (geo: any, cfg: any) => {
        for (const feat of geo?.features || []) {
          styledFeats.push({ props: feat.properties, style: cfg.style(feat) });
          const lyr: any = { options: {}, bindTooltip(t: string) { tips.push(t); return this; }, on() { return this; } };
          cfg.onEachFeature(feat, lyr);
        }
        return { addTo() { return this; } };
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(readMapBundle(), mapCtx);
  mapCtx.window.__DETAIL_STOP_SEGMENTS__ = stopSegments;
  mapCtx.buildDetailBusPolylineLayer(polyCoords, stops, 0, '#FF3B30');

  assert.ok(styledFeats.some((f) => f.props.source === 'BUS_API' && f.props.speedKmh === 7 && f.style.color === '#dc2626'),
    'Detail polyline must paint verified multi-bus stall 7 km/h in Red #dc2626');
  assert.ok(styledFeats.some((f) => f.props.source === 'BUS_API' && f.props.speedKmh === 12 && f.style.color === '#f59e0b'),
    'Detail polyline must paint moderate 12 km/h in Amber #f59e0b');
  assert.ok(styledFeats.some((f) => f.props.source === 'BUS_API' && f.props.speedKmh === 28 && f.style.color === '#16a34a'),
    'Detail polyline must paint smooth 28 km/h BUS_API in Green #16a34a');
  assert.ok(styledFeats.some((f) => f.props.source === 'BUS_EST' && f.props.speedKmh === 56 && f.style.color === '#16a34a'),
    'Detail polyline must paint smooth 56 km/h BUS_EST in Green #16a34a');
  assert.ok(tips.some((t) => t.includes('Bus ETA ·') && t.includes('Jammed') && !/km\/h/i.test(t)), `Expected qualitative Bus ETA Jammed tooltip without km/h, got: ${tips.join(' | ')}`);
  assert.ok(tips.some((t) => t.includes('Road Est. ·') && t.includes('Clear') && !/km\/h/i.test(t)), `Expected qualitative Road Est. Clear tooltip without km/h, got: ${tips.join(' | ')}`);
  assert.ok(!styledFeats.some((f) => f.style.color === '#3b82f6'), 'Detail polyline must NEVER emit Blue #3b82f6 features');
  assert.ok(!tips.some((t) => t.includes('no TD speed detector')), 'Detail polyline must NEVER emit "no TD speed detector" blue fallback tooltips');
});

test('E36 Yuen Long Polyline Continuity: upstream truncated CSDI (Stops 12 -> 13 -> 14), bypassed town detour, and 2-3 vertex consecutive stop spans stay connected', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const ensurePoly = sb.ctx.window.ensureRoutePolylineCoversStops;
  const pointToSeg = sb.ctx.window.pointToSegmentDistanceKm;
  assert.equal(typeof ensurePoly, 'function', 'ensureRoutePolylineCoversStops must be exported');

  // Helper: minimum distance in km from a stop point to any segment of a polyline
  const minDistToPolyKm = (poly: [number, number][], lat: number, lon: number) => {
    let best = Infinity;
    for (let i = 0; i < poly.length - 1; i++) {
      const p = pointToSeg(lat, lon, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
      if (p.distKm < best) best = p.distKm;
    }
    return best;
  };

  // Case 1: CSDI geometry starts downstream at Stop 14 (Shui Pin Wai), leaving Stops 12 (Fung Chi Tsuen) & 13 (San Shui House) upstream
  const yuenLongStops = [
    { seq: 12, stopName_e: 'Fung Chi Tsuen', name_tc: '鳳池村', latitude: '22.4478', longitude: '114.0176' },
    { seq: 13, stopName_e: 'San Shui House, Shui Pin Wai Estate', name_tc: '水邊圍邨山水樓', latitude: '22.4472', longitude: '114.0209' },
    { seq: 14, stopName_e: 'Shui Pin Wai', name_tc: '水邊圍', latitude: '22.4446', longitude: '114.0218' },
    { seq: 15, stopName_e: 'Yuen Long Plaza', name_tc: '元朗廣場', latitude: '22.4446', longitude: '114.0246' },
    { seq: 16, stopName_e: 'Tung Lok Street', name_tc: '同樂街', latitude: '22.4446', longitude: '114.0274' },
  ];
  const truncatedCsdi: [number, number][] = [
    [22.4446, 114.0218],
    [22.4446, 114.0232],
    [22.4446, 114.0246],
    [22.4446, 114.0260],
    [22.4446, 114.0274],
  ];

  const repairedLeading = ensurePoly(truncatedCsdi, yuenLongStops);
  assert.ok(repairedLeading.length > truncatedCsdi.length, 'Truncated upstream CSDI must prepend Stops 12 -> 13 -> 14');
  for (const s of yuenLongStops) {
    const dKm = minDistToPolyKm(repairedLeading, parseFloat(s.latitude), parseFloat(s.longitude));
    assert.ok(dKm <= 0.015, `Stop ${s.seq} (${s.stopName_e}) must lie on repaired polyline (got ${(dKm * 1000).toFixed(1)}m)`);
  }

  // Case 2: CSDI runs up Long Tin Rd straight onto Castle Peak Rd at Stop 14, bypassing Stops 12 & 13 ~350 m north
  const detourStops = [
    { seq: 11, stopName_e: 'Long Tin Road', name_tc: '朗天路', latitude: '22.4395', longitude: '114.0185' },
    ...yuenLongStops,
  ];
  const bypassedCsdi: [number, number][] = [
    [22.4395, 114.0185],
    [22.4420, 114.0198],
    [22.4446, 114.0210],
    [22.4446, 114.0218],
    [22.4446, 114.0246],
    [22.4446, 114.0274],
  ];
  const repairedDetour = ensurePoly(bypassedCsdi, detourStops);
  for (const s of detourStops) {
    const dKm = minDistToPolyKm(repairedDetour, parseFloat(s.latitude), parseFloat(s.longitude));
    assert.ok(dKm <= 0.015, `Bypassed stop ${s.seq} (${s.stopName_e}) must be spliced continuously onto polyline (got ${(dKm * 1000).toFixed(1)}m)`);
  }

  // Case 3: subdividePolylineMicroSteps & aggregateBusMicroStepsToCorridors preserve valid 2-3 vertex consecutive stop spans (12 -> 13, 13 -> 14)
  const twoPtSpan: [number, number][] = [[22.4478, 114.0176], [22.4472, 114.0209]]; // ~345 m
  const threePtSpan: [number, number][] = [[22.4478, 114.0176], [22.4472, 114.0209], [22.4446, 114.0218]]; // ~345 m + ~300 m
  const steps2 = engine.subdividePolylineMicroSteps(twoPtSpan, 50, { maxRawHopM: 250, allowConsecutiveStopSpans: true });
  const steps3 = engine.subdividePolylineMicroSteps(threePtSpan, 50, { maxRawHopM: 250, allowConsecutiveStopSpans: true });
  assert.ok(steps2.length >= 6, `2-vertex consecutive stop span 12 -> 13 must not be dropped (got ${steps2.length} micro-steps)`);
  assert.ok(steps3.length >= 12, `3-vertex consecutive stop span 12 -> 13 -> 14 must not be dropped (got ${steps3.length} micro-steps)`);

  const aggRes = engine.aggregateBusMicroStepsToCorridors(
    [
      {
        fromIdx: 0, toIdx: 1, fromSeq: 12, toSeq: 13,
        fromNameEn: 'Fung Chi Tsuen', toNameEn: 'San Shui House',
        source: 'BUS_API', tier: 'SMOOTH', speedKmh: 24, isRoadSnapped: false,
        coords: twoPtSpan,
      },
      {
        fromIdx: 1, toIdx: 2, fromSeq: 13, toSeq: 14,
        fromNameEn: 'San Shui House', toNameEn: 'Shui Pin Wai',
        source: 'BUS_API', tier: 'MODERATE', speedKmh: 12, isRoadSnapped: false,
        coords: [[22.4472, 114.0209], [22.4446, 114.0218]],
      },
    ],
    [],
    null,
    { allowConsecutiveStopSpans: true }
  );
  assert.ok(aggRes.corridors.length >= 2, `Expected both 2-vertex spans 12->13 and 13->14 preserved in corridors, got ${aggRes.corridors.length}`);

  // Case 4: buildDetailBusPolylineLayer renders a continuous polyline covering Stop 12 -> 13 -> 14 when given truncated CSDI geometry
  const renderedGeoFeats: any[] = [];
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __DETAIL_STOP_SEGMENTS__: [
        { fromIdx: 0, toIdx: 1, fromSeq: 12, toSeq: 13, fromNameEn: 'Fung Chi Tsuen', toNameEn: 'San Shui House', source: 'BUS_EST', tier: 'SMOOTH', speedKmh: 28 },
        { fromIdx: 1, toIdx: 2, fromSeq: 13, toSeq: 14, fromNameEn: 'San Shui House', toNameEn: 'Shui Pin Wai', source: 'BUS_API', tier: 'CONGESTED', speedKmh: 7, isVerifiedMultiBusStall: true },
        { fromIdx: 2, toIdx: 3, fromSeq: 14, toSeq: 15, fromNameEn: 'Shui Pin Wai', toNameEn: 'Yuen Long Plaza', source: 'BUS_API', tier: 'CONGESTED', speedKmh: 7, isVerifiedMultiBusStall: true },
        { fromIdx: 3, toIdx: 4, fromSeq: 15, toSeq: 16, fromNameEn: 'Yuen Long Plaza', toNameEn: 'Tung Lok Street', source: 'BUS_API', tier: 'MODERATE', speedKmh: 14 },
      ],
      ensureRoutePolylineCoversStops: ensurePoly,
      capBusApiTierHardcode: sb.ctx.window.capBusApiTierHardcode,
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: (arr: any[] = []) => ({ _arr: arr, addTo() { return this; }, clearLayers() {} }),
      polyline: (c: any, opts: any) => ({ c, opts, addTo() { return this; }, bindTooltip() { return this; } }),
      geoJSON: (geo: any, cfg: any) => {
        for (const feat of geo?.features || []) {
          renderedGeoFeats.push(feat);
          const lyr: any = { options: {}, bindTooltip() { return this; }, on() { return this; } };
          cfg.onEachFeature(feat, lyr);
        }
        return { addTo() { return this; } };
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(readMapBundle(), mapCtx);
  mapCtx.buildDetailBusPolylineLayer(truncatedCsdi, yuenLongStops, 0, '#FF3B30');

  const renderedFromSeqs = new Set(renderedGeoFeats.map((f) => f.properties?.fromSeq));
  assert.ok(renderedFromSeqs.has(12), 'Detail polyline must include Stop 12 -> 13 segment');
  assert.ok(renderedFromSeqs.has(13), 'Detail polyline must include Stop 13 -> 14 segment');
  assert.ok(renderedFromSeqs.has(14), 'Detail polyline must include Stop 14 -> 15 segment');
});

test('E36 Yuen Long Zero Off-By-One Span Projection: Stop 16 -> 17 (7 km/h Red) and Stop 17 -> 18 (19 km/h Green) align strictly to their own stop coordinates', () => {
  const sb = loadHardcodeAndPlannerSandbox();

  // Castle Peak Road (Yuen Long) eastbound stops with uneven road-snapped vertices
  const stops = [
    { seq: 15, stopName_e: 'Yuen Long Plaza', name_tc: '元朗廣場', latitude: '22.4446', longitude: '114.0240' },
    { seq: 16, stopName_e: 'Tung Lok Street', name_tc: '同樂街', latitude: '22.4446', longitude: '114.0272' },
    { seq: 17, stopName_e: 'Kuk Ting Street', name_tc: '谷亭街', latitude: '22.4446', longitude: '114.0305' },
    { seq: 18, stopName_e: 'Yoho Mall II', name_tc: '形點 II', latitude: '22.4446', longitude: '114.0342' },
    { seq: 19, stopName_e: 'Yoho Mall I', name_tc: '形點 I', latitude: '22.4446', longitude: '114.0378' },
  ];
  // Uneven CSDI polyline vertices that do NOT coincide with stop coordinates (tests orthogonal splitting!)
  const roadPoly: [number, number][] = [
    [22.4446, 114.0238],
    [22.4446, 114.0258],
    [22.4446, 114.0289],
    [22.4446, 114.0322],
    [22.4446, 114.0359],
    [22.4446, 114.0381],
  ];

  const stopSegments = [
    {
      fromIdx: 0, toIdx: 1, fromSeq: 15, toSeq: 16,
      fromNameEn: 'Yuen Long Plaza', toNameEn: 'Tung Lok Street',
      source: 'BUS_API', tier: 'CONGESTED', speedKmh: 7, matchedBusCount: 2, isVerifiedMultiBusStall: true,
    },
    {
      fromIdx: 1, toIdx: 2, fromSeq: 16, toSeq: 17,
      fromNameEn: 'Tung Lok Street', toNameEn: 'Kuk Ting Street',
      source: 'BUS_API', tier: 'CONGESTED', speedKmh: 7, matchedBusCount: 2, isVerifiedMultiBusStall: true,
    },
    {
      fromIdx: 2, toIdx: 3, fromSeq: 17, toSeq: 18,
      fromNameEn: 'Kuk Ting Street', toNameEn: 'Yoho Mall II',
      source: 'BUS_API', tier: 'SMOOTH', speedKmh: 19, matchedBusCount: 2, isVerifiedMultiBusStall: false,
    },
    {
      fromIdx: 3, toIdx: 4, fromSeq: 18, toSeq: 19,
      fromNameEn: 'Yoho Mall II', toNameEn: 'Yoho Mall I',
      source: 'BUS_API', tier: 'MODERATE', speedKmh: 14, matchedBusCount: 1, isVerifiedMultiBusStall: false,
    },
  ];

  const fc = sb.ctx.window.buildRouteSpeedGeoJson(roadPoly, [], {
    isRoadSnapped: true,
    stops,
    stopSegments,
    ensureStopCoverage: true,
    noDataColor: '#3b82f6',
  });

  const feat16To17 = fc.features.find((f: any) => f.properties?.fromIdx === 1);
  const feat17To18 = fc.features.find((f: any) => f.properties?.fromIdx === 2);
  const feat18To19 = fc.features.find((f: any) => f.properties?.fromIdx === 3);
  assert.ok(feat16To17, 'Expected GeoJSON feature for Stop 16 -> 17 (Tung Lok Street -> Kuk Ting Street)');
  assert.ok(feat17To18, 'Expected GeoJSON feature for Stop 17 -> 18 (Kuk Ting Street -> Yoho Mall II)');
  assert.ok(feat18To19, 'Expected GeoJSON feature for Stop 18 -> 19 (Yoho Mall II -> Yoho Mall I)');

  // Exact colors: Stop 16 -> 17 = Red (#dc2626), Stop 17 -> 18 = Green (#16a34a), Stop 18 -> 19 = Amber (#f59e0b)
  assert.equal(feat16To17.properties.color, '#dc2626', 'Stop 16 -> 17 (7 km/h) must render Red #dc2626');
  assert.equal(feat16To17.properties.speedKmh, 7);
  assert.equal(feat17To18.properties.color, '#16a34a', 'Stop 17 -> 18 (19 km/h) must render Green #16a34a');
  assert.equal(feat17To18.properties.speedKmh, 19);
  assert.equal(feat18To19.properties.color, '#f59e0b', 'Stop 18 -> 19 (14 km/h) must render Amber #f59e0b');

  // Exact coordinate boundaries (GeoJSON coords are [lon, lat]): ZERO off-by-one shift or spillover past Stop 17!
  const lons16To17 = feat16To17.geometry.coordinates.map((c: number[]) => c[0]);
  const lons17To18 = feat17To18.geometry.coordinates.map((c: number[]) => c[0]);
  const lons18To19 = feat18To19.geometry.coordinates.map((c: number[]) => c[0]);

  const stop16Lon = 114.0272;
  const stop17Lon = 114.0305;
  const stop18Lon = 114.0342;
  const stop19Lon = 114.0378;
  const tolDeg = 0.00015; // ~15 m tolerance

  assert.ok(Math.abs(Math.min(...lons16To17) - stop16Lon) <= tolDeg,
    `Stop 16 -> 17 Red line must start at Stop 16 lon ${stop16Lon}, got ${Math.min(...lons16To17)}`);
  assert.ok(Math.abs(Math.max(...lons16To17) - stop17Lon) <= tolDeg,
    `Stop 16 -> 17 Red line must end strictly at Stop 17 lon ${stop17Lon} without spilling onto 17->18, got ${Math.max(...lons16To17)}`);

  assert.ok(Math.abs(Math.min(...lons17To18) - stop17Lon) <= tolDeg,
    `Stop 17 -> 18 Green line must start strictly at Stop 17 lon ${stop17Lon}, got ${Math.min(...lons17To18)}`);
  assert.ok(Math.abs(Math.max(...lons17To18) - stop18Lon) <= tolDeg,
    `Stop 17 -> 18 Green line must end strictly at Stop 18 lon ${stop18Lon} without shifting onto 18->19, got ${Math.max(...lons17To18)}`);

  assert.ok(Math.abs(Math.min(...lons18To19) - stop18Lon) <= tolDeg,
    `Stop 18 -> 19 Amber line must start strictly at Stop 18 lon ${stop18Lon}, got ${Math.min(...lons18To19)}`);
  assert.ok(Math.abs(Math.max(...lons18To19) - stop19Lon) <= tolDeg,
    `Stop 18 -> 19 Amber line must end strictly at Stop 19 lon ${stop19Lon}, got ${Math.max(...lons18To19)}`);

  // Verify buildDetailBusPolylineLayer renders the exact same Red (16->17) and Green (17->18) styles & tooltips
  const styledByFromSeq = new Map<number, { color: string; tip: string }>();
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __DETAIL_STOP_SEGMENTS__: stopSegments,
      ensureRoutePolylineCoversStops: sb.ctx.window.ensureRoutePolylineCoversStops,
      capBusApiTierHardcode: sb.ctx.window.capBusApiTierHardcode,
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: (arr: any[] = []) => ({ _arr: arr, addTo() { return this; }, clearLayers() {} }),
      polyline: (c: any, opts: any) => ({ c, opts, addTo() { return this; }, bindTooltip() { return this; } }),
      geoJSON: (geo: any, cfg: any) => {
        for (const feat of geo?.features || []) {
          const st = cfg.style(feat);
          let tip = '';
          const lyr: any = { options: {}, bindTooltip(t: string) { tip = t; return this; }, on() { return this; } };
          cfg.onEachFeature(feat, lyr);
          if (feat.properties?.fromSeq) {
            styledByFromSeq.set(feat.properties.fromSeq, { color: st.color, tip });
          }
        }
        return { addTo() { return this; } };
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(readMapBundle(), mapCtx);
  mapCtx.buildDetailBusPolylineLayer(roadPoly, stops, 0, '#FF3B30');

  assert.equal(styledByFromSeq.get(16)?.color, '#dc2626', 'Map layer Stop 16 -> 17 must be Red');
  assert.ok(styledByFromSeq.get(16)?.tip.includes('Tung Lok Street → Kuk Ting Street') && styledByFromSeq.get(16)?.tip.includes('Jammed') && !/km\/h/i.test(styledByFromSeq.get(16)?.tip || ''),
    `Unexpected Stop 16 -> 17 tooltip: ${styledByFromSeq.get(16)?.tip}`);
  assert.equal(styledByFromSeq.get(17)?.color, '#16a34a', 'Map layer Stop 17 -> 18 must be Green');
  assert.ok(styledByFromSeq.get(17)?.tip.includes('Kuk Ting Street → Yoho Mall II') && styledByFromSeq.get(17)?.tip.includes('Clear') && !/km\/h/i.test(styledByFromSeq.get(17)?.tip || ''),
    `Unexpected Stop 17 -> 18 tooltip: ${styledByFromSeq.get(17)?.tip}`);
});

test('Global Zero-Blue & CSDI Direction Fix: Scheduled-only stops (E36 1-6) use busspeed.js Green (zero #3b82f6) and CSDI selects natural ROUTE_SEQ=2 over reversed ROUTE_SEQ=1', () => {
  // 1. Verify worker.js CSDI direction selector picks true natural ROUTE_SEQ=2 over reversed ROUTE_SEQ=1 when termini match
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8')
    .replace(/export async function onRequest/g, 'async function onRequest');
  const wCtx: any = { Math, Number, String, Array, Map, Set, Object, URL, URLSearchParams, Response, console };
  vm.createContext(wCtx);
  vm.runInContext(workerSrc, wCtx);
  assert.equal(typeof wCtx.selectBestCsdiBusGeometry, 'function');
  assert.equal(typeof wCtx.evaluatePolylineStopCoverage, 'function');

  // Shared endpoints A (Airport) & B (Pat Heung), but ROUTE_SEQ=1 runs via South road (B->A) while ROUTE_SEQ=2 runs via North detour (A->B)
  const seq1Outbound = {
    type: 'Feature',
    properties: { ROUTE_ID: 1000025, ROUTE_NAMEE: 'E36', ROUTE_SEQ: 1, COMPANY_CODE: 'LWB' },
    geometry: {
      type: 'LineString',
      coordinates: [
        [114.0623, 22.4203], // Pat Heung (start of outbound)
        [114.0250, 22.4445], // Castle Peak Rd south
        [114.0180, 22.4445], // Castle Peak Rd west (skips Fung Chi Tsuen / San Shui House!)
        [113.9378, 22.3133], // Airport (end of outbound)
      ],
    },
  };
  const seq2Inbound = {
    type: 'Feature',
    properties: { ROUTE_ID: 1000025, ROUTE_NAMEE: 'E36', ROUTE_SEQ: 2, COMPANY_CODE: 'LWB' },
    geometry: {
      type: 'LineString',
      coordinates: [
        [113.9378, 22.3133], // Airport (start of inbound)
        [114.0176, 22.4478], // Fung Chi Tsuen (Stop 12)
        [114.0209, 22.4472], // San Shui House (Stop 13)
        [114.0355, 22.4465], // Yoho Mall detour (Stop 18/19)
        [114.0623, 22.4203], // Pat Heung (end of inbound)
      ],
    },
  };
  const inboundStops: [number, number][] = [
    [22.3133, 113.9378],
    [22.4478, 114.0176],
    [22.4472, 114.0209],
    [22.4465, 114.0355],
    [22.4203, 114.0623],
  ];
  const pickedInbound = wCtx.selectBestCsdiBusGeometry([seq1Outbound, seq2Inbound], {
    company: 'LWB',
    bound: 'I',
    origPt: inboundStops[0],
    destPt: inboundStops[inboundStops.length - 1],
    stopPts: inboundStops,
  });
  assert.ok(pickedInbound && Array.isArray(pickedInbound.coords), 'Expected CSDI inbound selection');
  const covInbound = wCtx.evaluatePolylineStopCoverage(pickedInbound.coords, inboundStops);
  assert.equal(covInbound.uncovered90, 0, `Inbound ROUTE_SEQ=2 must cover all stops <=90m, got ${covInbound.uncovered90} uncovered (max ${(covInbound.maxDistKm * 1000).toFixed(0)}m)`);
  // Even without bound hint, natural ROUTE_SEQ=2 + stop coverage must beat reversed ROUTE_SEQ=1!
  const pickedNoBound = wCtx.selectBestCsdiBusGeometry([seq1Outbound, seq2Inbound], {
    company: 'LWB',
    bound: '',
    origPt: inboundStops[0],
    destPt: inboundStops[inboundStops.length - 1],
    stopPts: inboundStops,
  });
  const covNoBound = wCtx.evaluatePolylineStopCoverage(pickedNoBound.coords, inboundStops);
  assert.equal(covNoBound.uncovered90, 0, 'Natural ROUTE_SEQ=2 must win even when bound parameter is omitted');

  // 2. Verify scheduled-only BUS_API segments (e.g. E36 Stops 1-6 late evening) + leading/trailing tails NEVER render Blue #3b82f6
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  const t0 = Date.UTC(2026, 10, 27, 13, 56, 0);
  const e36AirportStops = [
    { seq: 1, stopName_e: 'Airport (Ground Transportation Centre)', latitude: '22.3156', longitude: '113.9369' },
    { seq: 2, stopName_e: 'Cathay City', latitude: '22.3016', longitude: '113.9333' },
    { seq: 3, stopName_e: 'Airport Freight Forwarding Centre', latitude: '22.2950', longitude: '113.9278' },
    { seq: 4, stopName_e: 'Asia Airfreight Terminal', latitude: '22.2932', longitude: '113.9218' },
    { seq: 5, stopName_e: 'Tung Chung Cable Car Terminal', latitude: '22.2899', longitude: '113.9384' },
    { seq: 6, stopName_e: 'Pat Heung Road Bus Terminus', latitude: '22.4203', longitude: '114.0623' },
  ];
  // Scheduled-only ETAs at Stops 1..4 (like 22:15 Scheduled Bus at Airport)
  const schedEtas: Record<number, any[]> = {
    0: [{ eta: new Date(t0 + 19 * 60_000).toISOString(), rmk_en: 'Scheduled Bus' }],
    1: [{ eta: new Date(t0 + 23 * 60_000).toISOString(), rmk_en: 'Scheduled Bus' }],
    2: [{ eta: new Date(t0 + 25 * 60_000).toISOString(), rmk_en: 'Scheduled Bus' }],
    3: [{ eta: new Date(t0 + 27 * 60_000).toISOString(), rmk_en: 'Scheduled Bus' }],
  };
  const polyWithTails: [number, number][] = [
    [22.3168, 113.9375], // Leading tail inside Airport GTC before Stop 1
    [22.3156, 113.9369],
    [22.3016, 113.9333],
    [22.2950, 113.9278],
    [22.2932, 113.9218],
    [22.2899, 113.9384],
    [22.4203, 114.0623],
    [22.4212, 114.0630], // Trailing tail past last stop
  ];
  const inferred = engine.inferBusApiSegmentSpeeds(e36AirportStops, schedEtas, polyWithTails, {
    routeNo: 'E36',
    company: 'LWB',
    includeSyntheticFallback: true,
    nowMs: t0,
  });
  const unified = engine.buildStopByStopSegmentTraffic(e36AirportStops, polyWithTails, [], [], inferred, { routeNo: 'E36', company: 'LWB' });
  assert.equal(unified.length, e36AirportStops.length - 1);
  assert.ok(unified.every((u: any) => u.source === 'BUS_API' || u.source === 'BUS_EST'),
    `Every stop span must be backed by BUS_API or BUS_EST (no NONE), got: ${unified.map((u: any) => u.source).join(',')}`);

  const renderedStyles: { color: string; source: string; speedKmh: number }[] = [];
  const renderedTips: string[] = [];
  const mapCtx: any = {
    window: {
      trafficLayerEnabled: true,
      __LIVE_TRAFFIC_DETECTORS__: [],
      __DETAIL_STOP_SEGMENTS__: unified,
      __DETAIL_BUS_SPEED_SEGMENTS__: inferred,
      BusSpeedEngine: engine,
      buildStopByStopSegmentTraffic: engine.buildStopByStopSegmentTraffic,
      ensureRoutePolylineCoversStops: sb.ctx.window.ensureRoutePolylineCoversStops,
      capBusApiTierHardcode: sb.ctx.window.capBusApiTierHardcode,
      buildRouteSpeedGeoJson: sb.ctx.window.buildRouteSpeedGeoJson,
    },
    document: { getElementById: () => null },
    currentLang: 'en',
    L: {
      layerGroup: (arr: any[] = []) => ({ _arr: arr, addTo() { return this; } }),
      polyline: (c: any, opts: any) => ({ c, opts, addTo() { return this; }, bindTooltip(t: string) { renderedTips.push(t); return this; } }),
      geoJSON: (geo: any, cfg: any) => {
        for (const feat of geo?.features || []) {
          const st = cfg.style(feat);
          renderedStyles.push({ color: st.color, source: feat.properties?.source, speedKmh: feat.properties?.speedKmh });
          const lyr: any = { options: {}, bindTooltip(t: string) { renderedTips.push(t); return this; }, on() { return this; } };
          cfg.onEachFeature(feat, lyr);
        }
        return { addTo() { return this; } };
      },
    },
    console, Math, Number, String, Array, Map, Set, Object,
  };
  vm.createContext(mapCtx);
  vm.runInContext(readMapBundle(), mapCtx);
  mapCtx.buildDetailBusPolylineLayer(polyWithTails, e36AirportStops, 0, '#FF3B30');

  assert.ok(renderedStyles.length >= 5, 'Expected rendered GeoJSON speed segments across all E36 spans + tails');
  assert.ok(renderedStyles.every((s) => s.color !== '#3b82f6'),
    `ZERO Blue (#3b82f6) segments permitted on bus routes, got: ${JSON.stringify(renderedStyles)}`);
  assert.ok(renderedStyles.every((s) => s.color === '#16a34a'),
    `Scheduled-only & synthetic spans must render Smooth Green (#16a34a), got: ${JSON.stringify(renderedStyles)}`);
  assert.ok(!renderedTips.some((t) => /no TD speed detector/i.test(t)),
    `Tooltips must never show "no TD speed detector", got: ${renderedTips.join(' | ')}`);
});

test('iOS PWA Journey Bar Containment: zero horizontal overflow CSS (min-width: 0, overflow: hidden) and long-route compaction preserving alerts', () => {
  const css = fs.readFileSync('public/app.css', 'utf8');
  const etaSrc = fs.readFileSync('public/eta-engine.js', 'utf8');

  // 1. CSS guarantees zero overflow on iOS Safari PWA
  const segRuleMatch = css.match(/\.traffic-journey-seg\s*\{[^}]+\}/);
  assert.ok(segRuleMatch, '.traffic-journey-seg CSS rule must exist');
  assert.ok(segRuleMatch[0].includes('min-width: 0'), '.traffic-journey-seg must use min-width: 0 so 45+ stop routes never burst out of the card');
  assert.ok(!segRuleMatch[0].includes('min-width: 8px'), '.traffic-journey-seg must NOT hardcode min-width: 8px');
  assert.ok(segRuleMatch[0].includes('-webkit-appearance: none'), '.traffic-journey-seg must disable iOS WebKit default button sizing');

  const barRuleMatch = css.match(/\.traffic-journey-bar\s*\{[^}]+\}/);
  assert.ok(barRuleMatch && barRuleMatch[0].includes('overflow: hidden') && barRuleMatch[0].includes('max-width: 100%'),
    '.traffic-journey-bar must enforce max-width: 100% and overflow: hidden');

  const stopListMatch = css.match(/#stop-list-container\s*\{[^}]+\}/);
  assert.ok(stopListMatch && stopListMatch[0].includes('overflow-x: hidden'),
    '#stop-list-container must enforce overflow-x: hidden on iOS PWA');

  const hudBoxMatch = css.match(/\.last60-hud-box\s*\{[^}]+\}/);
  assert.ok(hudBoxMatch && hudBoxMatch[0].includes('overflow: hidden') && hudBoxMatch[0].includes('min-width: 0'),
    '.last60-hud-box must enforce min-width: 0 and overflow: hidden');

  // 2. Long route (e.g. NLB 1 To Tai O with 46 legs) compacts consecutive green legs while keeping Slow/Jammed alerts distinct
  assert.ok(etaSrc.includes('normalizedLegs.length <= 18') && etaSrc.includes('const maxChunk = Math.max(2, Math.ceil(normalizedLegs.length / 16))'),
    'eta-engine.js must compact long-route (>18 legs) consecutive same-tone spans');
  assert.ok(etaSrc.includes('data-density="ultra-dense"') && etaSrc.includes('data-density="dense"'),
    'eta-engine.js must apply data-density attributes for high-density bars');
});

test('Low-Noise Traffic Card, Confidence Model, Neutral Signals & Saturday Morning False-Positive Guards (E36 Stop 12 & NLB 3M)', () => {
  const sb = loadHardcodeAndPlannerSandbox();
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, globalThis: bsWindow, Math, Date, Number, String, Array, Map, Set, Object, Uint8Array, parseFloat, isFinite };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;

  // 1. E36 Stop 12 (Fung Chi Tsuen) -> Stop 13 (San Shui House): 56 m straight-line across signalized U-turn loop on Saturday 08:28 HKT
  // Even if 2 consecutive buses take 3 minutes across the traffic-light U-turn, MUST NEVER flag CONGESTED (Red) or Multi-Bus Stall!
  const satMorningMs = Date.parse('2026-11-28T08:28:00+08:00');
  const e36Stop12Stops = [
    { stopKey: 'E12', stopName_e: 'Fung Chi Tsuen', name_tc: '鳳池村', latitude: '22.44644', longitude: '114.01946' },
    { stopKey: 'E13', stopName_e: 'San Shui House, Shui Pin Wai Estate', name_tc: '水邊圍邨山水樓', latitude: '22.44621', longitude: '114.01994' },
    { stopKey: 'E14', stopName_e: 'Shui Pin Wai Estate', name_tc: '水邊圍邨', latitude: '22.44460', longitude: '114.02180' },
  ];
  const e36UTurnPoly: [number, number][] = [
    [22.44644, 114.01946],
    [22.44735, 114.02115], // U-turn apex on Wang Tat Rd
    [22.44621, 114.01994], // San Shui House on Ma Wang Rd
    [22.44460, 114.02180], // Shui Pin Wai Estate
  ];
  const e36SatEtas = {
    0: [
      { eta: new Date(satMorningMs + 2 * 60000).toISOString(), seq: 1 },
      { eta: new Date(satMorningMs + 14 * 60000).toISOString(), seq: 2 },
    ],
    1: [
      { eta: new Date(satMorningMs + 5 * 60000).toISOString(), seq: 1 }, // 3 min across traffic-light U-turn
      { eta: new Date(satMorningMs + 17 * 60000).toISOString(), seq: 2 }, // 3 min across traffic-light U-turn
    ],
    2: [
      { eta: new Date(satMorningMs + 6 * 60000).toISOString(), seq: 1 }, // 1 min smooth downstream
      { eta: new Date(satMorningMs + 18 * 60000).toISOString(), seq: 2 },
    ],
  };
  const e36SatSegs = engine.inferBusApiSegmentSpeeds(e36Stop12Stops, e36SatEtas, e36UTurnPoly, {
    company: 'LWB', routeNo: 'E36', nowMs: satMorningMs, tdDetectors: [],
  });
  assert.ok(e36SatSegs.length >= 1, 'Expected E36 Stop 12 -> 13 segment');
  assert.equal(e36SatSegs[0].isShortUrbanTurn, true, '56m straight-line U-turn loop at E36 Stop 12 must set isShortUrbanTurn=true');
  assert.equal(e36SatSegs[0].tier, 'SMOOTH', `E36 Stop 12 on Saturday 08:28 HKT must classify SMOOTH, got ${e36SatSegs[0].tier}`);
  assert.equal(e36SatSegs[0].isVerifiedMultiBusStall, false, 'Short U-turn loop must NEVER flag isVerifiedMultiBusStall');
  assert.equal(e36SatSegs[0].confidence, 'LOW', 'Short U-turn Bus ETA segment must carry LOW confidence');

  // 2. NLB 3M Saturday 08:25 HKT: rural South Lantau winding corridor at ~17 km/h must classify SMOOTH (Clear), NOT propagate Slow across stops 1-12
  const nlb3mSatMs = Date.parse('2026-11-28T08:25:00+08:00');
  const nlb3mStops = [
    { stopKey: 'N11', stopName_e: 'Pui O Petrol Station, South Lantau Road', name_tc: '貝澳油站，嶼南道', latitude: '22.2442', longitude: '113.9788' },
    { stopKey: 'N12', stopName_e: 'Lo Wai Tsuen, South Lantau Road', name_tc: '老圍村，嶼南道', latitude: '22.2435', longitude: '113.9760' },
    { stopKey: 'N13', stopName_e: 'Sun Wai Tsuen, South Lantau Road', name_tc: '新圍村，嶼南道', latitude: '22.2428', longitude: '113.9749' }, // ~139m rural hop
  ];
  const nlb3mEtas = {
    0: [{ targetMs: nlb3mSatMs + 2 * 60000, rawTargetMs: nlb3mSatMs + 2 * 60000, isSched: false }],
    1: [{ targetMs: nlb3mSatMs + 3 * 60000, rawTargetMs: nlb3mSatMs + 3 * 60000, isSched: false }],
    2: [{ targetMs: nlb3mSatMs + 4 * 60000, rawTargetMs: nlb3mSatMs + 4 * 60000, isSched: false }], // 1-min step across 139m rural hop (~17 km/h)
  };
  const nlb3mSegs = engine.inferBusApiSegmentSpeeds(nlb3mStops, nlb3mEtas, null, {
    company: 'NLB', routeNo: '3M', nowMs: nlb3mSatMs, tdDetectors: [],
  });
  assert.ok(nlb3mSegs.length >= 2);
  nlb3mSegs.forEach((s: any) => {
    assert.equal(s.tier, 'SMOOTH', `NLB 3M Saturday morning rural stop span ${s.fromSeq}->${s.toSeq} must be SMOOTH, got ${s.tier}`);
  });

  // 3. Traffic Confidence Model: TD -> HIGH; multi-bus >= 450m live non-short non-rural BUS_API -> MEDIUM; short/single/rural/scheduled/BUS_EST -> LOW
  assert.equal(engine.computeTrafficConfidence({ source: 'TD' }).level, 'HIGH');
  assert.equal(engine.computeTrafficConfidence({ source: 'BUS_EST', isSyntheticFallback: true }).level, 'LOW');
  assert.equal(engine.computeTrafficConfidence({ source: 'BUS_API', matchedBusCount: 2, roadDistKm: 0.95, isShortUrbanTurn: false, isRuralWinding: false, allRounded: false }).level, 'MEDIUM');
  assert.equal(engine.computeTrafficConfidence({ source: 'BUS_API', matchedBusCount: 1, roadDistKm: 0.95 }).level, 'LOW');
  assert.equal(engine.computeTrafficConfidence({ source: 'BUS_API', matchedBusCount: 3, roadDistKm: 0.18, isShortUrbanTurn: true }).level, 'LOW');
  assert.equal(engine.computeTrafficConfidence({ source: 'BUS_API', matchedBusCount: 2, roadDistKm: 1.2, isRuralWinding: true }).level, 'LOW');
  assert.equal(engine.computeTrafficConfidence({ source: 'BUS_API', matchedBusCount: 2, roadDistKm: 1.2, isScheduledOnly: true }).level, 'LOW');

  // 4. Neutral signals & zero km/h across hardcode.js, app-ui.js, and eta-engine.js
  const hardcodeSrc = fs.readFileSync('public/hardcode.js', 'utf8');
  const appUiSrc = fs.readFileSync('public/app-ui.js', 'utf8');
  const etaSrc = fs.readFileSync('public/eta-engine.js', 'utf8');
  assert.ok(!/Switch to MTR|MTR may be faster|compare MTR|Take Bus|改乘港鐵|港鐵或較快|可乘巴士/.test(hardcodeSrc),
    'hardcode.js must never emit assumptive MTR or Take Bus recommendations');
  assert.ok(appUiSrc.includes("if (seg.source !== 'CAM_ONLY' && dispTier === 'SMOOTH')") && appUiSrc.includes("slotEl.innerHTML = '';"),
    'app-ui.js must suppress stop-row pills for Clear (SMOOTH) segments so green colour stripe speaks cleanly');
  assert.ok(appUiSrc.includes('data-seg-confidence=') && !appUiSrc.includes('🚌 Bus API •') && !appUiSrc.includes('🚌 Bus ETA ·'),
    'app-ui.js stop pills must attach confidence attribute without Bus ETA/conf. jargon or km/h numbers');
  assert.ok(!etaSrc.includes('class="traffic-road-status-bar') && !etaSrc.includes('class="traffic-inline-breakdown"'),
    'eta-engine.js must omit redundant banner box and vertical Details breakdown list in favor of the unified Journey Strip');
});

test('Exact Detector-to-Camera Colocation & Localized Journey Strip TD Sub-Segments (E36 Lung Fu Rd TDSLFR10001 vs Wong Chu Rd TDSLFR10002 vs Siu Hong TDS90053)', () => {
  const bsWindow: any = {};
  const bsSandbox: any = { window: bsWindow, console, Math, Date, Number, String, Array, Object, Set, Map, RegExp, JSON, isNaN, isFinite, parseFloat, parseInt };
  vm.createContext(bsSandbox);
  vm.runInContext(readHardcodeBundle(), bsSandbox);
  vm.runInContext(fs.readFileSync('public/busspeed.js', 'utf8'), bsSandbox);
  const engine: any = bsWindow.BusSpeedEngine;
  const hc = loadHardcodeAndPlannerSandbox();

  // Realistic E36 #11 (TM-CLK Tunnel BBI) -> #12 (Fung Chi Tsuen) polyline crossing:
  // 1) Lung Fu Rd near Wong Chu Rd EB (TDSLFR10001, Jammed 13 km/h, 71% occ, ~15m lateral)
  // 2) Wong Chu Rd near Hoi Wong Rd EB (TDSLFR10002, Slow 16 km/h, 63% occ, ~12m lateral)
  // 3) Tuen Mun Rd near Siu Hong MTR Station NB (TDS90053, Clear 62 km/h, 12% occ, ONLY ~2m lateral!)
  const e36SpanCoords = [
    [22.3716, 113.9636], // Stop 11: TM-CLK Tunnel BBI
    [22.3820, 113.9660], // Lung Fu Rd approach
    [22.3855, 113.9690], // Lung Fu Rd near Wong Chu Rd (EB ~105 deg)
    [22.3845, 113.9745], // Wong Chu Rd near Hoi Wong Rd (EB ~98 deg)
    [22.3840, 113.9790], // Tuen Mun Rd turn NB
    [22.4000, 113.9785], // Tuen Mun Rd Town Centre NB
    [22.4125, 113.9788], // Tuen Mun Rd near Siu Hong MTR Stn NB
    [22.4320, 113.9960], // Yuen Long Highway
    [22.4455, 114.0172], // Stop 12: Fung Chi Tsuen
  ];
  const fromStop = { stopId: 'E36_11', stopName_e: 'Tuen Mun Chek Lap Kok Tunnel BBI', name_tc: '屯門赤鱲角隧道轉車站', latitude: '22.3716', longitude: '113.9636' };
  const toStop = { stopId: 'E36_12', stopName_e: 'Fung Chi Tsuen', name_tc: '鳳池村', latitude: '22.4455', longitude: '114.0172' };

  const tdDetectors = [
    {
      id: 'TDSLFR10001',
      camKey: 'TDSLFR10001',
      lat: 22.3854,
      lon: 113.9702,
      spd: 13,
      occ: 71,
      tier: 'JAMMED',
      rot: 100,
      roadEn: 'Lung Fu Road near Wong Chu Road - Eastbound',
      roadTc: '龍富路近皇珠路 - 東行'
    },
    {
      id: 'TDSLFR10002',
      camKey: 'TDSLFR10002',
      lat: 22.3844,
      lon: 113.9752,
      spd: 16,
      occ: 63,
      tier: 'SLOW',
      rot: 96,
      roadEn: 'Wong Chu Road near Hoi Wong Road - Eastbound',
      roadTc: '皇珠路近海皇路 - 東行'
    },
    {
      id: 'TDS90053',
      camKey: 'TDS90053',
      lat: 22.4125,
      lon: 113.9788, // Dead-center on polyline (~0m lateral — closer than TDSLFR10001!)
      spd: 62,
      occ: 12,
      tier: 'SMOOTH',
      rot: 1,
      roadEn: 'Tuen Mun Road near Siu Hong MTR Station - Northbound (2)',
      roadTc: '屯門公路近兆康港鐵站 - 北行(2)'
    }
  ];

  const tdCameras = [
    { key: 'TDSLFR10001', lat: 22.38535, lon: 113.97025, desc: 'Lung Fu Road near Wong Chu Road - Eastbound', bearingDeg: 100 },
    { key: 'TDSLFR10002', lat: 22.38435, lon: 113.97525, desc: 'Wong Chu Road near Hoi Wong Road - Eastbound', bearingDeg: 96 },
    { key: 'TDS90053', lat: 22.4125, lon: 113.9788, desc: 'Tuen Mun Road near Siu Hong MTR Station - Northbound (2)', bearingDeg: 1 },
  ];

  // 1. Focus detector TDSLFR10001 MUST pair with camera TDSLFR10001 (NEVER TDS90053 Siu Hong even though TDS90053 is laterally closer!)
  const tdTruth = engine.matchTdGroundTruthForSpan(e36SpanCoords, tdDetectors, tdCameras, {
    fromStop, toStop, roadDistKm: 13.8, isRoadSnapped: true, routeNo: 'E36'
  });
  assert.equal(tdTruth.hasTd, true);
  assert.equal(tdTruth.tdDetId, 'TDSLFR10001');
  assert.equal(tdTruth.tdTier, 'CONGESTED');
  assert.ok(tdTruth.cam, 'Colocated TDSLFR10001 camera must be paired');
  assert.equal(tdTruth.cam.key, 'TDSLFR10001', 'Must pair Lung Fu Rd camera TDSLFR10001, NEVER distant Siu Hong camera TDS90053');

  // 2. Ordered localized tdSubSegments must expose all 3 detectors in exact route order with their own cameras & tiers
  assert.ok(Array.isArray(tdTruth.tdSubSegments) && tdTruth.tdSubSegments.length === 3,
    `Expected 3 ordered tdSubSegments along E36 #11->#12, got ${tdTruth.tdSubSegments?.length}`);
  assert.equal(tdTruth.tdSubSegments[0].detId, 'TDSLFR10001');
  assert.equal(tdTruth.tdSubSegments[0].tier, 'CONGESTED');
  assert.equal(tdTruth.tdSubSegments[0].camKey, 'TDSLFR10001');
  assert.equal(tdTruth.tdSubSegments[1].detId, 'TDSLFR10002');
  assert.equal(tdTruth.tdSubSegments[1].tier, 'MODERATE');
  assert.equal(tdTruth.tdSubSegments[1].camKey, 'TDSLFR10002');
  assert.equal(tdTruth.tdSubSegments[2].detId, 'TDS90053');
  assert.equal(tdTruth.tdSubSegments[2].tier, 'SMOOTH');
  assert.equal(tdTruth.tdSubSegments[2].camKey, 'TDS90053');

  // 3. Detector WITHOUT any colocated camera (only distant TDS90053 camera exists 3+ km away) -> cam MUST be null (detector-only view!)
  const detOnlyList = [
    { ...tdDetectors[0], camKey: '' }, // Lung Fu Rd detector without camera
    tdDetectors[2]
  ];
  const camOnlySiuHong = [tdCameras[2]]; // Only Siu Hong camera 3 km away
  const tdTruthDetOnly = engine.matchTdGroundTruthForSpan(e36SpanCoords, detOnlyList, camOnlySiuHong, {
    fromStop, toStop, roadDistKm: 13.8, isRoadSnapped: true, routeNo: 'E36'
  });
  assert.equal(tdTruthDetOnly.tdDetId, 'TDSLFR10001');
  assert.equal(tdTruthDetOnly.cam, null, 'Must NEVER attach distant TDS90053 camera onto TDSLFR10001 when no camera exists within 350m');
  assert.equal(tdTruthDetOnly.tdSubSegments[0].camKey, '', 'TDSLFR10001 sub-segment must stay detector-only');
  assert.equal(tdTruthDetOnly.tdSubSegments[1].camKey, 'TDS90053', 'Siu Hong sub-segment keeps its own colocated TDS90053 camera');

  // 4. Slow traffic modal consistency: 16 km/h, 72% occ, raw JAMMED -> Tier 2 Slow traffic headline MUST use tone='slow' (not red Jammed dot)
  const slowVerdict = hc.synthesizeTrafficDecision({
    status: 'JAMMED', avgSpd: 16, minSpd: 16, maxOcc: 72, estDelayMins: 9,
    worstDet: { id: 'TDSLFR10001', spd: 16, occ: 72, tier: 'JAMMED', roadEn: 'Lung Fu Road near Wong Chu Road - Eastbound', roadTc: '龍富路近皇珠路 - 東行' }
  }, null, false);
  assert.equal(slowVerdict.tone, 'slow', 'Slow traffic headline (+9m at 16 km/h) must have tone="slow" so dot & metric match headline');
  assert.match(slowVerdict.verdictEn, /^Slow traffic on Lung Fu Road/);

  // 5. UI wiring checks: Journey Strip expands tdSubSegments, passes detId to focusJourneySegmentOnDetailMap, and app-ui enforces _isCamColocatedWithDet
  const etaSrc = fs.readFileSync('public/eta-engine.js', 'utf8');
  const overlaySrc = fs.readFileSync('public/map-traffic-overlay.js', 'utf8');
  const appUiSrc = fs.readFileSync('public/app-ui.js', 'utf8');
  assert.ok(etaSrc.includes('seg.tdSubSegments') && etaSrc.includes('data-det-id='), 'eta-engine.js must expand tdSubSegments onto the Journey Strip with data-det-id');
  assert.ok(overlaySrc.includes('function focusJourneySegmentOnDetailMap(fromIdx, detId = \'\')'), 'map-traffic-overlay.js must focus exact sub-segment by detId');
  assert.ok(appUiSrc.includes('window.openStopSegmentTrafficModal = function(fromIdx, detId = \'\')') && appUiSrc.includes('_isCamColocatedWithDet'),
    'app-ui.js must resolve exact tdSubSegment by detId and enforce spatial colocation guard on cameras');
});

test('Minimal Clutter-Free Bus Card: No Banner Box, No Vertical Breakdown, No Bus ETA/Conf Jargon, Unified Alert Strip Header & Plain-English Modals', () => {
  const etaSrc = fs.readFileSync('public/eta-engine.js', 'utf8');
  const appUiSrc = fs.readFileSync('public/app-ui.js', 'utf8');
  const cssSrc = fs.readFileSync('public/app.css', 'utf8');

  // 1. Expanded bus card omits separate banner box, vertical breakdown list, and confidence acronyms
  assert.ok(!etaSrc.includes('traffic-road-status-bar'), 'Expanded bus card must NOT render the separate traffic banner box above the strip');
  assert.ok(!etaSrc.includes('traffic-inline-breakdown'), 'Expanded bus card must NOT render the redundant vertical Details breakdown list');
  assert.ok(!etaSrc.includes('Low conf.') && !etaSrc.includes('Med conf.') && !etaSrc.includes('High conf.'),
    'Expanded bus card must NOT render Low/Med/High conf. jargon');

  // 2. Journey Strip folds Slow/Jammed alert location cleanly into its single header line
  assert.ok(etaSrc.includes('traffic-journey-alert-head') && etaSrc.includes('const alertToneCls = hasAlertAhead ? ` tone-${roadSum.tone}` : \'\';'),
    'Journey Strip must fold Slow/Jammed location into the strip header with subtle alert tone');
  assert.ok(cssSrc.includes('.traffic-journey-bar-wrap.tone-slow') && cssSrc.includes('.traffic-journey-bar-wrap.tone-jammed'),
    'app.css must style subtle alert tones on .traffic-journey-bar-wrap');

  // 3. Collapsed stop pills omit Bus ETA / TD / conf. jargon and are hidden when stop card is expanded
  assert.ok(!appUiSrc.includes('🚌 Bus ETA ·') && !appUiSrc.includes('🚌 Road Est. ·'),
    'Collapsed stop pills must NOT show Bus ETA / Road Est. / conf. jargon');
  assert.ok(cssSrc.includes('.stop-item.active-stop .stop-seg-speed-slot { display: none; }'),
    'Expanded stop card must hide its redundant stop-row pill above the Journey Strip');

  // 4. Tap modals show plain-English source labels instead of conf. acronyms and execute cleanly without ReferenceError
  assert.ok(appUiSrc.includes("'Live Road Sensor'") && appUiSrc.includes("'Estimated from Bus Times'") && appUiSrc.includes("'Estimated from Road Flow'"),
    'Tap modals must show plain-English source labels');
  assert.ok(!appUiSrc.includes('confShort'), 'openStopSegmentTrafficModal must not reference undefined confShort');

  const modalFnMatch = appUiSrc.match(/window\.openStopSegmentTrafficModal = function\([\s\S]*?\n\};/);
  assert.ok(modalFnMatch, 'app-ui.js must define window.openStopSegmentTrafficModal');
  const mockEls: Record<string, any> = {
    trafficDecisionModal: { style: { display: 'none' } },
    trafficModalBody: { innerHTML: '' },
    trafficModalTitle: { innerText: '' },
    trafficModalSub: { innerHTML: '' },
    trafficModalCloseBtn: { innerText: '' },
  };
  const modalCtx: any = {
    window: {
      __DETAIL_STOP_SEGMENTS__: [
        {
          fromIdx: 14, toIdx: 15, fromSeq: 15, toSeq: 16,
          fromNameEn: 'Yuen Long Plaza', toNameEn: 'Tung Lok Street Yuen Long',
          source: 'BUS_API', tier: 'MODERATE', speedKmh: 12, roadDistKm: 0.42,
        },
        {
          fromIdx: 10, toIdx: 11, fromSeq: 11, toSeq: 12,
          fromNameEn: 'Yu Tung Court', toNameEn: 'TM-CLK Tunnel BBI',
          source: 'BUS_EST', isSyntheticFallback: true, tier: 'SMOOTH', speedKmh: 56, roadDistKm: 9.8,
        },
      ],
    },
    document: { getElementById: (id: string) => mockEls[id] || null },
    currentLang: 'en',
    triggerHaptic: () => {},
    escapeHtml: (s: any) => String(s ?? ''),
    escapeJsAttr: (s: any) => String(s ?? ''),
    buildTrafficCamProxyUrl: (k: string) => `/cam/${k}`,
    Date, Math, Number, String, Array, Boolean,
  };
  vm.createContext(modalCtx);
  vm.runInContext(modalFnMatch[0], modalCtx);

  modalCtx.window.openStopSegmentTrafficModal(14);
  assert.equal(mockEls.trafficDecisionModal.style.display, 'flex');
  assert.ok(mockEls.trafficModalBody.innerHTML.includes('Estimated from Bus Times'), 'BUS_API modal must show Estimated from Bus Times');
  assert.ok(mockEls.trafficModalBody.innerHTML.includes('Bus Times'), 'BUS_API modal metric box must show Bus Times source');
  assert.ok(!/Low conf\.|Med conf\.|High conf\./i.test(mockEls.trafficModalBody.innerHTML), 'BUS_API modal must omit conf. acronyms');

  modalCtx.window.openStopSegmentTrafficModal(10);
  assert.ok(mockEls.trafficModalBody.innerHTML.includes('Estimated from Road Flow'), 'BUS_EST modal must show Estimated from Road Flow');
  assert.ok(mockEls.trafficModalBody.innerHTML.includes('Road Flow'), 'BUS_EST modal metric box must show Road Flow source');
});

test('Weather-correlated bus load engine (weathercoorelation.js + bussurge.js), 25m rider report override, two-way sectional fare first-use auto-hide, and Saved tab drag-drop & 5s Undo snackbar', () => {
  // 1. Load weathercoorelation.js + bussurge.js + fare-load-engine.js in a clean VM matching browser load order
  const win: any = {
    __HKO_WEATHER__: null,
    __HK_PUBLIC_HOLIDAYS__: new Set(['2026-10-01']),
  };
  const memStore: Record<string, string> = {};
  const mockStorage = {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null),
    setItem: (k: string, v: string) => { memStore[k] = String(v); },
    removeItem: (k: string) => { delete memStore[k]; },
  };
  win.SafeStorage = mockStorage;
  const ctx: any = {
    window: win,
    globalThis: win,
    localStorage: mockStorage,
    SafeStorage: mockStorage,
    Date, Math, Number, String, Array, Object, Set, Map, JSON, parseFloat, parseInt, isFinite,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/transit-data.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/weathercoorelation.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/monthly_activity.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/hk-people-flow.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/bussurge.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/fare-load-engine.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/hardcode.js', 'utf8'), ctx);

  // 2. weathercoorelation.js rules
  const novSatMs = Date.parse('2026-11-28T07:36:00Z'); // 15:36 HKT Saturday (Nov -> Oct-Apr)
  const julSatMs = Date.parse('2026-07-18T07:36:00Z'); // 15:36 HKT Saturday (Jul -> May-Sep)
  assert.equal(win.getWeatherSurgeMultiplier(null, novSatMs), 1.2, 'Null HKO weather in Oct-Apr returns 1.2');
  assert.equal(win.getWeatherSurgeMultiplier(null, julSatMs), 1.0, 'Null HKO weather in May-Sep returns 1.0');
  assert.equal(win.getWeatherSurgeMultiplier({ warnings: ['RAIN'], temp: 22 }, novSatMs), 0.3, 'Rain warning returns 0.3');
  assert.equal(win.getWeatherSurgeMultiplier({ warnings: ['TC3'], temp: 24 }, novSatMs), 0.3, 'TC3 warning returns 0.3');
  assert.equal(win.getWeatherSurgeMultiplier({ warnings: ['TC8'], temp: 24 }, novSatMs), 0.3, 'TC8 warning returns 0.3');
  assert.equal(win.getWeatherSurgeMultiplier({ heavyRain: true }, novSatMs), 0.3, 'Live worker heavyRain returns 0.3');
  assert.equal(win.getWeatherSurgeMultiplier({ temp: 33, condition: 'Sunny' }, julSatMs), 0.5, 'Temp > 31 returns 0.5');
  assert.equal(win.getWeatherSurgeMultiplier({ temp: 10, condition: 'Clear' }, novSatMs), 0.6, 'Temp < 12 returns 0.6');
  assert.equal(win.getWeatherSurgeMultiplier({ temp: 22, condition: 'Clear', humidity: 60 }, novSatMs), 1.5, 'Dry clear 15-26°C returns 1.5');
  assert.equal(win.getWeatherSurgeMultiplier({ temp: 28, condition: 'Cloudy' }, julSatMs), 1.0, 'Default mild cloudy returns 1.0');

  // 3. bussurge.js leisure routing + weekend time multipliers + skip-stop HIGH_LOAD
  const nlb3mGroup = {
    key: 'NLB_3M_O',
    company: 'NLB',
    routeNo: '3M',
    orig_en: 'Tung Chung Station Bus Terminus',
    dest_en: 'Mui Wo Ferry Pier',
    orig_e: 'Tung Chung Station Bus Terminus',
    dest_e: 'Mui Wo Ferry Pier',
  };
  const urbanGroup = {
    key: 'KMB_1A_O',
    company: 'KMB',
    routeNo: '1A',
    orig_en: 'Sau Mau Ping',
    dest_en: 'Star Ferry',
  };

  const clearMildWx = { temp: 22, condition: 'Clear', humidity: 58, warnings: [] };
  const satMorningMs = Date.parse('2026-11-28T01:45:00Z'); // 09:45 HKT Sat (08:30-11:30 -> 1.6)
  const satAfternoonMs = Date.parse('2026-11-28T07:36:00Z'); // 15:36 HKT Sat (13:30-16:00 -> 1.8)
  const satEveningMs = Date.parse('2026-11-28T10:00:00Z'); // 18:00 HKT Sat (16:30-19:30 -> 1.9)
  const weekdayAfternoonMs = Date.parse('2026-11-25T07:36:00Z'); // 15:36 HKT Wed

  const rMorning = win.estimateGlobalBusLoadRisk(nlb3mGroup, 8, { etaSpacing: 45 }, clearMildWx, satMorningMs);
  assert.equal(rMorning.isLeisureRoute, true);
  assert.equal(rMorning.timeMultiplier, 1.6);
  assert.equal(rMorning.level, 'HIGH_LOAD');
  assert.equal(rMorning.label, '⚠️ Likely Full');
  assert.equal(rMorning.tip, 'Consider boarding upstream.');

  const rAfternoon = win.estimateGlobalBusLoadRisk(nlb3mGroup, 8, { etaSpacing: 40 }, clearMildWx, satAfternoonMs);
  assert.equal(rAfternoon.timeMultiplier, 1.8);
  assert.equal(rAfternoon.level, 'HIGH_LOAD');

  const rEvening = win.estimateGlobalBusLoadRisk(nlb3mGroup, 8, { etaSpacing: 50 }, clearMildWx, satEveningMs);
  assert.equal(rEvening.timeMultiplier, 1.9);
  assert.equal(rEvening.level, 'HIGH_LOAD');

  // Rainy / scorching summer suppresses HIGH_LOAD
  const rRainy = win.estimateGlobalBusLoadRisk(nlb3mGroup, 8, { etaSpacing: 40 }, { warnings: ['RAIN'], temp: 22 }, satAfternoonMs);
  assert.notEqual(rRainy.level, 'HIGH_LOAD', 'Rainy weather suppresses leisure surge');

  const rHot = win.estimateGlobalBusLoadRisk(nlb3mGroup, 8, { etaSpacing: 40 }, { temp: 33, condition: 'Sunny' }, satAfternoonMs);
  assert.notEqual(rHot.level, 'HIGH_LOAD', 'Scorching >31°C weather suppresses leisure surge');

  // Without fast/skipped stops (etaSpacing >= 60), does not falsely fire HIGH_LOAD
  const rNoSkip = win.estimateGlobalBusLoadRisk(nlb3mGroup, 8, { etaSpacing: 120 }, clearMildWx, satAfternoonMs);
  assert.equal(rNoSkip.level, 'MODERATE');

  // Non-leisure urban route & weekday afternoon return NORMAL
  const rUrban = win.estimateGlobalBusLoadRisk(urbanGroup, 5, { etaSpacing: 40 }, clearMildWx, satAfternoonMs);
  assert.equal(rUrban.isLeisureRoute, false);
  assert.equal(rUrban.level, 'NORMAL');

  const rWeekday = win.estimateGlobalBusLoadRisk(nlb3mGroup, 8, { etaSpacing: 40 }, clearMildWx, weekdayAfternoonMs);
  assert.equal(rWeekday.timeMultiplier, 1.0);
  assert.notEqual(rWeekday.level, 'HIGH_LOAD');

  // 4. fare-load-engine.js estimateBusSeatStatus downgrade via simulation-driven surge
  win.__HKO_WEATHER__ = clearMildWx;
  const downgradedSeat = win.estimateBusSeatStatus(nlb3mGroup, 8, { etaSpacing: 42 }, {
    nowMs: satAfternoonMs,
    stopKey: 'HA_LING_PEI',
    baseLoad: { pct: 24, band: 'LOW', labelEn: 'Seats', labelTc: '有位', cssClass: 'load-low', isSkipRisk: false },
  });
  assert.equal(downgradedSeat.cssClass, 'load-full', 'HIGH_LOAD must downgrade green Seats pill to load-full');
  assert.equal(downgradedSeat.labelEn, '⚠️ Likely Full');
  assert.equal(downgradedSeat.tipEn, 'Consider boarding upstream.');
  assert.equal(typeof win.setRiderLoadReport, 'undefined', 'Manual rider-report state must be removed');
  assert.equal(typeof win.getActiveRiderLoadReport, 'undefined', 'Manual rider-report lookup must be removed');

  // 5. Auto-hide two-way sectional fare notice after first use while keeping 2-Way Section badge
  const nlb1Group = { key: 'NLB_1_O', company: 'NLB', routeNo: '1', dest_e: 'Tai O', orig_e: 'Mui Wo Ferry Pier', mode: 'BUS' };
  const nlb1Stops = [
    { seq: 1, stopName_e: 'Mui Wo Ferry Pier', lat: 22.2647, lon: 114.0014, fare: '12.7' },
    { seq: 2, stopName_e: 'Mui Wo Cooked Food Market', lat: 22.2652, lon: 114.0005, fare: '12.7' },
    { seq: 3, stopName_e: 'Tai O', lat: 22.2535, lon: 113.8622, fare: '12.7' },
  ];
  assert.equal(win.hasAcknowledgedTwoWaySectionalFare(mockStorage), false);
  assert.equal(win.shouldShowTwoWaySectionalFareNotice(nlb1Group, nlb1Stops, 0, false, mockStorage), true, 'First visit shows two-way sectional fare notice');
  win.acknowledgeTwoWaySectionalFare(mockStorage);
  assert.equal(memStore['hk_transit_sectional_fare_ack'], '1', 'Acknowledgement persisted to hk_transit_sectional_fare_ack');
  assert.equal(win.shouldShowTwoWaySectionalFareNotice(nlb1Group, nlb1Stops, 0, false, mockStorage), false, 'Subsequent visits hide yellow sectional notice');
  assert.equal(win.hasStopTwoWaySectionalFare(nlb1Group, nlb1Stops, 0, false), true, 'Compact 2-Way Section badge logic still returns true');

  // 6. Verify eta-engine.js & app-ui.js wire up sectional ack, Fav drag handles, 5s Undo snackbar & remove rider-report-btn
  const etaSrc = fs.readFileSync('public/eta-engine.js', 'utf8');
  const uiSrc = fs.readFileSync('public/app-ui.js', 'utf8');
  assert.ok(etaSrc.includes('showUndoToast'), 'eta-engine.js must define showUndoToast');
  assert.ok(!etaSrc.includes('rider-report-btn'), 'eta-engine.js must not render manual rider-report-btn');
  assert.ok(etaSrc.includes('hk_transit_sectional_fare_ack'), 'eta-engine.js must check/persist hk_transit_sectional_fare_ack');
  assert.ok(uiSrc.includes('fav-drag-handle'), 'app-ui.js must render ⋮⋮ fav-drag-handle on Saved bookmarks');
  assert.ok(uiSrc.includes('reorderSavedBookmarks'), 'app-ui.js must implement reorderSavedBookmarks');
  assert.ok(uiSrc.includes('undoLastBookmarkRemoval'), 'app-ui.js must implement undoLastBookmarkRemoval');
  assert.ok(uiSrc.includes('showUndoToast') && uiSrc.includes('5000'), 'app-ui.js must trigger 5-second Undo snackbar on bookmark removal');
});

test('Expanded 7-Day Seasonal, Public Holiday, Eve-of-Holiday, Sunday Urban, School Dismissal, AWE Event Surge & /api/hk-holidays Proxy', async () => {
  // 1. Load full browser script stack in clean VM matching index.html order
  const win: any = {
    __HKO_WEATHER__: null,
    __HK_PUBLIC_HOLIDAYS__: new Set(),
  };
  const memStore: Record<string, string> = {};
  const mockStorage = {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null),
    setItem: (k: string, v: string) => { memStore[k] = String(v); },
    removeItem: (k: string) => { delete memStore[k]; },
  };
  win.SafeStorage = mockStorage;
  const ctx: any = {
    window: win,
    globalThis: win,
    localStorage: mockStorage,
    SafeStorage: mockStorage,
    Date, Math, Number, String, Array, Object, Set, Map, JSON, parseFloat, parseInt, isFinite, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/transit-data.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/weathercoorelation.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/monthly_activity.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/hk-people-flow.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/bussurge.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/fare-load-engine.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/hardcode.js', 'utf8'), ctx);

  // 2. MONTHLY_ACTIVITY_PROFILES covers all 12 months (0..11)
  assert.ok(win.MONTHLY_ACTIVITY_PROFILES, 'MONTHLY_ACTIVITY_PROFILES must be exported');
  for (let m = 0; m < 12; m++) {
    assert.ok(win.MONTHLY_ACTIVITY_PROFILES[m], `Missing MONTHLY_ACTIVITY_PROFILES entry for month ${m}`);
    assert.equal(win.MONTHLY_ACTIVITY_PROFILES[m].month, m);
    assert.ok(Number.isFinite(win.MONTHLY_ACTIVITY_PROFILES[m].trailWeight));
    assert.ok(Number.isFinite(win.MONTHLY_ACTIVITY_PROFILES[m].beachWeight));
  }

  // 3. Seasonal corridor multiplier rules
  // 3a. Cool/dry hiking boost (Nov Saturday Pak Kung Au / Mui Wo)
  const coolTrailMult = win.getSeasonalCorridorMultiplier({
    month: 10, dayType: 'saturday', hourFloat: 15.5, corridorText: '3M Tung Chung Pak Kung Au Mui Wo'
  });
  assert.ok(coolTrailMult >= 1.5, `Expected cool-season weekend trail boost >= 1.5, got ${coolTrailMult}`);

  // 3b. Hot summer afternoon ridge dampening vs summer dawn slot vs summer beach shift (July Saturday)
  const summerRidgePm = win.getSeasonalCorridorMultiplier({
    month: 6, dayType: 'saturday', hourFloat: 14.0, corridorText: '51 Tai Mo Shan'
  });
  assert.ok(summerRidgePm < 1.0, `Hot summer afternoon exposed ridge must dampen < 1.0, got ${summerRidgePm}`);

  const summerRidgeDawn = win.getSeasonalCorridorMultiplier({
    month: 6, dayType: 'saturday', hourFloat: 6.5, corridorText: '51 Tai Mo Shan'
  });
  assert.ok(summerRidgeDawn > 1.1, `Hot summer early-morning slot (06:30) must boost > 1.1, got ${summerRidgeDawn}`);

  const summerBeachPm = win.getSeasonalCorridorMultiplier({
    month: 6, dayType: 'saturday', hourFloat: 14.0, corridorText: '9 Shau Kei Wan Shek O Beach'
  });
  assert.ok(summerBeachPm >= 1.5, `Hot summer weekend beach corridor must boost >= 1.5, got ${summerBeachPm}`);

  // 3c. Sunday urban gathering modifier (Central / Admiralty / Causeway Bay / Mong Kok, 08:00-18:00)
  const sunUrban = win.getSeasonalCorridorMultiplier({
    month: 10, dayType: 'sunday', hourFloat: 13.5, corridorText: '104 Central Causeway Bay'
  });
  assert.ok(sunUrban >= 1.35, `Sunday urban gathering corridor must boost >= 1.35, got ${sunUrban}`);
  const satUrban = win.getSeasonalCorridorMultiplier({
    month: 10, dayType: 'saturday', hourFloat: 13.5, corridorText: '104 Central Causeway Bay'
  });
  assert.equal(satUrban, 1.0, 'Saturday urban non-leisure corridor must not trigger Sunday gathering modifier');

  // 3d. Eve-of-holiday exodus (17:00-21:00 airport/Lantau/border/A/E/B routes)
  const eveAirport = win.getSeasonalCorridorMultiplier({
    month: 8, dayType: 'weekday', hourFloat: 18.5, corridorText: 'Yuen Long Airport', routeNo: 'E36', isEveOfHoliday: true
  });
  assert.ok(eveAirport >= 1.8, `Eve-of-holiday airport/E-route exodus must boost >= 1.8, got ${eveAirport}`);
  const eveBorderB = win.getSeasonalCorridorMultiplier({
    month: 8, dayType: 'weekday', hourFloat: 19.0, corridorText: 'Lok Ma Chau', routeNo: 'B1', isEveOfHoliday: true
  });
  assert.ok(eveBorderB >= 1.8, `Eve-of-holiday B-route border exodus must boost >= 1.8, got ${eveBorderB}`);

  // 3e. Weekday school dismissal micro-rush (14:30-16:00, excluding Jul-Aug & school holidays)
  const schoolTermWed = win.getSeasonalCorridorMultiplier({
    month: 10, dayType: 'weekday', hourFloat: 15.25, corridorText: '103 Kowloon Tong Waterloo Road Pok Fu Lam', routeNo: '103'
  });
  assert.ok(schoolTermWed >= 1.5, `Weekday term-time school dismissal corridor must boost >= 1.5, got ${schoolTermWed}`);
  const schoolSummerJul = win.getSeasonalCorridorMultiplier({
    month: 6, dayType: 'weekday', hourFloat: 15.25, corridorText: '103 Kowloon Tong Waterloo Road Pok Fu Lam', routeNo: '103'
  });
  assert.equal(schoolSummerJul, 1.0, 'July summer break must suppress school dismissal micro-rush');
  const schoolHolidayFlag = win.getSeasonalCorridorMultiplier({
    month: 10, dayType: 'weekday', hourFloat: 15.25, corridorText: '103 Kowloon Tong Waterloo Road', routeNo: '103', isSchoolHoliday: true
  });
  assert.equal(schoolHolidayFlag, 1.0, 'Explicit isSchoolHoliday must suppress school dismissal micro-rush');

  // 4. HK Public Holiday & Eve-of-Holiday helpers
  const nationalDayMs = Date.parse('2026-10-01T07:00:00Z'); // Thu 2026-10-01 15:00 HKT
  const nationalDayEveMs = Date.parse('2026-09-30T10:30:00Z'); // Wed 2026-09-30 18:30 HKT
  const normalWedMs = Date.parse('2026-11-25T07:15:00Z'); // Wed 2026-11-25 15:15 HKT
  assert.equal(win.isHongKongPublicHoliday(nationalDayMs), true, '2026-10-01 National Day must be recognized as HK public holiday');
  assert.equal(win.isHongKongPublicHoliday(normalWedMs), false, '2026-11-25 must not be a public holiday');
  assert.equal(win.isEveOfPublicHoliday(nationalDayEveMs), true, '2026-09-30 must be recognized as eve of HK public holiday');
  assert.equal(win.isEveOfPublicHoliday(normalWedMs), false, '2026-11-25 must not be eve of public holiday');

  // 5. Integrated estimateGlobalBusLoadRisk across all 7 days, holidays, eve, Sunday, school, bad weather & AWE
  const clearMildWx = { temp: 22, condition: 'Clear', humidity: 58, warnings: [] };
  const nlb3m = { key: 'NLB_3M_O', company: 'NLB', routeNo: '3M', orig_en: 'Tung Chung Station', dest_en: 'Mui Wo Ferry Pier' };

  // 5a. Weekday public holiday (Thu Oct 1 15:00 HKT) triggers HIGH_LOAD with skip-stop
  const holRisk = win.estimateGlobalBusLoadRisk(nlb3m, 8, { etaSpacing: 40, stopName: 'Pak Kung Au' }, clearMildWx, nationalDayMs);
  assert.equal(holRisk.isHoliday, true);
  assert.equal(holRisk.dayType, 'holiday');
  assert.equal(holRisk.level, 'HIGH_LOAD');

  // 5b. Normal weekday suppression (Wed Nov 25 15:15 HKT) stays below HIGH_LOAD
  const wkRisk = win.estimateGlobalBusLoadRisk(nlb3m, 8, { etaSpacing: 40, stopName: 'Pak Kung Au' }, clearMildWx, normalWedMs);
  assert.equal(wkRisk.dayType, 'weekday');
  assert.notEqual(wkRisk.level, 'HIGH_LOAD');

  // 5c. Bad weather (RAIN / TC8) dampens holiday peak cleanly
  const holRain = win.estimateGlobalBusLoadRisk(nlb3m, 8, { etaSpacing: 40 }, { warnings: ['TC8'], temp: 23 }, nationalDayMs);
  assert.equal(holRain.level, 'NORMAL', 'Typhoon TC8 must dampen holiday leisure load to NORMAL');

  // 5d. Eve-of-holiday airport exodus (Wed Sep 30 18:30 HKT on E36 + skip-stop) -> HIGH_LOAD
  const lwbE36 = { key: 'LWB_E36_O', company: 'LWB', routeNo: 'E36', orig_en: 'Pat Heung', dest_en: 'Airport (GTC)' };
  const eveRisk = win.estimateGlobalBusLoadRisk(lwbE36, 12, { etaSpacing: 42 }, clearMildWx, nationalDayEveMs);
  assert.equal(eveRisk.isEveOfHoliday, true);
  assert.equal(eveRisk.level, 'HIGH_LOAD', 'Eve-of-holiday 18:30 E36 with skip-stop must trigger HIGH_LOAD');

  // 5e. Sunday urban gathering (Sun Nov 29 13:30 HKT on Central/Causeway Bay + skip-stop) -> HIGH_LOAD; Saturday -> NORMAL
  const sunMs = Date.parse('2026-11-29T05:30:00Z'); // Sun 13:30 HKT
  const satMs = Date.parse('2026-11-28T05:30:00Z'); // Sat 13:30 HKT
  const xht104 = { key: 'KMB_104_O', company: 'KMB', routeNo: '104', orig_en: 'Pak Tin', dest_en: 'Causeway Bay Central' };
  const sunUrbanRisk = win.estimateGlobalBusLoadRisk(xht104, 10, { etaSpacing: 45 }, clearMildWx, sunMs);
  assert.equal(sunUrbanRisk.dayType, 'sunday');
  assert.equal(sunUrbanRisk.level, 'HIGH_LOAD');
  const satUrbanRisk = win.estimateGlobalBusLoadRisk(xht104, 10, { etaSpacing: 45 }, clearMildWx, satMs);
  assert.equal(satUrbanRisk.level, 'NORMAL');

  // 5f. Weekday school dismissal (Wed Nov 25 15:15 HKT on 103 Waterloo Rd / Kowloon Tong + skip-stop) -> HIGH_LOAD; July -> NORMAL
  const kmb103 = { key: 'KMB_103_O', company: 'KMB', routeNo: '103', orig_en: 'Chuk Yuen', dest_en: 'Pok Fu Lam' };
  const schoolRisk = win.estimateGlobalBusLoadRisk(kmb103, 6, { etaSpacing: 40, stopName: 'Waterloo Road, Kowloon Tong' }, clearMildWx, normalWedMs);
  assert.equal(schoolRisk.level, 'HIGH_LOAD', 'Term-time weekday school dismissal with skip-stop must trigger HIGH_LOAD');
  const julWedMs = Date.parse('2026-07-15T07:15:00Z'); // Wed Jul 15 15:15 HKT
  const julSchoolRisk = win.estimateGlobalBusLoadRisk(kmb103, 6, { etaSpacing: 40, stopName: 'Waterloo Road, Kowloon Tong' }, clearMildWx, julWedMs);
  assert.equal(julSchoolRisk.level, 'NORMAL', 'July summer break must not trigger school dismissal surge');

  // 5g. Optional AWE event date pre-show (17:30) and post-show (22:45) surges on A/E routes
  const awePreShowMs = Date.parse('2026-11-28T09:30:00Z');  // Sat 2026-11-28 17:30 HKT
  const awePostShowMs = Date.parse('2026-11-28T14:45:00Z'); // Sat 2026-11-28 22:45 HKT
  const nonEventNightMs = Date.parse('2026-11-24T14:45:00Z'); // Tue 2026-11-24 22:45 HKT
  const lwbA33 = { key: 'LWB_A33_O', company: 'LWB', routeNo: 'A33', orig_en: 'Tuen Mun Road', dest_en: 'Airport (GTC)' };
  assert.equal(win.isAweEventDate(awePostShowMs), true);
  assert.equal(win.isAweEventDate(nonEventNightMs), false);

  const awePreRisk = win.estimateGlobalBusLoadRisk(lwbA33, 5, { etaSpacing: 45 }, clearMildWx, awePreShowMs);
  assert.equal(awePreRisk.aweMultiplier, 1.65);
  assert.equal(awePreRisk.level, 'HIGH_LOAD');

  const awePostRisk = win.estimateGlobalBusLoadRisk(lwbE36, 5, { etaSpacing: 45 }, null, awePostShowMs);
  assert.equal(awePostRisk.aweMultiplier, 1.85);
  assert.equal(awePostRisk.level, 'HIGH_LOAD', 'AWE post-show 22:45 E36 with skip-stop must trigger HIGH_LOAD');

  const nonAwePostRisk = win.estimateGlobalBusLoadRisk(lwbE36, 5, { etaSpacing: 45 }, null, nonEventNightMs);
  assert.equal(nonAwePostRisk.aweMultiplier, 1.0);
  assert.notEqual(nonAwePostRisk.level, 'HIGH_LOAD', 'Non-event night 22:45 E36 must not falsely trigger AWE HIGH_LOAD');

  // 6. syncHkHolidaysFromWorker hydrates both __HK_PUBLIC_HOLIDAYS__ and AWE_EVENT_DATES
  const syncRes = await win.syncHkHolidaysFromWorker('/api/hk-holidays', {
    force: true,
    storage: mockStorage,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        source: '1823_LIVE',
        holidays: ['2026-10-01', '2028-01-01'],
        aweEventDates: ['2026-12-12'],
      }),
    }),
  });
  assert.equal(syncRes.ok, true);
  assert.equal(win.__HK_PUBLIC_HOLIDAYS__.has('2028-01-01'), true, 'Worker sync must populate window.__HK_PUBLIC_HOLIDAYS__');
  assert.equal(win.isHongKongPublicHoliday(Date.parse('2028-01-01T04:00:00Z')), true);
  assert.equal(win.isAweEventDate(Date.parse('2026-12-12T14:45:00Z')), true);

  // 7. Worker /api/hk-holidays route & 1823.gov.hk iCal JSON parser (while worker.js keeps sole export)
  const workerSrc = fs.readFileSync('functions/api/worker.js', 'utf8');
  const workerExports = workerSrc.split('\n').filter((l) => /^export\s+/.test(l.trim()));
  assert.deepEqual(workerExports, ['export async function onRequest(context) {'], 'worker.js must keep strictly one export (onRequest)');
  assert.ok(fs.existsSync('functions/api/hk-holidays.js'), 'functions/api/hk-holidays.js Pages Function must exist');

  const wSandbox: any = {
    Math, Number, String, Array, Map, Set, Object, URL, URLSearchParams, Response, Request, Date, console,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        vcalendar: [{
          vevent: [
            { dtstart: ['20261001', { value: 'DATE' }], summary: 'National Day' },
            { dtstart: ['20261225', { value: 'DATE' }], summary: 'Christmas Day' },
          ],
        }],
      }),
    }),
  };
  vm.createContext(wSandbox);
  vm.runInContext(workerSrc.replace(/export async function onRequest/g, 'async function onRequest'), wSandbox);
  const parsed1823 = wSandbox.parse1823HolidayJson({
    vcalendar: [{ vevent: [{ dtstart: ['20261001'] }, { dtstart: '20261225' }] }],
  });
  assert.deepEqual(parsed1823, ['2026-10-01', '2026-12-25']);

  const workerResp = await wSandbox.onRequest({ request: new Request('https://hkway.pages.dev/api/hk-holidays') });
  const workerJson = await workerResp.json();
  assert.equal(workerJson.ok, true);
  assert.ok(Array.isArray(workerJson.holidays) && workerJson.holidays.includes('2026-10-01'));
  assert.ok(Array.isArray(workerJson.aweEventDates) && workerJson.aweEventDates.length >= 1);

  // 8. Map road-speed telemetry purity: busspeed.js and map.js must NEVER import or couple to seasonal/crowding load engines
  const busSpeedSrc = fs.readFileSync('public/busspeed.js', 'utf8');
  const mapSrc = fs.readFileSync('public/map.js', 'utf8');
  assert.ok(!/monthly_activity|getSeasonalCorridorMultiplier|estimateGlobalBusLoadRisk|bussurge|hk-people-flow|simulateCityPeopleFlow/i.test(busSpeedSrc),
    'public/busspeed.js must remain strictly data-driven road speed telemetry');
  assert.ok(!/monthly_activity|getSeasonalCorridorMultiplier|estimateGlobalBusLoadRisk|bussurge|hk-people-flow|simulateCityPeopleFlow/i.test(mapSrc),
    'public/map.js must remain strictly data-driven road speed telemetry');
});

test('Standalone HK People Flow Simulator (52-week, EDB school breaks, 2026/27 holidays, weather inversion) & Bus Network Kinematics Adapter', () => {
  // 1. Load standalone People Flow Simulator + Bus Adapter in clean VM
  const win: any = {
    __HKO_WEATHER__: null,
    __HK_PUBLIC_HOLIDAYS__: new Set(),
  };
  const ctx: any = {
    window: win,
    globalThis: win,
    Date, Math, Number, String, Array, Object, Set, Map, JSON, parseFloat, parseInt, isFinite, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/transit-data.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/weathercoorelation.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/monthly_activity.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/hk-people-flow.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/bussurge.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/fare-load-engine.js', 'utf8'), ctx);

  // Confirm hk-people-flow.js is 100% mode-agnostic (no DOM / bus-card UI code)
  const flowSrc = fs.readFileSync('public/hk-people-flow.js', 'utf8');
  assert.ok(!/document\.|innerHTML|classList|querySelector/i.test(flowSrc),
    'public/hk-people-flow.js must contain zero DOM/UI code');

  const clearMildWx = { temp: 22, condition: 'Clear', humidity: 58, warnings: [] };
  const summerSunnyWx = { temp: 29, condition: 'Sunny', humidity: 75, warnings: [] };
  const rainWx = { temp: 22, condition: 'Rain', warnings: ['RAIN'] };
  const hotWx = { temp: 33, condition: 'Sunny', warnings: [] };

  // 2. 52-week seasonal flip: Nov W48 (hiking peak > beach) vs Jul W29 (beach peak > afternoon exposed trail; summer dawn hike > summer PM)
  const novSatPm = Date.parse('2026-11-28T07:00:00Z'); // Sat 15:00 HKT, W48
  const julSatPm = Date.parse('2026-07-18T06:00:00Z'); // Sat 14:00 HKT, W29
  const julSatDawn = Date.parse('2026-07-17T22:30:00Z'); // Sat 06:30 HKT, W29

  const flowNov = win.simulateCityPeopleFlow(novSatPm, clearMildWx);
  const flowJulPm = win.simulateCityPeopleFlow(julSatPm, summerSunnyWx);
  const flowJulDawn = win.simulateCityPeopleFlow(julSatDawn, clearMildWx);

  assert.equal(flowNov.calendar.isoWeek, 48);
  assert.equal(flowJulPm.calendar.isoWeek, 29);
  assert.ok(flowNov.vectors.TO_TRAIL_EXPOSED > flowNov.vectors.TO_BEACH_WATER,
    `Nov W48 must favor trails (${flowNov.vectors.TO_TRAIL_EXPOSED}) over beaches (${flowNov.vectors.TO_BEACH_WATER})`);
  assert.ok(flowJulPm.vectors.TO_BEACH_WATER > flowJulPm.vectors.TO_TRAIL_EXPOSED,
    `Jul W29 afternoon must favor beaches (${flowJulPm.vectors.TO_BEACH_WATER}) over exposed trails (${flowJulPm.vectors.TO_TRAIL_EXPOSED})`);
  assert.ok(flowJulDawn.vectors.TO_TRAIL_EXPOSED > flowJulPm.vectors.TO_TRAIL_EXPOSED,
    'Jul dawn hiking window (06:30) must exceed Jul afternoon exposed trail pressure');

  // Verify all 15 normalized vectors exist in [0.0, 2.0]
  assert.equal(win.FLOW_VECTOR_KEYS.length, 15);
  for (const k of win.FLOW_VECTOR_KEYS) {
    const v = flowNov.vectors[k];
    assert.ok(Number.isFinite(v) && v >= 0.0 && v <= 2.0, `Vector ${k} out of range [0,2]: ${v}`);
  }

  // 3. Mon–Fri school-term vs. EDB school breaks (Christmas, LNY, Easter, Summer)
  const termThuAm = Date.parse('2026-11-25T23:45:00Z'); // Thu 2026-11-26 07:45 HKT
  const termWedPm = Date.parse('2026-11-25T07:15:00Z'); // Wed 2026-11-25 15:15 HKT
  const xmasBreak = Date.parse('2026-12-28T07:15:00Z'); // Mon 2026-12-28 15:15 HKT (EDB Xmas break)
  const lnyBreak = Date.parse('2027-02-11T07:15:00Z');  // Thu 2027-02-11 15:15 HKT (EDB LNY break)
  const easterBreak = Date.parse('2027-03-25T07:15:00Z'); // Thu 2027-03-25 15:15 HKT (EDB Easter break)
  const summerBreak = Date.parse('2027-07-15T07:15:00Z'); // Thu 2027-07-15 15:15 HKT (EDB Summer break)

  const flowTermAm = win.simulateCityPeopleFlow(termThuAm, clearMildWx);
  const flowTermPm = win.simulateCityPeopleFlow(termWedPm, clearMildWx);
  assert.equal(flowTermAm.calendar.isSchoolDay, true);
  assert.ok(flowTermAm.vectors.SCHOOL_ZONE >= 1.5, `School AM rush expected >= 1.5, got ${flowTermAm.vectors.SCHOOL_ZONE}`);
  assert.equal(flowTermPm.calendar.isSchoolDay, true);
  assert.ok(flowTermPm.vectors.SCHOOL_ZONE >= 1.5, `School PM dismissal expected >= 1.5, got ${flowTermPm.vectors.SCHOOL_ZONE}`);

  for (const [label, ts] of [['Xmas', xmasBreak], ['LNY', lnyBreak], ['Easter', easterBreak], ['Summer', summerBreak]] as const) {
    const f = win.simulateCityPeopleFlow(ts, clearMildWx);
    assert.equal(f.calendar.isSchoolDay, false, `${label} break must set isSchoolDay=false`);
    assert.equal(f.vectors.SCHOOL_ZONE, 0, `${label} break must zero out SCHOOL_ZONE`);
  }

  // 4. Sat northbound + sunset hike vs. Sun urban hub + southbound return
  const satAm = Date.parse('2026-11-28T01:30:00Z'); // Sat 09:30 HKT
  const sunMid = Date.parse('2026-11-29T05:30:00Z'); // Sun 13:30 HKT
  const sunPm = Date.parse('2026-11-29T10:00:00Z');  // Sun 18:00 HKT

  const flowSatAm = win.simulateCityPeopleFlow(satAm, clearMildWx);
  const flowSunMid = win.simulateCityPeopleFlow(sunMid, clearMildWx);
  const flowSunPm = win.simulateCityPeopleFlow(sunPm, clearMildWx);

  assert.ok(flowSatAm.vectors.TO_BORDER_NORTH >= 1.6, `Sat AM northbound expected >= 1.6, got ${flowSatAm.vectors.TO_BORDER_NORTH}`);
  assert.equal(flowSatAm.vectors.SUNDAY_URBAN_HUB, 0, 'Saturday must not trigger SUNDAY_URBAN_HUB');
  assert.ok(flowSunMid.vectors.SUNDAY_URBAN_HUB >= 1.4, `Sun midday urban hub expected >= 1.4, got ${flowSunMid.vectors.SUNDAY_URBAN_HUB}`);
  assert.ok(flowSunPm.vectors.FROM_BORDER_NORTH >= 1.7, `Sun PM southbound return expected >= 1.7, got ${flowSunPm.vectors.FROM_BORDER_NORTH}`);

  // 5. Gazetted 2026 & 2027 public holidays, eve-of-holiday, and Ching Ming cemetery festival
  assert.equal(win.isHongKongPublicHoliday(Date.parse('2027-05-13T04:00:00Z')), true, '2027-05-13 Buddha Birthday gazetted holiday');
  assert.equal(win.isHongKongPublicHoliday(Date.parse('2027-10-08T04:00:00Z')), true, '2027-10-08 Chung Yeung gazetted holiday');
  assert.equal(win.isHongKongPublicHoliday(Date.parse('2027-12-27T04:00:00Z')), true, '2027-12-27 Christmas holiday');

  const eveNatDay = Date.parse('2026-09-30T10:30:00Z'); // Wed 18:30 HKT
  const flowEve = win.simulateCityPeopleFlow(eveNatDay, clearMildWx);
  assert.equal(flowEve.calendar.isEveOfHoliday, true);
  assert.ok(flowEve.vectors.TO_AIRPORT_AWE >= 1.7, 'Eve-of-holiday must spike TO_AIRPORT_AWE');
  assert.ok(flowEve.vectors.TO_BORDER_NORTH >= 1.7, 'Eve-of-holiday must spike TO_BORDER_NORTH');

  const chingMing = Date.parse('2026-04-06T03:00:00Z'); // Mon 2026-04-06 11:00 HKT (Holiday)
  const flowChingMing = win.simulateCityPeopleFlow(chingMing, clearMildWx);
  assert.ok(flowChingMing.vectors.CEMETERY_FESTIVAL >= 1.4, 'Ching Ming holiday must elevate CEMETERY_FESTIVAL');

  // 6. Weather inversion (Rain & Heat crush outdoor trails while boosting urban/indoor; pre-T8 evac spikes CBD_OUTBOUND)
  const flowNovRain = win.simulateCityPeopleFlow(novSatPm, rainWx);
  const flowNovHot = win.simulateCityPeopleFlow(novSatPm, hotWx);
  assert.ok(flowNovRain.vectors.TO_TRAIL_EXPOSED < 0.7 && flowNovRain.weather.outdoorMod <= 0.35,
    'Rain must crush outdoor trail flow');
  assert.ok(flowNovRain.weather.urbanIndoorMod > 1.15 && flowNovRain.vectors.CBD_INBOUND > flowNov.vectors.CBD_INBOUND,
    'Rain must invert demand upward onto urban/indoor vectors');
  assert.ok(flowNovHot.weather.outdoorMod <= 0.55 && flowNovHot.weather.urbanIndoorMod > 1.05,
    'Heat >31°C must dampen outdoor while lifting urban/indoor');

  const wedAfternoon = Date.parse('2026-11-25T06:00:00Z'); // Wed 14:00 HKT
  const flowNormalPm = win.simulateCityPeopleFlow(wedAfternoon, clearMildWx);
  const flowPreT8 = win.simulateCityPeopleFlow(wedAfternoon, { preTyphoonEvac: true, warnings: ['TC3'] });
  assert.ok(flowPreT8.vectors.CBD_OUTBOUND > flowNormalPm.vectors.CBD_OUTBOUND * 1.4,
    'Pre-T8 evacuation must spike CBD_OUTBOUND exodus');

  // 7. Mode-agnostic mapCorridorToFlowVectors works across Bus, MTR, and Ferry
  const mtrBorder = win.mapCorridorToFlowVectors({ originText: 'Admiralty', destText: 'Lo Wu', routeCode: 'EAL', mode: 'MTR' });
  assert.ok(mtrBorder.vectorKeys.includes('TO_BORDER_NORTH'), 'MTR East Rail to Lo Wu maps to TO_BORDER_NORTH');
  const ferryIsland = win.mapCorridorToFlowVectors({ originText: 'Central Pier 5', destText: 'Cheung Chau', mode: 'FERRY' });
  assert.ok(ferryIsland.vectorKeys.includes('ISLAND_OUTBOUND'), 'Central -> Cheung Chau ferry maps to ISLAND_OUTBOUND');
  const busTrail = win.mapCorridorToFlowVectors({ originText: 'Tung Chung', destText: 'Mui Wo', stopText: 'Pak Kung Au', routeCode: '3M', mode: 'BUS' });
  assert.ok(busTrail.vectorKeys.includes('TO_TRAIL_EXPOSED'), 'Bus 3M via Pak Kung Au maps to TO_TRAIL_EXPOSED');

  // 8. Bus Adapter Kinematics: headway-gap amplification, bunched trailing-bus relief, and stop-position progress curve
  const kmbCommute = {
    key: 'KMB_968_O',
    company: 'KMB',
    routeNo: '968',
    orig_en: 'Yuen Long West',
    dest_en: 'Causeway Bay (Tin Hau)',
    headwayMins: 10
  };
  const wedAmPeak = Date.parse('2026-11-25T00:20:00Z'); // Wed 08:20 HKT AM rush

  // 8a. Headway-gap amplification: 22-min live gap on 10-min route amplifies lead bus into HIGH_LOAD
  const normalHw = win.estimateGlobalBusLoadRisk(kmbCommute, 10, {
    totalStops: 24,
    obsHeadwaySec: 600,
    schedHeadwaySec: 600,
    etaIdx: 0
  }, clearMildWx, wedAmPeak);
  const wideGapHw = win.estimateGlobalBusLoadRisk(kmbCommute, 10, {
    totalStops: 24,
    obsHeadwaySec: 1320, // 22 min gap
    schedHeadwaySec: 600,
    etaIdx: 0,
    nextBusGapSec: 180 // trailing bus 3m behind
  }, clearMildWx, wedAmPeak);
  assert.equal(wideGapHw.isWideGap, true, '22-min gap on 10-min route must flag isWideGap');
  assert.ok(wideGapHw.headwayMod > 1.3 && wideGapHw.score > normalHw.score,
    `Wide headway gap must amplify headwayMod (${wideGapHw.headwayMod}) & score (${wideGapHw.score} > ${normalHw.score})`);
  assert.equal(wideGapHw.level, 'HIGH_LOAD', 'Severe headway gap during CBD AM peak must escalate to HIGH_LOAD');
  assert.equal(wideGapHw.tip, 'Next bus 3m behind likely has space',
    'Lead bus with 3m bunched follower must surface concise next-bus decision tip');

  // 8b. Bunched trailing-bus relief: trailing bus 3 min behind lead bus gets load relief (headwayMod < 0.75)
  const trailingBunched = win.estimateGlobalBusLoadRisk(kmbCommute, 10, {
    totalStops: 24,
    schedHeadwaySec: 600,
    etaIdx: 1,
    prevBusGapSec: 180 // 3 min behind lead bus
  }, clearMildWx, wedAmPeak);
  assert.equal(trailingBunched.isBunchedTrailing, true);
  assert.ok(trailingBunched.headwayMod < 0.75, `Bunched trailing bus headwayMod must be < 0.75, got ${trailingBunched.headwayMod}`);
  assert.equal(trailingBunched.level, 'NORMAL', 'Bunched trailing bus must receive load relief to NORMAL');

  const seatBunched = win.estimateBusSeatStatus(kmbCommute, 10, {
    totalStops: 24,
    schedHeadwaySec: 600,
    etaIdx: 1,
    prevBusGapSec: 180
  }, {
    nowMs: wedAmPeak,
    weather: clearMildWx,
    baseLoad: { pct: 78, band: 'HIGH', labelEn: 'Crowded', labelTc: '較擠迫', cssClass: 'load-high', isSkipRisk: false }
  });
  assert.equal(seatBunched.band, 'LOW', 'estimateBusSeatStatus must relieve bunched trailing bus to Seats/LOW');
  assert.equal(seatBunched.cssClass, 'load-low');

  // 8c. Stop-position progress curve: origin stop (<15%) stays easier to board than mid-corridor (25%–75%)
  const originRisk = win.estimateGlobalBusLoadRisk(kmbCommute, 0, {
    totalStops: 34,
    etaSpacing: 45
  }, clearMildWx, wedAmPeak);
  const midRisk = win.estimateGlobalBusLoadRisk(kmbCommute, 16, {
    totalStops: 34,
    etaSpacing: 45
  }, clearMildWx, wedAmPeak);
  const tailRisk = win.estimateGlobalBusLoadRisk(kmbCommute, 32, {
    totalStops: 34,
    etaSpacing: 45
  }, clearMildWx, wedAmPeak);
  assert.ok(originRisk.stopPositionMod < 0.75, `Origin stopPositionMod must be < 0.75, got ${originRisk.stopPositionMod}`);
  assert.ok(midRisk.stopPositionMod > 1.1, `Mid-corridor stopPositionMod must be > 1.1, got ${midRisk.stopPositionMod}`);
  assert.ok(tailRisk.stopPositionMod < 0.85, `Post-dropoff stopPositionMod must decay < 0.85, got ${tailRisk.stopPositionMod}`);
  assert.ok(midRisk.score > originRisk.score && midRisk.score > tailRisk.score,
    'Mid-corridor stop must carry higher accumulated load score than origin or final drop-off stops');
  assert.notEqual(originRisk.level, 'HIGH_LOAD', 'Origin stop (0/34) stays easier to board than mid-corridor');
  assert.equal(midRisk.level, 'HIGH_LOAD', 'Mid-corridor stop (16/34) under AM CBD peak + skip-stop flags HIGH_LOAD');

  // 9. Complete removal of manual user-reporting UI/state across entire frontend
  const filesToCheckNoRiderReport = [
    'index.html',
    'public/app-ui.js',
    'public/eta-engine.js',
    'public/app.css',
    'public/bussurge.js',
    'public/fare-load-engine.js'
  ];
  for (const rel of filesToCheckNoRiderReport) {
    const src = fs.readFileSync(rel, 'utf8');
    assert.ok(!/toggleRiderBusLoadReport|setRiderLoadReport|getActiveRiderLoadReport|rider-report-btn|RIDER_LOAD_STORAGE_KEY/i.test(src),
      `${rel} must not contain any manual rider-reporting UI or localStorage override logic`);
  }
  const mapOverlaySrc = fs.readFileSync('public/map-traffic-overlay.js', 'utf8');
  assert.ok(!/hk-people-flow|simulateCityPeopleFlow|bussurge|estimateGlobalBusLoadRisk/i.test(mapOverlaySrc),
    'public/map-traffic-overlay.js must remain strictly data-driven road traffic telemetry');
});

test('Multi-Modal MTR & Ferry Load Adapters (mtrsurge.js, ferrysurge.js) + Mui Wo Ferry-to-Bus Cross-Modal Pulse', () => {
  const win: any = {};
  const ctx: any = {
    window: win,
    globalThis: win,
    Math, Date, Number, String, Array, Map, Set, Object, RegExp, JSON, Promise, console, isFinite, parseInt, parseFloat
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/weathercoorelation.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/monthly_activity.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/hk-people-flow.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/mtrsurge.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/ferrysurge.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('public/bussurge.js', 'utf8'), ctx);

  assert.equal(typeof win.estimateMtrLoadStatus, 'function', 'mtrsurge.js must export estimateMtrLoadStatus');
  assert.equal(typeof win.estimateFerryLoadStatus, 'function', 'ferrysurge.js must export estimateFerryLoadStatus');
  assert.equal(typeof win.getRecentFerryArrivalPulse, 'function', 'ferrysurge.js must export getRecentFerryArrivalPulse');

  const clearMildWx = { temperature: 22, rainfall: 0, warningCodes: [] };
  const rainstormWx = { temperature: 24, rainfall: 38, warningCodes: ['WRAINR'] };
  const preT8Wx = { temperature: 27, rainfall: 15, warningCodes: ['PRE8'] };

  // 1. MTR Directional Choke Links: TWL AM southbound vs PM northbound, KTL core, TKL Yau Tong-Quarry Bay
  const wedAm0820 = Date.UTC(2026, 10, 18, 0, 20, 0); // Wed 08:20 HKT
  const wedPm1815 = Date.UTC(2026, 10, 18, 10, 15, 0); // Wed 18:15 HKT
  const wedMid1130 = Date.UTC(2026, 10, 18, 3, 30, 0); // Wed 11:30 HKT

  const twlAmSb = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'TST', direction: 'DOWN', destCode: 'CEN',
    nextTrains: [wedAm0820 + 60000, wedAm0820 + 210000], hkoWeather: clearMildWx, nowMs: wedAm0820
  });
  const twlAmNb = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'TST', direction: 'UP', destCode: 'TSW',
    nextTrains: [wedAm0820 + 60000, wedAm0820 + 210000], hkoWeather: clearMildWx, nowMs: wedAm0820
  });
  assert.ok(twlAmSb.score > twlAmNb.score * 1.6,
    `TWL AM southbound (${twlAmSb.score}) must strongly exceed counter-peak northbound (${twlAmNb.score})`);
  assert.equal(twlAmSb.state, 'CRUSH', 'TWL AM southbound at TST must flag CRUSH');
  assert.equal(twlAmSb.labelEn, 'Crowded');
  assert.equal(twlAmSb.labelTc, '擠迫');

  const twlPmNb = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'ADM', direction: 'UP', destCode: 'TSW',
    nextTrains: [wedPm1815 + 60000, wedPm1815 + 210000], hkoWeather: clearMildWx, nowMs: wedPm1815
  });
  const twlPmSb = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'ADM', direction: 'DOWN', destCode: 'CEN',
    nextTrains: [wedPm1815 + 60000, wedPm1815 + 210000], hkoWeather: clearMildWx, nowMs: wedPm1815
  });
  assert.ok(twlPmNb.score > twlPmSb.score * 1.6,
    `TWL PM northbound (${twlPmNb.score}) must strongly exceed counter-peak southbound (${twlPmSb.score})`);
  assert.equal(twlPmNb.state, 'CRUSH');

  const tklAmChoke = win.estimateMtrLoadStatus({
    lineCode: 'TKL', stationCode: 'YAT', direction: 'DOWN', destCode: 'NOP',
    nextTrains: [wedAm0820 + 60000, wedAm0820 + 210000], hkoWeather: clearMildWx, nowMs: wedAm0820
  });
  const ktlAmCore = win.estimateMtrLoadStatus({
    lineCode: 'KTL', stationCode: 'KOT', direction: 'DOWN', destCode: 'WHA',
    nextTrains: [wedAm0820 + 60000, wedAm0820 + 210000], hkoWeather: clearMildWx, nowMs: wedAm0820
  });
  assert.ok(tklAmChoke.chokeBoost >= 1.30 && tklAmChoke.state === 'CRUSH',
    `TKL Yau Tong-Quarry Bay AM harbour choke must flag CRUSH, got ${tklAmChoke.state} (${tklAmChoke.score})`);
  assert.ok(ktlAmCore.chokeBoost >= 1.20 && ktlAmCore.state === 'CRUSH',
    `KTL Kowloon core AM peak must flag CRUSH, got ${ktlAmCore.state} (${ktlAmCore.score})`);

  // 2. EAL Border Waves: Fri PM & Sat AM northbound vs Sun PM southbound + TCL/AEL weekend airport/Lantau
  const friPm1830 = Date.UTC(2026, 10, 20, 10, 30, 0); // Fri 18:30 HKT
  const satAm0930 = Date.UTC(2026, 10, 21, 1, 30, 0);  // Sat 09:30 HKT
  const sunPm1830 = Date.UTC(2026, 10, 22, 10, 30, 0); // Sun 18:30 HKT

  const ealSatNb = win.estimateMtrLoadStatus({
    lineCode: 'EAL', stationCode: 'SHT', direction: 'UP', destCode: 'LOW',
    nextTrains: [satAm0930 + 60000, satAm0930 + 240000], hkoWeather: clearMildWx, nowMs: satAm0930
  });
  const ealSatSb = win.estimateMtrLoadStatus({
    lineCode: 'EAL', stationCode: 'SHT', direction: 'DOWN', destCode: 'ADM',
    nextTrains: [satAm0930 + 60000, satAm0930 + 240000], hkoWeather: clearMildWx, nowMs: satAm0930
  });
  assert.ok(ealSatNb.score > ealSatSb.score * 1.8 && ealSatNb.state === 'CRUSH',
    `EAL Sat AM northbound (${ealSatNb.score}/${ealSatNb.state}) must surge over southbound (${ealSatSb.score})`);

  const ealSunSb = win.estimateMtrLoadStatus({
    lineCode: 'EAL', stationCode: 'SHT', direction: 'DOWN', destCode: 'ADM',
    nextTrains: [sunPm1830 + 60000, sunPm1830 + 240000], hkoWeather: clearMildWx, nowMs: sunPm1830
  });
  const ealSunNb = win.estimateMtrLoadStatus({
    lineCode: 'EAL', stationCode: 'SHT', direction: 'UP', destCode: 'LOW',
    nextTrains: [sunPm1830 + 60000, sunPm1830 + 240000], hkoWeather: clearMildWx, nowMs: sunPm1830
  });
  assert.ok(ealSunSb.score > ealSunNb.score * 1.5 && ealSunSb.state === 'CRUSH',
    `EAL Sun PM southbound return (${ealSunSb.score}/${ealSunSb.state}) must surge over northbound (${ealSunNb.score})`);

  const ealFriNb = win.estimateMtrLoadStatus({
    lineCode: 'EAL', stationCode: 'TAW', direction: 'UP', destCode: 'LOW',
    nextTrains: [friPm1830 + 60000, friPm1830 + 240000], hkoWeather: clearMildWx, nowMs: friPm1830
  });
  assert.equal(ealFriNb.state, 'CRUSH', 'EAL Fri PM northbound border exodus must flag CRUSH');

  const tclSatOut = win.estimateMtrLoadStatus({
    lineCode: 'TCL', stationCode: 'TSY', direction: 'DOWN', destCode: 'TUC',
    nextTrains: [satAm0930 + 120000, satAm0930 + 480000], hkoWeather: clearMildWx, nowMs: satAm0930
  });
  assert.ok(tclSatOut.state === 'BUSY' || tclSatOut.state === 'CRUSH',
    `TCL Saturday AM Lantau/Airport outbound must be elevated, got ${tclSatOut.state} (${tclSatOut.score})`);

  // 3. Live Headway Spacing Stretch (>= 5m gap amplifies platform crush) + Rain & Pre-T8 Weather Fusion
  const normalMidTwl = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'MOK', direction: 'DOWN', destCode: 'CEN',
    nextTrains: [wedMid1130 + 60000, wedMid1130 + 210000], hkoWeather: clearMildWx, nowMs: wedMid1130
  });
  assert.equal(normalMidTwl.state, 'COMFORTABLE', `Quiet midday TWL must be COMFORTABLE, got ${normalMidTwl.state}`);
  assert.equal(normalMidTwl.labelEn, 'Space');
  assert.equal(normalMidTwl.labelTc, '寬敞');

  const wedAmShoulder = Date.UTC(2026, 10, 18, 1, 35, 0); // Wed 09:35 HKT (AM peak shoulder)
  const shoulderTight = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'SSP', direction: 'DOWN', destCode: 'CEN',
    nextTrains: [wedAmShoulder + 60000, wedAmShoulder + 210000], hkoWeather: clearMildWx, nowMs: wedAmShoulder
  });
  const shoulderStretched = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'SSP', direction: 'DOWN', destCode: 'CEN',
    nextTrains: [wedAmShoulder + 60000, wedAmShoulder + 420000], // 6m gap (>= 5m)
    hkoWeather: clearMildWx, nowMs: wedAmShoulder
  });
  assert.equal(shoulderStretched.isHeadwayStretched, true, '6m live train gap on TWL must flag isHeadwayStretched');
  assert.ok(shoulderStretched.score > shoulderTight.score * 1.25,
    `6m gap (${shoulderStretched.score}) must amplify platform crush vs 2.5m gap (${shoulderTight.score})`);
  assert.equal(shoulderStretched.state, 'CRUSH', '6m gap during high-pressure shoulder must push to CRUSH');

  const rainMidTwl = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'MOK', direction: 'DOWN', destCode: 'CEN',
    nextTrains: [wedMid1130 + 60000, wedMid1130 + 210000], hkoWeather: rainstormWx, nowMs: wedMid1130
  });
  assert.ok(rainMidTwl.score > normalMidTwl.score * 1.2,
    `Rainstorm urbanIndoorMod must push underground MTR demand up (${rainMidTwl.score} > ${normalMidTwl.score})`);

  const preT8Homebound = win.estimateMtrLoadStatus({
    lineCode: 'TWL', stationCode: 'CEN', direction: 'UP', destCode: 'TSW',
    nextTrains: [wedMid1130 + 60000, wedMid1130 + 210000], hkoWeather: preT8Wx, nowMs: wedMid1130
  });
  assert.ok(preT8Homebound.score > normalMidTwl.score * 1.7,
    `Pre-T8 warning must spike homebound MTR line (${preT8Homebound.score} vs ${normalMidTwl.score})`);

  // 4. Hybrid Ferry Load Adapter: FAST vs ORD, Sailing Interval (>= 45m vs <= 15m), Sensor-Fused vs Timetable-Only
  const sunAm1000 = Date.UTC(2026, 10, 22, 2, 0, 0); // Sun 10:00 HKT (Nov cool & clear)
  const fastCcOut = win.estimateFerryLoadStatus({
    operator: 'Sun Ferry', routeName: 'Central - Cheung Chau',
    pierOrigin: 'Central Pier 5', pierDest: 'Cheung Chau',
    vesselType: 'FAST', sailingIntervalMins: 45, liveDelayMins: 0, hasLiveApi: true,
    hkoWeather: clearMildWx, nowMs: sunAm1000
  });
  const ordCcOut = win.estimateFerryLoadStatus({
    operator: 'Sun Ferry', routeName: 'Central - Cheung Chau',
    pierOrigin: 'Central Pier 5', pierDest: 'Cheung Chau',
    vesselType: 'ORD', sailingIntervalMins: 45, liveDelayMins: 0, hasLiveApi: true,
    hkoWeather: clearMildWx, nowMs: sunAm1000
  });
  assert.equal(fastCcOut.fusionMode, 'SENSOR_FUSED');
  assert.ok(fastCcOut.score > ordCcOut.score * 1.7,
    `Fast Ferry (${fastCcOut.score}) must load much faster than Ordinary 3-deck (${ordCcOut.score})`);
  assert.equal(fastCcOut.state, 'QUEUE_EARLY', 'Weekend AM Fast Ferry to Cheung Chau must flag QUEUE_EARLY');
  assert.equal(fastCcOut.labelEn, 'Queue Early');
  assert.equal(fastCcOut.labelTc, '建議早到');

  // Sailing interval concentration (>= 45m vs <= 15m shuttle)
  const longGapDb = win.estimateFerryLoadStatus({
    operator: 'Discovery Bay', routeName: 'Central - Discovery Bay',
    pierOrigin: 'Central Pier 3', pierDest: 'Discovery Bay',
    vesselType: 'FAST', sailingIntervalMins: 50, hasLiveApi: false,
    hkoWeather: clearMildWx, nowMs: sunAm1000
  });
  const shuttleDb = win.estimateFerryLoadStatus({
    operator: 'Discovery Bay', routeName: 'Central - Discovery Bay',
    pierOrigin: 'Central Pier 3', pierDest: 'Discovery Bay',
    vesselType: 'FAST', sailingIntervalMins: 15, hasLiveApi: false,
    hkoWeather: clearMildWx, nowMs: sunAm1000
  });
  assert.equal(longGapDb.fusionMode, 'TIMETABLE_ONLY', 'Discovery Bay must use TIMETABLE_ONLY fusion mode');
  assert.ok(longGapDb.score > shuttleDb.score * 1.45,
    `50m sailing interval (${longGapDb.score}) must concentrate arrivals harder than 15m shuttle (${shuttleDb.score})`);

  // Star Ferry timetable-only quiet midday -> SPACE
  const starQuiet = win.estimateFerryLoadStatus({
    operator: 'Star Ferry', routeName: 'Central - Tsim Sha Tsui',
    pierOrigin: 'Central Pier 7', pierDest: 'Tsim Sha Tsui',
    vesselType: 'STAR', sailingIntervalMins: 10, hasLiveApi: false,
    hkoWeather: clearMildWx, nowMs: wedMid1130
  });
  assert.equal(starQuiet.fusionMode, 'TIMETABLE_ONLY');
  assert.equal(starQuiet.state, 'SPACE');
  assert.equal(starQuiet.labelEn, 'Space');
  assert.equal(starQuiet.labelTc, '充裕');

  // Sensor-fused live departure lag (>= 4m amplifies boarding queue load)
  const satPm1500 = Date.UTC(2026, 10, 21, 7, 0, 0); // Sat 15:00 HKT
  const mwOnTime = win.estimateFerryLoadStatus({
    operator: 'Sun Ferry', routeName: 'Central - Mui Wo',
    pierOrigin: 'Central Pier 6', pierDest: 'Mui Wo',
    vesselType: 'ORD', sailingIntervalMins: 35, liveDelayMins: 0, hasLiveApi: true,
    hkoWeather: clearMildWx, nowMs: satPm1500
  });
  const mwDelayed = win.estimateFerryLoadStatus({
    operator: 'Sun Ferry', routeName: 'Central - Mui Wo',
    pierOrigin: 'Central Pier 6', pierDest: 'Mui Wo',
    vesselType: 'ORD', sailingIntervalMins: 35, liveDelayMins: 6, hasLiveApi: true,
    hkoWeather: clearMildWx, nowMs: satPm1500
  });
  assert.equal(mwDelayed.isLiveDelayAmplified, true, '6m live delay on Sun Ferry must amplify boarding queue');
  assert.ok(mwDelayed.score > mwOnTime.score * 1.3,
    `Delayed ferry (${mwDelayed.score}) must strongly exceed on-time sailing (${mwOnTime.score})`);

  // 5. Cross-Modal Mui Wo Ferry-to-Bus Pulse (Central -> Mui Wo ferry docked 8m ago boosts NLB 1, 2, 3M origin departures)
  const sun0943 = Date.UTC(2026, 10, 22, 1, 43, 0); // Sun 09:43 HKT (09:00 ferry + 35m crossing = 09:35 dock -> 8m ago!)
  const sun0958 = Date.UTC(2026, 10, 22, 1, 58, 0); // Sun 09:58 HKT (23m after 09:35 dock; next ferry docks 10:15 -> quiet gap)

  const pulseActive = win.getRecentFerryArrivalPulse({
    pierName: 'Mui Wo Ferry Pier',
    nowMs: sun0943,
    hkoWeather: clearMildWx
  });
  const pulseQuiet = win.getRecentFerryArrivalPulse({
    pierName: 'Mui Wo Ferry Pier',
    nowMs: sun0958,
    hkoWeather: clearMildWx
  });
  assert.equal(pulseActive.active, true, `09:43 HKT (8m after 09:35 Central->Mui Wo dock) must activate pulse`);
  assert.ok(pulseActive.minsSinceDock >= 5 && pulseActive.minsSinceDock <= 15,
    `Expected minsSinceDock in 5..15, got ${pulseActive.minsSinceDock}`);
  assert.ok(pulseActive.pulseMultiplier >= 1.35, `Expected pulseMultiplier >= 1.35, got ${pulseActive.pulseMultiplier}`);
  assert.equal(pulseQuiet.active, false, '23m after docking must NOT trigger ferry arrival pulse');

  const nlb3mFromMuiWo = {
    routeNo: '3M',
    orig_en: 'Mui Wo Ferry Pier',
    dest_en: 'Tung Chung Station Bus Terminus',
    totalStops: 34
  };
  const busWithPulse = win.estimateGlobalBusLoadRisk(nlb3mFromMuiWo, 0, {
    stopName: 'Mui Wo Ferry Pier',
    totalStops: 34
  }, clearMildWx, sun0943);
  const busWithoutPulse = win.estimateGlobalBusLoadRisk(nlb3mFromMuiWo, 0, {
    stopName: 'Mui Wo Ferry Pier',
    totalStops: 34
  }, clearMildWx, sun0958);
  assert.equal(busWithPulse.ferryPulse.active, true, 'NLB 3M Mui Wo origin must ingest active ferry pulse');
  assert.equal(busWithoutPulse.ferryPulse.active, false, 'NLB 3M outside docking window must have inactive ferry pulse');
  assert.ok(busWithPulse.score > busWithoutPulse.score * 1.8,
    `Mui Wo ferry pulse (${busWithPulse.score}) must sharply elevate stop #0 load vs quiet window (${busWithoutPulse.score})`);
  assert.ok(busWithPulse.level === 'HIGH_LOAD' || busWithPulse.level === 'MODERATE',
    `NLB 3M Mui Wo origin after ferry dock must elevate above NORMAL, got ${busWithPulse.level}`);
  assert.ok(/ferry/i.test(busWithPulse.tip), `Expected ferry arrival tip on Mui Wo bus card, got: "${busWithPulse.tip}"`);

  // Non-Mui-Wo stop (e.g. mid-route stop 12) must not trigger Mui Wo pier origin pulse
  const busMidRoute = win.estimateGlobalBusLoadRisk(nlb3mFromMuiWo, 12, {
    stopName: 'Pui O',
    totalStops: 34
  }, clearMildWx, sun0943);
  assert.equal(busMidRoute.ferryPulse.active, false, 'Mid-route stop #12 must not inherit Mui Wo pier origin pulse');

  // 6. Strict decoupling: road-speed telemetry modules must remain untouched by MTR/Ferry/People-Flow adapters
  for (const rel of ['public/busspeed.js', 'public/map.js', 'public/map-traffic-overlay.js']) {
    const src = fs.readFileSync(rel, 'utf8');
    assert.ok(!/mtrsurge|ferrysurge|estimateMtrLoadStatus|estimateFerryLoadStatus|getRecentFerryArrivalPulse/i.test(src),
      `${rel} must remain strictly decoupled from mtrsurge.js and ferrysurge.js`);
  }
});






