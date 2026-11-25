import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

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
      buildPlannerLegRoadTrafficTagHtml,
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

  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.includes('class="app-switcher-item app-switcher-plan" id="topXferBtn"'), 'Route Planner must be promoted to a labeled top-bar Plan tab');
  assert.ok(html.includes('data-i18n="planApp">Plan</span>') && html.includes("planApp: '規劃'"), 'Plan tab must have EN/ZH labels');
  assert.ok(html.includes('html.ios-standalone .app-switcher') && html.includes('calc(env(safe-area-inset-top) + 14px)'), 'iOS standalone PWA must clear the status-bar whiteout frost zone');
  assert.ok(html.includes('function triggerIosStandaloneTopBarReflow()'), 'index.html must include post-load iOS standalone compositor reflow');
  assert.ok(
    html.includes('id="aboutModal"') &&
    html.includes('id="settingAboutRow"') &&
    html.includes('Rent, Buy &amp; Livability Twin') &&
    html.includes('DrySmart HK — 晾衫王') &&
    html.includes('https://hksundry.pages.dev/') &&
    html.includes('Historical Split-View Map') &&
    html.includes("openCompanionAppAtCurrentStop('sundry')"),
    'About subpage in Settings must include updated HKProperty, DrySmart HK (hksundry.pages.dev), and HK Past companion links'
  );
  assert.ok(html.includes('ONBOARDING_SEEN_KEY') && html.includes('maybeShowFirstVisitOnboarding') && html.includes('openPlannerFromTutorial'), 'First-use visual onboarding carousel with Skip/Next/Open Planner must be wired');
});

