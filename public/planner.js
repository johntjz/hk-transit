// ============================================================================
// File: planner.js (johntjz/Hk-Fleet — Inline Autocomplete, Real-Time ETA Resolution & Card Rendering)
// ============================================================================

var userCommuteProfile = (typeof userCommuteProfile !== 'undefined') ? userCommuteProfile : { home: null, work: null };
var activeCommutePickerSlot = (typeof activeCommutePickerSlot !== 'undefined') ? activeCommutePickerSlot : 'home';
var lastXferSolvedSpec = (typeof lastXferSolvedSpec !== 'undefined') ? lastXferSolvedSpec : null;
var activeXferCorridorIdx = (typeof activeXferCorridorIdx !== 'undefined') ? activeXferCorridorIdx : 0;
var activeXferStopNodeIdx = (typeof activeXferStopNodeIdx !== 'undefined') ? activeXferStopNodeIdx : 0;
var activeUnifiedCardKey = (typeof activeUnifiedCardKey !== 'undefined') ? activeUnifiedCardKey : '';
var xferTimeMode = (typeof xferTimeMode !== 'undefined') ? xferTimeMode : 'NOW';
var xferPlannedHHMM = (typeof xferPlannedHHMM !== 'undefined') ? xferPlannedHHMM : null;
var xferLocoBikeEnabled = (typeof xferLocoBikeEnabled !== 'undefined') ? xferLocoBikeEnabled : false;
var xferSortPref = (typeof xferSortPref !== 'undefined') ? xferSortPref : 'BULLETPROOF';
var activePlannerInlineSlot = (typeof activePlannerInlineSlot !== 'undefined') ? activePlannerInlineSlot : null; // 'home' | 'work' | null
var plannerInlineAlsResults = (typeof plannerInlineAlsResults !== 'undefined') ? plannerInlineAlsResults : [];
var plannerInlineDebounce = (typeof plannerInlineDebounce !== 'undefined') ? plannerInlineDebounce : null;
var plannerInlineReqSeq = (typeof plannerInlineReqSeq !== 'undefined') ? plannerInlineReqSeq : 0;
var xferRenderToken = (typeof xferRenderToken !== 'undefined') ? xferRenderToken : 0;
var xferTimeChangeDebounce = (typeof xferTimeChangeDebounce !== 'undefined') ? xferTimeChangeDebounce : null;
var recentCommutePlaces = (typeof recentCommutePlaces !== 'undefined') ? recentCommutePlaces : [];

function formatLegLoadPillHtml(loadEst) {
  if (!loadEst || !loadEst.cssClass) return '';
  const isZh = (currentLang === 'zh');
  const txt = isZh ? loadEst.labelTc : loadEst.labelEn;
  const titleAttr = (isZh ? loadEst.tipTc : loadEst.tipEn) || `${loadEst.pct}%`;
  return ` <span class="load-pill ${escapeHtml(loadEst.cssClass)}" style="padding:1px 6px;font-size:0.61rem;" title="${escapeHtml(titleAttr)}">${escapeHtml(txt)}</span>`;
}

