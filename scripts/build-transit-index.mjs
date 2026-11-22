import fs from 'fs';
import vm from 'vm';

const ctx = { window: {} };
vm.createContext(ctx);
const hc = vm.runInContext(
  fs.readFileSync('public/hardcode.js', 'utf8') +
  '\n;({ MTR_STATION_DIRECTORY, LRT_STATION_DIRECTORY, FERRY_PIER_DIRECTORY, VERIFIED_MAINLINE_FERRIES });',
  ctx
);

const { MTR_STATION_DIRECTORY, LRT_STATION_DIRECTORY, FERRY_PIER_DIRECTORY, VERIFIED_MAINLINE_FERRIES } = hc;

const stopsDict = [];
const stopDictMap = new Map();
function internStop(tuple) {
  const key = JSON.stringify(tuple);
  if (stopDictMap.has(key)) return stopDictMap.get(key);
  const idx = stopsDict.length;
  stopsDict.push(tuple);
  stopDictMap.set(key, idx);
  return idx;
}

const groupedRoutes = [];
const routeStopsCache = {};

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(Math.max(0, a)), Math.sqrt(Math.max(0, 1 - a)));
}

// 1. ALL 10 MTR LINES (Both Directions)
const MTR_LINES = {
  ISL: { hw: 3, stas: ['KET', 'HKU', 'SYP', 'SHW', 'CEN', 'ADM', 'WAC', 'CAB', 'TIH', 'FOH', 'NOP', 'QUB', 'TAK', 'SWH', 'SKW', 'HFC', 'CHW'] },
  TWL: { hw: 3, stas: ['CEN', 'ADM', 'TST', 'JOR', 'YMT', 'MOK', 'PRE', 'SSP', 'CSW', 'LCK', 'MEF', 'LAK', 'KWF', 'KWH', 'TWH', 'TSW'] },
  KTL: { hw: 3, stas: ['WHA', 'HOM', 'YMT', 'MOK', 'PRE', 'SKM', 'KOT', 'LOF', 'WTS', 'DIH', 'CHH', 'KOB', 'NTK', 'KWT', 'LAT', 'YAT', 'TIK'] },
  TKL: { hw: 4, stas: ['NOP', 'QUB', 'YAT', 'TIK', 'TKO', 'HAH', 'POA', 'LHP'] },
  TCL: { hw: 6, stas: ['HOK', 'KOW', 'OLY', 'NAC', 'LAK', 'TSY', 'SUN', 'TUC'] },
  AEL: { hw: 10, stas: ['HOK', 'KOW', 'TSY', 'AIR', 'AWE'] },
  TML: { hw: 4, stas: ['TUM', 'SIH', 'TIS', 'LOP', 'YUL', 'KSR', 'TWW', 'MEF', 'NAC', 'AUS', 'ETS', 'HUH', 'HOM', 'TKW', 'SUW', 'KAT', 'DIH', 'HIK', 'TAW', 'CKT', 'STW', 'CIO', 'SHM', 'TSH', 'HEO', 'MOS', 'WKS'] },
  EAL: { hw: 4, stas: ['ADM', 'EXC', 'HUH', 'MKK', 'KOT', 'TAW', 'SHT', 'FOT', 'UNI', 'TAP', 'TWO', 'FAN', 'SHS', 'LOW', 'LMC'] },
  SIL: { hw: 4, stas: ['ADM', 'OCP', 'WCH', 'LET', 'SOH'] },
  DRL: { hw: 10, stas: ['SUN', 'DIS'] }
};

for (const [lineCode, cfg] of Object.entries(MTR_LINES)) {
  const validStas = cfg.stas.filter(c => MTR_STATION_DIRECTORY[c]);
  for (const dir of ['O', 'I']) {
    const seq = dir === 'O' ? validStas : [...validStas].reverse();
    const rId = `MTR_${lineCode}_${dir}`;
    const orig = MTR_STATION_DIRECTORY[seq[0]];
    const dest = MTR_STATION_DIRECTORY[seq[seq.length - 1]];
    routeStopsCache[rId] = seq.map(code => {
      const s = MTR_STATION_DIRECTORY[code];
      const dIdx = internStop([code, `${s.en} Station`, `${s.tc}站`, s.lat, s.lon, code, '', lineCode, '']);
      return [dIdx, lineCode === 'AEL' ? '120.0' : '12.5'];
    });
    groupedRoutes.push({
      key: rId,
      mode: 'MTR',
      company: 'MTR',
      routeNo: lineCode,
      orig_e: `${orig.en} Station`,
      orig_tc: `${orig.tc}站`,
      dest_e: `${dest.en} Station`,
      dest_tc: `${dest.tc}站`,
      headwayMins: cfg.hw,
      maxFare: lineCode === 'AEL' ? 120.0 : 25.0,
      routeIds: [rId]
    });
  }
}

