/* Transit HK — Hong Kong Monthly Seasonal & Structural Micro-Surge Matrix (monthly_activity.js)
 * Dual Browser Global + CommonJS module.
 * Strictly feeds bus crowding/load inference (bussurge.js / fare-load-engine.js),
 * NEVER alters map road-speed telemetry.
 */
(function (root) {
  'use strict';

  const MONTHLY_ACTIVITY_PROFILES = Object.freeze({
    0: {
      month: 0,
      name: 'January',
      season: 'COOL_DRY',
      trailWeight: 1.5,
      beachWeight: 0.75,
      earlyHikeBoost: 1.2,
      eveningDiningBoost: 1.05,
      schoolBreak: false,
      events: ['New Year', 'AIA Carnival', 'Lunar New Year Prep']
    },
    1: {
      month: 1,
      name: 'February',
      season: 'COOL_DRY',
      trailWeight: 1.5,
      beachWeight: 0.75,
      earlyHikeBoost: 1.2,
      eveningDiningBoost: 1.1,
      schoolBreak: false,
      events: ['Lunar New Year', 'Victoria Park Flower Market', 'Cherry Blossoms']
    },
    2: {
      month: 2,
      name: 'March',
      season: 'SPRING',
      trailWeight: 1.4,
      beachWeight: 0.9,
      earlyHikeBoost: 1.15,
      eveningDiningBoost: 1.05,
      schoolBreak: false,
      events: ['Hong Kong Sevens', 'Art Basel', 'Tai Mo Shan Flora']
    },
    3: {
      month: 3,
      name: 'April',
      season: 'SPRING',
      trailWeight: 1.35,
      beachWeight: 1.05,
      earlyHikeBoost: 1.15,
      eveningDiningBoost: 1.0,
      schoolBreak: false,
      events: ['Ching Ming Festival', 'Easter']
    },
    4: {
      month: 4,
      name: 'May',
      season: 'HOT_SUMMER',
      trailWeight: 0.75,
      beachWeight: 1.45,
      earlyHikeBoost: 1.25,
      eveningDiningBoost: 1.0,
      schoolBreak: false,
      events: ['Labour Day', 'Buddha Birthday', 'Early Beach Shift']
    },
    5: {
      month: 5,
      name: 'June',
      season: 'HOT_SUMMER',
      trailWeight: 0.7,
      beachWeight: 1.55,
      earlyHikeBoost: 1.25,
      eveningDiningBoost: 1.0,
      schoolBreak: false,
      events: ['Dragon Boat Festival', 'Summer Beaches & Waterfalls']
    },
    6: {
      month: 6,
      name: 'July',
      season: 'HOT_SUMMER',
      trailWeight: 0.65,
      beachWeight: 1.6,
      earlyHikeBoost: 1.25,
      eveningDiningBoost: 1.0,
      schoolBreak: true,
      events: ['HKSAR Day', 'Book Fair', 'Ani-Com', 'Summer School Break']
    },
    7: {
      month: 7,
      name: 'August',
      season: 'HOT_SUMMER',
      trailWeight: 0.65,
      beachWeight: 1.6,
      earlyHikeBoost: 1.25,
      eveningDiningBoost: 1.0,
      schoolBreak: true,
      events: ['Peak Typhoon Season', 'Summer School Break', 'Beaches']
    },
    8: {
      month: 8,
      name: 'September',
      season: 'LATE_SUMMER',
      trailWeight: 0.8,
      beachWeight: 1.45,
      earlyHikeBoost: 1.2,
      eveningDiningBoost: 1.05,
      schoolBreak: false,
      events: ['Mid-Autumn Festival', 'Tai Hang Fire Dragon']
    },
    9: {
      month: 9,
      name: 'October',
      season: 'COOL_DRY',
      trailWeight: 1.5,
      beachWeight: 1.15,
      earlyHikeBoost: 1.2,
      eveningDiningBoost: 1.1,
      schoolBreak: false,
      events: ['National Day Golden Week', 'Chung Yeung Festival', 'Wine & Dine']
    },
    10: {
      month: 10,
      name: 'November',
      season: 'COOL_DRY',
      trailWeight: 1.65,
      beachWeight: 0.9,
      earlyHikeBoost: 1.25,
      eveningDiningBoost: 1.15,
      schoolBreak: false,
      events: ['Sunset Peak Silvergrass', 'Oxfam Trailwalker', 'TransLantau', 'Hairy Crab Season']
    },
    11: {
      month: 11,
      name: 'December',
      season: 'COOL_DRY',
      trailWeight: 1.55,
      beachWeight: 0.75,
      earlyHikeBoost: 1.2,
      eveningDiningBoost: 1.15,
      schoolBreak: false,
      events: ['WinterFest', 'Christmas Shopping', 'Lantau Sunrise Hikes']
    }
  });

  const HIKING_TRAIL_KEYWORDS = [
    'pak kung au', 'nam shan', 'tai mo shan', 'peak', 'dragon',
    'lantau', 'mui wo', 'tai o', 'sai kung',
    '伯公坳', '南山', '大帽山', '山頂', '龍脊', '大嶼山', '梅窩', '大澳', '西貢'
  ];

  const BEACH_WATERFALL_KEYWORDS = [
    'shek o', 'repulse bay', 'pui o', 'cheung sha', 'tong fuk',
    'silvermine', 'ng tung chai', "bride's pool", 'brides pool',
    'stanley', 'big wave bay', 'waterfall', 'beach', 'sai kung', 'mui wo',
    '石澳', '淺水灣', '貝澳', '長沙', '塘福', '銀礦灣', '梧桐寨', '新娘潭', '赤柱', '大浪灣', '泳灘'
  ];

  const SUNDAY_URBAN_GATHERING_KEYWORDS = [
    'central', 'admiralty', 'causeway bay', 'mong kok',
    '中環', '金鐘', '銅鑼灣', '旺角'
  ];

  const AIRPORT_BORDER_KEYWORDS = [
    'airport', 'tung chung', 'hzmb', 'hong kong port', 'asiaworld', 'expo',
    'lok ma chau', 'shenzhen bay', 'heung yuen wai', 'border', 'boundary',
    '機場', '東涌', '港珠澳', '香港口岸', '博覽館', '落馬洲', '深圳灣', '香園圍', '口岸'
  ];

  const SCHOOL_DISMISSAL_KEYWORDS = [
    'kowloon tong', 'ho man tin', 'mid-levels', 'mid levels', 'pok fu lam', 'waterloo road',
    '九龍塘', '何文田', '半山', '薄扶林', '窩打老道'
  ];

  const SCHOOL_DISTRICT_ROUTE_RE = /^(103|113|170|271|281A|208|7|7B|8|17|18|23|23B|40M|45|109|970)$/i;
  const AIRPORT_BORDER_ROUTE_RE = /^(A\d+|E\d+|B\d+)[A-Z]?$/i;

  function _matchesAny(text, keywords) {
    if (!text) return false;
    for (let i = 0; i < keywords.length; i++) {
      if (text.includes(keywords[i])) return true;
    }
    return false;
  }

  /**
   * Computes a seasonal & structural corridor demand multiplier for Hong Kong bus load inference.
   *
   * @param {Object} params
   * @param {number} params.month - 0 (Jan) through 11 (Dec)
   * @param {'weekday'|'saturday'|'sunday'|'holiday'|'weekend'} params.dayType
   * @param {number} params.hourFloat - Local HK hour as float (e.g. 15.5 = 15:30)
   * @param {string} [params.corridorText] - Combined origin/destination/stop/route text
   * @param {string} [params.routeNo] - Optional route number (e.g. '3M', 'E36', 'A33', 'B1', '103')
   * @param {boolean} [params.isEveOfHoliday] - True when tomorrow is an HK public holiday
   * @param {boolean} [params.isSchoolHoliday] - True during non-summer school breaks (e.g. Easter/Christmas/LNY)
   * @returns {number}
   */
  function getSeasonalCorridorMultiplier(params) {
    const p = params && typeof params === 'object' ? params : {};
    const rawMonth = Number.isFinite(Number(p.month)) ? Number(p.month) : 0;
    const month = ((Math.floor(rawMonth) % 12) + 12) % 12;
    const profile = MONTHLY_ACTIVITY_PROFILES[month] || MONTHLY_ACTIVITY_PROFILES[0];

    const dayType = String(p.dayType || 'weekday').trim().toLowerCase();
    const hourFloat = Number.isFinite(Number(p.hourFloat)) ? Number(p.hourFloat) : 12;
    const corridorText = String(p.corridorText || '').toLowerCase();
    const routeNo = String(p.routeNo || '').trim().toUpperCase();
    const isEveOfHoliday = Boolean(p.isEveOfHoliday);
    const isSchoolHoliday = Boolean(p.isSchoolHoliday);

    const isWeekendOrHoliday =
      dayType === 'saturday' ||
      dayType === 'sunday' ||
      dayType === 'holiday' ||
      dayType === 'weekend';
    const isCoolMonth = month >= 9 || month <= 3; // Oct–Apr
    const isHotSummerMonth = month >= 4 && month <= 8; // May–Sep

    const isTrailCorridor = _matchesAny(corridorText, HIKING_TRAIL_KEYWORDS);
    const isBeachWaterfallCorridor = _matchesAny(corridorText, BEACH_WATERFALL_KEYWORDS);
    const isSundayUrbanCorridor = _matchesAny(corridorText, SUNDAY_URBAN_GATHERING_KEYWORDS);
    const isAirportBorderCorridor =
      _matchesAny(corridorText, AIRPORT_BORDER_KEYWORDS) ||
      (routeNo !== '' && AIRPORT_BORDER_ROUTE_RE.test(routeNo)) ||
      /\b(a\d+|e\d+|b\d+)[a-z]?\b/i.test(corridorText);
    const isSchoolCorridor =
      _matchesAny(corridorText, SCHOOL_DISMISSAL_KEYWORDS) ||
      (routeNo !== '' && SCHOOL_DISTRICT_ROUTE_RE.test(routeNo));

    let multiplier = 1.0;

    // 1. Peak hiking/trail vs Summer beach/waterfall/early-slot seasonal shift (weekends & holidays)
    if (isWeekendOrHoliday) {
      if (isCoolMonth && isTrailCorridor) {
        multiplier = Math.max(multiplier, profile.trailWeight);
      } else if (isHotSummerMonth) {
        if (isBeachWaterfallCorridor && hourFloat >= 8.5 && hourFloat <= 19.5) {
          multiplier = Math.max(multiplier, profile.beachWeight);
        } else if (isTrailCorridor) {
          if (hourFloat >= 5.5 && hourFloat < 8.5) {
            // Summer dawn hikers start early to avoid midday heat
            multiplier = Math.max(multiplier, profile.earlyHikeBoost || 1.25);
          } else if (hourFloat >= 10.0 && hourFloat <= 18.0) {
            // Exposed ridges dampen sharply during hot summer afternoons
            multiplier = Math.min(multiplier, profile.trailWeight);
          }
        }
      }
    }

    // 2. Sunday urban gathering modifier (08:00–18:00)
    if (dayType === 'sunday' && hourFloat >= 8.0 && hourFloat <= 18.0 && isSundayUrbanCorridor) {
      multiplier = Math.max(multiplier, 1.35);
    }

    // 3. Eve-of-holiday airport/Lantau/border exodus (17:00–21:00)
    if (isEveOfHoliday && hourFloat >= 17.0 && hourFloat <= 21.0 && isAirportBorderCorridor) {
      multiplier = Math.max(multiplier, 1.8);
    }

    // 4. Weekday school dismissal micro-rush (14:30–16:00, excluding Jul–Aug & school holidays)
    const isSummerSchoolBreak = month === 6 || month === 7 || profile.schoolBreak;
    if (
      dayType === 'weekday' &&
      !isSummerSchoolBreak &&
      !isSchoolHoliday &&
      hourFloat >= 14.5 &&
      hourFloat <= 16.0 &&
      isSchoolCorridor
    ) {
      multiplier = Math.max(multiplier, 1.55);
    }

    return Number(multiplier.toFixed(3));
  }

  const MonthlyActivityEngine = {
    MONTHLY_ACTIVITY_PROFILES,
    HIKING_TRAIL_KEYWORDS,
    BEACH_WATERFALL_KEYWORDS,
    SUNDAY_URBAN_GATHERING_KEYWORDS,
    AIRPORT_BORDER_KEYWORDS,
    SCHOOL_DISMISSAL_KEYWORDS,
    getSeasonalCorridorMultiplier
  };

  if (root) {
    root.MONTHLY_ACTIVITY_PROFILES = MONTHLY_ACTIVITY_PROFILES;
    root.getSeasonalCorridorMultiplier = getSeasonalCorridorMultiplier;
    root.MonthlyActivityEngine = MonthlyActivityEngine;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      MONTHLY_ACTIVITY_PROFILES,
      HIKING_TRAIL_KEYWORDS,
      BEACH_WATERFALL_KEYWORDS,
      SUNDAY_URBAN_GATHERING_KEYWORDS,
      AIRPORT_BORDER_KEYWORDS,
      SCHOOL_DISMISSAL_KEYWORDS,
      getSeasonalCorridorMultiplier,
      MonthlyActivityEngine
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