// Last-bus / last-ferry service-hours cutoff detector (flags departures within 20 min of daily cutoff)
function getLegServiceCutoffWarning(group, depMs, isZh = false) {
  if (!group || !Number.isFinite(depMs)) return null;
  if (group.mode === 'MTR' && group.company === 'MTR') return null;

  const hk = getHongKongNow(depMs);
  const depMin = hk.getHours() * 60 + hk.getMinutes();

  const fmtMin = (m) => {
    const norm = ((Math.round(m) % 1440) + 1440) % 1440;
    const hh = String(Math.floor(norm / 60)).padStart(2, '0');
    const mm = String(norm % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };

  let closingMin = null;
  const wins = Array.isArray(group.activeWindows) ? group.activeWindows : [];
  if (wins.length > 0) {
    // Find the active window containing depMin (skip full-day overnight 0..1439 routes that run 24h)
    const is24h = wins.some(([s, e]) => s <= 15 && e >= 1425) && wins.some(([s]) => s <= 60);
    if (!is24h) {
      let bestEnd = null;
      for (const w of wins) {
        if (!Array.isArray(w) || w.length < 2) continue;
        const [s, e] = w;
        if (depMin >= s - 15 && depMin <= e + 5) {
          // If another window starts right after midnight (e.g. [0, 60]), extend closing time past midnight
          const wrapsPastMidnight = (e >= 1435) && wins.some(([s2, e2]) => s2 === 0 && e2 > 0 && e2 <= 180);
          if (wrapsPastMidnight) {
            const afterMid = wins.find(([s2, e2]) => s2 === 0 && e2 > 0 && e2 <= 180);
            bestEnd = 1440 + afterMid[1];
          } else {
            bestEnd = e;
          }
          break;
        }
      }
      if (bestEnd !== null) closingMin = bestEnd;
    }
  }

  if (closingMin === null) return null;
  const minsRemaining = closingMin - depMin;
  if (minsRemaining >= -5 && minsRemaining <= 20) {
    const cutoffLabel = fmtMin(closingMin);
    const isFerry = group.mode === 'FERRY';
    return {
      isLastSoon: true,
      minsRemaining: Math.max(0, Math.round(minsRemaining)),
      cutoffLabel,
      labelEn: isFerry ? `Last ferry ~${cutoffLabel}` : `Last bus ~${cutoffLabel}`,
      labelTc: isFerry ? `尾班船 ~${cutoffLabel}` : `尾班車 ~${cutoffLabel}`
    };
  }
  return null;
}

window.getLegServiceCutoffWarning = getLegServiceCutoffWarning;

function getPeriodHeadwaySecs(group, targetEpochMs, liveArrsSample = []) {
  if (Array.isArray(liveArrsSample) && liveArrsSample.length >= 2) {
    const firstMs = liveArrsSample[0].rawTargetMs || liveArrsSample[0].targetMs;
    const lastMs = liveArrsSample[liveArrsSample.length - 1].rawTargetMs || liveArrsSample[liveArrsSample.length - 1].targetMs;
    const empSec = Math.round(((lastMs - firstMs) / (liveArrsSample.length - 1)) / 1000);
    if (empSec >= 120 && empSec <= 5400) {
      const baseSec = (Number(group?.headwayMins) || 15) * 60;
      return Math.round(empSec * 0.65 + baseSec * 0.35);
    }
  }

  const hk = getHongKongNow(targetEpochMs);
  const h = hk.getHours();
  const baseMins = Number(group?.headwayMins) || (group?.mode === 'MTR' ? 4 : (group?.mode === 'FERRY' ? 35 : 15));

  if (group?.mode === 'MTR') {
    if (group.company === 'LRT') return ((h >= 7 && h < 9) || (h >= 17 && h < 19)) ? 360 : 480;
    if (group.routeNo === 'AEL' || group.routeNo === 'DRL') return 600;
    if (h >= 21 || h < 7) return 360; // Evening/late-night MTR ~6m headway
    return ((h >= 7 && h < 9) || (h >= 17 && h < 19)) ? 180 : 270;
  }

  let mult = 1.0;
  if (h >= 7 && h < 10) mult = 0.80;
  else if (h >= 10 && h < 17) mult = 1.0;
  else if (h >= 17 && h < 20) mult = 0.85;
  else if (h >= 20 && h < 23) mult = 1.20;
  else mult = 1.45;

  return Math.max(180, Math.min(5400, Math.round(baseMins * 60 * mult)));
}

// ============================================================================
// MTR EXIT-AWARE WALKING HELPER

// ============================================================================
// CORRIDOR-SCOPED HIGHWAY & HKO WEATHER PILLS + DISMISSIBLE ALERT BANNER
// ============================================================================
var dismissedPlannerAlertKey = '';
var currentPlannerAlertKey = '';

function collectSelectedCardCorridors(home, work, selectedCard) {
  const foundById = new Map();
  const corList = Array.isArray(window.HK_STRATEGIC_CORRIDORS) ? window.HK_STRATEGIC_CORRIDORS : [];

  const checkCrossHarbourOrRelevant = (aLa, aLo, bLa, bLo) => {
    if (!isValidRailOrFerryCoord(aLa, aLo) || !isValidRailOrFerryCoord(bLa, bLo)) return;
    if (typeof resolveRelevantCorridorForTrip === 'function') {
      const rel = resolveRelevantCorridorForTrip(aLa, aLo, bLa, bLo);
      if (rel?.id) foundById.set(rel.id, rel);
    }
    // Also detect short cross-harbour trips (e.g. Central <-> TST ~2.3km) where resolveRelevantCorridorForTrip skips <2.5km
    const isHkA = aLa < 22.293 && aLo >= 114.110 && aLo <= 114.265;
    const isHkB = bLa < 22.293 && bLo >= 114.110 && bLo <= 114.265;
    if (isHkA !== isHkB) {
      const ht = corList.find(c => c.id === 'HARBOUR_TUNS');
      if (ht) foundById.set(ht.id, ht);
    }
  };

  if (home && work) {
    checkCrossHarbourOrRelevant(Number(home.lat), Number(home.lon), Number(work.lat), Number(work.lon));
  }

  const checkSegment = (a, b) => {
    const aLa = Number(a?.lat ?? a?.latitude), aLo = Number(a?.lon ?? a?.longitude);
    const bLa = Number(b?.lat ?? b?.latitude), bLo = Number(b?.lon ?? b?.longitude);
    if (!isValidRailOrFerryCoord(aLa, aLo) || !isValidRailOrFerryCoord(bLa, bLo)) return;
    checkCrossHarbourOrRelevant(aLa, aLo, bLa, bLo);
    const pts = [
      [(aLa + bLa) / 2, (aLo + bLo) / 2],
      [aLa * 0.7 + bLa * 0.3, aLo * 0.7 + bLo * 0.3],
      [aLa * 0.3 + bLa * 0.7, aLo * 0.3 + bLo * 0.7]
    ];
    for (const cor of corList) {
      if (foundById.has(cor.id)) continue;
      for (const [pLa, pLo] of pts) {
        if (calculateDistanceKm(pLa, pLo, cor.lat, cor.lon) <= cor.radiusKm) {
          foundById.set(cor.id, cor);
          break;
        }
      }
    }
  };

  if (selectedCard?.type === 'DIRECT' && selectedCard.item) {
    const dp = selectedCard.item;
    if (!dp.group || dp.group.mode !== 'MTR') {
      checkSegment(dp.boardStopObj, dp.alightStopObj);
    }
  } else if (selectedCard?.type === 'XFER' && selectedCard.item) {
    const cor = selectedCard.item;
    const node = cor.xferStopNodes?.[0];
    if (node) {
      if (!cor.leg1Group || cor.leg1Group.mode !== 'MTR') {
        checkSegment(cor.board1StopObj, node.alight1StopObj);
      }
      const leg2End = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
      if (!cor.leg2Group || cor.leg2Group.mode !== 'MTR') {
        checkSegment(node.board2StopObj, leg2End);
      }
      (cor.leg3Options || []).forEach(l3 => {
        if (!l3.group || l3.group.mode !== 'MTR') {
          checkSegment(l3.boardStopObj, l3.alightStopObj);
        }
      });
    }
  }

  return Array.from(foundById.values());
}

function evaluatePlannerAlertBannerState(wx, liveCorridors, home, work, selectedCard = null, isZh = false) {
  const codes = Array.isArray(wx?.warningCodes) ? wx.warningCodes.map(c => String(c || '').toUpperCase()) : [];
  const labelEnStr = String(wx?.labelEn || '');
  const hasTc8Plus = Boolean(wx?.typhoon) || codes.some(c => /^TC(8|9|10)/.test(c)) || /TC(8|9|10)/i.test(labelEnStr);
  const hasBlackRain = codes.includes('WRAINB') || /black\s*rain/i.test(labelEnStr);

  const weatherParts = [];
  const keyParts = [];

  if (hasTc8Plus) {
    const tcCode = codes.find(c => /^TC(8|9|10)/.test(c)) || 'TC8+';
    keyParts.push(`WX_${tcCode}`);
    weatherParts.push(isZh ? (wx?.labelTc || '八號或以上烈風或暴風信號生效') : (wx?.labelEn || `Typhoon Signal ${tcCode} Active`));
  }
  if (hasBlackRain) {
    keyParts.push('WX_WRAINB');
    weatherParts.push(isZh ? '黑色暴雨警告生效' : 'Black Rainstorm Warning (WRAINB)');
  }

  const incidentCorridors = [];
  const corMap = liveCorridors || {};
  const usedCorridors = collectSelectedCardCorridors(home, work, selectedCard);
  for (const cor of usedCorridors) {
    const st = corMap[cor.id];
    if (st && st.status === 'INCIDENT') {
      keyParts.push(`COR_${cor.id}_INCIDENT`);
      incidentCorridors.push({
        id: cor.id,
        label: isZh ? (cor.tc || cor.en) : (cor.en || cor.tc),
        headline: String(st.headline || '').trim()
      });
    }
  }

  if (!weatherParts.length && !incidentCorridors.length) {
    return { active: false, alertKey: '', severity: 'none', title: '', detail: '' };
  }

  const isSevereWx = weatherParts.length > 0;
  const corSummary = incidentCorridors.map(c => c.label).join(' · ');
  const firstHeadline = incidentCorridors.find(c => c.headline)?.headline || '';

  let title = '';
  let detail = '';

  if (isSevereWx && incidentCorridors.length) {
    title = isZh
      ? `${weatherParts.join(' · ')} ｜ ${corSummary} 受阻`
      : `${weatherParts.join(' · ')} · ${corSummary} Incident`;
    detail = firstHeadline || (isZh
      ? '港鐵服務可能調整，地面巴士及渡輪或會暫停或受阻。'
      : 'Surface bus & ferry services may be suspended or heavily delayed; rail preferred.');
  } else if (isSevereWx) {
    title = weatherParts.join(' · ');
    detail = hasTc8Plus
      ? (isZh ? '天文台已發出八號或以上熱帶氣旋警告，巴士及渡輪服務可能陸續暫停。' : 'HKO severe tropical cyclone warning in force — bus & ferry services may suspend.')
      : (isZh ? '天文台黑色暴雨警告生效，已優先減步行及室內鐵路路線。' : 'HKO Black Rainstorm warning in force — prioritizing sheltered rail & shorter walks.');
  } else {
    title = isZh ? `${corSummary} 交通受阻` : `Traffic Incident: ${corSummary}`;
    detail = firstHeadline || (isZh ? '運輸署特別交通消息：此路段現正受阻，建議考慮鐵路替代路線。' : 'TD Special Traffic News: active incident on this route corridor.');
  }

  return {
    active: true,
    alertKey: keyParts.join('|'),
    severity: isSevereWx ? 'severe' : 'incident',
    icon: isSevereWx ? (hasTc8Plus ? '🌀' : '⛈️') : '⚠️',
    title,
    detail
  };
}

function dismissPlannerAlertBanner() {
  if (currentPlannerAlertKey) dismissedPlannerAlertKey = currentPlannerAlertKey;
  const el = document.getElementById('plannerAlertBanner');
  if (el) el.style.display = 'none';
}

function syncPlannerAlertBannerUI(selectedCard = null) {
  const el = document.getElementById('plannerAlertBanner');
  if (!el) return;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const activeCard = selectedCard
    || (lastXferSolvedSpec?._unifiedCards?.find(c => c.key === activeUnifiedCardKey) || lastXferSolvedSpec?._unifiedCards?.[0])
    || null;
  const state = evaluatePlannerAlertBannerState(
    window.__HKO_WEATHER__,
    window.__LIVE_CORRIDORS__,
    userCommuteProfile.home,
    userCommuteProfile.work,
    activeCard,
    isZh
  );

  currentPlannerAlertKey = state.alertKey || '';
  if (!state.active || (dismissedPlannerAlertKey && dismissedPlannerAlertKey === state.alertKey)) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  el.className = `planner-alert-banner severity-${state.severity}`;
  el.innerHTML = `
    <span class="planner-alert-icon" aria-hidden="true">${state.icon}</span>
    <span class="planner-alert-body">
      <span class="planner-alert-title">${escapeHtml(state.title)}</span>
      ${state.detail ? `<span class="planner-alert-detail">${escapeHtml(state.detail)}</span>` : ''}
    </span>
    <button type="button" class="planner-alert-dismiss" onclick="dismissPlannerAlertBanner()" aria-label="${isZh ? '關閉提示' : 'Dismiss alert'}">✕</button>`;
  el.style.display = 'flex';
}

window.evaluatePlannerAlertBannerState = evaluatePlannerAlertBannerState;
window.syncPlannerAlertBannerUI = syncPlannerAlertBannerUI;
window.dismissPlannerAlertBanner = dismissPlannerAlertBanner;

function syncRelevantCorridorPillUI() {
  const pill = document.getElementById('xferHighwaySpeedPill');
  const wPill = document.getElementById('xferWeatherAlertPill');
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  if (pill) {
    const h = userCommuteProfile.home, w = userCommuteProfile.work;
    const relCor = (h && w && typeof resolveRelevantCorridorForTrip === 'function')
      ? resolveRelevantCorridorForTrip(h.lat, h.lon, w.lat, w.lon)
      : null;

    if (!relCor) {
      pill.style.display = 'none';
    } else {
      const liveMap = window.__LIVE_CORRIDORS__ || {};
      const st = liveMap[relCor.id] || { status: 'SMOOTH', speedKmh: 70, headline: '' };
      const corLabel = isZh ? relCor.tc : relCor.en;
      const isInc = st.status === 'INCIDENT';
      const isSlow = st.status === 'SLOW';

      pill.style.display = 'inline-flex';
      pill.className = `state-pill ${isInc ? 'load-full' : (isSlow ? 'sched-ghost' : 'live-gps')}`;
      pill.title = st.headline || (isZh ? `實時運輸署 ${corLabel} 交通狀況` : `Live TD ${corLabel} corridor status`);
      if (isInc) {
        pill.innerText = isZh ? `⚠️ ${corLabel} 受阻` : `⚠️ ${corLabel} Incident`;
      } else if (isSlow) {
        pill.innerText = isZh ? `🟠 ${corLabel} 緩慢` : `🟠 ${corLabel} Slow`;
      } else {
        pill.innerText = isZh ? `🛣️ ${corLabel} 暢順` : `🛣️ ${corLabel} Smooth`;
      }
    }
  }

  if (wPill) {
    const wx = window.__HKO_WEATHER__;
    if (wx && (wx.heavyRain || wx.rainAdvisory)) {
      wPill.style.display = 'inline-flex';
      wPill.className = `state-pill ${wx.heavyRain ? 'load-full' : 'sched-ghost'}`;
      const lbl = isZh ? (wx.labelTc || '惡劣天氣') : (wx.labelEn || 'Heavy Rain');
      wPill.innerText = wx.heavyRain
        ? (isZh ? `⛈️ ${lbl} · 減步行` : `⛈️ ${lbl} · Less Walk`)
        : (isZh ? `🌧️ ${lbl}` : `🌧️ ${lbl}`);
    } else {
      wPill.style.display = 'none';
    }
  }

  syncPlannerAlertBannerUI();
}

window.syncRelevantCorridorPillUI = syncRelevantCorridorPillUI;

// ============================================================================
// UI CONTROLS & ADDRESS / STOP PICKER
// ============================================================================
function openTransferPlannerFromTop() {
  triggerHaptic(10);
  if (currentView === 'xfer') return;
  switchView('xfer', false);
  const c = document.getElementById('xferResultsContainer');
  if (c && userCommuteProfile.home && userCommuteProfile.work && !c.children.length) {
    c.innerHTML = `<div class="text-center" style="padding:28px;">${currentLang === 'zh' ? '正在計算最佳跨工具路線...' : 'Finding best multi-modal routes...'}</div>`;
  }
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function sendMapPointToTransferPlanner(slot, stopKey, stopName_e, name_tc, lat, lon, nodeType = 'BUS') {
  triggerHaptic(14);
  const placeItem = {
    stopKey: stopKey || `MAP_PIN_${Number(lat).toFixed(5)}_${Number(lon).toFixed(5)}`,
    stopName_e: stopName_e,
    name_tc: name_tc || stopName_e,
    lat: Number(lat),
    lon: Number(lon),
    nodeType
  };

  if (slot === 'work') {
    userCommuteProfile.work = placeItem;
    if (!userCommuteProfile.home) {
      const curStop = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
      if (curStop) {
        userCommuteProfile.home = {
          stopKey: curStop.stopKey,
          stopName_e: curStop.stopName_e,
          name_tc: curStop.name_tc || curStop.stopName_e,
          lat: parseFloat(curStop.latitude),
          lon: parseFloat(curStop.longitude),
          nodeType: curStop.mode || 'BUS'
        };
      }
    }
  } else {
    userCommuteProfile.home = placeItem;
  }

  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  savePlaceToRecentCommuteHistory(placeItem);
  window.browseMapInstance?.closePopup();
  window.xferMapInstance?.closePopup();
  updateCommuteBarUI();
  if (currentView !== 'xfer') switchView('xfer', false);
  if (userCommuteProfile.home && userCommuteProfile.work && typeof isXferMapExpanded !== 'undefined' && isXferMapExpanded) {
    setXferMapHeightPx(220, false);
  }
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function bindTimeInputListeners() {
  const timeInp = document.getElementById('xferDepartTimeInput');
  if (timeInp && !timeInp._boundListeners) {
    timeInp._boundListeners = true;
    timeInp.addEventListener('input', onXferPlannedTimeChange);
    timeInp.addEventListener('change', onXferPlannedTimeChange);
  }
}

function setXferTimeMode(mode) {
  triggerHaptic(10);
  bindTimeInputListeners();
  xferTimeMode = (mode === 'PLAN' || mode === 'ARRIVE') ? mode : 'NOW';
  document.getElementById('xferTimeNowBtn')?.classList.toggle('active-opt', xferTimeMode === 'NOW');
  document.getElementById('xferTimePlanBtn')?.classList.toggle('active-opt', xferTimeMode === 'PLAN');
  document.getElementById('xferTimeArriveBtn')?.classList.toggle('active-opt', xferTimeMode === 'ARRIVE');
  const timeInp = document.getElementById('xferDepartTimeInput');
  if (timeInp) {
    if (xferTimeMode === 'PLAN' || xferTimeMode === 'ARRIVE') {
      timeInp.style.display = 'inline-block';
      if (!timeInp.value) {
        const hk = getHongKongNow();
        if (xferTimeMode === 'ARRIVE') hk.setMinutes(hk.getMinutes() + 60);
        timeInp.value = `${String(hk.getHours()).padStart(2, '0')}:${String(hk.getMinutes()).padStart(2, '0')}`;
      }
      xferPlannedHHMM = timeInp.value;
    } else {
      timeInp.style.display = 'none';
      xferPlannedHHMM = null;
    }
  }
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function setXferSortPref(pref) {
  triggerHaptic(8);
  const p = String(pref || '').toUpperCase();
  if (p === 'LESS_WALK') xferSortPref = 'EASY';
  else if (p === 'BULLETPROOF' || p === 'FASTEST' || p === 'EASY' || p === 'CHEAPEST') xferSortPref = p;
  else xferSortPref = 'BULLETPROOF';
  syncXferSubbarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function onXferPlannedTimeChange() {
  const timeInp = document.getElementById('xferDepartTimeInput');
  if (timeInp?.value) {
    xferPlannedHHMM = timeInp.value;
    clearTimeout(xferTimeChangeDebounce);
    xferTimeChangeDebounce = setTimeout(() => {
      renderTransferPlannerView();
    }, 80);
  }
}

function toggleXferLocoBikeMode() {
  triggerHaptic(10);
  xferLocoBikeEnabled = !xferLocoBikeEnabled;
  syncXferSubbarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function syncXferSubbarUI() {
  const isZh = (currentLang === 'zh');
  const bikeBtn = document.getElementById('xferBikeToggleBtn');
  const bikeLbl = document.getElementById('xferBikeToggleLbl');

  const h = userCommuteProfile.home, w = userCommuteProfile.work;
  const inBikeArea = !h || !w
    || isInSharedBikeZone(h?.lat, h?.lon)
    || isInSharedBikeZone(w?.lat, w?.lon);
  if (bikeBtn && bikeLbl) {
    bikeBtn.style.display = (inBikeArea || xferLocoBikeEnabled) ? 'inline-flex' : 'none';
    bikeBtn.classList.toggle('active-opt', xferLocoBikeEnabled);
    bikeLbl.innerText = xferLocoBikeEnabled
      ? (isZh ? '🚲 單車: 開' : '🚲 Bike: ON')
      : (isZh ? '🚲 單車' : '🚲 Bike');
  }

  const nowBtn = document.getElementById('xferTimeNowBtn');
  const planBtn = document.getElementById('xferTimePlanBtn');
  const arrBtn = document.getElementById('xferTimeArriveBtn');
  if (nowBtn) nowBtn.innerText = isZh ? '即時' : 'Leave Now';
  if (planBtn) planBtn.innerText = isZh ? '出發時間' : 'Depart At';
  if (arrBtn) arrBtn.innerText = isZh ? '抵達時間' : 'Arrive By';

  const pBullet = document.getElementById('xferPrefBulletBtn');
  const pFast   = document.getElementById('xferPrefFastBtn');
  const pEasy   = document.getElementById('xferPrefEasyBtn') || document.getElementById('xferPrefWalkBtn');
  const pCheap  = document.getElementById('xferPrefCheapBtn');

  if (pBullet) {
    pBullet.innerText = isZh ? '最佳' : 'Best';
    pBullet.classList.toggle('active-opt', xferSortPref === 'BULLETPROOF');
  }
  if (pFast) {
    pFast.innerText = isZh ? '最快' : 'Fastest';
    pFast.classList.toggle('active-opt', xferSortPref === 'FASTEST');
  }
  if (pEasy) {
    pEasy.innerText = isZh ? '少步行' : 'Less Walk';
    pEasy.classList.toggle('active-opt', xferSortPref === 'EASY');
  }
  if (pCheap) {
    pCheap.innerText = isZh ? '最平' : 'Cheapest';
    pCheap.classList.toggle('active-opt', xferSortPref === 'CHEAPEST');
  }

  syncRelevantCorridorPillUI();
}

var plannerInputDirtyClearedMap = false;

function clearCommuteSlot(slot) {
  triggerHaptic(10);
  const key = slot === 'work' ? 'work' : 'home';
  userCommuteProfile[key] = null;
  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  lastXferSolvedSpec = null;
  activeUnifiedCardKey = '';
  plannerInputDirtyClearedMap = false;
  if (typeof window.clearTransferPlannerMapLayers === 'function') {
    window.clearTransferPlannerMapLayers();
  }
  const inp = document.getElementById(key === 'work' ? 'plannerToInput' : 'plannerFromInput');
  if (inp) inp.value = '';
  updateCommuteBarUI();
  renderTransferPlannerView();
}

function formatPlannerSlotDisplay(placeObj) {
  if (!placeObj) return '';
  const isZh = (currentLang === 'zh');
  return stripPlatformCodeFromDisplay(isZh && placeObj.name_tc ? placeObj.name_tc : placeObj.stopName_e) || '';
}

function updateCommuteBarUI() {
  const isZh = (currentLang === 'zh');
  const h = userCommuteProfile.home;
  const w = userCommuteProfile.work;

  const fromInput = document.getElementById('plannerFromInput');
  const toInput = document.getElementById('plannerToInput');
  const clearHomeBtn = document.getElementById('clearHomeStopBtn');
  const clearWorkBtn = document.getElementById('clearWorkStopBtn');

  if (fromInput) {
    fromInput.placeholder = isZh ? '起點：地址、港鐵站、巴士站或碼頭' : 'Origin: address, MTR, stop or pier';
    if (document.activeElement !== fromInput || activePlannerInlineSlot !== 'home') {
      fromInput.value = formatPlannerSlotDisplay(h);
    }
  }
  if (toInput) {
    toInput.placeholder = isZh ? '目的地：想去邊度？' : 'Destination: where to?';
    if (document.activeElement !== toInput || activePlannerInlineSlot !== 'work') {
      toInput.value = formatPlannerSlotDisplay(w);
    }
  }
  if (clearHomeBtn) clearHomeBtn.style.display = h ? 'inline-flex' : 'none';
  if (clearWorkBtn) clearWorkBtn.style.display = w ? 'inline-flex' : 'none';

  // Legacy slot buttons fallback (if present)
  const homeBtn = document.getElementById('favHomeStopBtn');
  const homeLbl = document.getElementById('favHomeStopLbl');
  const workBtn = document.getElementById('favWorkStopBtn');
  const workLbl = document.getElementById('favWorkStopLbl');
  if (homeBtn && homeLbl) {
    homeBtn.classList.toggle('set', Boolean(h));
    const hName = h ? formatPlannerSlotDisplay(h) : (isZh ? '選擇起點' : 'Select Origin');
    homeLbl.innerText = `${isZh ? '起點' : 'From'}: ${hName}`;
  }
  if (workBtn && workLbl) {
    workBtn.classList.toggle('set', Boolean(w));
    const wName = w ? formatPlannerSlotDisplay(w) : (isZh ? '選擇終點' : 'Address / MTR / Stop');
    workLbl.innerText = `${isZh ? '終點' : 'To'}: ${wName}`;
  }
  syncXferSubbarUI();
}

function swapHomeAndWorkCommuteStops() {
  triggerHaptic(12);
  const tmp = userCommuteProfile.home;
  userCommuteProfile.home = userCommuteProfile.work;
  userCommuteProfile.work = tmp;
  plannerInputDirtyClearedMap = false;
  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  closePlannerInlineDropdown();
  updateCommuteBarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function closePlannerInlineDropdown() {
  const shouldRestoreRoute = plannerInputDirtyClearedMap;
  plannerInputDirtyClearedMap = false;
  activePlannerInlineSlot = null;
  const dd = document.getElementById('plannerInlineDropdown');
  if (dd) dd.style.display = 'none';
  updateCommuteBarUI();
  if (shouldRestoreRoute && userCommuteProfile.home && userCommuteProfile.work && lastXferSolvedSpec?._unifiedCards?.length && typeof drawTransferCorridorOnMap === 'function') {
    const activeCard = lastXferSolvedSpec._unifiedCards.find(c => c.key === activeUnifiedCardKey) || lastXferSolvedSpec._unifiedCards[0];
    if (activeCard) drawTransferCorridorOnMap(lastXferSolvedSpec, activeCard);
  }
}

function focusPlannerInlineInput(slot) {
  activePlannerInlineSlot = slot === 'work' ? 'work' : 'home';
  plannerInlineAlsResults = [];
  const inp = document.getElementById(activePlannerInlineSlot === 'work' ? 'plannerToInput' : 'plannerFromInput');
  if (inp && inp.value) {
    try { inp.select(); } catch (e) {}
  }
  renderPlannerInlineDropdown('');
}

function onPlannerInlineInput(slot) {
  activePlannerInlineSlot = slot === 'work' ? 'work' : 'home';
  const inp = document.getElementById(activePlannerInlineSlot === 'work' ? 'plannerToInput' : 'plannerFromInput');
  const q = (inp?.value || '').trim();
  const committedLabel = formatPlannerSlotDisplay(userCommuteProfile[activePlannerInlineSlot]).trim();

  // Clear stale route polylines & destination pins immediately while user edits or clears Origin/Destination
  if (q !== committedLabel) {
    plannerInputDirtyClearedMap = true;
    if (typeof window.clearTransferPlannerMapLayers === 'function') {
      window.clearTransferPlannerMapLayers();
    }
  }

  plannerInlineAlsResults = [];
  renderPlannerInlineDropdown(q);

  clearTimeout(plannerInlineDebounce);
  const parsedGps = (typeof parseHkGpsCoordinates === 'function') ? parseHkGpsCoordinates(q) : null;
  if (parsedGps) return; // Instant 0ms local GPS pin — no need to query remote geocoder
  const hasCjk = /[\u4e00-\u9fa5]/.test(q);
  if ((!hasCjk && q.length < 2) || (hasCjk && q.length < 1)) return;

  const seq = ++plannerInlineReqSeq;
  plannerInlineDebounce = setTimeout(async () => {
    try {
      const data = await fetchEdgeApiJSON(`?action=address_lookup&q=${encodeURIComponent(q)}&client=hk-fleet`, 3500, false);
      if (seq !== plannerInlineReqSeq || !activePlannerInlineSlot) return;
      if (Array.isArray(data?.results) && data.results.length > 0) {
        plannerInlineAlsResults = data.results;
        renderPlannerInlineDropdown(q);
      }
    } catch (e) {}
  }, 200);
}

function onPlannerInlineKeydown(event, slot) {
  if (event.key === 'Escape') {
    closePlannerInlineDropdown();
    event.target?.blur();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const dd = document.getElementById('plannerInlineDropdown');
    const firstOpt = dd?.querySelector('button.planner-ac-item[data-pick="1"]');
    if (firstOpt) firstOpt.click();
  }
}

async function useGpsForPlannerSlot(slot = 'home') {
  triggerHaptic(14);
  const targetSlot = slot === 'work' ? 'work' : 'home';
  const pos = await refreshGPS(3000, true);
  if (pos && Number.isFinite(pos.lat)) syncNearestStopFromGPS(pos.lat, pos.lon, false);
  const curStop = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
  if (pos && pos.hasLiveFix && Number(pos.acc) <= 600) {
    selectPlannerInlineOption(
      targetSlot,
      curStop?.stopKey || `GPS_${pos.lat.toFixed(5)}_${pos.lon.toFixed(5)}`,
      curStop ? curStop.stopName_e : 'Current Location',
      curStop ? (curStop.name_tc || curStop.stopName_e) : '目前位置',
      pos.lat,
      pos.lon,
      curStop?.mode || 'ADDRESS'
    );
  } else if (curStop) {
    selectPlannerInlineOption(
      targetSlot,
      curStop.stopKey,
      curStop.stopName_e,
      curStop.name_tc || curStop.stopName_e,
      parseFloat(curStop.latitude),
      parseFloat(curStop.longitude),
      curStop.mode || 'BUS'
    );
  } else {
    showToast(currentLang === 'zh' ? '未能獲取定位，請輸入起點名稱' : 'GPS unavailable — type a starting point');
  }
}

function selectPlannerInlineOption(slot, stopKey, stopName_e, name_tc, lat = 0, lon = 0, nodeType = 'BUS') {
  triggerHaptic(12);
  const targetSlot = slot === 'work' ? 'work' : 'home';
  const parts = String(stopKey || '').split('_');
  const parsedLat = Number(lat) || parseFloat(parts[parts.length - 2]) || 0;
  const parsedLon = Number(lon) || parseFloat(parts[parts.length - 1]) || 0;
  const cleanEn = nodeType === 'ADDRESS' ? cleanAlsAddressLabel(stopName_e) : stopName_e;
  const placeItem = { stopKey, stopName_e: cleanEn, name_tc: name_tc || cleanEn, lat: parsedLat, lon: parsedLon, nodeType };

  userCommuteProfile[targetSlot] = placeItem;
  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  savePlaceToRecentCommuteHistory(placeItem);

  plannerInputDirtyClearedMap = false;
  activePlannerInlineSlot = null;
  const dd = document.getElementById('plannerInlineDropdown');
  if (dd) dd.style.display = 'none';
  updateCommuteBarUI();

  if (targetSlot === 'home' && !userCommuteProfile.work) {
    const toInp = document.getElementById('plannerToInput');
    if (toInp) setTimeout(() => toInp.focus(), 60);
  }

  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function getPlannerAutocompleteRefPoint() {
  if (typeof lastKnownPos !== 'undefined' && lastKnownPos && isValidRailOrFerryCoord(Number(lastKnownPos.lat), Number(lastKnownPos.lon))) {
    return { lat: Number(lastKnownPos.lat), lon: Number(lastKnownPos.lon), source: 'gps' };
  }
  const xferCenter = window.xferMapInstance && typeof window.xferMapInstance.getCenter === 'function'
    ? window.xferMapInstance.getCenter()
    : null;
  if (xferCenter && isValidRailOrFerryCoord(Number(xferCenter.lat), Number(xferCenter.lng))) {
    return { lat: Number(xferCenter.lat), lon: Number(xferCenter.lng), source: 'map' };
  }
  const browseCenter = window.browseMapInstance && typeof window.browseMapInstance.getCenter === 'function'
    ? window.browseMapInstance.getCenter()
    : null;
  if (browseCenter && isValidRailOrFerryCoord(Number(browseCenter.lat), Number(browseCenter.lng))) {
    return { lat: Number(browseCenter.lat), lon: Number(browseCenter.lng), source: 'map' };
  }
  return null;
}

function formatCompactDistanceLabel(distKm) {
  if (!Number.isFinite(distKm) || distKm < 0) return '';
  if (distKm < 1.0) {
    const meters = Math.max(10, Math.round((distKm * 1000) / 10) * 10);
    if (meters >= 1000) return '1.0 km';
    return `${meters}m`;
  }
  return distKm < 10 ? `${distKm.toFixed(1)} km` : `${Math.round(distKm)} km`;
}

function sortRouteNosNatural(routeNos) {
  return Array.from(routeNos || []).sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  );
}

function deduplicatePlannerAutocompleteStops(stops, refLat = null, refLon = null, rawQ = '', maxMergeKm = 0.22) {
  const hasRef = isValidRailOrFerryCoord(Number(refLat), Number(refLon));
  const q = String(rawQ || '').trim().toLowerCase();
  const clusters = [];

  for (const s of (stops || [])) {
    if (!s) continue;
    const lat = parseFloat(s.latitude ?? s.lat);
    const lon = parseFloat(s.longitude ?? s.lon);
    if (!isValidRailOrFerryCoord(lat, lon)) continue;

    const baseKey = getBaseStopNameKey(s.stopName_e || s.name_tc || '');
    const distTag = typeof getStopDistrictTag === 'function' ? getStopDistrictTag(s) : '';
    const dRefKm = hasRef ? calculateDistanceKm(Number(refLat), Number(refLon), lat, lon) : Infinity;

    let merged = null;
    for (const c of clusters) {
      if (c._baseKey !== baseKey) continue;
      if (c._distTag && distTag && c._distTag !== distTag) continue;
      const dClusterKm = calculateDistanceKm(c._lat, c._lon, lat, lon);
      if (dClusterKm <= maxMergeKm) {
        merged = c;
        break;
      }
    }

    const rIter = s.routeNos ? Array.from(s.routeNos) : [];
    if (!merged) {
      clusters.push({
        ...s,
        latitude: lat,
        longitude: lon,
        _lat: lat,
        _lon: lon,
        _baseKey: baseKey,
        _distTag: distTag,
        _distKm: dRefKm,
        routeNos: new Set(rIter)
      });
    } else {
      for (const rNo of rIter) merged.routeNos.add(rNo);
      if (dRefKm < merged._distKm) {
        merged.stopKey = s.stopKey;
        merged.stopName_e = s.stopName_e || merged.stopName_e;
        merged.name_tc = s.name_tc || merged.name_tc;
        merged.latitude = lat;
        merged.longitude = lon;
        merged._lat = lat;
        merged._lon = lon;
        merged._distKm = dRefKm;
      }
    }
  }

  const stopMatchTier = (s) => {
    if (!q) return 0;
    const en = String(s.stopName_e || '').toLowerCase();
    const tc = String(s.name_tc || '').toLowerCase();
    if (en === q || tc === q) return 0;
    if (en.startsWith(q) || tc.startsWith(q)) return 1;
    return 2;
  };

  return clusters
    .map(c => ({
      ...c,
      mergedRouteNos: sortRouteNosNatural(c.routeNos)
    }))
    .sort((a, b) => {
      const tierDiff = stopMatchTier(a) - stopMatchTier(b);
      if (tierDiff !== 0) return tierDiff;
      const aDist = Number.isFinite(a._distKm) ? a._distKm : 9999;
      const bDist = Number.isFinite(b._distKm) ? b._distKm : 9999;
      if (Math.abs(aDist - bDist) > 0.01) return aDist - bDist;
      return (b.mergedRouteNos?.length || 0) - (a.mergedRouteNos?.length || 0);
    });
}

function getPlannerAutocompleteSectionOrder() {
  // Strict fixed order: transit hubs and deduplicated bus/minibus stops stay pinned above async HK Addresses & Landmarks
  return ['HUBS', 'STOPS', 'ALS'];
}

function renderPlannerInlineDropdown(rawQ = '') {
  const dd = document.getElementById('plannerInlineDropdown');
  if (!dd || !activePlannerInlineSlot) return;

  const slot = activePlannerInlineSlot;
  const q = String(rawQ || '').trim().toLowerCase();
  const isZh = (currentLang === 'zh');
  const savedHubs = SavedHubsManager.getHubs();
  const refPt = getPlannerAutocompleteRefPoint();
  const distKmFromRef = (lat, lon) => {
    const la = Number(lat), lo = Number(lon);
    if (!refPt || !isValidRailOrFerryCoord(la, lo)) return Infinity;
    return calculateDistanceKm(refPt.lat, refPt.lon, la, lo);
  };
  const renderDistBadge = (dKm) => {
    const lbl = formatCompactDistanceLabel(dKm);
    return lbl ? `<span class="planner-ac-dist">${escapeHtml(lbl)}</span>` : '';
  };

  let html = '';

  if (!q) {
    html += `
      <button type="button" class="planner-ac-item planner-ac-gps" onmousedown="event.preventDefault()" onclick="useGpsForPlannerSlot('${slot}')">
        <span class="planner-ac-icon">🎯</span>
        <span class="planner-ac-body">
          <span class="planner-ac-title">${isZh ? '使用目前位置 (GPS)' : 'Your current location (GPS)'}</span>
        </span>
      </button>`;

    if (savedHubs.home || savedHubs.work) {
      if (savedHubs.home) {
        const h = savedHubs.home;
        html += `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(h.stopKey)}', '${escapeJsAttr(h.nameEn)}', '${escapeJsAttr(h.nameTc)}', ${h.lat}, ${h.lon}, '${escapeJsAttr(h.mode || 'BUS')}')">
          <span class="planner-ac-icon">🏠</span>
          <span class="planner-ac-body"><span class="planner-ac-title">${isZh ? '屋企' : 'Home'} · ${escapeHtml(isZh ? h.nameTc : h.nameEn)}</span></span>
          ${renderDistBadge(distKmFromRef(h.lat, h.lon))}
        </button>`;
      }
      if (savedHubs.work) {
        const w = savedHubs.work;
        html += `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(w.stopKey)}', '${escapeJsAttr(w.nameEn)}', '${escapeJsAttr(w.nameTc)}', ${w.lat}, ${w.lon}, '${escapeJsAttr(w.mode || 'BUS')}')">
          <span class="planner-ac-icon">💼</span>
          <span class="planner-ac-body"><span class="planner-ac-title">${isZh ? '公司' : 'Work'} · ${escapeHtml(isZh ? w.nameTc : w.nameEn)}</span></span>
          ${renderDistBadge(distKmFromRef(w.lat, w.lon))}
        </button>`;
      }
    }

    const recList = recentCommutePlaces.slice(0, 4);
    if (recList.length) {
      html += `<div class="planner-ac-sec">${isZh ? '最近地點' : 'Recent'}</div>`;
      html += recList.map(r => {
        const disp = stripPlatformCodeFromDisplay(isZh && r.name_tc ? r.name_tc : r.stopName_e);
        const distTag = getStopDistrictTag({ stopName_e: r.stopName_e, latitude: r.lat, longitude: r.lon });
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(r.stopKey)}', '${escapeJsAttr(r.stopName_e)}', '${escapeJsAttr(r.name_tc || r.stopName_e)}', ${Number(r.lat) || 0}, ${Number(r.lon) || 0}, '${escapeJsAttr(r.nodeType || 'BUS')}')">
          <span class="planner-ac-icon">🕒</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(disp)}</span>
            ${distTag ? `<span class="planner-ac-sub">${escapeHtml(distTag)}</span>` : ''}
          </span>
          ${renderDistBadge(distKmFromRef(r.lat, r.lon))}
        </button>`;
      }).join('');
    }
  } else if (typeof parseHkGpsCoordinates === 'function') {
    const gpsPin = parseHkGpsCoordinates(rawQ);
    if (gpsPin) {
      const distTag = typeof getStopDistrictTag === 'function'
        ? getStopDistrictTag({ stopName_e: '', latitude: gpsPin.lat, longitude: gpsPin.lon })
        : '';
      const pinKey = `GPS_PIN_${gpsPin.lat.toFixed(5)}_${gpsPin.lon.toFixed(5)}`;
      const pinTitleEn = distTag ? `${distTag} (${gpsPin.formatted})` : gpsPin.labelEn;
      const pinTitleTc = distTag ? `${distTag} (${gpsPin.formatted})` : gpsPin.labelTc;
      html += `<div class="planner-ac-sec" data-ac-sec="GPS">${isZh ? 'GPS 座標位置' : 'GPS Coordinate'}</div>`;
      html += `<button type="button" class="planner-ac-item planner-ac-gps" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(pinKey)}', '${escapeJsAttr(pinTitleEn)}', '${escapeJsAttr(pinTitleTc)}', ${gpsPin.lat}, ${gpsPin.lon}, 'ADDRESS')">
        <span class="planner-ac-icon">📍</span>
        <span class="planner-ac-body">
          <span class="planner-ac-title">${escapeHtml(isZh ? pinTitleTc : pinTitleEn)}</span>
          <span class="planner-ac-sub">${isZh ? '直接使用此座標規劃路線' : 'Use exact pasted GPS coordinate'}</span>
        </span>
        ${renderDistBadge(distKmFromRef(gpsPin.lat, gpsPin.lon))}
      </button>`;
    }
  }

  // 1. MTR Stations & Ferry Piers (relevance tier, then proximity to GPS / map center)
  const allHubs = getPlannerHubDirectory();
  const normHubScore = (h) => {
    if (!q) return 0;
    const en = String(h.name_en || '').toLowerCase();
    const enCore = en.replace(/\s+(station|mtr|ferry\s+pier|pier)$/i, '').trim();
    const tc = String(h.name_tc || '');
    const tcCore = tc.replace(/(港鐵站|站|渡輪碼頭|碼頭)$/, '').trim();
    if (en === q || enCore === q || tc === q || tcCore === q) return 0;
    if (en.startsWith(q) || enCore.startsWith(q) || tc.startsWith(q)) return 1;
    return 2;
  };
  const matchedHubs = allHubs
    .filter(h => !q || h.name_en.toLowerCase().includes(q) || (h.name_tc && h.name_tc.includes(q)) || (h.badge && h.badge.toLowerCase().includes(q)))
    .map(h => ({ ...h, _distKm: distKmFromRef(h.lat, h.lon) }))
    .sort((a, b) => {
      const sDiff = normHubScore(a) - normHubScore(b);
      if (sDiff !== 0) return sDiff;
      return a._distKm - b._distKm;
    })
    .slice(0, q ? 6 : 6);

  const renderHubsSection = () => {
    if (!matchedHubs.length) return '';
    return `<div class="planner-ac-sec" data-ac-sec="HUBS">${isZh ? '港鐵站及碼頭' : 'MTR Stations & Ferry Piers'}</div>` +
      matchedHubs.map(h => {
        const disp = isZh && h.name_tc ? h.name_tc : h.name_en;
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(h.id)}', '${escapeJsAttr(h.name_en)}', '${escapeJsAttr(h.name_tc || h.name_en)}', ${h.lat}, ${h.lon}, '${escapeJsAttr(h.mode || 'MTR')}')">
          <span class="planner-ac-icon">${h.mode === 'FERRY' ? '⛴️' : '🚇'}</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(disp)}</span>
            <span class="planner-ac-sub">${escapeHtml(h.badge || h.mode)}</span>
          </span>
          ${renderDistBadge(h._distKm)}
        </button>`;
      }).join('');
  };

  // 2. Deduplicated Bus & Minibus Stops (merged opposite-side stops within ~220m, distance-ranked)
  buildNearbyStopsFast(refPt || (typeof lastKnownPos !== 'undefined' ? lastKnownPos : null));
  const rawStopMatches = q
    ? allStops.filter(s => s.mode !== 'MTR' && s.mode !== 'FERRY' && `${s.stopName_e || ''} ${s.name_tc || ''}`.toLowerCase().includes(q))
    : nearbyStopsList.slice(0, 18);
  const stopPool = deduplicatePlannerAutocompleteStops(rawStopMatches, refPt?.lat, refPt?.lon, q, 0.22).slice(0, q ? 8 : 6);

  const renderStopsSection = () => {
    if (!stopPool.length) return '';
    return `<div class="planner-ac-sec" data-ac-sec="STOPS">${q ? (isZh ? '巴士 / 小巴站' : 'Bus & Minibus Stops') : (isZh ? '附近車站' : 'Nearby Stops')}</div>` +
      stopPool.map(s => {
        const distTag = s._distTag || getStopDistrictTag(s);
        const rNos = (s.mergedRouteNos || sortRouteNosNatural(s.routeNos)).slice(0, 6).join(', ');
        const subParts = [distTag, rNos].filter(Boolean).join(' · ');
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(s.stopKey)}', '${escapeJsAttr(s.stopName_e)}', '${escapeJsAttr(s.name_tc || s.stopName_e)}', ${parseFloat(s.latitude)}, ${parseFloat(s.longitude)}, '${escapeJsAttr(s.mode || 'BUS')}')">
          <span class="planner-ac-icon">🚌</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(getStopName(s))}</span>
            ${subParts ? `<span class="planner-ac-sub">${escapeHtml(subParts)}</span>` : ''}
          </span>
          ${renderDistBadge(s._distKm)}
        </button>`;
      }).join('');
  };

  // 3. Async HK Addresses & Landmarks (ALWAYS rendered below Bus & Minibus Stops to prevent dropdown jumping)
  const sortedAls = plannerInlineAlsResults
    .map(a => ({ ...a, _distKm: distKmFromRef(a.lat, a.lon) }))
    .sort((a, b) => a._distKm - b._distKm)
    .slice(0, 5);

  const renderAlsSection = () => {
    if (!sortedAls.length) return '';
    return `<div class="planner-ac-sec" data-ac-sec="ALS">${isZh ? '香港街道地址 / 大廈' : 'HK Addresses & Landmarks'}</div>` +
      sortedAls.map((a, idx) => {
        const dispName = isZh ? (a.name_zh || a.name_en) : (a.name_en || a.name_zh);
        const distName = isZh ? (a.district_zh || a.district_en) : (a.district_en || a.district_zh);
        const stopKey = `ALS_${idx}_${a.lat}_${a.lon}`;
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(stopKey)}', '${escapeJsAttr(a.name_en || dispName)}', '${escapeJsAttr(a.name_zh || dispName)}', ${a.lat}, ${a.lon}, 'ADDRESS')">
          <span class="planner-ac-icon">📍</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(dispName)}</span>
            ${distName ? `<span class="planner-ac-sub">${escapeHtml(distName)}</span>` : ''}
          </span>
          ${renderDistBadge(a._distKm)}
        </button>`;
      }).join('');
  };

  // Strict fixed section order prevents layout jumping when async ALS results arrive
  const sectionRenderers = {
    HUBS: renderHubsSection,
    STOPS: renderStopsSection,
    ALS: renderAlsSection
  };
  for (const secKey of getPlannerAutocompleteSectionOrder()) {
    html += sectionRenderers[secKey]();
  }

  if (!html) {
    html = `<div style="padding:14px;text-align:center;font-size:0.8rem;color:var(--text-sub);">${isZh ? '找不到相符地點，可嘗試輸入區域名稱、港鐵站或街道名稱' : 'No matching places — try a district, MTR station, or street name'}</div>`;
  }

  dd.innerHTML = html;
  dd.style.display = 'block';
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (!activePlannerInlineSlot) return;
    const box = document.getElementById('plannerSearchBox');
    if (box && !box.contains(e.target)) {
      closePlannerInlineDropdown();
    }
  });
}

window.getPlannerAutocompleteRefPoint = getPlannerAutocompleteRefPoint;
window.formatCompactDistanceLabel = formatCompactDistanceLabel;
window.deduplicatePlannerAutocompleteStops = deduplicatePlannerAutocompleteStops;
window.getPlannerAutocompleteSectionOrder = getPlannerAutocompleteSectionOrder;
window.focusPlannerInlineInput = focusPlannerInlineInput;
window.onPlannerInlineInput = onPlannerInlineInput;
window.onPlannerInlineKeydown = onPlannerInlineKeydown;
window.selectPlannerInlineOption = selectPlannerInlineOption;
window.closePlannerInlineDropdown = closePlannerInlineDropdown;
window.useGpsForPlannerSlot = useGpsForPlannerSlot;

// STATIC SCHEDULE + LEG-1 LIVE ANCHOR + LEAVE-NOW GHOST BUS FILTER
// ============================================================================
function resolveStaticFerrySlot(group, earliestBoardMs, fallbackDriveSec) {
  const fMeta = group?.ferryMeta || {};
  const dirKey = `${normStationLookupKey(group.orig_e)}_${normStationLookupKey(group.dest_e)}`;
  const sched = fMeta.sched || (typeof VERIFIED_MAINLINE_FERRIES !== 'undefined' ? VERIFIED_MAINLINE_FERRIES[dirKey] : null);
  if (!sched) return null;

  const hkRef = getHongKongNow(earliestBoardMs);
  const isHol = isHongKongHolidayFareDay(hkRef);
  const dayKey = isHol ? 'hol' : (hkRef.getDay() === 6 ? 'sat' : 'wk');
  const slots = (Array.isArray(sched[dayKey]) && sched[dayKey].length)
    ? sched[dayKey]
    : ((Array.isArray(sched.wk) && sched.wk.length) ? sched.wk : (sched.sat || sched.hol || []));
  if (!slots.length) return null;

  const nowSecOfDay = hkRef.getHours() * 3600 + hkRef.getMinutes() * 60 + hkRef.getSeconds();
  let bestSlot = null, bestWaitSec = Infinity;

  for (const entry of slots) {
    const depMin = Array.isArray(entry) ? Number(entry[0]) : Number(entry);
    const slotDur = (Array.isArray(entry) && entry[1]) ? Number(entry[1]) : 0;
    if (!Number.isFinite(depMin)) continue;
    let diffSec = depMin * 60 - nowSecOfDay;
    if (diffSec < -60 && nowSecOfDay >= 72000 && depMin < 180) diffSec += 86400;
    if (diffSec >= -30 && diffSec < bestWaitSec) {
      bestWaitSec = diffSec;
      bestSlot = { depMin, slotDur };
    }
  }
  if (!bestSlot) return null;

  const depMs = earliestBoardMs + Math.max(0, bestWaitSec) * 1000;
  const isOrd = bestSlot.slotDur >= 50;
  const vClass = isOrd ? 'ORD' : 'FAST';
  const durMins = bestSlot.slotDur || (isOrd ? fMeta.durOrd : fMeta.durFast) || fMeta.dur || Math.round(fallbackDriveSec / 60);
  const depDate = getHongKongNow(depMs);
  const loadEstimate = inferPlannerLegLoad(group, null, depDate, isHongKongHolidayFareDay(depDate), 0, {
    vesselClass: vClass,
    isSched: true
  });
  return {
    depMs,
    arrMs: depMs + durMins * 60000,
    isLive: false,
    signalType: 'SCHED',
    headwayMins: 0,
    hasSignal: true,
    isDeadGhost: false,
    vesselClass: vClass,
    loadEstimate
  };
}

function resolveStaticDownstreamLegWindow(group, earliestBoardMs, driveSec, boardStopObj = null, alightStopObj = null) {
  if (group?.mode === 'FERRY') {
    const ferrySlot = resolveStaticFerrySlot(group, earliestBoardMs, driveSec);
    if (ferrySlot) return ferrySlot;
  }
  const hwSec = getPeriodHeadwaySecs(group, earliestBoardMs);
  const expectedWaitSec = Math.min(900, Math.round(hwSec * 0.50));
  const depMs = earliestBoardMs + expectedWaitSec * 1000;
  const depDate = getHongKongNow(depMs);
  const loadEstimate = inferPlannerLegLoad(group, boardStopObj, depDate, isHongKongHolidayFareDay(depDate), hwSec, { alightStopObj, isSched: true });
  return {
    depMs,
    arrMs: depMs + driveSec * 1000,
    isLive: false,
    signalType: 'HEADWAY_PROJ',
    headwayMins: Math.round(hwSec / 60),
    headwaySec: hwSec,
    candidateDeps: [],
    selectedDepIdx: 0,
    hasSignal: true,
    isDeadGhost: false,
    vesselClass: null,
    loadEstimate
  };
}

function getOperatorAuditKeyForGroup(group) {
  if (!group) return 'KMB';
  if (group.mode === 'FERRY') return 'FERRY';
  if (group.company === 'LRT') return 'LRT';
  if (group.mode === 'MTR') return 'MTR';
  if (String(group.company).startsWith('GMB')) return 'GMB';
  if (group.company === 'LWB') return 'KMB';
  return group.company || 'KMB';
}

async function checkDownstreamBusRouteHasLiveFleet(group, boardStopObj, fleetCheckCache) {
  if (!group || (group.mode && group.mode !== 'BUS')) return true;
  if (xferTimeMode !== 'NOW' || navigator.onLine === false) return true;

  const rId = group.routeIds?.[0] || '';
  const cacheKey = `${group.key}|${boardStopObj?.stopId || ''}`;
  if (fleetCheckCache.has(cacheKey)) return fleetCheckCache.get(cacheKey);

  const now = Date.now();
  const opKey = getOperatorAuditKeyForGroup(group);

  const checkPromise = (async () => {
    try {
      if (rId.startsWith('KMB_') || rId.startsWith('LWB_')) {
        const parts = rId.split('_');
        const routeNo = parts[1], dirChar = parts[2] || 'O', srvType = parts[3] || '1';
        const byStopSeq = await fetchKmbRouteBulkEta(routeNo, srvType, false);
        const kmbUrl = `https://data.etabus.gov.hk/v1/transport/kmb/route-eta/${routeNo}/${srvType}`;
        if (!requestCache.get(kmbUrl)?.data) return true;

        const prefix = `${dirChar}_`;
        for (const [k, items] of byStopSeq.entries()) {
          if (!k.startsWith(prefix)) continue;
          for (const e of items) {
            const tMs = new Date(e.eta).getTime();
            if (Number.isFinite(tMs) && tMs >= now - 60000 && tMs <= now + 120 * 60000) {
              return true;
            }
          }
        }
        return false;
      }

      if (rId.startsWith('CTB_') || rId.startsWith('NLB_') || rId.startsWith('GMB_') || rId.startsWith('MTRB_')) {
        const stops = getStopsForGroup(group);
        const probeStop = boardStopObj || stops[0];
        if (!probeStop) return true;
        const arrs = await fetchStopSingleRaw(group, probeStop, false, now);
        if (arrs.length > 0) return true;

        if (stops[0] && stops[0].stopId !== probeStop.stopId) {
          const origArrs = await fetchStopSingleRaw(group, stops[0], false, now);
          if (origArrs.length > 0) return true;
        }

        const opSt = SignalHealthMonitor.byOperator[opKey];
        if (opSt?.okMs && (Date.now() - opSt.okMs) < 10000) {
          return false;
        }
        return true;
      }
    } catch (e) {}
    return true;
  })();

  fleetCheckCache.set(cacheKey, checkPromise);
  return checkPromise;
}

function isBusLegOnIncidentCorridor(group, boardStopObj = null, alightStopObj = null) {
  if (group?.mode && group.mode !== 'BUS') return false;
  const bLat = Number(boardStopObj?.lat ?? boardStopObj?.latitude);
  const bLon = Number(boardStopObj?.lon ?? boardStopObj?.longitude);
  const aLat = Number(alightStopObj?.lat ?? alightStopObj?.latitude);
  const aLon = Number(alightStopObj?.lon ?? alightStopObj?.longitude);
  const hasB = isValidRailOrFerryCoord(bLat, bLon);
  const hasA = isValidRailOrFerryCoord(aLat, aLon);
  if (!hasB && !hasA) return false;

  const liveMap = (typeof window !== 'undefined' && window.__LIVE_CORRIDORS__) ? window.__LIVE_CORRIDORS__ : {};
  const corList = (typeof window !== 'undefined' && Array.isArray(window.HK_STRATEGIC_CORRIDORS)) ? window.HK_STRATEGIC_CORRIDORS : [];

  if (typeof getCorridorLiveStatusAt === 'function') {
    const probePts = [];
    if (hasB) probePts.push([bLat, bLon]);
    if (hasA) probePts.push([aLat, aLon]);
    if (hasB && hasA) probePts.push([(bLat + aLat) / 2, (bLon + aLon) / 2]);
    for (const [pLat, pLon] of probePts) {
      const st = getCorridorLiveStatusAt(pLat, pLon);
      if (st?.status === 'INCIDENT') return true;
    }
  }

  if (hasB && hasA && typeof resolveRelevantCorridorForTrip === 'function') {
    const relCor = resolveRelevantCorridorForTrip(bLat, bLon, aLat, aLon);
    if (relCor?.id && liveMap[relCor.id]?.status === 'INCIDENT') return true;
  }

  const samplePts = [];
  if (hasB) samplePts.push([bLat, bLon]);
  if (hasA) samplePts.push([aLat, aLon]);
  if (hasB && hasA) {
    samplePts.push([(bLat + aLat) / 2, (bLon + aLon) / 2]);
    samplePts.push([bLat * 0.7 + aLat * 0.3, bLon * 0.7 + aLon * 0.3]);
    samplePts.push([bLat * 0.3 + aLat * 0.7, bLon * 0.3 + aLon * 0.7]);
  }
  for (const cor of corList) {
    if (liveMap[cor.id]?.status !== 'INCIDENT') continue;
    for (const [pLat, pLon] of samplePts) {
      if (calculateDistanceKm(pLat, pLon, cor.lat, cor.lon) <= cor.radiusKm) {
        return true;
      }
    }
  }

  if (liveMap.LANTAU_TM?.status === 'INCIDENT' && typeof isLantauOrAirportZone === 'function') {
    if ((hasB && isLantauOrAirportZone(bLat, bLon, boardStopObj?.stopName_e || '')) ||
        (hasA && isLantauOrAirportZone(aLat, aLon, alightStopObj?.stopName_e || ''))) {
      return true;
    }
  }

  return false;
}

window.isBusLegOnIncidentCorridor = isBusLegOnIncidentCorridor;

async function resolveLiveOrStaticLegWindow(group, boardStopKey, earliestBoardMs, driveSec, boardStopObj = null, isFirstLeg = true, alightStopObj = null) {
  const now = Date.now();
  const horizonMins = isFirstLeg ? 25 : 35;
  const deltaMs = earliestBoardMs - now;
  const isWithinLiveHorizon = deltaMs <= horizonMins * 60000 && deltaMs >= -5 * 60000;

  if (isWithinLiveHorizon && (isFirstLeg || (xferTimeMode === 'NOW' && navigator.onLine !== false))) {
    try {
      const arrs = await fetchEtaRaw(group, boardStopKey, false, earliestBoardMs, null);

      // Reject "scheduled-only ghost buses" when the route's road corridor has an active INCIDENT
      if (
        isFirstLeg &&
        xferTimeMode === 'NOW' &&
        (!group?.mode || group.mode === 'BUS') &&
        Array.isArray(arrs) &&
        arrs.length > 0 &&
        arrs.every(a => Boolean(a?.isSched)) &&
        isBusLegOnIncidentCorridor(group, boardStopObj, alightStopObj)
      ) {
        return {
          depMs: earliestBoardMs,
          arrMs: earliestBoardMs + driveSec * 1000,
          isLive: false,
          signalType: 'NO_SERVICE',
          headwayMins: 0,
          hasSignal: false,
          isDeadGhost: true,
          vesselClass: null,
          loadEstimate: null
        };
      }

      const sortedArrs = Array.isArray(arrs)
        ? [...arrs]
            .filter(a => Number.isFinite(a?.targetMs))
            .sort((a, b) => a.targetMs - b.targetMs)
        : [];

      const computeEffDriveSec = (a) => {
        let eff = driveSec;
        if (group?.mode === 'FERRY') {
          const rmkDur = String(a?.remark || '').match(/(?:~|約)(\d+)\s*(?:m|分)/i);
          if (rmkDur) eff = Number(rmkDur[1]) * 60;
          else if (a?.vesselClass === 'ORD') eff = (group.ferryMeta?.durOrd || 55) * 60;
          else if (a?.vesselClass === 'FAST') eff = (group.ferryMeta?.durFast || group.ferryMeta?.dur || 35) * 60;
        }
        return eff;
      };

      const minCandMs = (isFirstLeg && xferTimeMode === 'NOW')
        ? (now - 15000)
        : (earliestBoardMs - (isFirstLeg ? 30000 : 20000));
      const candidateDeps = [];
      for (const a of sortedArrs) {
        if (a.targetMs < minCandMs) continue;
        if (candidateDeps.length && Math.abs(a.targetMs - candidateDeps[candidateDeps.length - 1].depMs) < 45000) continue;
        const cDepMs = a.targetMs;
        const cEffDrive = computeEffDriveSec(a);
        const cLoad = a.loadEstimate || inferPlannerLegLoad(
          group,
          boardStopObj,
          getHongKongNow(cDepMs),
          isHongKongHolidayFareDay(getHongKongNow(cDepMs)),
          0,
          { vesselClass: a.vesselClass, alightStopObj, isSched: Boolean(a.isSched) }
        );
        candidateDeps.push({
          depMs: cDepMs,
          effDriveSec: cEffDrive,
          isLive: !a.isSched,
          signalType: a.isSched ? 'SCHED' : 'LIVE',
          vesselClass: a.vesselClass || null,
          loadEstimate: cLoad
        });
        if (candidateDeps.length >= 6) break;
      }

      const defaultMinBoardMs = earliestBoardMs - (isFirstLeg ? 30000 : 20000);
      const selectedIdx = candidateDeps.findIndex(c => c.depMs >= defaultMinBoardMs);
      if (selectedIdx >= 0) {
        const chosen = candidateDeps[selectedIdx];
        const depMs = Math.max(earliestBoardMs, chosen.depMs);
        const hwSec = getPeriodHeadwaySecs(group, depMs, sortedArrs);
        return {
          depMs,
          arrMs: depMs + chosen.effDriveSec * 1000,
          isLive: chosen.isLive,
          signalType: chosen.signalType,
          headwayMins: Math.round(hwSec / 60),
          headwaySec: hwSec,
          candidateDeps,
          selectedDepIdx: selectedIdx,
          hasSignal: true,
          isDeadGhost: false,
          vesselClass: chosen.vesselClass || null,
          loadEstimate: chosen.loadEstimate
        };
      }
    } catch (e) {}

    if (isFirstLeg && xferTimeMode === 'NOW' && navigator.onLine !== false) {
      if (group?.mode === 'FERRY') {
        const ferrySlot = resolveStaticFerrySlot(group, earliestBoardMs, driveSec);
        if (ferrySlot) return ferrySlot;
        return { depMs: earliestBoardMs, arrMs: earliestBoardMs + driveSec * 1000, isLive: false, signalType: 'NO_SERVICE', headwayMins: 0, headwaySec: 0, candidateDeps: [], selectedDepIdx: 0, hasSignal: false, isDeadGhost: true, vesselClass: null, loadEstimate: null };
      }
      const opKey = getOperatorAuditKeyForGroup(group);
      const opSt = SignalHealthMonitor.byOperator[opKey];
      const apiConfirmedOk = Boolean(opSt?.okMs && (Date.now() - opSt.okMs) < 10000);
      if (apiConfirmedOk) {
        return {
          depMs: earliestBoardMs,
          arrMs: earliestBoardMs + driveSec * 1000,
          isLive: false,
          signalType: 'NO_SERVICE',
          headwayMins: 0,
          headwaySec: 0,
          candidateDeps: [],
          selectedDepIdx: 0,
          hasSignal: false,
          isDeadGhost: true,
          vesselClass: null,
          loadEstimate: null
        };
      }
    }
  }

  return resolveStaticDownstreamLegWindow(group, earliestBoardMs, driveSec, boardStopObj, alightStopObj);
}

function findConnectingLegWindow(candidateDeps, minBoardMs, driveSec, headwaySec = 480, fallbackSigType = 'HEADWAY_PROJ') {
  const safeDriveSec = Math.max(60, Number(driveSec) || 180);
  const safeHwSec = Math.max(120, Number(headwaySec) || 480);
  if (Array.isArray(candidateDeps) && candidateDeps.length) {
    const match = candidateDeps.find(c => Number.isFinite(c?.depMs) && c.depMs >= minBoardMs - 20000);
    if (match) {
      const depMs = Math.max(minBoardMs, match.depMs);
      const effDrive = Math.max(60, Number(match.effDriveSec) || safeDriveSec);
      return {
        depMs,
        arrMs: depMs + effDrive * 1000,
        isLive: Boolean(match.isLive),
        signalType: match.signalType || fallbackSigType,
        loadEstimate: match.loadEstimate || null
      };
    }
    const anchor = candidateDeps[candidateDeps.length - 1];
    if (Number.isFinite(anchor?.depMs)) {
      const steps = Math.max(1, Math.ceil((minBoardMs - anchor.depMs) / (safeHwSec * 1000)));
      const depMs = anchor.depMs + steps * safeHwSec * 1000;
      const effDrive = Math.max(60, Number(anchor.effDriveSec) || safeDriveSec);
      return {
        depMs,
        arrMs: depMs + effDrive * 1000,
        isLive: false,
        signalType: 'HEADWAY_PROJ',
        loadEstimate: anchor.loadEstimate || null
      };
    }
  }
  const waitSec = Math.min(900, Math.round(safeHwSec * 0.50));
  const depMs = minBoardMs + waitSec * 1000;
  return {
    depMs,
    arrMs: depMs + safeDriveSec * 1000,
    isLive: false,
    signalType: 'HEADWAY_PROJ',
    loadEstimate: null
  };
}

function recalculatePlannerCardForFirstLegDep(card, newDepIdx, refStartMs) {
  if (!card?.item) return false;
  const item = card.item;
  const cands1 = Array.isArray(item.candidateDeps1) ? item.candidateDeps1 : [];
  if (newDepIdx < 0 || newDepIdx >= cands1.length) return false;

  const cand1 = cands1[newDepIdx];
  if (!cand1 || !Number.isFinite(cand1.depMs)) return false;

  const safeRefMs = Number.isFinite(refStartMs) ? refStartMs : Date.now();
  item.selectedDepIdx1 = newDepIdx;
  item.sigType1 = cand1.signalType || item.sigType1;
  if (cand1.loadEstimate) item.load1 = cand1.loadEstimate;
  item.isBoardNowRush = cand1.depMs < (safeRefMs + (Number(item.accessWalkSec) || 0) * 1000 - 30000);

  if (card.type === 'DIRECT') {
    const effDriveSec = Math.max(60, Number(cand1.effDriveSec) || Number(item.driveSec) || 180);
    item.driveSec = effDriveSec;
    item.liveDepMs = cand1.depMs;
    item.liveArrMs = cand1.depMs + (effDriveSec + (Number(item.egressWalkSec) || 0)) * 1000;
    item.totalMins = Math.max(2, Math.round((item.liveArrMs - safeRefMs) / 60000));
    return true;
  }

  if (card.type === 'XFER') {
    const node = item.xferStopNodes?.[0];
    if (!node) return false;
    const leg1DriveSec = Math.max(60, Number(cand1.effDriveSec) || Number(node.leg1DriveSec) || 180);
    const leg1ArrMs = cand1.depMs + leg1DriveSec * 1000;
    const xfer1BufSec = Math.max(60, Number(item.xfer1BufSec) || 180);
    const w2 = findConnectingLegWindow(
      item.candidateDeps2,
      leg1ArrMs + xfer1BufSec * 1000,
      node.leg2DriveSec || 180,
      item.headwaySec2 || ((item.hw2 || 8) * 60),
      item.sigType2 || 'HEADWAY_PROJ'
    );

    item.liveDep1Ms = cand1.depMs;
    item.liveDep2Ms = w2.depMs;
    item.sigType2 = w2.signalType || item.sigType2;
    if (w2.loadEstimate) item.load2 = w2.loadEstimate;

    const isLeg12RailToRail = item.leg1Group?.mode === 'MTR' && item.leg1Group?.company === 'MTR' && item.leg2Group?.mode === 'MTR' && item.leg2Group?.company === 'MTR';
    const xfer1SlackMs = w2.depMs - leg1ArrMs - (Number(node.walkSec) || 0) * 1000;
    item.tightTransfer1 = !isLeg12RailToRail && xfer1SlackMs < 240000;
    item.tightTransfer1Mins = Math.max(1, Math.round(Math.max(0, xfer1SlackMs) / 60000));

    let curArrMs = w2.arrMs;
    (item.leg3Options || []).forEach((l3, idx) => {
      const l3BufSec = Math.max(60, Number(l3.xferBufSec) || 180);
      const w3 = findConnectingLegWindow(
        l3.candidateDeps,
        curArrMs + l3BufSec * 1000,
        l3.driveSec || 180,
        l3.headwaySec || ((l3.hwMins || 8) * 60),
        l3.sigType || 'HEADWAY_PROJ'
      );
      const prevG = idx === 0 ? item.leg2Group : item.leg3Options[idx - 1].group;
      const isRailToRail = prevG?.mode === 'MTR' && prevG?.company === 'MTR' && l3.group?.mode === 'MTR' && l3.group?.company === 'MTR';
      const l3SlackMs = w3.depMs - curArrMs - (Number(l3.walkSec) || 0) * 1000;
      l3.liveDepMs = w3.depMs;
      l3.liveArrMs = w3.arrMs;
      l3.sigType = w3.signalType || l3.sigType;
      if (w3.loadEstimate) l3.loadEstimate = w3.loadEstimate;
      l3.tightTransfer = !isRailToRail && l3SlackMs < 240000;
      l3.tightTransferMins = Math.max(1, Math.round(Math.max(0, l3SlackMs) / 60000));
      curArrMs = w3.arrMs;
    });

    item.liveArrMs = curArrMs + (Number(item.egressWalkSec) || 0) * 1000;
    item.totalMins = Math.max(4, Math.round((item.liveArrMs - safeRefMs) / 60000));
    return true;
  }

  return false;
}

function shiftPlannerCardDeparture(cardKey, delta) {
  if (!lastXferSolvedSpec || !Array.isArray(lastXferSolvedSpec._unifiedCards)) return false;
  const card = lastXferSolvedSpec._unifiedCards.find(c => c.key === cardKey);
  if (!card?.item || !Array.isArray(card.item.candidateDeps1)) return false;
  const curIdx = Number.isInteger(card.item.selectedDepIdx1) ? card.item.selectedDepIdx1 : 0;
  const nextIdx = curIdx + Number(delta || 0);
  const ok = recalculatePlannerCardForFirstLegDep(card, nextIdx, lastXferSolvedSpec._refStartMs || Date.now());
  if (!ok) return false;
  activeUnifiedCardKey = cardKey;
  if (typeof lastXferSolvedSpec._repaintCards === 'function') {
    lastXferSolvedSpec._repaintCards(true, true);
  }
  return true;
}

window.resolveLiveOrStaticLegWindow = resolveLiveOrStaticLegWindow;
window.findConnectingLegWindow = findConnectingLegWindow;
window.recalculatePlannerCardForFirstLegDep = recalculatePlannerCardForFirstLegDep;
window.shiftPlannerCardDeparture = shiftPlannerCardDeparture;

async function resolveFirstLegWindow(group, boardStopKey, earliestBoardMs, driveSec, boardStopObj = null, alightStopObj = null) {
  return resolveLiveOrStaticLegWindow(group, boardStopKey, earliestBoardMs, driveSec, boardStopObj, true, alightStopObj);
}

// ============================================================================

function applyCpmsFilterToUnifiedCards(cards) {
  if (!Array.isArray(cards) || cards.length < 2) return;
  const pricedCards = cards.filter(c => c.type !== 'WALK_BIKE' && (c.item?.fareHkd || 0) > 0);
  if (pricedCards.length < 2) return;

  const cheapest = [...pricedCards].sort((a, b) => (a.item.fareHkd || 0) - (b.item.fareHkd || 0))[0];
  const baseFare = cheapest.item.fareHkd || 0;
  const baseMins = cheapest.item.totalMins || 60;

  for (const c of pricedCards) {
    if (c === cheapest) continue;
    const extraFare = (c.item.fareHkd || 0) - baseFare;
    const minsSaved = baseMins - (c.item.totalMins || 60);
    if (extraFare >= 14.0 && minsSaved < 12) {
      const cpmsPenalty = xferSortPref === 'CHEAPEST' ? 35.0 : (xferSortPref === 'FASTEST' ? 3.0 : 14.0);
      c.score = Number((c.score + cpmsPenalty).toFixed(1));
    }
  }
}

function formatLegSignalTagHtml(sigType, headwayMins = 0, isFreeFeeder = false, loadEst = null, cutoffWarn = null) {
  const isZh = (currentLang === 'zh');
  const parts = [];
  if (sigType === 'LIVE') {
    parts.push(`<span class="planner-sig-live" style="white-space:nowrap;">● ${isZh ? '實時' : 'Real-time'}</span>`);
  } else if (sigType === 'SCHED') {
    parts.push(`<span class="planner-sig-sched">${isZh ? '預計班次' : 'Scheduled'}</span>`);
  } else if (sigType === 'HEADWAY_PROJ') {
    const hwTxt = headwayMins > 0 ? (isZh ? `約${headwayMins}分一班` : `every ${headwayMins}m`) : (isZh ? '預計' : 'Est');
    parts.push(`<span class="planner-sig-est">${escapeHtml(hwTxt)}</span>`);
  }
  if (isFreeFeeder) {
    parts.push(`<span class="planner-sig-live">${isZh ? '免費轉乘' : 'Free xfer'}</span>`);
  }
  if (loadEst && loadEst.pct >= 75 && !loadEst.firstClassWarning) {
    parts.push(`<span class="planner-sig-warn">${escapeHtml(isZh ? loadEst.labelTc : loadEst.labelEn)}</span>`);
  }
  if (cutoffWarn && cutoffWarn.isLastSoon) {
    parts.push(`<span class="planner-sig-cutoff">⚠ ${escapeHtml(isZh ? cutoffWarn.labelTc : cutoffWarn.labelEn)}</span>`);
  }
  return parts.join(' · ');
}

function buildPlannerLegRoadTrafficTagHtml(group, boardStopObj, alightStopObj, isZh = false) {
  if (group?.mode && group.mode !== 'BUS') return '';
  const detectors = (typeof window !== 'undefined' && Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__))
    ? window.__LIVE_TRAFFIC_DETECTORS__
    : null;
  if (!detectors || !detectors.length || typeof inferDirectionalRoadTrafficForStops !== 'function') return '';

  let segStops = [];
  if (typeof sliceRouteStopPoints === 'function' && boardStopObj && alightStopObj) {
    segStops = sliceRouteStopPoints(group, boardStopObj, alightStopObj).map(x => x.stop).filter(Boolean);
  }
  if (segStops.length < 2 && typeof getStopsForGroup === 'function' && boardStopObj && alightStopObj) {
    const allGroupStops = getStopsForGroup(group) || [];
    if (allGroupStops.length >= 2) {
      const bKey = String(boardStopObj.stopKey || boardStopObj.stopId || '');
      const aKey = String(alightStopObj.stopKey || alightStopObj.stopId || '');
      const bIdx = allGroupStops.findIndex(s => String(s.stopKey || s.stopId || '') === bKey);
      const aIdx = bIdx >= 0 ? allGroupStops.findIndex((s, i) => i > bIdx && String(s.stopKey || s.stopId || '') === aKey) : -1;
      if (bIdx >= 0 && aIdx > bIdx) segStops = allGroupStops.slice(bIdx, aIdx + 1);
    }
  }
  if (segStops.length < 2 && boardStopObj && alightStopObj) {
    segStops = [boardStopObj, alightStopObj];
  }
  if (segStops.length < 2) return '';

  const roadPoly = (typeof window !== 'undefined' && window.__ROUTE_GEOM_CACHE__ && group?.key)
    ? window.__ROUTE_GEOM_CACHE__[group.key]
    : null;
  const res = inferDirectionalRoadTrafficForStops(segStops, 0, detectors, segStops.length, roadPoly);
  if (!res?.sameSide) return '';
  const same = res.sameSide;
  const spdJam = Math.abs(Math.round(Number(same.minSpd) || 0));
  const spdAvg = Math.abs(Math.round(Number(same.avgSpd) || 0));

  // Strictly the route's own forward direction: opposite-carriageway jams are never mentioned.
  if (same.status === 'JAMMED') {
    return `<span class="planner-sig-road-jammed">${isZh ? `🔴 前路擠塞 ${spdJam} km/h` : `🔴 Traffic jam ${spdJam} km/h`}</span>`;
  }
  if (same.status === 'SLOW') {
    return `<span class="planner-sig-road-slow">${isZh ? `🟠 前路緩慢 ${spdJam} km/h` : `🟠 Slow traffic ${spdJam} km/h`}</span>`;
  }
  return `<span class="planner-sig-road-smooth">${isZh ? `🟢 路面暢順 ${spdAvg} km/h` : `🟢 Road ${spdAvg} km/h`}</span>`;
}