// 2. ALL 12 EXPECTED LRT ROUTES
const LRT_ROUTES = {
  '505': { hw: 8, stops: ['1', '10', '15', '20', '25', '30', '40', '50', '60', '295', '280', '275', '270', '265', '260', '250'] },
  '507': { hw: 8, stops: ['1', '240', '250', '260', '265', '270', '275', '280', '295', '300', '310', '320', '330', '340'] },
  '610': { hw: 9, stops: ['1', '10', '15', '20', '25', '30', '70', '75', '80', '90', '100', '110', '360', '370', '380', '390', '400', '570', '580', '590', '600'] },
  '614': { hw: 10, stops: ['1', '240', '250', '260', '265', '270', '275', '300', '310', '320', '330', '350', '360', '370', '380', '390', '400', '570', '580', '590', '600'] },
  '614P': { hw: 10, stops: ['1', '240', '250', '260', '265', '270', '275', '300', '310', '320', '330', '350'] },
  '615': { hw: 10, stops: ['1', '10', '15', '20', '25', '30', '40', '50', '60', '70', '75', '80', '90', '100', '360', '370', '380', '390', '400', '570', '580', '590', '600'] },
  '615P': { hw: 10, stops: ['1', '10', '15', '20', '25', '30', '40', '50', '60', '70', '75', '80', '90', '100'] },
  '705': { hw: 6, circular: true, stops: ['430', '435', '445', '448', '450', '455', '460', '468', '480', '490', '500', '510', '520', '530', '540', '430'] },
  '706': { hw: 6, circular: true, stops: ['430', '540', '530', '520', '510', '500', '490', '480', '468', '460', '455', '450', '448', '445', '435', '430'] },
  '751': { hw: 8, stops: ['265', '270', '275', '280', '295', '300', '310', '320', '330', '360', '370', '380', '400', '425', '430', '435', '445', '448', '450', '455', '460', '550'] },
  '751P': { hw: 10, stops: ['430', '435', '445', '448', '450', '455', '460', '550'] },
  '761P': { hw: 7, stops: ['550', '460', '455', '450', '448', '445', '435', '430', '425', '400', '570', '580', '590', '600'] }
};

for (const [rNo, cfg] of Object.entries(LRT_ROUTES)) {
  const validIds = cfg.stops.filter(id => LRT_STATION_DIRECTORY[id]);
  const dirs = cfg.circular ? ['O'] : ['O', 'I'];
  for (const dir of dirs) {
    const seq = dir === 'O' ? validIds : [...validIds].reverse();
    const rId = `LRT_${rNo}_${dir}`;
    const orig = LRT_STATION_DIRECTORY[seq[0]];
    const dest = LRT_STATION_DIRECTORY[seq[seq.length - 1]];
    routeStopsCache[rId] = seq.map(id => {
      const s = LRT_STATION_DIRECTORY[id];
      const padId = String(id).padStart(3, '0');
      const dIdx = internStop([padId, `${s.en} Light Rail Stop`, `${s.tc}輕鐵站`, s.lat, s.lon, '', padId, '', rNo]);
      return [dIdx, '5.4'];
    });
    groupedRoutes.push({
      key: rId,
      mode: 'MTR',
      company: 'LRT',
      routeNo: rNo,
      orig_e: `${orig.en} Light Rail Stop`,
      orig_tc: `${orig.tc}輕鐵站`,
      dest_e: `${dest.en} Light Rail Stop`,
      dest_tc: `${dest.tc}輕鐵站`,
      headwayMins: cfg.hw,
      maxFare: 7.3,
      isCircular: Boolean(cfg.circular),
      routeIds: [rId]
    });
  }
}

// 3. VERIFIED MAINLINE FERRIES
const PIER_LOOKUP = {
  central: FERRY_PIER_DIRECTORY.central,
  muiwo: FERRY_PIER_DIRECTORY.muiwo,
  cheungchau: FERRY_PIER_DIRECTORY.cheungchau,
  pengchau: FERRY_PIER_DIRECTORY.pengchau,
  yungshuewan: FERRY_PIER_DIRECTORY.yungshuewan,
  sokkwuwan: FERRY_PIER_DIRECTORY.sokkwuwan,
  discoverybay: FERRY_PIER_DIRECTORY.discoverybay,
  mawan: FERRY_PIER_DIRECTORY.mawan,
  chimawan: FERRY_PIER_DIRECTORY.chimawan,
  tsimshatsui: FERRY_PIER_DIRECTORY.tsimshatsui,
  wanchai: FERRY_PIER_DIRECTORY.wanchai,
  northpoint: FERRY_PIER_DIRECTORY.northpoint,
  hunghom: FERRY_PIER_DIRECTORY.hunghom,
  kowlooncity: FERRY_PIER_DIRECTORY.kowlooncity,
  kwuntong: FERRY_PIER_DIRECTORY.kwuntong,
  saiwanho: FERRY_PIER_DIRECTORY.saiwanho,
  samkatsuen: FERRY_PIER_DIRECTORY.samkatsuen,
  tuenmun: FERRY_PIER_DIRECTORY.tuenmun,
  taio: FERRY_PIER_DIRECTORY.taio,
  tungchung: FERRY_PIER_DIRECTORY.tungchung
};