test('index.html: detects client device language on landing and renders MTR-style 7-slide HK-landmark visual tutorial', () => {
  const html = fs.readFileSync('index.html', 'utf8');

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

  const plannerSrc = fs.readFileSync('public/planner.js', 'utf8');
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
  const html = fs.readFileSync('index.html', 'utf8');
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
  const html = fs.readFileSync('index.html', 'utf8');
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
  assert.ok(sumEn.headline.includes('Take Bus · Your side clear (No delay)'), `Unexpected EN headline: ${sumEn.headline}`);
  assert.ok(sumEn.detail.includes('Opp. bound jammed (22 km/h)'), `Unexpected EN detail: ${sumEn.detail}`);

  const sumZh = sb.getDirectionalRoadSummary(e36Stops, 0, detectors, true, 14);
  assert.ok(sumZh.headline.includes('可乘巴士 · 你方向暢通 (無延誤)'), `Unexpected ZH headline: ${sumZh.headline}`);
  assert.ok(sumZh.detail.includes('僅對面線塞車 (22 km/h)'), `Unexpected ZH detail: ${sumZh.detail}`);

  // Opposite scenario: bus's OWN direction ahead is jammed (19 km/h, 94% occ -> severe jam -> Switch to MTR)
  const jammedDetectors = [
    { id: 'AID_NB_JAM', lat: 22.3465, lon: 113.9640, rot: 28, spd: 19, occ: 94, tier: 'JAMMED', roadEn: 'Tuen Mun Rd', roadTc: '屯門公路', camKey: 'TM108F' },
  ];
  const jammedSum = sb.getDirectionalRoadSummary(e36Stops, 0, jammedDetectors, false, 14);
  assert.equal(jammedSum.tone, 'jammed');
  assert.equal(jammedSum.modeRec, 'SWITCH_MTR');
  assert.ok(jammedSum.headline.includes('Switch to MTR · Heavy jam on Tuen Mun Rd (+15m)'), `Unexpected jammed headline: ${jammedSum.headline}`);
  assert.ok(jammedSum.detail.includes('19 km/h'), `Unexpected jammed detail: ${jammedSum.detail}`);

  // Planner leg inline road badge when live detectors loaded
  sb.ctx.window.__LIVE_TRAFFIC_DETECTORS__ = detectors;
  const gE36 = { key: 'KMB_E36_O', mode: 'BUS', company: 'KMB', routeNo: 'E36', _stops: e36Stops };
  const legRoadHtml = sb.buildPlannerLegRoadTrafficTagHtml(gE36, e36Stops[0], e36Stops[2], false);
  assert.ok(legRoadHtml.includes('~68 km/h') && legRoadHtml.includes('planner-sig-road-smooth'), `Expected smooth road badge in planner leg, got: ${legRoadHtml}`);

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
  const html = fs.readFileSync('index.html', 'utf8');
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

  // 2. At Stop 16 (TM-CLK Tunnel BBI): even though the tunnel ahead is smooth (90 km/h),
  // the waiting passenger MUST be warned that the incoming bus is stuck in the Tuen Mun jam between Stop 15 and Stop 16!
  const sumAtBbiEn = sb.getDirectionalRoadSummary(stops, tmClkIdx, detectors, false, 8);
  assert.ok(sumAtBbiEn, 'Expected approaching-jam summary at TM-CLK Tunnel BBI');
  assert.equal(sumAtBbiEn.tone, 'jammed', 'Waiting at TM-CLK BBI must surface upstream Tuen Mun jam');
  assert.equal(sumAtBbiEn.isApproaching, true);
  assert.equal(sumAtBbiEn.focusDet?.id, 'AID_TM_WCR_WB');
  assert.ok(sumAtBbiEn.headline.includes('Switch to MTR · Incoming bus in jam'), `Unexpected approaching headline: ${sumAtBbiEn.headline}`);
  assert.ok(sumAtBbiEn.detail.includes('Ahead clear (~90 km/h)'), `Expected ahead-clear context alongside approaching jam: ${sumAtBbiEn.detail}`);

  const sumAtBbiZh = sb.getDirectionalRoadSummary(stops, tmClkIdx, detectors, true, 8);
  assert.ok(sumAtBbiZh.headline.includes('改乘港鐵') && sumAtBbiZh.headline.includes('來車'), `Unexpected ZH approaching headline: ${sumAtBbiZh.headline}`);

  // 3. Opposite-direction-only detector in Tuen Mun MUST NOT trigger a false same-direction jam
  const oppOnlyDetectors = [
    { id: 'AID_TM_OPP_JAM', lat: 22.3925, lon: 113.9768, rot: 42, spd: 14, occ: 95, tier: 'JAMMED', roadEn: 'Tuen Mun Road Northbound', roadTc: '屯門公路北行', camKey: 'TM105F' }
  ];
  const oppOnlySum = sb.getDirectionalRoadSummary(stops, ylParkIdx, oppOnlyDetectors, false, 8);
  assert.ok(oppOnlySum, 'Expected opposite-bound info summary');
  assert.equal(oppOnlySum.tone, 'smooth', 'Opposite-bound Tuen Mun jam must NOT be flagged as same-direction jam');
  assert.ok(oppOnlySum.headline.includes('Opposite bound jammed'), `Unexpected opp-only headline: ${oppOnlySum.headline}`);
});