function getLegStopDisplayName(group, stopObj) {
  const isZh = (currentLang === 'zh');
  if (group?.mode === 'FERRY' && typeof getFerryPierBerthLabel === 'function') {
    const berth = getFerryPierBerthLabel(group, stopObj, isZh);
    if (berth) return berth;
  }
  return getStopName(stopObj);
}

function collectLoadNoticesFromList(loadList) {
  const out = [];
  let addedEal = false;
  for (const ld of (loadList || [])) {
    if (!ld) continue;
    if (ld.firstClassWarning && ld.tipEn && !addedEal) {
      addedEal = true;
      out.push({ type: 'eal_first_class', routeNo: 'EAL', en: ld.tipEn, tc: ld.tipTc || ld.tipEn });
    } else if (!ld.firstClassWarning && ld.pct >= 75 && ld.tipEn && out.length < 1) {
      out.push({ type: 'load_tip', routeNo: ld.lineCode || '', en: ld.tipEn, tc: ld.tipTc || ld.tipEn });
    }
  }
  return out;
}

function renderSectionalNoticesHtml(notices) {
  if (!Array.isArray(notices) || !notices.length) return '';
  const isZh = (currentLang === 'zh');
  return notices.slice(0, 2).map(n => {
    const isWarn = n.type === 'driver_override' || n.type === 'strict_boarding_only' || n.type === 'eal_first_class';
    const fareMath = (n.rebateAmount > 0 && n.upfrontFare > n.netFare)
      ? (isZh
          ? `（先拍 $${n.upfrontFare.toFixed(1)} → 實付 $${n.netFare.toFixed(1)}）`
          : ` (Tap $${n.upfrontFare.toFixed(1)} → Net $${n.netFare.toFixed(1)})`)
      : '';
    return `<div class="planner-notice-row ${isWarn ? 'warn' : ''}">${n.routeNo ? `<strong>${escapeHtml(n.routeNo)}</strong> · ` : ''}${escapeHtml(isZh ? n.tc : n.en)}${escapeHtml(fareMath)}</div>`;
  }).join('');
}