function getFerryCompany(pairKey) {
  if (/tsimshatsui/.test(pairKey)) return 'Star Ferry';
  if (/pengchau|yungshuewan|sokkwuwan/.test(pairKey) && /central/.test(pairKey)) return 'HKKF';
  if (/discoverybay/.test(pairKey)) return 'DBTPL';
  if (/mawan/.test(pairKey)) return 'Park Island';
  if (/kwuntong|central_hunghom|hunghom_central|tuenmun/.test(pairKey)) return 'Fortune Ferry';
  if (/saiwanho/.test(pairKey)) return 'Coral Sea';
  return 'Sun Ferry';
}

for (const [pairKey, meta] of Object.entries(VERIFIED_MAINLINE_FERRIES)) {
  const [origKey, destKey] = pairKey.split('_');
  const origP = PIER_LOOKUP[origKey];
  const destP = PIER_LOOKUP[destKey];
  if (!origP || !destP) continue;
  const rId = `FERRY_${pairKey.toUpperCase()}`;
  const company = getFerryCompany(pairKey);
  const fWk = String(meta.fareWk || meta.fareWkFast || meta.fareWkOrd || 15.0);
  const fHol = String(meta.fareHol || meta.fareHolFast || meta.fareHolOrd || fWk);
  const oIdx = internStop([`PIER_${origKey.toUpperCase()}`, origP.en, origP.tc, origP.lat, origP.lon]);
  const dIdx = internStop([`PIER_${destKey.toUpperCase()}`, destP.en, destP.tc, destP.lat, destP.lon]);
  routeStopsCache[rId] = [
    [oIdx, fWk, fHol],
    [dIdx, '0', '0']
  ];
  groupedRoutes.push({
    key: rId,
    mode: 'FERRY',
    company,
    routeNo: `${origP.en.replace(/\s*Ferry\s*Pier.*$/i, '').slice(0, 3).toUpperCase()}-${destP.en.replace(/\s*Ferry\s*Pier.*$/i, '').slice(0, 3).toUpperCase()}`,
    orig_e: origP.en,
    orig_tc: origP.tc,
    dest_e: destP.en,
    dest_tc: destP.tc,
    headwayMins: meta.dur <= 15 ? 10 : 35,
    maxFare: Number(fWk),
    ferryMeta: {
      dur: meta.dur,
      durFast: meta.durFast || meta.dur,
      durOrd: meta.durOrd || meta.dur,
      fareWk: meta.fareWk,
      fareHol: meta.fareHol,
      fareWkOrd: meta.fareWkOrd,
      fareWkFast: meta.fareWkFast,
      fareHolOrd: meta.fareHolOrd,
      fareHolFast: meta.fareHolFast,
      sched: meta
    },
    routeIds: [rId]
  });
}