test('map.js: slim clickable traffic arrows (20-22px inside 32x32 hit area), zoom-15 smooth hiding, left-hand lane separation, and N/S/E/W bound badges', () => {
  const mapCode = fs.readFileSync('public/map.js', 'utf8');
  const addedPolylines: any[] = [];
  const addedMarkers: any[] = [];
  const fakeLayerGroup = {
    addTo() { return this; },
    clearLayers() { addedPolylines.length = 0; addedMarkers.length = 0; },
    hasLayer() { return false; },
  };
  const ctx: any = {
    window: { trafficLayerEnabled: true },
    document: { getElementById: () => null },
    currentLang: 'en',
    escapeHtml: (s: string) => String(s ?? ''),
    escapeJsAttr: (s: string) => String(s ?? ''),
    L: {
      layerGroup: () => fakeLayerGroup,
      polyline: (latlngs: any, opts: any) => {
        const obj = { latlngs, opts, popupFn: null as any, addTo() { addedPolylines.push(obj); return obj; }, bindTooltip() { return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; } };
        return obj;
      },
      divIcon: (opts: any) => opts,
      marker: (latlng: any, opts: any) => {
        const obj = { latlng, opts, popupFn: null as any, addTo() { addedMarkers.push(obj); return obj; }, bindTooltip() { return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; } };
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

  // Popup displays crisp directional bound pill
  const sbPopup = sbMarker.popupFn();
  const nbPopup = nbMarker.popupFn();
  assert.ok(sbPopup.includes('↓ Southbound') && sbPopup.includes('#7C3AED'), 'Southbound popup must show Southbound pill');
  assert.ok(nbPopup.includes('↑ Northbound') && nbPopup.includes('#1D4ED8'), 'Northbound popup must show Northbound pill');
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

  // 1. With road-snapped polyline: strictly locks onto TDS90067 (YLH) and preserves opposite-bound jam callout
  const sumRoadSnapped = sb.getDirectionalRoadSummary(stops, 0, detectors, false, 8, e36RoadPolyline);
  assert.ok(sumRoadSnapped, 'Expected road-snapped summary');
  assert.equal(sumRoadSnapped.tone, 'smooth', 'On-corridor YLH is smooth (82 km/h); off-corridor slow detectors must NOT poison verdict');
  assert.equal(sumRoadSnapped.focusDet?.id, 'TDS90067', `Must select on-corridor YLH detector TDS90067, got ${sumRoadSnapped.focusDet?.id}`);
  assert.equal(sumRoadSnapped.oppDet?.id, 'TDS90068', 'Must retain opposite-bound YLH jam callout');

  // 2. Even WITHOUT road-snapped polyline (before async fetch completes), Castle Peak Rd / LRT detector is strictly excluded on highway/BBI spans
  const onlyCprAndYlh = [detectors[0], detectors[2]];
  const sumFallback = sb.getDirectionalRoadSummary(stops, 0, onlyCprAndYlh, false, 8, null);
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
  const html = fs.readFileSync('index.html', 'utf8');
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
  const mapCode = fs.readFileSync('public/map.js', 'utf8');
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
        const obj = { latlngs, opts, popupFn: null as any, addTo() { addedPolylines.push(obj); return obj; }, bindTooltip() { return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; } };
        return obj;
      },
      divIcon: (opts: any) => opts,
      marker: (latlng: any, opts: any) => {
        const obj = { latlng, opts, popupFn: null as any, addTo() { addedMarkers.push(obj); return obj; }, bindTooltip() { return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; } };
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

  const popupTexts = addedMarkers.map((m: any) => m.popupFn());
  assert.ok(popupTexts.some((t: string) => t.includes('YLH Westbound Slow')), 'Prioritized SLOW bottleneck must render on route map');
  assert.ok(!popupTexts.some((t: string) => t.includes('YLH Westbound Far')), 'Smooth-flow detectors must NEVER render circle/arrow badges on active bus route view');

  // Verify every traffic arrow zIndexOffset sits strictly below numbered stop markers (320 / 650)
  for (const m of addedMarkers) {
    assert.ok(m.opts.zIndexOffset <= 140, `Expected traffic arrow zIndexOffset <= 140, got ${m.opts.zIndexOffset}`);
  }
  assert.ok(mapCode.includes('zIndexOffset: isAct ? 650 : 320'), 'Stop markers must sit at zIndexOffset 320 (normal) / 650 (active) strictly above traffic arrows');
});

test('Decision-first Transit: zero off-route clutter (<=2 bottlenecks on route map), 3-tier Bus-vs-MTR verdicts, and E36 Tuen Mun Rd (TDS90048) + YLH (TDS90067) worst-bottleneck ranking rejecting CPR-*', () => {
  const sb = loadHardcodeAndPlannerSandbox();

  // --- AC 2: 3-tier plain-English & ZH Bus-vs-MTR Decision Verdicts ---
  const dMinor = sb.synthesizeTrafficDecision({
    status: 'SLOW', avgSpd: 38, minSpd: 38, maxOcc: 32, estDelayMins: 4,
    worstDet: { id: 'TDS90048', spd: 38, occ: 32, tier: 'SLOW', roadEn: 'Tuen Mun Road near San Hui Market - Northbound', roadTc: '屯門公路近新墟街市 - 北行' }
  }, null, false);
  assert.equal(dMinor.modeRec, 'TAKE_BUS');
  assert.equal(dMinor.verdictEn, 'Take Bus · Corridor moving (+2–5m)');

  const dMod = sb.synthesizeTrafficDecision({
    status: 'SLOW', avgSpd: 26, minSpd: 26, maxOcc: 58, estDelayMins: 8,
    worstDet: { id: 'TDS90048', spd: 26, occ: 58, tier: 'SLOW', roadEn: 'Tuen Mun Road near San Hui Market - Northbound', roadTc: '屯門公路近新墟街市 - 北行' }
  }, null, false);
  assert.equal(dMod.modeRec, 'MTR_FASTER');
  assert.equal(dMod.verdictEn, 'Bus delayed (+8m) · MTR may be faster');

  const dSevere = sb.synthesizeTrafficDecision({
    status: 'JAMMED', avgSpd: 12, minSpd: 12, maxOcc: 88, estDelayMins: 15,
    worstDet: { id: 'TDS90048', spd: 12, occ: 88, tier: 'JAMMED', roadEn: 'Tuen Mun Road near San Hui Market - Northbound', roadTc: '屯門公路近新墟街市 - 北行' }
  }, null, false);
  assert.equal(dSevere.modeRec, 'SWITCH_MTR');
  assert.equal(dSevere.verdictEn, 'Switch to MTR · Heavy jam on Tuen Mun Road (+15m)');
  assert.ok(dSevere.verdictTc.includes('改乘港鐵') && dSevere.verdictTc.includes('屯門公路'));

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
  const sumA = sb.getDirectionalRoadSummary(e36Stops, 0, detCaseA, false, 8, e36RealPolyline);
  assert.equal(sumA.focusDet?.id, 'TDS90048', 'When TMR is slower than YLH, TDS90048 must win while CPR-* is rejected');
  assert.equal(sumA.headline, 'Take Bus · Corridor moving (+2–5m)');

  // Case B: Tuen Mun Rd slow at 38 km/h, YLH severely jammed at 11 km/h -> TDS90067 wins with Switch to MTR verdict!
  const detCaseB = [
    detCaseA[0],
    detCaseA[1],
    { ...detCaseA[2], spd: 11, occ: 90, tier: 'JAMMED' },
  ];
  const sumB = sb.getDirectionalRoadSummary(e36Stops, 0, detCaseB, false, 8, e36RealPolyline);
  assert.equal(sumB.focusDet?.id, 'TDS90067', 'When YLH is jammed worse than TMR, TDS90067 must win');
  assert.equal(sumB.modeRec, 'SWITCH_MTR');
  assert.ok(sumB.headline.includes('Switch to MTR · Heavy jam on Yuen Long Highway (+15m)'), `Unexpected YLH severe jam headline: ${sumB.headline}`);

  // --- AC 1: Zoomed-out E36 map hides Sha Tin / Ma On Shan / Tsuen Wan off-route badges and caps route bottlenecks to <= 2 ---
  const mapCode = fs.readFileSync('public/map.js', 'utf8');
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
      polyline: () => ({ addTo() { return this; }, bindTooltip() { return this; }, bindPopup() { return this; } }),
      divIcon: (opts: any) => opts,
      marker: (latlng: any, opts: any) => {
        const obj = { latlng, opts, popupFn: null as any, addTo() { addedMarkers.push(obj); return obj; }, bindTooltip() { return obj; }, bindPopup(fn: any) { obj.popupFn = fn; return obj; } };
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
  const routePopups = addedMarkers.map((m: any) => m.popupFn()).join(' | ');
  assert.ok(!routePopups.includes('Sha Tin') && !routePopups.includes('Ma On Shan') && !routePopups.includes('Tsuen Wan') && !routePopups.includes('Castle Peak'), `Off-route regional/local badges leaked onto E36 route map: ${routePopups}`);
  assert.ok(routePopups.includes('Tuen Mun Road'), 'Worst bottleneck (Tuen Mun Road 14 km/h) must be visible on route map');

  // General browse map (no active bus route selected) still shows regional Sha Tin / Ma On Shan / Tsuen Wan bottlenecks
  mapCtx.window.renderTrafficOverlayOnMap(fakeBrowseMap, true);
  const browsePopups = addedMarkers.map((m: any) => m.popupFn()).join(' | ');
  assert.ok(browsePopups.includes('Sha Tin') || browsePopups.includes('Ma On Shan'), 'General browse map must still display regional traffic markers when no route is selected');
});