function renderWalkTimelineRowHtml(distM, walkSec, isBike, targetLabel, fromLat, fromLon, destLat, destLon, exitObj = null, exitDirection = 'to') {
  const minDist = exitObj?.ref ? 15 : 40;
  if (!distM || distM < minDist) return '';
  const isZh = (currentLang === 'zh');
  const mins = Math.max(1, Math.round((walkSec || Math.round(distM / (isBike ? 4.16 : 1.25))) / 60));
  const verb = isBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk');
  const exitPrefix = (exitObj?.ref && exitDirection === 'from')
    ? (isZh ? ` 經${exitObj.ref}出口` : ` via Exit ${exitObj.ref}`)
    : '';
  const exitSuffix = (exitObj?.ref && exitDirection !== 'from')
    ? (isZh ? ` (${exitObj.ref}出口)` : ` (Exit ${exitObj.ref})`)
    : '';
  const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${Number(destLat).toFixed(6)},${Number(destLon).toFixed(6)}&travelmode=${isBike ? 'bicycling' : 'walking'}`;
  const focusCall = (Number.isFinite(Number(fromLat)) && Number.isFinite(Number(fromLon)))
    ? `focusPlannerMapLeg(${Number(fromLat)}, ${Number(fromLon)}, ${Number(destLat)}, ${Number(destLon)})`
    : `focusPlannerMapLeg(${Number(destLat)}, ${Number(destLon)})`;
  return `
    <div class="planner-step-walk" onclick="event.stopPropagation(); ${focusCall};">
      <div class="planner-step-rail walk"></div>
      <div class="planner-step-content">
        <div class="planner-step-main">${isBike ? '🚲' : '🚶'} ${verb} ${mins}${t('minsUnit')} (${distM}m)${escapeHtml(exitPrefix)} → ${escapeHtml(targetLabel)}${escapeHtml(exitSuffix)}</div>
      </div>
      <a href="${mapUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="planner-step-link">${isZh ? '導航 ↗' : 'Walk ↗'}</a>
    </div>`;
}

function renderRouteChipHtml(group, fallbackLabel = '') {
  const badge = (group && window.getDisplayRouteBadge) ? window.getDisplayRouteBadge(group) : (group?.routeNo || fallbackLabel || '');
  const bg = group?.colorHex || (typeof window.__GET_ROUTE_COLOR_HEX__ === 'function' ? window.__GET_ROUTE_COLOR_HEX__(group?.mode, group?.company, group?.routeNo) : '#007AFF') || '#007AFF';
  return `<span class="planner-line-chip" style="background:${escapeHtml(bg)};">${escapeHtml(badge)}</span>`;
}

function renderPlannerEmptyStateHtml() {
  const isZh = (currentLang === 'zh');
  const quickHubs = [
    { id: 'MTR_CEN', en: 'Central', tc: '中環' },
    { id: 'MTR_TST', en: 'Tsim Sha Tsui', tc: '尖沙咀' },
    { id: 'MTR_MOK', en: 'Mong Kok', tc: '旺角' },
    { id: 'MTR_TUC', en: 'Tung Chung', tc: '東涌' },
    { id: 'FERRY_CC', en: 'Cheung Chau', tc: '長洲' },
    { id: 'MTR_AIR', en: 'Airport (HKG)', tc: '香港機場' }
  ];
  const hasFrom = Boolean(userCommuteProfile.home);
  const promptTitle = !hasFrom
    ? (isZh ? '輸入起點與目的地' : 'Where are you going?')
    : (isZh ? '選擇目的地即可查看實時路線' : 'Pick a destination for live routes');
  const promptSub = isZh
    ? '整合九巴、城巴、港鐵及渡輪實時到站時間，輸入車站、港鐵站或地址即時規劃。'
    : 'Real-time KMB, Citybus, MTR & Ferry ETAs combined — search any stop, station, pier, or HK address.';

  return `
    <div class="planner-empty-state">
      <div class="planner-empty-title">${promptTitle}</div>
      <div class="planner-empty-sub">${promptSub}</div>
      <div class="planner-quick-hubs">
        ${quickHubs.map(h => `
          <button type="button" class="planner-quick-hub-btn" onclick="quickPickPlannerHub('${h.id}')">
            ${escapeHtml(isZh ? h.tc : h.en)}
          </button>`).join('')}
      </div>
    </div>`;
}

function formatPlannerCardShareText(spec, card, isZh = false) {
  if (!spec || !card?.item) return '';
  const origName = (isZh && spec.fromMeta?.name_tc) ? spec.fromMeta.name_tc : (spec.fromMeta?.name_en || (isZh ? '起點' : 'Origin'));
  const destName = (isZh && spec.toMeta?.name_tc) ? spec.toMeta.name_tc : (spec.toMeta?.name_en || (isZh ? '目的地' : 'Destination'));
  const fmtClk = (ms) => ms ? formatHkArrivalClock(ms) : '';
  const fmtEx = (ex) => ex?.ref ? (isZh ? ` (${ex.ref}出口)` : ` (Exit ${ex.ref})`) : '';
  const lines = [];

  if (card.type === 'WALK_BIKE') {
    const wb = card.item;
    const mins = Math.max(1, Number(wb.totalMins) || 1);
    const fareNum = Number(wb.fareHkd) || 0;
    const fareStr = fareNum > 0 ? ` · ~$${fareNum.toFixed(1)}` : ' · $0';
    lines.push(`${origName} → ${destName}`);
    lines.push(`${mins}${isZh ? '分鐘' : 'm'}${fareStr}`);
    lines.push(`• ${wb.isBike ? (isZh ? '共享單車 (LocoBike)' : 'Bike Direct (LocoBike)') : (isZh ? '步行前往' : 'Walk Direct')} ${wb.distM}m → ${destName}`);
    return lines.join('\n');
  }

  if (card.type === 'DIRECT') {
    const dp = card.item;
    const badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(dp.group) : dp.group?.routeNo;
    const mins = Math.max(1, Number(dp.totalMins) || 1);
    const fareStr = dp.fareHkd > 0 ? ` · $${dp.fareHkd.toFixed(1)}` : '';
    const arrStr = dp.liveArrMs ? ` · ${isZh ? '抵達' : 'Arr'} ${fmtClk(dp.liveArrMs)}` : '';
    lines.push(`${origName} → ${destName}`);
    lines.push(`${mins}${isZh ? '分鐘' : 'm'}${fareStr}${arrStr}`);
    if (dp.accessWalkDistM >= 40) {
      lines.push(`• ${dp.accessByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${dp.accessWalkDistM}m → ${getLegStopDisplayName(dp.group, dp.boardStopObj)}${fmtEx(dp.accessExitObj)}`);
    }
    lines.push(`• ${dp.liveDepMs ? fmtClk(dp.liveDepMs) + ' ' : ''}${badge}: ${getLegStopDisplayName(dp.group, dp.boardStopObj)} → ${getLegStopDisplayName(dp.group, dp.alightStopObj)}`);
    if (dp.egressWalkDistM >= 40) {
      lines.push(`• ${dp.egressByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${dp.egressWalkDistM}m${fmtEx(dp.egressExitObj)} → ${destName}`);
    }
    return lines.join('\n');
  }

  if (card.type === 'XFER') {
    const cor = card.item;
    const node = cor.xferStopNodes?.[0];
    if (!node) return '';
    const b1 = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg1Group) : cor.leg1Group?.routeNo;
    const b2 = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg2Group) : cor.leg2Group?.routeNo;
    const mins = Math.max(1, Number(cor.totalMins) || 1);
    const fareStr = cor.fareHkd > 0 ? ` · $${cor.fareHkd.toFixed(1)}` : '';
    const arrStr = cor.liveArrMs ? ` · ${isZh ? '抵達' : 'Arr'} ${fmtClk(cor.liveArrMs)}` : '';
    lines.push(`${origName} → ${destName}`);
    lines.push(`${mins}${isZh ? '分鐘' : 'm'}${fareStr}${arrStr}`);
    if (cor.accessWalkDistM >= 40) {
      lines.push(`• ${cor.accessByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${cor.accessWalkDistM}m → ${getLegStopDisplayName(cor.leg1Group, cor.board1StopObj)}${fmtEx(cor.accessExitObj)}`);
    }
    lines.push(`• ${cor.liveDep1Ms ? fmtClk(cor.liveDep1Ms) + ' ' : ''}${b1}: ${getLegStopDisplayName(cor.leg1Group, cor.board1StopObj)} → ${getLegStopDisplayName(cor.leg1Group, node.alight1StopObj)}`);
    if (node.walkDistM >= 40 || node.xferExitObj?.ref) {
      lines.push(`• ${isZh ? '轉乘步行' : 'Transfer walk'} ${node.walkDistM || 0}m${fmtEx(node.xferExitObj)} → ${getLegStopDisplayName(cor.leg2Group, node.board2StopObj)}`);
    }
    const leg2Alight = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
    lines.push(`• ${cor.liveDep2Ms ? fmtClk(cor.liveDep2Ms) + ' ' : ''}${b2}: ${getLegStopDisplayName(cor.leg2Group, node.board2StopObj)} → ${getLegStopDisplayName(cor.leg2Group, leg2Alight)}`);
    (cor.leg3Options || []).forEach(l3 => {
      const b3 = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(l3.group) : l3.routeNo;
      if (l3.walkDistM >= 40 || l3.xferExitObj?.ref) {
        lines.push(`• ${isZh ? '轉乘步行' : 'Transfer walk'} ${l3.walkDistM || 0}m${fmtEx(l3.xferExitObj)} → ${getLegStopDisplayName(l3.group, l3.boardStopObj)}`);
      }
      lines.push(`• ${l3.liveDepMs ? fmtClk(l3.liveDepMs) + ' ' : ''}${b3}: ${getLegStopDisplayName(l3.group, l3.boardStopObj)} → ${getLegStopDisplayName(l3.group, l3.alightStopObj)}`);
    });
    if (cor.egressWalkDistM >= 40 || cor.egressExitObj?.ref) {
      lines.push(`• ${cor.egressByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${cor.egressWalkDistM || 0}m${fmtEx(cor.egressExitObj)} → ${destName}`);
    }
    return lines.join('\n');
  }
  return '';
}

window.formatPlannerCardShareText = formatPlannerCardShareText;

async function shareUnifiedPlannerCard(cardKey, btnEl = null) {
  triggerHaptic(10);
  const isZh = (currentLang === 'zh');
  const card = lastXferSolvedSpec?._unifiedCards?.find(c => c.key === cardKey);
  if (!card) return;
  const text = formatPlannerCardShareText(lastXferSolvedSpec, card, isZh);
  if (!text) return;

  const markCopied = () => {
    if (!btnEl) return;
    const orig = btnEl.getAttribute('data-orig-label') || btnEl.textContent;
    btnEl.setAttribute('data-orig-label', orig);
    btnEl.classList.add('copied');
    btnEl.textContent = isZh ? '✓ 已複製路線' : '✓ Copied';
    setTimeout(() => {
      btnEl.classList.remove('copied');
      btnEl.textContent = orig;
    }, 1800);
  };

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({ title: 'Transit HK Route', text });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      markCopied();
      return;
    }
  } catch (e) {}

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    markCopied();
  } catch (e) {}
}

window.shareUnifiedPlannerCard = shareUnifiedPlannerCard;

function selectUnifiedPlannerCard(cardKey, corIdx = 0) {
  triggerHaptic(10);
  activeUnifiedCardKey = cardKey;
  if (corIdx >= 0) activeXferCorridorIdx = corIdx;
  document.querySelectorAll('#xferResultsContainer .xfer-decision-card').forEach(el => {
    const isMatch = el.getAttribute('data-card-key') === cardKey;
    el.classList.toggle('selected', isMatch);
  });
  if (lastXferSolvedSpec && Array.isArray(lastXferSolvedSpec._unifiedCards)) {
    const picked = lastXferSolvedSpec._unifiedCards.find(c => c.key === cardKey) || lastXferSolvedSpec._unifiedCards[0];
    if (picked) {
      drawTransferCorridorOnMap(lastXferSolvedSpec, picked);
      syncPlannerAlertBannerUI(picked);
    }
  }
}

async function renderTransferPlannerView() {
  const container = document.getElementById('xferResultsContainer');
  if (!container) return;
  updateCommuteBarUI();
  if (typeof ensureXferMapInitialized === 'function') ensureXferMapInitialized();

  if (!userCommuteProfile.home || !userCommuteProfile.work) {
    if (typeof window.clearTransferPlannerMapLayers === 'function') {
      window.clearTransferPlannerMapLayers();
    }
    syncPlannerAlertBannerUI(null);
    container.innerHTML = renderPlannerEmptyStateHtml();
    return;
  }

  const myToken = ++xferRenderToken;
  const isZh = (currentLang === 'zh');

  let refStartMs = Date.now();
  let targetArriveMs = null;

  if ((xferTimeMode === 'PLAN' || xferTimeMode === 'ARRIVE') && xferPlannedHHMM) {
    const [hh, mm] = xferPlannedHHMM.split(':').map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) {
      const hkNow = getHongKongNow();
      const targetToday = new Date(hkNow.getFullYear(), hkNow.getMonth(), hkNow.getDate(), hh, mm, 0);
      let diffMs = targetToday.getTime() - hkNow.getTime();
      if (diffMs < -1800000) diffMs += 86400000;
      const targetEpochMs = Date.now() + diffMs;
      if (xferTimeMode === 'ARRIVE') {
        targetArriveMs = targetEpochMs;
        refStartMs = targetEpochMs - 60 * 60000;
      } else {
        refStartMs = targetEpochMs;
      }
    }
  }

  const queryDateObj = getHongKongNow(refStartMs);
  const isHolQuery = isHongKongHolidayFareDay(queryDateObj);
  const spec = buildFromToEdgeRequestSpec(queryDateObj);
  if (!spec) {
    container.innerHTML = `<div class="text-center">${t('noRoutesFound')}</div>`;
    return;
  }
  lastXferSolvedSpec = spec;
  spec._refStartMs = refStartMs;
  activeUnifiedCardKey = '';

  const renderFirstLegDepartureSwitcherHtml = (cardKey, candidateDeps, selectedIdx, zhFlag) => {
    if (xferTimeMode !== 'NOW' || !Array.isArray(candidateDeps) || candidateDeps.length <= 1) return '';
    const idx = Number.isInteger(selectedIdx) ? Math.max(0, Math.min(candidateDeps.length - 1, selectedIdx)) : 0;
    const prevCand = idx > 0 ? candidateDeps[idx - 1] : null;
    const nextCand = idx < candidateDeps.length - 1 ? candidateDeps[idx + 1] : null;
    const prevLbl = prevCand
      ? (zhFlag ? `‹ 早一班 ${formatHkArrivalClock(prevCand.depMs)}` : `‹ Earlier ${formatHkArrivalClock(prevCand.depMs)}`)
      : (zhFlag ? '‹ 最早班' : '‹ Earlier');
    const nextLbl = nextCand
      ? (zhFlag ? `遲一班 ${formatHkArrivalClock(nextCand.depMs)} ›` : `Later ${formatHkArrivalClock(nextCand.depMs)} ›`)
      : (zhFlag ? '尾班 ›' : 'Later ›');
    return `
      <div class="planner-dep-switcher" onclick="event.stopPropagation()">
        <button type="button" class="planner-dep-step-btn" ${prevCand ? '' : 'disabled'} onclick="event.stopPropagation(); shiftPlannerCardDeparture('${escapeJsAttr(cardKey)}', -1);">${escapeHtml(prevLbl)}</button>
        <button type="button" class="planner-dep-step-btn" ${nextCand ? '' : 'disabled'} onclick="event.stopPropagation(); shiftPlannerCardDeparture('${escapeJsAttr(cardKey)}', 1);">${escapeHtml(nextLbl)}</button>
      </div>`;
  };

  const paintUnifiedCards = (isFinalPass = false, preserveCardOrder = false) => {
    let topCards;
    if (preserveCardOrder && Array.isArray(spec._unifiedCards) && spec._unifiedCards.length) {
      topCards = spec._unifiedCards;
    } else {
      const unified = [];
      if (spec.walkBikeDirectCard) {
        unified.push({
          type: 'WALK_BIKE',
          idx: -1,
          score: spec.walkBikeDirectCard.disruptionScore,
          item: spec.walkBikeDirectCard,
          key: 'WALK_BIKE_0',
          isRailOrFerry: false
        });
      }
      const resolvedDirects = collapseParallelDirectRoutes(spec.directRoutes, isFinalPass, xferTimeMode, xferSortPref);
      resolvedDirects.forEach((dp, i) => {
        if (dp.isDeadGhost) return;
        const isRF = dp.group?.mode === 'FERRY' || (dp.group?.mode === 'MTR' && dp.group?.company === 'MTR');
        unified.push({ type: 'DIRECT', idx: i, score: dp.disruptionScore, item: dp, key: `DIRECT_${dp.group?.key || i}`, isRailOrFerry: isRF });
      });
      spec.transferCorridors.forEach((cor, i) => {
        if (cor.isDeadGhost) return;
        unified.push({ type: 'XFER', idx: i, score: cor.disruptionScore, item: cor, key: `XFER_${i}`, isRailOrFerry: corridorHasRailOrFerryTrunk(cor) });
      });

      applyCpmsFilterToUnifiedCards(unified);
      topCards = pruneDominatedPlannerCards(unified, xferSortPref, refStartMs);
      spec._unifiedCards = topCards;
    }

    if (!topCards.length) {
      container.innerHTML = `<div class="text-center">${t('noRoutesFound')}</div>`;
      return;
    }

    if (!activeUnifiedCardKey || !topCards.some(c => c.key === activeUnifiedCardKey)) {
      activeUnifiedCardKey = topCards[0].key;
    }

    const metricsList = topCards.map(c => extractCardMetrics(c, refStartMs));
    const minMins = Math.min(...metricsList.map(m => m.mins));
    const pricedMetrics = metricsList.filter(m => (!m.isWalkBike || (m.modes?.[0] === 'BIKE')) && m.fareHkd > 0);
    const minFare = pricedMetrics.length ? Math.min(...pricedMetrics.map(m => m.fareHkd)) : Infinity;
    const winnerFare = metricsList[0]?.fareHkd || 0;

    const toDispName = stripPlatformCodeFromDisplay(isZh && spec.toMeta.name_tc ? spec.toMeta.name_tc : spec.toMeta.name_en);
    const mtrClosedBanner = spec.mtrClosedNow
      ? `<div class="planner-notice-row warn">🌙 ${isZh ? '港鐵深夜收車時段 (01:00–05:50) — 已切換通宵巴士／小巴路線' : 'MTR closed (01:00–05:50 HKT) — Showing overnight buses & GMBs'}</div>`
      : '';

    const getCardTag = (c, m, rankIdx) => {
      if (rankIdx === 0) {
        if (xferSortPref === 'FASTEST') return isZh ? '最快' : 'Fastest';
        if (xferSortPref === 'CHEAPEST') return isZh ? '最抵' : 'Cheapest';
        if (xferSortPref === 'EASY') return isZh ? '少步行' : 'Less Walk';
        return isZh ? '最佳路線' : 'Best';
      }
      if ((!m.isWalkBike || m.modes?.[0] === 'BIKE') && m.fareHkd > 0 && m.fareHkd <= minFare + 0.1 && (winnerFare - m.fareHkd) >= 2.0) {
        const diff = (winnerFare - m.fareHkd).toFixed(1);
        return isZh ? `較平 · 慳$${diff}` : `Cheaper · Save $${diff}`;
      }
      if (m.mins <= minMins && rankIdx > 0) return isZh ? '最快' : 'Fastest';
      if (c.type === 'DIRECT') return isZh ? '直達免轉車' : 'Direct';
      if (m.walkM + 200 < (metricsList[0]?.walkM || 0)) return isZh ? '少步行' : 'Less Walk';
      return '';
    };

    const statusLine = !isFinalPass
      ? `<div class="planner-sync-note">${isZh ? '正在核對實時班次...' : 'Checking live departures...'}</div>`
      : '';

    container.innerHTML = mtrClosedBanner + statusLine + topCards.map((c, rankIdx) => {
      const m = metricsList[rankIdx];
      const isWinner = (rankIdx === 0);
      const isSelected = (c.key === activeUnifiedCardKey);
      const isOpen = isSelected || isWinner;
      const cardTag = getCardTag(c, m, rankIdx);

      if (c.type === 'WALK_BIKE') {
        const wb = c.item;
        const wbArrMs = targetArriveMs ? targetArriveMs : (refStartMs + wb.totalMins * 60000);
        const wbDepMs = wbArrMs - wb.totalMins * 60000;
        const arrClk = formatHkArrivalClock(wbArrMs);
        const depClk = formatHkArrivalClock(wbDepMs);
        const modeTitle = wb.isBike ? (isZh ? '單車直達' : 'Bike Direct') : (isZh ? '步行前往' : 'Walk Direct');
        const wbFare = Number(wb.fareHkd || 0);
        const wbFareStr = wbFare > 0 ? `~$${wbFare.toFixed(1)}` : '$0';
        const wbBikeNotice = wb.isBike
          ? `<div class="planner-notice-row">🚲 ${isZh ? '含 LocoBike 共享單車約 $5.0/30分鐘（錢包標準價）' : 'Includes LocoBike ~$5.0/30m (standard wallet rate)'}</div>`
          : '';
        const mapUrl = `https://www.google.com/maps/dir/?api=1&origin=${Number(spec.fromMeta.lat).toFixed(6)},${Number(spec.fromMeta.lon).toFixed(6)}&destination=${Number(spec.toMeta.lat).toFixed(6)},${Number(spec.toMeta.lon).toFixed(6)}&travelmode=${wb.isBike ? 'bicycling' : 'walking'}`;
        return `
          <details class="xfer-decision-card ${isWinner ? 'winner' : ''} ${isSelected ? 'selected' : ''}" data-card-key="${c.key}" ${isOpen ? 'open' : ''}>
            <summary class="xfer-card-header" onclick="selectUnifiedPlannerCard('${c.key}', -1)">
              <div class="planner-card-left">
                ${cardTag ? `<div class="xfer-badge-title">${escapeHtml(cardTag)}</div>` : ''}
                <div class="planner-route-chain">${wb.isBike ? '🚲' : '🚶'} <strong>${modeTitle}</strong></div>
                <div class="planner-meta-line">${wb.distM}m · ${depClk} → ${arrClk} · ${escapeHtml(wbFareStr)}</div>
              </div>
              <div class="planner-card-right">
                <div class="planner-dur-big">${wb.totalMins}<span class="planner-dur-unit">${t('minsUnit')}</span></div>
                <div class="planner-fare-sub">${escapeHtml(wbFareStr)}</div>
              </div>
            </summary>
            <div class="xfer-timeline">
              ${wbBikeNotice}
              <div class="planner-step-walk" onclick="event.stopPropagation(); focusPlannerMapLeg(${spec.fromMeta.lat}, ${spec.fromMeta.lon}, ${spec.toMeta.lat}, ${spec.toMeta.lon});">
                <div class="planner-step-rail walk"></div>
                <div class="planner-step-content">
                  <div class="planner-step-main">${modeTitle} (${wb.distM}m) → ${escapeHtml(toDispName)}</div>
                </div>
                <a href="${mapUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="planner-step-link">${isZh ? '導航 ↗' : 'Directions ↗'}</a>
              </div>
            </div>
          </details>`;
      }

      if (c.type === 'DIRECT') {
        const dp = c.item;
        const badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(dp.group) : dp.group.routeNo;
        const parallelHtml = dp.parallelRoutes?.length
          ? `<span class="planner-parallel-alt">/ ${dp.parallelRoutes.map(escapeHtml).join(' / ')}</span>`
          : '';
        const depMs = dp.liveDepMs || (refStartMs + dp.accessWalkSec * 1000);
        const arrMs = dp.liveArrMs || (refStartMs + dp.totalMins * 60000);
        const leaveOriginMs = depMs - dp.accessWalkSec * 1000;
        const displayMins = m.mins;
        const waitMins = (xferTimeMode === 'NOW') ? Math.max(0, Math.round((leaveOriginMs - refStartMs) / 60000)) : 0;

        const arrClk = formatHkArrivalClock(arrMs);
        const depClk = formatHkArrivalClock(depMs);
        const rideMins = Math.max(1, Math.round((dp.driveSec || 180) / 60));
        const walkTotalMins = Math.round(((dp.accessWalkSec || 0) + (dp.egressWalkSec || 0)) / 60);
        const cutoff1 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(dp.group, depMs, isZh) : null;
        const baseSigText = formatLegSignalTagHtml(dp.sigType1, dp.hw1, false, dp.load1, cutoff1);
        const roadSig1 = buildPlannerLegRoadTrafficTagHtml(dp.group, dp.boardStopObj, dp.alightStopObj, isZh);
        const sigText = [baseSigText, roadSig1].filter(Boolean).join(' · ');
        const allNotices = [...(dp.fareNotices || []), ...collectLoadNoticesFromList([dp.load1])];
        const noticesHtml = renderSectionalNoticesHtml(allNotices);

        const directLeaveTxt = dp.isBoardNowRush
          ? (isZh ? '立即上車' : 'Board now')
          : (waitMins >= 1 ? (isZh ? `${waitMins}分鐘後出發` : `Leave in ${waitMins}m`) : (isZh ? '立即出發' : 'Leave now'));
        const metaParts = [
          directLeaveTxt,
          `${isZh ? '抵達' : 'Arr'} ${arrClk}`,
          walkTotalMins >= 1 ? (isZh ? `步行${walkTotalMins}分` : `${walkTotalMins}m walk`) : null
        ].filter(Boolean).join(' · ');
        const directSwitcherHtml = renderFirstLegDepartureSwitcherHtml(c.key, dp.candidateDeps1, dp.selectedDepIdx1, isZh);
        const liveMetaBadgeHtml = dp.sigType1 === 'LIVE'
          ? ` · <span class="planner-sig-live" style="white-space:nowrap;">● ${isZh ? '實時' : 'Real-time'}</span>`
          : '';

        const boardDisp = getLegStopDisplayName(dp.group, dp.boardStopObj);
        const alightDisp = getLegStopDisplayName(dp.group, dp.alightStopObj);
        const accessWalkRow = renderWalkTimelineRowHtml(
          dp.accessWalkDistM, dp.accessWalkSec, dp.accessByBike,
          boardDisp,
          spec.fromMeta.lat, spec.fromMeta.lon,
          dp.accessExitObj?.lat || dp.boardStopObj.lat,
          dp.accessExitObj?.lon || dp.boardStopObj.lon,
          dp.accessExitObj,
          'to'
        );
        const egressWalkRow = renderWalkTimelineRowHtml(
          dp.egressWalkDistM, dp.egressWalkSec, dp.egressByBike,
          toDispName,
          dp.egressExitObj?.lat || dp.alightStopObj.lat,
          dp.egressExitObj?.lon || dp.alightStopObj.lon,
          spec.toMeta.lat, spec.toMeta.lon,
          dp.egressExitObj,
          'from'
        );
        const legCol = dp.group.colorHex || '#007AFF';

        const directEgressChip = ((dp.egressWalkDistM || 0) >= 150 || (dp.egressWalkSec || 0) >= 120)
          ? `<span class="planner-chain-sep">›</span><span class="planner-walk-chip">${dp.egressByBike ? '🚲' : '🚶'} ${Math.max(1, Math.round((dp.egressWalkSec || Math.round((dp.egressWalkDistM || 0) / 1.25)) / 60))}${t('minsUnit')}</span>`
          : '';

        return `
          <details class="xfer-decision-card ${isWinner ? 'winner' : ''} ${isSelected ? 'selected' : ''}" data-card-key="${escapeHtml(c.key)}" ${isOpen ? 'open' : ''}>
            <summary class="xfer-card-header" onclick="selectUnifiedPlannerCard('${escapeJsAttr(c.key)}', -1)">
              <div class="planner-card-left">
                ${cardTag ? `<div class="xfer-badge-title">${escapeHtml(cardTag)}</div>` : ''}
                <div class="planner-route-chain">${renderRouteChipHtml(dp.group)}${parallelHtml}${directEgressChip}</div>
                <div class="planner-meta-line">${escapeHtml(metaParts)}${liveMetaBadgeHtml}</div>
              </div>
              <div class="planner-card-right">
                <div class="planner-dur-big">${displayMins}<span class="planner-dur-unit">${t('minsUnit')}</span></div>
                <div class="planner-fare-sub">${dp.fareHkd > 0 ? `$${dp.fareHkd.toFixed(1)}` : ''}</div>
              </div>
            </summary>
            <div class="xfer-timeline">
              ${noticesHtml}
              ${accessWalkRow}
              <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${dp.boardStopObj.lat}, ${dp.boardStopObj.lon}, ${dp.alightStopObj.lat}, ${dp.alightStopObj.lon}, 0, this);">
                <div class="planner-step-rail" style="background:${escapeHtml(legCol)};"></div>
                <div class="planner-step-content">
                  <div class="planner-step-top">
                    <span class="planner-step-clock">${depClk}</span>
                    <span class="planner-step-main">${escapeHtml(boardDisp)}</span>
                  </div>
                  <div class="planner-step-sub">
                    <strong>${escapeHtml(badge)}</strong> → ${escapeHtml(alightDisp)} · ${rideMins}${t('minsUnit')} (${dp.stopsCount} ${isZh ? '站' : (dp.stopsCount === 1 ? 'stop' : 'stops')})
                  </div>
                  ${sigText ? `<div class="planner-step-sigs">${sigText}</div>` : ''}
                  ${directSwitcherHtml}
                </div>
                <button type="button" class="planner-live-btn" title="${isZh ? '查看全線站點及未來班次' : 'View all route stops & next departures'}" aria-label="${isZh ? '站點班次' : 'Stops and ETA'}" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(dp.group.key)}', '${escapeJsAttr(dp.boardStopKey)}');">${isZh ? '站點班次 ›' : 'Stops & ETA ›'}</button>
              </div>
              ${egressWalkRow}
              <div class="planner-card-actions">
                <button type="button" class="planner-share-btn" onclick="event.stopPropagation(); shareUnifiedPlannerCard('${escapeJsAttr(c.key)}', this);">↗ ${isZh ? '分享行程' : 'Share Trip'}</button>
              </div>
            </div>
          </details>`;
      }

      // XFER card
      const cor = c.item;
      const node = cor.xferStopNodes[0];
      const b1Badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg1Group) : cor.leg1Group.routeNo;
      const b2Badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg2Group) : cor.leg2Group.routeNo;
      const l3Chips = (cor.leg3Options || []).map(l3 => renderRouteChipHtml(l3.group, l3.routeNo));
      const xferEgressChip = ((cor.egressWalkDistM || 0) >= 150 || (cor.egressWalkSec || 0) >= 120)
        ? [`<span class="planner-walk-chip">${cor.egressByBike ? '🚲' : '🚶'} ${Math.max(1, Math.round((cor.egressWalkSec || Math.round((cor.egressWalkDistM || 0) / 1.25)) / 60))}${t('minsUnit')}</span>`]
        : [];
      const chainChipsHtml = [renderRouteChipHtml(cor.leg1Group), renderRouteChipHtml(cor.leg2Group), ...l3Chips, ...xferEgressChip]
        .join('<span class="planner-chain-sep">›</span>');

      const xferName = getStopName(node.board2StopObj);
      const dep1Ms = cor.liveDep1Ms || (refStartMs + cor.accessWalkSec * 1000);
      const dep2Ms = cor.liveDep2Ms || (dep1Ms + node.leg1DriveSec * 1000 + 180000);
      const arrMs  = cor.liveArrMs  || (refStartMs + cor.totalMins * 60000);
      const leaveOriginMs = dep1Ms - cor.accessWalkSec * 1000;
      const displayMins = m.mins;
      const waitMins = (xferTimeMode === 'NOW') ? Math.max(0, Math.round((leaveOriginMs - refStartMs) / 60000)) : 0;

      const arrClk = formatHkArrivalClock(arrMs);
      const dep1Clk = formatHkArrivalClock(dep1Ms);
      const dep2Clk = formatHkArrivalClock(dep2Ms);
      const isMultiBus = (cor.leg1Mode === 'BUS' && cor.leg2Mode === 'BUS');
      const fareLabel = cor.fareHkd > 0 ? `${isMultiBus ? '~' : ''}$${cor.fareHkd.toFixed(1)}` : '';
      const xferCount = 1 + (cor.leg3Options?.length || 0);
      const walkTotalMins = Math.round(((cor.accessWalkSec || 0) + (cor.egressWalkSec || 0) + (cor.totalTransferWalkSec || 0)) / 60);
      const anyLive = cor.sigType1 === 'LIVE' || cor.sigType2 === 'LIVE';

      const xferLeaveTxt = cor.isBoardNowRush
        ? (isZh ? '立即上車' : 'Board now')
        : (waitMins >= 1 ? (isZh ? `${waitMins}分鐘後出發` : `Leave in ${waitMins}m`) : (isZh ? '立即出發' : 'Leave now'));
      const metaParts = [
        xferLeaveTxt,
        `${isZh ? '抵達' : 'Arr'} ${arrClk}`,
        isZh ? `${xferCount}次轉乘` : `${xferCount} ${xferCount === 1 ? 'transfer' : 'transfers'}`,
        walkTotalMins >= 1 ? (isZh ? `步行${walkTotalMins}分` : `${walkTotalMins}m walk`) : null
      ].filter(Boolean).join(' · ');
      const xferSwitcherHtml = renderFirstLegDepartureSwitcherHtml(c.key, cor.candidateDeps1, cor.selectedDepIdx1, isZh);
      const xferLiveBadgeHtml = anyLive
        ? ` · <span class="planner-sig-live" style="white-space:nowrap;">● ${isZh ? '實時' : 'Real-time'}</span>`
        : '';

      const cutoff1 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(cor.leg1Group, dep1Ms, isZh) : null;
      const cutoff2 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(cor.leg2Group, dep2Ms, isZh) : null;
      const leg2AlightPre = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
      const roadSig1 = buildPlannerLegRoadTrafficTagHtml(cor.leg1Group, cor.board1StopObj, node.alight1StopObj, isZh);
      const roadSig2 = buildPlannerLegRoadTrafficTagHtml(cor.leg2Group, node.board2StopObj, leg2AlightPre, isZh);
      const sig1Text = [formatLegSignalTagHtml(cor.sigType1, cor.hw1, Boolean(cor.leg1FreeFeeder), cor.load1, cutoff1), roadSig1].filter(Boolean).join(' · ');
      const sig2Text = [formatLegSignalTagHtml(cor.sigType2, cor.hw2, Boolean(cor.leg2FreeFeeder), cor.load2, cutoff2), roadSig2].filter(Boolean).join(' · ');
      const tight1MinsTxt = cor.tightTransfer1Mins > 0 ? (isZh ? ` ${cor.tightTransfer1Mins}分` : ` ${cor.tightTransfer1Mins}m`) : '';
      const tightText = cor.tightTransfer1 ? `<span class="planner-sig-warn">⚠ ${isZh ? '緊湊轉乘' : 'Tight xfer'}${tight1MinsTxt}</span>` : '';

      const allLoadList = [cor.load1, cor.load2, ...(cor.leg3Options || []).map(l3 => l3.loadEstimate)];
      const allNotices = [...(cor.fareNotices || []), ...collectLoadNoticesFromList(allLoadList)];
      const noticesHtml = renderSectionalNoticesHtml(allNotices);

      const board1Disp = getLegStopDisplayName(cor.leg1Group, cor.board1StopObj);
      const alight1Disp = getLegStopDisplayName(cor.leg1Group, node.alight1StopObj);
      const board2Disp = getLegStopDisplayName(cor.leg2Group, node.board2StopObj);
      const accessWalkRow = renderWalkTimelineRowHtml(
        cor.accessWalkDistM, cor.accessWalkSec, cor.accessByBike,
        board1Disp,
        spec.fromMeta.lat, spec.fromMeta.lon,
        cor.accessExitObj?.lat || cor.board1StopObj.lat,
        cor.accessExitObj?.lon || cor.board1StopObj.lon,
        cor.accessExitObj,
        'to'
      );
      const xfer1FromLat = (node.xferExitSide === 'alight' && node.xferExitObj?.lat) ? node.xferExitObj.lat : node.alight1StopObj.lat;
      const xfer1FromLon = (node.xferExitSide === 'alight' && node.xferExitObj?.lon) ? node.xferExitObj.lon : node.alight1StopObj.lon;
      const xfer1ToLat = (node.xferExitSide === 'board' && node.xferExitObj?.lat) ? node.xferExitObj.lat : node.board2StopObj.lat;
      const xfer1ToLon = (node.xferExitSide === 'board' && node.xferExitObj?.lon) ? node.xferExitObj.lon : node.board2StopObj.lon;
      const xfer1WalkRow = (node.walkDistM >= (node.xferExitObj?.ref ? 15 : 55))
        ? renderWalkTimelineRowHtml(
            node.walkDistM, node.walkSec, false, board2Disp,
            xfer1FromLat, xfer1FromLon, xfer1ToLat, xfer1ToLon,
            node.xferExitObj, node.xferExitSide === 'alight' ? 'from' : 'to'
          )
        : '';
      const egressWalkRow = renderWalkTimelineRowHtml(
        cor.egressWalkDistM, cor.egressWalkSec, cor.egressByBike,
        toDispName,
        cor.egressExitObj?.lat || cor.alight2StopObj.lat,
        cor.egressExitObj?.lon || cor.alight2StopObj.lon,
        spec.toMeta.lat, spec.toMeta.lon,
        cor.egressExitObj,
        'from'
      );

      const leg1Col = cor.leg1Group.colorHex || '#007AFF';
      const leg2Col = cor.leg2Group.colorHex || '#007AFF';
      const leg2AlightObj = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
      const leg2AlightDisp = getLegStopDisplayName(cor.leg2Group, leg2AlightObj);
      const leg1Mins = Math.max(1, Math.round((node.leg1DriveSec || 180) / 60));
      const leg2Mins = Math.max(1, Math.round((node.leg2DriveSec || 180) / 60));

      const leg3RowsHtml = (cor.leg3Options || []).map((l3, l3Idx) => {
        const l3Badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(l3.group) : l3.routeNo;
        const l3DepMs = l3.liveDepMs || (arrMs - (cor.egressWalkSec + l3.driveSec) * 1000);
        const l3DepClk = formatHkArrivalClock(l3DepMs);
        const cutoff3 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(l3.group, l3DepMs, isZh) : null;
        const sig3Text = formatLegSignalTagHtml(l3.sigType, l3.hwMins, Boolean(l3.isFreeMtrFeeder), l3.loadEstimate, cutoff3);
        const roadSig3 = buildPlannerLegRoadTrafficTagHtml(l3.group, l3.boardStopObj, l3.alightStopObj, isZh);
        const l3TightMinsTxt = l3.tightTransferMins > 0 ? (isZh ? ` ${l3.tightTransferMins}分` : ` ${l3.tightTransferMins}m`) : '';
        const l3TightText = l3.tightTransfer ? `<span class="planner-sig-warn">⚠ ${isZh ? '緊湊轉乘' : 'Tight xfer'}${l3TightMinsTxt}</span>` : '';
        const l3SigsCombined = [sig3Text, roadSig3, l3TightText].filter(Boolean).join(' · ');
        const l3Mins = Math.max(1, Math.round((l3.driveSec || 180) / 60));
        const l3Col = l3.group?.colorHex || '#007AFF';
        const l3BoardDisp = getLegStopDisplayName(l3.group, l3.boardStopObj);
        const l3AlightDisp = getLegStopDisplayName(l3.group, l3.alightStopObj);
        const l3FromLat = (l3.xferExitSide === 'alight' && l3.xferExitObj?.lat) ? l3.xferExitObj.lat : l3.prevAlightStopObj?.lat;
        const l3FromLon = (l3.xferExitSide === 'alight' && l3.xferExitObj?.lon) ? l3.xferExitObj.lon : l3.prevAlightStopObj?.lon;
        const l3ToLat = (l3.xferExitSide === 'board' && l3.xferExitObj?.lat) ? l3.xferExitObj.lat : l3.boardStopObj.lat;
        const l3ToLon = (l3.xferExitSide === 'board' && l3.xferExitObj?.lon) ? l3.xferExitObj.lon : l3.boardStopObj.lon;
        const l3WalkRow = (l3.walkDistM >= (l3.xferExitObj?.ref ? 15 : 55))
          ? renderWalkTimelineRowHtml(
              l3.walkDistM, l3.walkSec, false, l3BoardDisp,
              l3FromLat, l3FromLon, l3ToLat, l3ToLon,
              l3.xferExitObj, l3.xferExitSide === 'alight' ? 'from' : 'to'
            )
          : '';
        return `${l3WalkRow}
          <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${l3.boardStopObj.lat}, ${l3.boardStopObj.lon}, ${l3.alightStopObj.lat}, ${l3.alightStopObj.lon}, ${2 + l3Idx}, this);">
            <div class="planner-step-rail" style="background:${escapeHtml(l3Col)};"></div>
            <div class="planner-step-content">
              <div class="planner-step-top">
                <span class="planner-step-clock">${l3DepClk}</span>
                <span class="planner-step-main">${escapeHtml(l3BoardDisp)}</span>
              </div>
              <div class="planner-step-sub">
                <strong>${escapeHtml(l3Badge)}</strong> → ${escapeHtml(l3AlightDisp)} · ${l3Mins}${t('minsUnit')}
              </div>
              ${l3SigsCombined ? `<div class="planner-step-sigs">${l3SigsCombined}</div>` : ''}
            </div>
            <button type="button" class="planner-live-btn" title="${isZh ? '查看全線站點及未來班次' : 'View all route stops & next departures'}" aria-label="${isZh ? '站點班次' : 'Stops and ETA'}" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(l3.group.key)}', '${escapeJsAttr(l3.boardStopKey)}');">${isZh ? '站點班次 ›' : 'Stops & ETA ›'}</button>
          </div>`;
      }).join('');

      const sig2Combined = [sig2Text, tightText].filter(Boolean).join(' · ');

      return `
        <details class="xfer-decision-card ${isWinner ? 'winner' : ''} ${isSelected ? 'selected' : ''}" data-card-key="${escapeHtml(c.key)}" ${isOpen ? 'open' : ''}>
          <summary class="xfer-card-header" onclick="selectUnifiedPlannerCard('${escapeJsAttr(c.key)}', ${c.idx})">
            <div class="planner-card-left">
              ${cardTag ? `<div class="xfer-badge-title">${escapeHtml(cardTag)}</div>` : ''}
              <div class="planner-route-chain">${chainChipsHtml}</div>
              <div class="planner-meta-line">${escapeHtml(metaParts)}${xferLiveBadgeHtml}</div>
            </div>
            <div class="planner-card-right">
              <div class="planner-dur-big">${displayMins}<span class="planner-dur-unit">${t('minsUnit')}</span></div>
              <div class="planner-fare-sub">${escapeHtml(fareLabel)}</div>
            </div>
          </summary>
          <div class="xfer-timeline">
            ${noticesHtml}
            ${accessWalkRow}
            <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${cor.board1StopObj.lat}, ${cor.board1StopObj.lon}, ${node.alight1StopObj.lat}, ${node.alight1StopObj.lon}, 0, this);">
              <div class="planner-step-rail" style="background:${escapeHtml(leg1Col)};"></div>
              <div class="planner-step-content">
                <div class="planner-step-top">
                  <span class="planner-step-clock">${dep1Clk}</span>
                  <span class="planner-step-main">${escapeHtml(board1Disp)}</span>
                </div>
                <div class="planner-step-sub">
                  <strong>${escapeHtml(b1Badge)}</strong> → ${escapeHtml(alight1Disp)} · ${leg1Mins}${t('minsUnit')}
                </div>
                ${sig1Text ? `<div class="planner-step-sigs">${sig1Text}</div>` : ''}
                ${xferSwitcherHtml}
              </div>
              <button type="button" class="planner-live-btn" title="${isZh ? '查看全線站點及未來班次' : 'View all route stops & next departures'}" aria-label="${isZh ? '站點班次' : 'Stops and ETA'}" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(cor.leg1Group.key)}', '${escapeJsAttr(cor.board1StopKey)}');">${isZh ? '站點班次 ›' : 'Stops & ETA ›'}</button>
            </div>
            ${xfer1WalkRow}
            <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${node.board2StopObj.lat}, ${node.board2StopObj.lon}, ${leg2AlightObj.lat}, ${leg2AlightObj.lon}, 1, this);">
              <div class="planner-step-rail" style="background:${escapeHtml(leg2Col)};"></div>
              <div class="planner-step-content">
                <div class="planner-step-top">
                  <span class="planner-step-clock">${dep2Clk}</span>
                  <span class="planner-step-main">${escapeHtml(board2Disp)}</span>
                </div>
                <div class="planner-step-sub">
                  <strong>${escapeHtml(b2Badge)}</strong> → ${escapeHtml(leg2AlightDisp)} · ${leg2Mins}${t('minsUnit')}
                </div>
                ${sig2Combined ? `<div class="planner-step-sigs">${sig2Combined}</div>` : ''}
              </div>
              <button type="button" class="planner-live-btn" title="${isZh ? '查看全線站點及未來班次' : 'View all route stops & next departures'}" aria-label="${isZh ? '站點班次' : 'Stops and ETA'}" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(cor.leg2Group.key)}', '${escapeJsAttr(node.board2StopKey)}');">${isZh ? '站點班次 ›' : 'Stops & ETA ›'}</button>
            </div>
            ${leg3RowsHtml}
            ${egressWalkRow}
            <div class="planner-card-actions">
              <button type="button" class="planner-share-btn" onclick="event.stopPropagation(); shareUnifiedPlannerCard('${escapeJsAttr(c.key)}', this);">↗ ${isZh ? '分享行程' : 'Share Trip'}</button>
            </div>
          </div>
        </details>`;
    }).join('') + renderMtrStyleReportFooterHtml();

    const activeCard = topCards.find(c => c.key === activeUnifiedCardKey) || topCards[0];
    if (activeCard) drawTransferCorridorOnMap(spec, activeCard);
    syncPlannerAlertBannerUI(activeCard || null);
  };

  spec._repaintCards = paintUnifiedCards;
  paintUnifiedCards(false);
  const initialAutoPickedKey = activeUnifiedCardKey;

  const fleetCheckCache = new Map();
  let prunedGhosts = 0;

  const syncNlbStopFareOnLeg = async (group, stopObj) => {
    if (group?.company !== 'NLB' || !stopObj) return false;
    const updated = await ensureNlbHolidayFaresLoaded(group);
    const liveSt = getStopsForGroup(group).find(s =>
      s.stopId === stopObj.stopId ||
      getBaseStopNameKey(s.stopName_e) === getBaseStopNameKey(stopObj.stopName_e)
    );
    if (liveSt?.fareHol) stopObj.fareHol = liveSt.fareHol;
    if (liveSt?.fare) stopObj.fare = liveSt.fare;
    if (updated) _raptorGraph = null;
    return Boolean(updated || liveSt?.fareHol);
  };

  await Promise.all([
    ...spec.directRoutes.map(async (dp) => {
      if (dp.group.company === 'NLB') {
        await syncNlbStopFareOnLeg(dp.group, dp.boardStopObj);
      }
      const minValidStartMs = Date.now();
      let candStartMs = targetArriveMs
        ? Math.max(minValidStartMs, targetArriveMs - (dp.totalMins + 4) * 60000)
        : refStartMs;

      let w1 = await resolveLiveOrStaticLegWindow(dp.group, dp.boardStopKey, candStartMs + dp.accessWalkSec * 1000, dp.driveSec, dp.boardStopObj, true, dp.alightStopObj);
      if (w1.isDeadGhost) {
        dp.isDeadGhost = true;
        prunedGhosts++;
        return;
      }

      for (let pass = 0; targetArriveMs && pass < 2; pass++) {
        const estArrMs = w1.arrMs + dp.egressWalkSec * 1000;
        if (estArrMs <= targetArriveMs + 180000 || candStartMs <= minValidStartMs) break;
        const overshootMs = estArrMs - targetArriveMs;
        const stepBackMs = getPeriodHeadwaySecs(dp.group, candStartMs) * 1000;
        const nextStartMs = Math.max(minValidStartMs, candStartMs - Math.max(stepBackMs, overshootMs + 180000));
        if (nextStartMs === candStartMs) break;
        candStartMs = nextStartMs;
        w1 = await resolveLiveOrStaticLegWindow(dp.group, dp.boardStopKey, candStartMs + dp.accessWalkSec * 1000, dp.driveSec, dp.boardStopObj, true, dp.alightStopObj);
      }

      dp.sigType1 = w1.signalType;
      dp.hw1 = w1.headwayMins || 0;
      dp.headwaySec1 = w1.headwaySec || (dp.hw1 * 60);
      dp.candidateDeps1 = Array.isArray(w1.candidateDeps) ? w1.candidateDeps : [];
      dp.selectedDepIdx1 = Number.isInteger(w1.selectedDepIdx) ? w1.selectedDepIdx : 0;
      dp.isBoardNowRush = false;
      dp.load1 = w1.loadEstimate || dp.load1;
      const fareMeta = {};
      const legSpec = {
        group: dp.group,
        boardStopObj: dp.boardStopObj,
        alightStopObj: dp.alightStopObj,
        driveSec: dp.driveSec,
        stopsCount: dp.stopsCount,
        vesselClass: w1.vesselClass,
        loadEstimate: dp.load1
      };
      const directBikeSpec = (dp.accessByBike || dp.egressByBike)
        ? { accessByBike: dp.accessByBike, accessWalkDistM: dp.accessWalkDistM, egressByBike: dp.egressByBike, egressWalkDistM: dp.egressWalkDistM }
        : null;
      dp.fareHkd = computeLegChainFareHkd([legSpec], isHolQuery, fareMeta, spec.fromMeta.lat, spec.fromMeta.lon, directBikeSpec);
      dp.fareNotices = fareMeta.notices || [];
      dp.liveDepMs = w1.depMs;
      dp.liveArrMs = w1.arrMs + dp.egressWalkSec * 1000;
      const rankOriginMs = (xferTimeMode === 'NOW') ? refStartMs : (w1.depMs - dp.accessWalkSec * 1000);
      dp.totalMins = Math.max(2, Math.round((dp.liveArrMs - rankOriginMs) / 60000));
      dp.disruptionScore = computeDisruptionAdjustedScore(
        dp.totalMins,
        [legSpec],
        dp.accessWalkSec,
        dp.egressWalkSec,
        [],
        dp.fareHkd,
        [],
        0,
        { queryDate: queryDateObj, isLantauTrip: spec.isLantauTrip, fromMeta: spec.fromMeta, toMeta: spec.toMeta, egressByBike: dp.egressByBike, egressWalkDistM: dp.egressWalkDistM }
      );
    }),
    ...spec.transferCorridors.map(async (cor) => {
      const node = cor.xferStopNodes[0];
      await Promise.all([
        syncNlbStopFareOnLeg(cor.leg1Group, cor.board1StopObj),
        syncNlbStopFareOnLeg(cor.leg2Group, node.board2StopObj),
        ...(cor.leg3Options || []).map(l3 => syncNlbStopFareOnLeg(l3.group, l3.boardStopObj))
      ]);

      if (xferTimeMode === 'NOW') {
        const downstreamChecks = [
          checkDownstreamBusRouteHasLiveFleet(cor.leg2Group, node.board2StopObj, fleetCheckCache),
          ...(cor.leg3Options || []).map(l3 => checkDownstreamBusRouteHasLiveFleet(l3.group, l3.boardStopObj, fleetCheckCache))
        ];
        const aliveFlags = await Promise.all(downstreamChecks);
        if (aliveFlags.some(isAlive => !isAlive)) {
          cor.isDeadGhost = true;
          prunedGhosts++;
          return;
        }
      }

      const solveCorridorFrom = async (startMs) => {
        const w1 = await resolveLiveOrStaticLegWindow(cor.leg1Group, cor.board1StopKey, startMs + cor.accessWalkSec * 1000, node.leg1DriveSec, cor.board1StopObj, true, node.alight1StopObj);
        if (w1.isDeadGhost) return { w1, isDeadGhost: true };
        const xfer1BufSec = getInterchangeTransferSec(
          cor.leg1Group, cor.leg2Group,
          { mtrCode: cor.xferMtrCodes?.[0] || '', isGoldenHub: isStrategicInterchangeHub(node.board2StopObj) },
          node.walkSec || 0
        );
        const leg2AlightObj = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
        const w2 = await resolveLiveOrStaticLegWindow(cor.leg2Group, node.board2StopKey, w1.arrMs + xfer1BufSec * 1000, node.leg2DriveSec, node.board2StopObj, false, leg2AlightObj);
        let curArrMs = w2.arrMs;
        const w3List = [];
        const l3BufList = [];
        for (let lIdx = 0; lIdx < (cor.leg3Options || []).length; lIdx++) {
          const l3 = cor.leg3Options[lIdx];
          const prevG = lIdx === 0 ? cor.leg2Group : cor.leg3Options[lIdx - 1].group;
          const l3BufSec = getInterchangeTransferSec(
            prevG, l3.group,
            { mtrCode: cor.xferMtrCodes?.[lIdx + 1] || '', isGoldenHub: isStrategicInterchangeHub(l3.boardStopObj) },
            l3.walkSec || 0
          );
          l3BufList.push(l3BufSec);
          const w3 = await resolveLiveOrStaticLegWindow(l3.group, l3.boardStopKey, curArrMs + l3BufSec * 1000, l3.driveSec, l3.boardStopObj, false, l3.alightStopObj);
          w3List.push(w3);
          curArrMs = w3.arrMs;
        }
        return { w1, w2, w3List, xfer1BufSec, l3BufList, finalArrMs: curArrMs + cor.egressWalkSec * 1000, isDeadGhost: false };
      };

      const minValidStartMs = Date.now();
      let candStartMs = targetArriveMs
        ? Math.max(minValidStartMs, targetArriveMs - (cor.totalMins + 6) * 60000)
        : refStartMs;

      let solved = await solveCorridorFrom(candStartMs);
      if (solved.isDeadGhost) {
        cor.isDeadGhost = true;
        prunedGhosts++;
        return;
      }

      for (let pass = 0; targetArriveMs && pass < 2; pass++) {
        if (solved.finalArrMs <= targetArriveMs + 180000 || candStartMs <= minValidStartMs) break;
        const overshootMs = solved.finalArrMs - targetArriveMs;
        const nextStartMs = Math.max(minValidStartMs, candStartMs - (overshootMs + 300000));
        if (nextStartMs === candStartMs) break;
        candStartMs = nextStartMs;
        solved = await solveCorridorFrom(candStartMs);
        if (solved.isDeadGhost) {
          cor.isDeadGhost = true;
          prunedGhosts++;
          return;
        }
      }

      const { w1, w2, w3List, xfer1BufSec, l3BufList, finalArrMs } = solved;

      cor.load1 = w1.loadEstimate || cor.load1;
      cor.load2 = w2.loadEstimate || cor.load2;
      cor.candidateDeps1 = Array.isArray(w1.candidateDeps) ? w1.candidateDeps : [];
      cor.selectedDepIdx1 = Number.isInteger(w1.selectedDepIdx) ? w1.selectedDepIdx : 0;
      cor.isBoardNowRush = false;
      cor.candidateDeps2 = Array.isArray(w2.candidateDeps) ? w2.candidateDeps : [];
      cor.headwaySec2 = w2.headwaySec || ((w2.headwayMins || 8) * 60);
      cor.xfer1BufSec = xfer1BufSec || 180;

      const allLegs = [
        { group: cor.leg1Group, boardStopObj: cor.board1StopObj, alightStopObj: node.alight1StopObj, driveSec: node.leg1DriveSec, walkAfterSec: node.walkSec || 0, stopsCount: node.leg1StopsCount, vesselClass: w1.vesselClass, loadEstimate: cor.load1 },
        { group: cor.leg2Group, boardStopObj: node.board2StopObj, alightStopObj: cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj, driveSec: node.leg2DriveSec, stopsCount: node.leg2StopsCount, vesselClass: w2.vesselClass, loadEstimate: cor.load2 }
      ];
      let prevLegArrMs = w2.arrMs;
      (cor.leg3Options || []).forEach((l3, idx) => {
        const w3 = w3List[idx];
        l3.liveDepMs = w3.depMs;
        l3.liveArrMs = w3.arrMs;
        l3.sigType = w3.signalType;
        l3.hwMins = w3.headwayMins || 0;
        l3.headwaySec = w3.headwaySec || ((w3.headwayMins || 8) * 60);
        l3.candidateDeps = Array.isArray(w3.candidateDeps) ? w3.candidateDeps : [];
        l3.xferBufSec = l3BufList?.[idx] || 180;
        l3.loadEstimate = w3.loadEstimate || l3.loadEstimate;
        const prevG = idx === 0 ? cor.leg2Group : cor.leg3Options[idx - 1].group;
        const isRailToRail = prevG?.mode === 'MTR' && prevG?.company === 'MTR' && l3.group?.mode === 'MTR' && l3.group?.company === 'MTR';
        const l3SlackMs = w3.depMs - prevLegArrMs - (Number(l3.walkSec) || 0) * 1000;
        l3.tightTransfer = !isRailToRail && l3SlackMs < 240000;
        l3.tightTransferMins = Math.max(1, Math.round(Math.max(0, l3SlackMs) / 60000));
        prevLegArrMs = w3.arrMs;
        allLegs.push({ group: l3.group, boardStopObj: l3.boardStopObj, alightStopObj: l3.alightStopObj, driveSec: l3.driveSec, walkAfterSec: l3.walkSec || 0, stopsCount: l3.stopsCount, vesselClass: w3.vesselClass, loadEstimate: l3.loadEstimate, _l3Ref: l3 });
      });

      const fareMeta = {};
      const corBikeSpec = (cor.accessByBike || cor.egressByBike)
        ? { accessByBike: cor.accessByBike, accessWalkDistM: cor.accessWalkDistM, egressByBike: cor.egressByBike, egressWalkDistM: cor.egressWalkDistM }
        : null;
      cor.fareHkd = computeLegChainFareHkd(allLegs, isHolQuery, fareMeta, spec.fromMeta.lat, spec.fromMeta.lon, corBikeSpec);
      cor.fareNotices = fareMeta.notices || [];
      cor.leg1FreeFeeder = Boolean(allLegs[0]?.isFreeMtrFeeder);
      cor.leg2FreeFeeder = Boolean(allLegs[1]?.isFreeMtrFeeder);
      allLegs.slice(2).forEach(al => {
        if (al._l3Ref) al._l3Ref.isFreeMtrFeeder = Boolean(al.isFreeMtrFeeder);
      });

      cor.sigType1 = w1.signalType;
      cor.hw1 = w1.headwayMins || 0;
      cor.sigType2 = w2.signalType;
      cor.hw2 = w2.headwayMins || 0;
      const isLeg12RailToRail = cor.leg1Group?.mode === 'MTR' && cor.leg1Group?.company === 'MTR' && cor.leg2Group?.mode === 'MTR' && cor.leg2Group?.company === 'MTR';
      const xfer1SlackMs = w2.depMs - w1.arrMs - (Number(node.walkSec) || 0) * 1000;
      cor.tightTransfer1 = !isLeg12RailToRail && xfer1SlackMs < 240000;
      cor.tightTransfer1Mins = Math.max(1, Math.round(Math.max(0, xfer1SlackMs) / 60000));
      cor.liveDep1Ms = w1.depMs;
      cor.liveDep2Ms = w2.depMs;
      cor.liveArrMs = finalArrMs;

      const rankOriginMs = (xferTimeMode === 'NOW') ? refStartMs : (w1.depMs - cor.accessWalkSec * 1000);
      cor.totalMins = Math.max(4, Math.round((cor.liveArrMs - rankOriginMs) / 60000));
      cor.disruptionScore = computeDisruptionAdjustedScore(
        cor.totalMins,
        allLegs,
        cor.accessWalkSec,
        cor.egressWalkSec,
        cor.xferMtrCodes,
        cor.fareHkd,
        cor.xferStopObjs,
        cor.totalTransferWalkSec || 0,
        { queryDate: queryDateObj, isLantauTrip: spec.isLantauTrip, fromMeta: spec.fromMeta, toMeta: spec.toMeta, egressByBike: cor.egressByBike, egressWalkDistM: cor.egressWalkDistM }
      );
    })
  ]);

  if (myToken !== xferRenderToken || currentView !== 'xfer') return;

  // If user didn't manually click another card during async ETA resolution, let the live #1 winner take focus
  if (activeUnifiedCardKey === initialAutoPickedKey) {
    activeUnifiedCardKey = '';
  }
  paintUnifiedCards(true);
}