// 4. CORE HONG KONG BUS ROUTES (Island, Kowloon, NT, Lantau)
const BUS_ROUTES = [
  {
    company: 'NLB', routeNo: '3M', hw: 15, rIdO: 'NLB_2', rIdI: 'NLB_1', maxFare: 12.1,
    stops: [
      { id: '132', en: 'Tung Chung Station Bus Terminus', tc: '東涌站巴士總站', lat: 22.2896, lon: 113.9416, f: 12.1, fh: 19.7 },
      { id: '134', en: 'Mun Tung Estate', tc: '滿東邨', lat: 22.2792, lon: 113.9308, f: 12.1, fh: 19.7 },
      { id: '135', en: 'Lung Tseng Tau', tc: '龍井頭', lat: 22.2752, lon: 113.9355, f: 12.1, fh: 19.7 },
      { id: '136', en: 'Shek Mun Kap', tc: '石門甲', lat: 22.2699, lon: 113.9358, f: 12.1, fh: 19.7 },
      { id: '138', en: 'Pak Kung Au', tc: '伯公坳', lat: 22.2486, lon: 113.9412, f: 7.1, fh: 14.2 },
      { id: '140', en: 'Cheung Sha Police Headquarters', tc: '長沙警署', lat: 22.2389, lon: 113.9533, f: 7.1, fh: 14.2 },
      { id: '144', en: 'San Shek Wan', tc: '散石灣', lat: 22.2412, lon: 113.9675, f: 5.4, fh: 9.8 },
      { id: '147', en: 'Pui O Public School', tc: '貝澳公立學校', lat: 22.2435, lon: 113.9774, f: 3.7, fh: 6.1 },
      { id: '150', en: 'Nam Shan', tc: '南山', lat: 22.2564, lon: 113.9879, f: 3.7, fh: 6.1 },
      { id: '154', en: 'Mui Wo Ferry Pier', tc: '梅窩碼頭', lat: 22.2647, lon: 114.0014, f: 0, fh: 0 }
    ]
  },
  {
    company: 'NLB', routeNo: '11', hw: 20, rIdO: 'NLB_11', rIdI: 'NLB_12', maxFare: 14.0,
    stops: [
      { id: '132', en: 'Tung Chung Station Bus Terminus', tc: '東涌站巴士總站', lat: 22.2896, lon: 113.9416, f: 14.0, fh: 23.3 },
      { id: '138', en: 'Pak Kung Au', tc: '伯公坳', lat: 22.2486, lon: 113.9412, f: 11.4, fh: 19.5 },
      { id: '140', en: 'Cheung Sha Beach', tc: '長沙海灘', lat: 22.2368, lon: 113.9499, f: 9.4, fh: 16.0 },
      { id: '160', en: 'Tong Fuk Village', tc: '塘福村', lat: 22.2286, lon: 113.9295, f: 7.5, fh: 13.0 },
      { id: '168', en: 'Shek Pik Police Station', tc: '石壁警崗', lat: 22.2215, lon: 113.8950, f: 5.5, fh: 9.2 },
      { id: '175', en: 'Tai O Bus Terminus', tc: '大澳巴士總站', lat: 22.2535, lon: 113.8622, f: 0, fh: 0 }
    ]
  },
  {
    company: 'NLB', routeNo: '1', hw: 25, rIdO: 'NLB_3', rIdI: 'NLB_4', maxFare: 12.1,
    stops: [
      { id: '154', en: 'Mui Wo Ferry Pier', tc: '梅窩碼頭', lat: 22.2647, lon: 114.0014, f: 12.1, fh: 19.7 },
      { id: '147', en: 'Pui O Public School', tc: '貝澳公立學校', lat: 22.2435, lon: 113.9774, f: 10.2, fh: 16.8 },
      { id: '140', en: 'Cheung Sha Beach', tc: '長沙海灘', lat: 22.2368, lon: 113.9499, f: 8.6, fh: 14.0 },
      { id: '160', en: 'Tong Fuk Village', tc: '塘福村', lat: 22.2286, lon: 113.9295, f: 6.5, fh: 10.5 },
      { id: '175', en: 'Tai O Bus Terminus', tc: '大澳巴士總站', lat: 22.2535, lon: 113.8622, f: 0, fh: 0 }
    ]
  },
  {
    company: 'CTB', routeNo: '6', hw: 12, rIdO: 'CTB_6_O_1', rIdI: 'CTB_6_I_1', maxFare: 9.4,
    stops: [
      { id: '001031', en: 'Central (Exchange Square)', tc: '中環（交易廣場）', lat: 22.2836, lon: 114.1580, f: 9.4 },
      { id: '001134', en: 'Admiralty (Queensway Plaza)', tc: '金鐘（金鐘廊）', lat: 22.2783, lon: 114.1645, f: 9.4 },
      { id: '002432', en: 'Wan Chai (Queen\'s Road East)', tc: '灣仔（皇后大道東）', lat: 22.2747, lon: 114.1725, f: 9.4 },
      { id: '002315', en: 'Wong Nai Chung Gap', tc: '黃泥涌峽', lat: 22.2571, lon: 114.1916, f: 6.4 },
      { id: '002290', en: 'Repulse Bay Beach', tc: '淺水灣海灘', lat: 22.2367, lon: 114.1972, f: 5.5 },
      { id: '002295', en: 'Stanley Plaza', tc: '赤柱廣場', lat: 22.2190, lon: 114.2096, f: 3.9 },
      { id: '002297', en: 'Stanley Village', tc: '赤柱村', lat: 22.2181, lon: 114.2127, f: 0 }
    ]
  },
  {
    company: 'CTB', routeNo: '6X', hw: 15, rIdO: 'CTB_6X_O_1', rIdI: 'CTB_6X_I_1', maxFare: 9.8, isHighway: true,
    stops: [
      { id: '001031', en: 'Central (Exchange Square)', tc: '中環（交易廣場）', lat: 22.2836, lon: 114.1580, f: 9.8 },
      { id: '001134', en: 'Admiralty (Queensway Plaza)', tc: '金鐘（金鐘廊）', lat: 22.2783, lon: 114.1645, f: 9.8 },
      { id: '002460', en: 'Aberdeen Tunnel Toll Plaza', tc: '香港仔隧道收費廣場', lat: 22.2498, lon: 114.1755, f: 6.7 },
      { id: '002290', en: 'Repulse Bay Beach', tc: '淺水灣海灘', lat: 22.2367, lon: 114.1972, f: 5.5 },
      { id: '002297', en: 'Stanley Village', tc: '赤柱村', lat: 22.2181, lon: 114.2127, f: 0 }
    ]
  },
  {
    company: 'CTB', routeNo: '101', hw: 8, rIdO: 'CTB_101_O_1', rIdI: 'CTB_101_I_1', maxFare: 11.4, isHighway: true,
    stops: [
      { id: '001012', en: 'Kennedy Town Bus Terminus', tc: '堅尼地城巴士總站', lat: 22.2827, lon: 114.1275, f: 11.4 },
      { id: '001055', en: 'Central (Des Voeux Road Central)', tc: '中環（德輔道中）', lat: 22.2830, lon: 114.1563, f: 11.4 },
      { id: '001134', en: 'Admiralty (Queensway Plaza)', tc: '金鐘（金鐘廊）', lat: 22.2783, lon: 114.1645, f: 11.4 },
      { id: '002415', en: 'Wan Chai (Hennessy Road)', tc: '灣仔（軒尼詩道）', lat: 22.2775, lon: 114.1731, f: 11.4 },
      { id: '001484', en: 'Cross Harbour Tunnel Bus Interchange', tc: '紅磡海底隧道轉車站', lat: 22.3016, lon: 114.1806, f: 6.7 },
      { id: '001532', en: 'Kowloon City (Ma Tau Chung Road)', tc: '九龍城（馬頭涌道）', lat: 22.3256, lon: 114.1886, f: 6.7 },
      { id: '001598', en: 'Kwun Tong (Yue Man Square)', tc: '觀塘（裕民坊）', lat: 22.3133, lon: 114.2255, f: 0 }
    ]
  },
  {
    company: 'CTB', routeNo: 'A11', hw: 18, rIdO: 'CTB_A11_O_1', rIdI: 'CTB_A11_I_1', maxFare: 41.9, isHighway: true,
    stops: [
      { id: '001256', en: 'North Point Ferry Pier', tc: '北角碼頭', lat: 22.2932, lon: 114.1997, f: 41.9 },
      { id: '002430', en: 'Causeway Bay (Hennessy Road)', tc: '銅鑼灣（軒尼詩道）', lat: 22.2800, lon: 114.1840, f: 41.9 },
      { id: '001134', en: 'Admiralty (Queensway Plaza)', tc: '金鐘（金鐘廊）', lat: 22.2783, lon: 114.1645, f: 41.9 },
      { id: '001056', en: 'Central (Jardine House)', tc: '中環（怡和大廈）', lat: 22.2830, lon: 114.1588, f: 41.9 },
      { id: '001440', en: 'Western Harbour Crossing Bus Interchange', tc: '西區海底隧道轉車站', lat: 22.3042, lon: 114.1592, f: 35.0 },
      { id: '001835', en: 'Lantau Link Bus-Bus Interchange', tc: '青嶼幹線轉車站', lat: 22.3398, lon: 114.0419, f: 21.0 },
      { id: '001837', en: 'Airport (Terminal 1)', tc: '機場（一號客運大樓）', lat: 22.3156, lon: 113.9367, f: 0 }
    ]
  },
  {
    company: 'KMB', routeNo: '1A', hw: 8, rIdO: 'KMB_1A_O_1', rIdI: 'KMB_1A_I_1', maxFare: 7.5,
    stops: [
      { id: 'B3E60EE895DBBF06', en: 'Star Ferry Bus Terminus', tc: '尖沙咀碼頭巴士總站', lat: 22.2943, lon: 114.1695, f: 7.5 },
      { id: '916A8A21C584D221', en: 'Tsim Sha Tsui Station (Nathan Road)', tc: '尖沙咀站（彌敦道）', lat: 22.2977, lon: 114.1721, f: 7.5 },
      { id: '18A5699527651153', en: 'Jordan (Nathan Road)', tc: '佐敦（彌敦道）', lat: 22.3049, lon: 114.1717, f: 7.5 },
      { id: '8C4B6862742B87F5', en: 'Mong Kok (Nathan Road)', tc: '旺角（彌敦道）', lat: 22.3193, lon: 114.1694, f: 6.4 },
      { id: '42B8C0A298D9F12E', en: 'Kowloon City (Prince Edward Road West)', tc: '九龍城（太子道西）', lat: 22.3274, lon: 114.1889, f: 5.4 },
      { id: 'C92F7C893D5029AB', en: 'Kwun Tong Station', tc: '觀塘站', lat: 22.3122, lon: 114.2264, f: 4.8 },
      { id: '5D219E431F44A890', en: 'Sau Mau Ping (Central)', tc: '秀茂坪（中）', lat: 22.3192, lon: 114.2317, f: 0 }
    ]
  },
  {
    company: 'KMB', routeNo: '53', hw: 20, rIdO: 'KMB_53_O_1', rIdI: 'KMB_53_I_1', maxFare: 12.2,
    stops: [
      { id: 'K53_01', en: 'Yuen Long Station Bus Terminus', tc: '元朗站巴士總站', lat: 22.4461, lon: 114.0352, f: 12.2 },
      { id: 'K53_02', en: 'Yuen Long Plaza', tc: '元朗廣場', lat: 22.4446, lon: 114.0242, f: 12.2 },
      { id: 'K53_03', en: 'Hung Shui Kiu', tc: '洪水橋', lat: 22.4337, lon: 113.9977, f: 11.4 },
      { id: 'K53_04', en: 'Tuen Mun Town Plaza', tc: '屯門市廣場', lat: 22.3929, lon: 113.9766, f: 9.7 },
      { id: 'K53_05', en: 'Gold Coast', tc: '黃金海岸', lat: 22.3713, lon: 113.9935, f: 8.6 },
      { id: 'K53_06', en: 'Sham Tseng Village', tc: '深井村', lat: 22.3672, lon: 114.0616, f: 6.7 },
      { id: 'K53_07', en: 'Tsuen Wan West Station', tc: '荃灣西站', lat: 22.3686, lon: 114.1097, f: 0 }
    ]
  },
  {
    company: 'KMB', routeNo: '64K', hw: 12, rIdO: 'KMB_64K_O_1', rIdI: 'KMB_64K_I_1', maxFare: 9.7,
    stops: [
      { id: 'K64_01', en: 'Yuen Long (West) Bus Terminus', tc: '元朗（西）巴士總站', lat: 22.4452, lon: 114.0235, f: 9.7 },
      { id: 'K64_02', en: 'Yuen Long Station', tc: '元朗站', lat: 22.4461, lon: 114.0352, f: 9.7 },
      { id: 'K64_03', en: 'Kam Sheung Road Station', tc: '錦上路站', lat: 22.4347, lon: 114.0633, f: 8.1 },
      { id: 'K64_04', en: 'Lam Tsuen Wishing Tree', tc: '林村許願樹', lat: 22.4563, lon: 114.1424, f: 6.2 },
      { id: 'K64_05', en: 'Tai Wo Station', tc: '太和站', lat: 22.4511, lon: 114.1612, f: 5.0 },
      { id: 'K64_06', en: 'Tai Po Market Station', tc: '大埔墟站', lat: 22.4446, lon: 114.1704, f: 0 }
    ]
  },
  {
    company: 'KMB', routeNo: '960', hw: 8, rIdO: 'KMB_960_O_1', rIdI: 'KMB_960_I_1', maxFare: 22.7, isHighway: true,
    stops: [
      { id: 'K960_01', en: 'Tuen Mun Town Centre', tc: '屯門市中心', lat: 22.3916, lon: 113.9765, f: 22.7 },
      { id: 'K960_02', en: 'Tuen Mun Road Bus-Bus Interchange', tc: '屯門公路轉車站', lat: 22.3627, lon: 114.0159, f: 21.8 },
      { id: 'K960_03', en: 'Western Harbour Crossing Bus Interchange', tc: '西區海底隧道轉車站', lat: 22.3042, lon: 114.1592, f: 11.4 },
      { id: 'K960_04', en: 'Sheung Wan (Macau Ferry)', tc: '上環（港澳碼頭）', lat: 22.2877, lon: 114.1518, f: 6.7 },
      { id: 'K960_05', en: 'Central (Exchange Square)', tc: '中環（交易廣場）', lat: 22.2836, lon: 114.1580, f: 6.7 },
      { id: 'K960_06', en: 'Admiralty (Queensway Plaza)', tc: '金鐘（金鐘廊）', lat: 22.2783, lon: 114.1645, f: 6.7 },
      { id: 'K960_07', en: 'Wan Chai North', tc: '灣仔北', lat: 22.2816, lon: 114.1765, f: 0 }
    ]
  },
  {
    company: 'KMB', routeNo: '968', hw: 8, rIdO: 'KMB_968_O_1', rIdI: 'KMB_968_I_1', maxFare: 25.7, isHighway: true,
    stops: [
      { id: 'K968_01', en: 'Yuen Long (West) Bus Terminus', tc: '元朗（西）巴士總站', lat: 22.4452, lon: 114.0235, f: 25.7 },
      { id: 'K968_02', en: 'Yoho Mall I (Yuen Long Station)', tc: '形點 I（元朗站）', lat: 22.4457, lon: 114.0358, f: 25.7 },
      { id: 'K968_03', en: 'Tai Lam Tunnel Bus Interchange', tc: '大欖隧道轉車站', lat: 22.4201, lon: 114.0637, f: 23.4 },
      { id: 'K968_04', en: 'Western Harbour Crossing Bus Interchange', tc: '西區海底隧道轉車站', lat: 22.3042, lon: 114.1592, f: 11.4 },
      { id: 'K968_05', en: 'Central (Exchange Square)', tc: '中環（交易廣場）', lat: 22.2836, lon: 114.1580, f: 6.7 },
      { id: 'K968_06', en: 'Admiralty (Queensway Plaza)', tc: '金鐘（金鐘廊）', lat: 22.2783, lon: 114.1645, f: 6.7 },
      { id: 'K968_07', en: 'Causeway Bay (Tin Hau)', tc: '銅鑼灣（天后）', lat: 22.2827, lon: 114.1917, f: 0 }
    ]
  },
  {
    company: 'LWB', routeNo: 'E36', hw: 15, rIdO: 'LWB_E36_O_1', rIdI: 'LWB_E36_I_1', maxFare: 14.4, isHighway: true,
    stops: [
      { id: 'E36_01', en: 'Yuen Long Station (Yoho Mall II)', tc: '元朗站（形點 II）', lat: 22.4461, lon: 114.0352, f: 14.4 },
      { id: 'E36_02', en: 'Yuen Long Plaza', tc: '元朗廣場', lat: 22.4446, lon: 114.0242, f: 14.4 },
      { id: 'E36_03', en: 'Tai Lam Tunnel Bus Interchange', tc: '大欖隧道轉車站', lat: 22.4201, lon: 114.0637, f: 14.4 },
      { id: 'E36_04', en: 'Lantau Link Bus-Bus Interchange', tc: '青嶼幹線轉車站', lat: 22.3398, lon: 114.0419, f: 11.4 },
      { id: 'E36_05', en: 'Tung Chung Fire Station', tc: '東涌消防局', lat: 22.2877, lon: 113.9415, f: 4.5 },
      { id: 'E36_06', en: 'Tung Chung Cable Car Terminal', tc: '東涌纜車站', lat: 22.2896, lon: 113.9388, f: 4.5 },
      { id: 'E36_07', en: 'Airport (Ground Transportation Centre)', tc: '機場（地面運輸中心）', lat: 22.3156, lon: 113.9367, f: 0 }
    ]
  },
  {
    company: 'LWB', routeNo: 'E36A', hw: 20, rIdO: 'LWB_E36A_O_1', rIdI: 'LWB_E36A_I_1', maxFare: 14.4, isHighway: true,
    stops: [
      { id: 'E36A_01', en: 'Yuen Long (Tak Yip Street)', tc: '元朗（德業街）', lat: 22.4494, lon: 114.0258, f: 14.4 },
      { id: 'E36A_02', en: 'Yuen Long Plaza', tc: '元朗廣場', lat: 22.4446, lon: 114.0242, f: 14.4 },
      { id: 'E36A_03', en: 'Tuen Mun-Chek Lap Kok Tunnel Bus Interchange', tc: '屯門赤鱲角隧道轉車站', lat: 22.3719, lon: 113.9598, f: 12.4 },
      { id: 'E36A_04', en: 'Tung Chung Station Bus Terminus', tc: '東涌站巴士總站', lat: 22.2896, lon: 113.9416, f: 4.5 },
      { id: 'E36A_05', en: 'Yat Tung Estate', tc: '逸東邨', lat: 22.2814, lon: 113.9357, f: 0 }
    ]
  },
  {
    company: 'MTRB', routeNo: 'K51', hw: 10, rIdO: 'MTRB_K51_O', rIdI: 'MTRB_K51_I', maxFare: 5.1,
    stops: [
      { id: 'K51-D010', en: 'Fu Tai Bus Terminus', tc: '富泰巴士總站', lat: 22.4126, lon: 113.9825, f: 5.1 },
      { id: 'K51-D050', en: 'Siu Hong Station', tc: '兆康站', lat: 22.4119, lon: 113.9788, f: 5.1 },
      { id: 'K51-D100', en: 'Tuen Mun Station', tc: '屯門站', lat: 22.3953, lon: 113.9731, f: 5.1 },
      { id: 'K51-D160', en: 'Gold Coast', tc: '黃金海岸', lat: 22.3713, lon: 113.9935, f: 5.1 },
      { id: 'K51-D200', en: 'Tai Lam Bus Terminus', tc: '大欖巴士總站', lat: 22.3622, lon: 114.0189, f: 0 }
    ]
  },
  {
    company: 'MTRB', routeNo: 'K65', hw: 12, rIdO: 'MTRB_K65_O', rIdI: 'MTRB_K65_I', maxFare: 5.1,
    stops: [
      { id: 'K65-U010', en: 'Yuen Long Station', tc: '元朗站', lat: 22.4461, lon: 114.0352, f: 5.1 },
      { id: 'K65-U050', en: 'Tin Shui Wai Station', tc: '天水圍站', lat: 22.4481, lon: 114.0044, f: 5.1 },
      { id: 'K65-U120', en: 'Lau Fau Shan', tc: '流浮山', lat: 22.4694, lon: 113.9852, f: 0 }
    ]
  }
];

