/*
 * prayer.js — original prayer-time calculation engine for OpenMasjidAPPS.
 *
 * Implements the standard astronomical method: it computes the sun's
 * declination and the equation of time (NOAA/USNO low-precision approximation,
 * accurate to well under a minute for this purpose), then solves the hour-angle
 * equation for each prayer's defining sun altitude. No third-party code is used;
 * this is an independent implementation of public-domain astronomy.
 *
 * All trig helpers operate in degrees. Times are returned as decimal hours on
 * the masjid's local civil clock (0..24).
 */

// --- Degree-based trigonometry helpers -------------------------------------
const dtr = (d) => (d * Math.PI) / 180;
const rtd = (r) => (r * 180) / Math.PI;
const dsin = (d) => Math.sin(dtr(d));
const dcos = (d) => Math.cos(dtr(d));
const dtan = (d) => Math.tan(dtr(d));
const darcsin = (x) => rtd(Math.asin(x));
const darccos = (x) => rtd(Math.acos(x));
const darctan2 = (y, x) => rtd(Math.atan2(y, x));
const darccot = (x) => rtd(Math.atan2(1, x));
const fixAngle = (a) => ((a % 360) + 360) % 360;
const fixHour = (h) => ((h % 24) + 24) % 24;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Calculation methods: Fajr/Isha depression angles, with a couple of special
// cases (Makkah uses a fixed interval after Maghrib; Tehran/Jafari define
// Maghrib by an angle rather than apparent sunset).
export const METHODS = {
  MWL: { label: 'Muslim World League', fajr: 18, isha: 17 },
  ISNA: { label: 'Islamic Society of North America', fajr: 15, isha: 15 },
  Egypt: { label: 'Egyptian General Authority', fajr: 19.5, isha: 17.5 },
  Makkah: { label: 'Umm al-Qura, Makkah', fajr: 18.5, ishaMinutes: 90 },
  Karachi: { label: 'University of Islamic Sciences, Karachi', fajr: 18, isha: 18 },
  Tehran: { label: 'Institute of Geophysics, Tehran', fajr: 17.7, maghrib: 4.5, isha: 14 },
  Jafari: { label: 'Shia Ithna-Ashari (Jafari)', fajr: 16, maghrib: 4, isha: 14 },
};

// Julian Day Number at 0h UT for a Gregorian calendar date.
function julian(year, month, day) {
  if (month <= 2) {
    year -= 1;
    month += 12;
  }
  const a = Math.floor(year / 100);
  const b = 2 - a + Math.floor(a / 4);
  return (
    Math.floor(365.25 * (year + 4716)) +
    Math.floor(30.6001 * (month + 1)) +
    day +
    b -
    1524.5
  );
}

// Sun's apparent declination (deg) and equation of time (hours) for a Julian date.
function sunPosition(jd) {
  const d = jd - 2451545.0; // days since the J2000.0 epoch
  const g = fixAngle(357.529 + 0.98560028 * d); // mean anomaly
  const q = fixAngle(280.459 + 0.98564736 * d); // mean longitude
  const L = fixAngle(q + 1.915 * dsin(g) + 0.02 * dsin(2 * g)); // ecliptic longitude
  const e = 23.439 - 0.00000036 * d; // obliquity of the ecliptic
  const ra = darctan2(dcos(e) * dsin(L), dcos(L)) / 15; // right ascension (hours)
  const declination = darcsin(dsin(e) * dsin(L));
  const equation = q / 15 - fixHour(ra); // equation of time (hours)
  return { declination, equation };
}

/**
 * Compute prayer times for a given civil date and location.
 *
 * @param {{year:number,month:number,day:number}} date  Civil date in the masjid's timezone.
 * @param {number} lat       Latitude in degrees (north positive).
 * @param {number} lng       Longitude in degrees (east positive).
 * @param {number} tz        UTC offset in hours for that date (DST-aware).
 * @param {string} methodKey Key into METHODS.
 * @param {string} asrMadhab 'Hanafi' uses shadow factor 2; anything else uses 1 (Standard).
 * @returns {{fajr:number,sunrise:number,dhuhr:number,asr:number,maghrib:number,isha:number,sunset:number}}
 *          Each value is decimal hours on the local clock.
 */
export function prayerTimes(date, lat, lng, tz, methodKey, asrMadhab) {
  const m = METHODS[methodKey] || METHODS.MWL;
  const jd = julian(date.year, date.month, date.day);
  // Evaluate the sun at local apparent noon for best accuracy.
  const { declination: decl, equation: eqt } = sunPosition(jd + 0.5 - lng / 360);

  const dhuhr = fixHour(12 - eqt) - lng / 15 + tz;

  // Hour offset (hours) from noon for the sun at a given depression angle below
  // the horizon (positive angle = below horizon).
  const depressionOffset = (angle) => {
    const x =
      (-dsin(angle) - dsin(lat) * dsin(decl)) / (dcos(lat) * dcos(decl));
    return darccos(clamp(x, -1, 1)) / 15;
  };

  // Hour offset for Asr, when an object's shadow equals its noon shadow plus
  // `shadow` times its height.
  const asrOffset = (shadow) => {
    const altitude = darccot(shadow + dtan(Math.abs(lat - decl)));
    const x =
      (dsin(altitude) - dsin(lat) * dsin(decl)) / (dcos(lat) * dcos(decl));
    return darccos(clamp(x, -1, 1)) / 15;
  };

  const sunrise = dhuhr - depressionOffset(0.833);
  const sunset = dhuhr + depressionOffset(0.833);
  const fajr = dhuhr - depressionOffset(m.fajr);
  const asr = dhuhr + asrOffset(asrMadhab === 'Hanafi' ? 2 : 1);
  const maghrib = m.maghrib != null ? dhuhr + depressionOffset(m.maghrib) : sunset;
  const isha =
    m.ishaMinutes != null
      ? maghrib + m.ishaMinutes / 60
      : dhuhr + depressionOffset(m.isha);

  return { fajr, sunrise, dhuhr, asr, maghrib, isha, sunset };
}

// UTC offset (hours) for a given instant in an IANA timezone — DST aware.
export function timezoneOffsetHours(instant, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = dtf.formatToParts(instant).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (asUTC - instant.getTime()) / 3600000;
  } catch {
    return -instant.getTimezoneOffset() / 60; // fall back to the host's zone
  }
}

// The masjid-local wall-clock parts for an instant in an IANA timezone.
export function localParts(instant, timeZone) {
  const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (timeZone) opts.timeZone = timeZone;
  const p = new Intl.DateTimeFormat('en-US', opts)
    .formatToParts(instant)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}