if (typeof window !== 'undefined') {
  window.formatLegLoadPillHtml = formatLegLoadPillHtml;
  window.getPeriodHeadwaySecs = getPeriodHeadwaySecs;
  window.openTransferPlannerFromTop = openTransferPlannerFromTop;
  window.sendMapPointToTransferPlanner = sendMapPointToTransferPlanner;
  window.setXferTimeMode = setXferTimeMode;
  window.setXferSortPref = setXferSortPref;
  window.onXferPlannedTimeChange = onXferPlannedTimeChange;
  window.toggleXferLocoBikeMode = toggleXferLocoBikeMode;
  window.syncXferSubbarUI = syncXferSubbarUI;
  window.clearCommuteSlot = clearCommuteSlot;
  window.formatPlannerSlotDisplay = formatPlannerSlotDisplay;
  window.updateCommuteBarUI = updateCommuteBarUI;
  window.swapHomeAndWorkCommuteStops = swapHomeAndWorkCommuteStops;
  window.renderPlannerInlineDropdown = renderPlannerInlineDropdown;
  window.resolveStaticFerrySlot = resolveStaticFerrySlot;
  window.resolveStaticDownstreamLegWindow = resolveStaticDownstreamLegWindow;
  window.resolveFirstLegWindow = resolveFirstLegWindow;
  window.applyCpmsFilterToUnifiedCards = applyCpmsFilterToUnifiedCards;
  window.selectUnifiedPlannerCard = selectUnifiedPlannerCard;
  window.renderTransferPlannerView = renderTransferPlannerView;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatLegLoadPillHtml,
    getLegServiceCutoffWarning,
    getPeriodHeadwaySecs,
    evaluatePlannerAlertBannerState,
    syncPlannerAlertBannerUI,
    dismissPlannerAlertBanner,
    syncRelevantCorridorPillUI,
    getPlannerAutocompleteRefPoint,
    formatCompactDistanceLabel,
    deduplicatePlannerAutocompleteStops,
    getPlannerAutocompleteSectionOrder,
    focusPlannerInlineInput,
    onPlannerInlineInput,
    onPlannerInlineKeydown,
    selectPlannerInlineOption,
    closePlannerInlineDropdown,
    useGpsForPlannerSlot,
    isBusLegOnIncidentCorridor,
    resolveLiveOrStaticLegWindow,
    findConnectingLegWindow,
    recalculatePlannerCardForFirstLegDep,
    shiftPlannerCardDeparture,
    resolveFirstLegWindow,
    formatPlannerCardShareText,
    shareUnifiedPlannerCard,
    selectUnifiedPlannerCard,
    renderTransferPlannerView
  };
}