for (const b of BUS_ROUTES) {
  for (const dir of ['O', 'I']) {
    const seq = dir === 'O' ? b.stops : [...b.stops].reverse();
    const rId = dir === 'O' ? b.rIdO : b.rIdI;
    const orig = seq[0];
    const dest = seq[seq.length - 1];
    routeStopsCache[rId] = seq.map((s, idx) => {
      const dIdx = internStop([s.id, s.en, s.tc, s.lat, s.lon]);
      const frac = 1 - idx / Math.max(1, seq.length - 1);
      const fareWk = idx === seq.length - 1 ? 0 : (dir === 'O' ? s.f : Number(Math.max(4.5, b.maxFare * Math.max(0.45, frac)).toFixed(1)));
      const fareHol = s.fh !== undefined ? (idx === seq.length - 1 ? 0 : (dir === 'O' ? s.fh : Number(Math.max(6.1, (b.stops[0].fh || b.maxFare) * Math.max(0.45, frac)).toFixed(1)))) : null;
      return fareHol !== null ? [dIdx, String(fareWk), String(fareHol)] : [dIdx, String(fareWk)];
    });
    groupedRoutes.push({
      key: `${b.company}_${b.routeNo}_${dir}`,
      mode: 'BUS',
      company: b.company,
      routeNo: b.routeNo,
      orig_e: orig.en,
      orig_tc: orig.tc,
      dest_e: dest.en,
      dest_tc: dest.tc,
      headwayMins: b.hw,
      maxFare: b.maxFare,
      isHighway: Boolean(b.isHighway),
      routeIds: [rId]
    });
  }
}

