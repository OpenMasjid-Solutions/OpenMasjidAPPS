/*
 * app.js — drives the full-screen prayer clock.
 *
 * Reads install-time configuration from window.OMOS_CONFIG (generated into
 * config.js at container start from the settings the masjid filled in), computes
 * today's prayer times locally, and keeps the clock, countdown, and "current
 * prayer" highlight live.
 */
import { prayerTimes, timezoneOffsetHours, localParts, METHODS } from './prayer.js';

const cfg = window.OMOS_CONFIG || {};
const config = {
  masjidName: cfg.MASJID_NAME || 'Our Masjid',
  latitude: parseFloat(cfg.LATITUDE),
  longitude: parseFloat(cfg.LONGITUDE),
  method: cfg.CALC_METHOD || 'MWL',
  asrMadhab: cfg.ASR_MADHAB || 'Standard',
  timezone: cfg.TIMEZONE || '', // empty => use the display device's own zone
  timeFormat: cfg.TIME_FORMAT === '24h' ? '24h' : '12h',
  orientation: cfg.SCREEN_ORIENTATION === 'portrait' ? 'portrait' : 'landscape',
  language: cfg.LANGUAGE || 'en',
};

const PRAYERS = [
  { key: 'fajr', label: 'Fajr' },
  { key: 'sunrise', label: 'Sunrise', minor: true },
  { key: 'dhuhr', label: 'Dhuhr' },
  { key: 'asr', label: 'Asr' },
  { key: 'maghrib', label: 'Maghrib' },
  { key: 'isha', label: 'Isha' },
];

const $ = (sel) => document.querySelector(sel);

// --- Formatting -------------------------------------------------------------
function pad(n) {
  return String(n).padStart(2, '0');
}

function formatClockTime(hours) {
  // hours: decimal local hours -> "h:mm AM" or "HH:mm"
  let total = Math.round(hours * 60);
  total = ((total % 1440) + 1440) % 1440;
  let h = Math.floor(total / 60);
  const m = total % 60;
  if (config.timeFormat === '24h') return `${pad(h)}:${pad(m)}`;
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return { time: `${h}:${pad(m)}`, period };
}

function gregorianDate(parts) {
  return new Intl.DateTimeFormat(config.language, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: config.timezone || undefined,
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
}

function hijriDate(parts) {
  try {
    return new Intl.DateTimeFormat(`${config.language}-u-ca-islamic-umalqura`, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
  } catch {
    return '';
  }
}

// --- Rendering --------------------------------------------------------------
function renderCards(times, activeKey, nextKey) {
  const grid = $('#prayer-grid');
  grid.innerHTML = '';
  for (const p of PRAYERS) {
    const card = document.createElement('div');
    card.className = 'prayer-card';
    if (p.minor) card.classList.add('minor');
    if (p.key === activeKey) card.classList.add('is-active');
    if (p.key === nextKey) card.classList.add('is-next');

    const t = formatClockTime(times[p.key]);
    const timeHtml =
      typeof t === 'string'
        ? `<span class="t">${t}</span>`
        : `<span class="t">${t.time}</span><span class="period">${t.period}</span>`;

    card.innerHTML = `
      <div class="prayer-name">${p.label}</div>
      <div class="prayer-time">${timeHtml}</div>
    `;
    grid.appendChild(card);
  }
}

let lastDayKey = '';
let cachedTimes = null;

function compute(now) {
  const parts = localParts(now, config.timezone);
  const dayKey = `${parts.year}-${parts.month}-${parts.day}`;

  if (dayKey !== lastDayKey) {
    // Recompute the day's table (also resolves the DST-aware tz offset).
    const tz = timezoneOffsetHours(now, config.timezone || undefined);
    cachedTimes = prayerTimes(parts, config.latitude, config.longitude, tz, config.method, config.asrMadhab);

    // Tomorrow's Fajr, so the "next prayer" after Isha rolls over correctly.
    const tomorrowInstant = new Date(now.getTime() + 86400000);
    const tParts = localParts(tomorrowInstant, config.timezone);
    const tTz = timezoneOffsetHours(tomorrowInstant, config.timezone || undefined);
    cachedTimes.tomorrowFajr = prayerTimes(tParts, config.latitude, config.longitude, tTz, config.method, config.asrMadhab).fajr;

    lastDayKey = dayKey;
    $('#masjid-name').textContent = config.masjidName;
    $('#gregorian-date').textContent = gregorianDate(parts);
    $('#hijri-date').textContent = hijriDate(parts);
    $('#method-note').textContent = `${METHODS[config.method]?.label || config.method} · Asr: ${config.asrMadhab}`;
  }
  return { parts, times: cachedTimes };
}

function findActiveAndNext(times, nowHours) {
  // Order of trackable prayers (sunrise is informational, not "current").
  const order = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  let activeKey = null;
  let nextKey = null;
  let nextHours = null;

  for (const key of order) {
    if (times[key] <= nowHours) activeKey = key;
  }
  for (const key of order) {
    if (times[key] > nowHours) {
      nextKey = key;
      nextHours = times[key];
      break;
    }
  }
  if (!nextKey) {
    // After Isha → next is tomorrow's Fajr.
    nextKey = 'fajr';
    nextHours = times.tomorrowFajr + 24;
    activeKey = 'isha';
  }
  if (!activeKey) {
    // Before Fajr → still "Isha" period from yesterday.
    activeKey = 'isha';
  }
  return { activeKey, nextKey, nextHours };
}

function tick() {
  const now = new Date();
  const { parts, times } = compute(now);
  const nowHours = parts.hour + parts.minute / 60 + parts.second / 3600;

  // Live clock
  const clock = formatClockTime(nowHours);
  if (typeof clock === 'string') {
    $('#clock-time').textContent = clock;
    $('#clock-period').textContent = '';
  } else {
    $('#clock-time').textContent = clock.time;
    $('#clock-period').textContent = clock.period;
  }

  const { activeKey, nextKey, nextHours } = findActiveAndNext(times, nowHours);
  renderCards(times, activeKey, nextKey);

  // Countdown to next prayer
  const remainingMin = (nextHours - nowHours) * 60;
  const h = Math.floor(remainingMin / 60);
  const mm = Math.floor(remainingMin % 60);
  const ss = Math.floor((remainingMin * 60) % 60);
  const label = PRAYERS.find((p) => p.key === nextKey)?.label || '';
  $('#next-label').textContent = label;
  $('#countdown').textContent =
    h > 0 ? `${h}h ${pad(mm)}m` : `${mm}m ${pad(ss)}s`;
}

function start() {
  document.documentElement.dataset.orientation = config.orientation;
  document.documentElement.lang = config.language;

  if (!Number.isFinite(config.latitude) || !Number.isFinite(config.longitude)) {
    $('#app').innerHTML =
      '<div class="setup-needed"><h1>Almost there</h1><p>This display needs the masjid’s latitude and longitude. Open the app’s settings in OpenMasjidOS and enter them, then restart the app.</p></div>';
    return;
  }

  tick();
  setInterval(tick, 1000);
}

start();
