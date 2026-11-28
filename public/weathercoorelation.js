/* Transit HK — HKO Weather Correlation Engine (weathercoorelation.js)
 * Dual Browser Global + CommonJS module.
 * Pure, mode-agnostic weather modifier calculations for Hong Kong outdoor leisure,
 * urban/indoor transit shift (rain/heat inversion), and pre-typhoon evacuation surges.
 */
(function (root) {
  'use strict';

  function _getHkMonthZeroBased(nowMs) {
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    // HK Time is UTC+8 year-round (no DST)
    const hkDate = new Date(ms + 8 * 3600 * 1000);
    return hkDate.getUTCMonth(); // 0=Jan .. 11=Dec
  }

  function _isCoolHikingSeasonMonth(monthZeroBased) {
    // Oct (9), Nov (10), Dec (11), Jan (0), Feb (1), Mar (2), Apr (3)
    return monthZeroBased >= 9 || monthZeroBased <= 3;
  }

  function _collectWarningTokens(hkoWeather) {
    const tokens = [];
    const pushVal = (v) => {
      if (!v) return;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) pushVal(v[i]);
      } else if (typeof v === 'object') {
        if (v.code) tokens.push(String(v.code).toUpperCase());
        if (v.name) tokens.push(String(v.name).toUpperCase());
      } else {
        String(v)
          .split(/[,;/|\s]+/)
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
          .forEach((s) => tokens.push(s));
      }
    };
    pushVal(hkoWeather.warnings);
    pushVal(hkoWeather.warningCodes);
    pushVal(hkoWeather.warning);
    return tokens;
  }

  function _parseTemperature(hkoWeather) {
    const candidates = [
      hkoWeather.temp,
      hkoWeather.temperature,
      hkoWeather.tempC,
      hkoWeather.temperatureC
    ];
    for (let i = 0; i < candidates.length; i++) {
      const raw = candidates[i];
      if (raw === null || raw === undefined || raw === '') continue;
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  function _parseHumidity(hkoWeather) {
    const candidates = [hkoWeather.humidity, hkoWeather.rh, hkoWeather.relativeHumidity];
    for (let i = 0; i < candidates.length; i++) {
      const raw = candidates[i];
      if (raw === null || raw === undefined || raw === '') continue;
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  /**
   * Computes outdoor leisure weather surge multiplier.
   *
   * Rules:
   * - If hkoWeather is null/missing: 1.2 for Oct–Apr (cool hiking season), else 1.0.
   * - If rainy or typhoon (TC3/TC8/TC9/TC10/RAIN/heavyRain/rainAdvisory): 0.3.
   * - If temp > 31°C: 0.5.
   * - If temp < 12°C: 0.6.
   * - If dry, clear, and 15 <= temp <= 26°C: 1.5.
   * - Default: 1.0.
   *
   * @param {Object|null|undefined} hkoWeather
   * @param {number} [nowMs]
   * @returns {number}
   */
  function getWeatherSurgeMultiplier(hkoWeather, nowMs) {
    if (!hkoWeather || typeof hkoWeather !== 'object') {
      const month = _getHkMonthZeroBased(nowMs);
      return _isCoolHikingSeasonMonth(month) ? 1.2 : 1.0;
    }

    const warnings = _collectWarningTokens(hkoWeather);
    const condStr = String(
      hkoWeather.condition || hkoWeather.weather || hkoWeather.summary || hkoWeather.labelEn || ''
    ).trim();
    const condLower = condStr.toLowerCase();

    const hasTyphoonWarning = Boolean(
      hkoWeather.typhoon ||
      warnings.some((w) => /^(TC3|TC8|TC9|TC10|TYPHOON|T3|T8|T9|T10|WTCSGNL)/.test(w) || w.includes('TC3') || w.includes('TC8')) ||
      /\b(typhoon|tc3|tc8|tc9|tc10|gale|storm\s*signal)\b/i.test(condLower)
    );

    const hasRainWarning = Boolean(
      hkoWeather.heavyRain ||
      hkoWeather.rainAdvisory ||
      hkoWeather.isRainy ||
      (Number.isFinite(Number(hkoWeather.rainfallMm)) && Number(hkoWeather.rainfallMm) >= 1) ||
      warnings.some((w) => /^(RAIN|WRAIN|WRAINA|WRAINR|WRAINB|TS|THUNDER)/.test(w) || w.includes('RAIN')) ||
      /\b(rain|rainy|shower|showers|drizzle|downpour|thunderstorm|squall|storm)\b/i.test(condLower)
    );

    if (hasTyphoonWarning || hasRainWarning) {
      return 0.3;
    }

    const temp = _parseTemperature(hkoWeather);
    if (temp !== null) {
      if (temp > 31) return 0.5;
      if (temp < 12) return 0.6;
    }

    const humidity = _parseHumidity(hkoWeather);
    const isHumid = (humidity !== null && humidity > 85) || hkoWeather.isDry === false;
    const hasNonClearCondition = Boolean(
      condStr && /\b(cloud|cloudy|overcast|fog|foggy|mist|misty|haze|hazy|humid|damp|wet)\b/i.test(condLower)
    );
    const hasExplicitClearCondition = Boolean(
      hkoWeather.isClear === true ||
      hkoWeather.isDry === true ||
      (condStr && /\b(clear|sunny|fine|fair|dry|bright)\b/i.test(condLower))
    );
    const isDryAndClear = !isHumid && !hasNonClearCondition && (hasExplicitClearCondition || !condStr);

    if (temp !== null && temp >= 15 && temp <= 26 && isDryAndClear) {
      return 1.5;
    }

    return 1.0;
  }

  /**
   * Computes decomposed city-flow weather modifiers for the People Flow Simulator:
   * - outdoorMod: hiking/beach/outdoor leisure appetite (0.3..1.5)
   * - urbanIndoorMod: rain/heat inversion pushing street walkers into urban buses/MTR/malls (0.55..1.25)
   * - preTyphoonEvacMod: homebound evacuation spike before T8 hoisting (1.0 or 1.8)
   *
   * @param {Object|null|undefined} hkoWeather
   * @param {number} [nowMs]
   * @returns {{ outdoorMod: number, urbanIndoorMod: number, preTyphoonEvacMod: number }}
   */
  function getWeatherFlowModifiers(hkoWeather, nowMs) {
    const outdoorMod = getWeatherSurgeMultiplier(hkoWeather, nowMs);
    if (!hkoWeather || typeof hkoWeather !== 'object') {
      return {
        outdoorMod,
        urbanIndoorMod: 1.0,
        preTyphoonEvacMod: 1.0
      };
    }

    const warnings = _collectWarningTokens(hkoWeather);
    const condStr = String(
      hkoWeather.condition || hkoWeather.weather || hkoWeather.summary || hkoWeather.labelEn || ''
    ).trim().toLowerCase();

    const hasPreT8 = Boolean(
      hkoWeather.preTyphoonEvac ||
      hkoWeather.preT8 ||
      warnings.some((w) => /^(PRE_T8|PRE8|T8_IMMINENT|PRE_TC8|WTCSGNL_PRE8)$/.test(w)) ||
      /\b(pre[-\s]?t8|t8\s*within|pre[-\s]?no\.?\s*8)\b/i.test(condStr)
    );

    const hasT8Plus = Boolean(
      warnings.some((w) => /^(TC8|TC9|TC10|T8|T9|T10)$/.test(w) || w.includes('TC8') || w.includes('TC9') || w.includes('TC10')) ||
      /\b(tc8|tc9|tc10|no\.?\s*8|no\.?\s*9|no\.?\s*10)\b/i.test(condStr)
    );

    const hasT3 = Boolean(
      !hasT8Plus && (
        hkoWeather.typhoon ||
        warnings.some((w) => /^(TC3|T3|TYPHOON|WTCSGNL)$/.test(w) || w.includes('TC3')) ||
        /\b(typhoon|tc3|no\.?\s*3|strong\s*wind)\b/i.test(condStr)
      )
    );

    const hasRain = Boolean(
      hkoWeather.heavyRain ||
      hkoWeather.rainAdvisory ||
      hkoWeather.isRainy ||
      (Number.isFinite(Number(hkoWeather.rainfallMm)) && Number(hkoWeather.rainfallMm) >= 1) ||
      warnings.some((w) => /^(RAIN|WRAIN|WRAINA|WRAINR|WRAINB|TS|THUNDER)/.test(w) || w.includes('RAIN')) ||
      /\b(rain|rainy|shower|showers|drizzle|downpour|thunderstorm|squall|storm)\b/i.test(condStr)
    );

    const temp = _parseTemperature(hkoWeather);

    let urbanIndoorMod = 1.0;
    if (hasT8Plus && !hasPreT8) {
      // Active T8+ shuts offices & suspends most daytime bus services
      urbanIndoorMod = 0.55;
    } else if (hasRain) {
      // Rain inversion: street walkers compress into buses, MTR, and covered hubs
      urbanIndoorMod = hkoWeather.heavyRain ? 1.25 : 1.2;
    } else if (hasT3) {
      urbanIndoorMod = 1.15;
    } else if (temp !== null && temp > 31) {
      // Scorching heat inversion: walkers shift onto air-conditioned transit & malls
      urbanIndoorMod = 1.12;
    }

    const preTyphoonEvacMod = hasPreT8 ? 1.8 : 1.0;

    return {
      outdoorMod: Number(outdoorMod.toFixed(3)),
      urbanIndoorMod: Number(urbanIndoorMod.toFixed(3)),
      preTyphoonEvacMod: Number(preTyphoonEvacMod.toFixed(3))
    };
  }

  const WeatherCorrelationEngine = {
    getWeatherSurgeMultiplier,
    getWeatherFlowModifiers
  };

  if (root) {
    root.getWeatherSurgeMultiplier = getWeatherSurgeMultiplier;
    root.getWeatherFlowModifiers = getWeatherFlowModifiers;
    root.WeatherCorrelationEngine = WeatherCorrelationEngine;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getWeatherSurgeMultiplier,
      getWeatherFlowModifiers,
      WeatherCorrelationEngine
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