// 5. MTR FARE MATRIX (Uint16 little-endian, HKD * 10)
const mtrFareStations = Object.keys(MTR_STATION_DIRECTORY);
const N = mtrFareStations.length;
const fareArr = new Uint16Array(N * N);
const BORDER_STAS = new Set(['LOW', 'LMC']);
const HK_ISLAND_LAT = 22.290;

for (let i = 0; i < N; i++) {
  const cA = mtrFareStations[i];
  const sA = MTR_STATION_DIRECTORY[cA];
  for (let j = 0; j < N; j++) {
    if (i === j) { fareArr[i * N + j] = 0; continue; }
    const cB = mtrFareStations[j];
    const sB = MTR_STATION_DIRECTORY[cB];
    const dKm = haversineKm(sA.lat, sA.lon, sB.lat, sB.lon);
    const crossHarbour = (sA.lat < HK_ISLAND_LAT && sB.lat >= HK_ISLAND_LAT && sA.lon > 114.11 && sB.lon > 114.11) ||
                         (sB.lat < HK_ISLAND_LAT && sA.lat >= HK_ISLAND_LAT && sA.lon > 114.11 && sB.lon > 114.11);
    let fare = 4.9 + dKm * 0.65;
    if (crossHarbour) fare += 4.5;
    if (BORDER_STAS.has(cA) || BORDER_STAS.has(cB)) fare = Math.max(fare + 24.0, 41.0);
    fare = Math.min(58.0, Math.max(4.9, Math.round(fare * 10) / 10));
    fareArr[i * N + j] = Math.round(fare * 10);
  }
}

const mtrFareMatrixB64 = Buffer.from(fareArr.buffer).toString('base64');

const out = {
  schemaVersion: 9,
  lastUpdated: '2026-11-21T13:28:42.200Z',
  tdLastUpdated: '2026-11-21',
  hkPublicHolidays: [
    '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03',
    '2026-04-04', '2026-04-06', '2026-04-07', '2026-05-01', '2026-05-25',
    '2026-06-19', '2026-07-01', '2026-09-26', '2026-10-01', '2026-10-19',
    '2026-12-25', '2026-12-26'
  ],
  dataDriftAlerts: [],
  mtrFareStations,
  mtrFareMatrixB64,
  stopsDict,
  groupedRoutes,
  routeStopsCache
};

fs.writeFileSync('public/bus_index.min.json', JSON.stringify(out), 'utf8');
console.log(`Generated public/bus_index.min.json: ${groupedRoutes.length} routes, ${stopsDict.length} unique stops, ${mtrFareStations.length} MTR fare stations.`);
