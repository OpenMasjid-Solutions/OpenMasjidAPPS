/*
 * app.js — drives the full-screen announcements board.
 *
 * Reads install-time configuration from window.OMOS_CONFIG (generated into
 * config.js at container start), then rotates through the announcements the
 * masjid entered, with a live clock and an optional footer note.
 */
const cfg = window.OMOS_CONFIG || {};

const config = {
  masjidName: cfg.MASJID_NAME || 'Our Masjid',
  rotateSeconds: Math.max(4, parseInt(cfg.ROTATE_SECONDS, 10) || 12),
  footerNote: cfg.FOOTER_NOTE || '',
  showTime: cfg.SHOW_TIME !== 'false',
  timeFormat: cfg.TIME_FORMAT === '24h' ? '24h' : '12h',
  timezone: cfg.TIMEZONE || '',
  language: cfg.LANGUAGE || 'en',
};

// Gather the announcement slots (ANN1..ANN6) that actually have content.
const slides = [];
for (let i = 1; i <= 6; i++) {
  const title = (cfg[`ANN${i}_TITLE`] || '').trim();
  const body = (cfg[`ANN${i}_TEXT`] || '').trim();
  if (title || body) slides.push({ title, body });
}
if (slides.length === 0) {
  slides.push({
    title: 'Welcome',
    body: 'Add your announcements in this app’s settings in OpenMasjidOS, then restart it.',
  });
}

const $ = (s) => document.querySelector(s);
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- Clock ------------------------------------------------------------------
function updateClock() {
  if (!config.showTime) {
    $('#clock-wrap').style.display = 'none';
    return;
  }
  const now = new Date();
  const timeOpts = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: config.timeFormat !== '24h',
  };
  const dateOpts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (config.timezone) {
    timeOpts.timeZone = config.timezone;
    dateOpts.timeZone = config.timezone;
  }
  $('#clock').textContent = new Intl.DateTimeFormat(config.language, timeOpts).format(now);
  $('#today').textContent = new Intl.DateTimeFormat(config.language, dateOpts).format(now);
}

// --- Slides -----------------------------------------------------------------
function renderDots(active) {
  const dots = $('#dots');
  if (slides.length <= 1) {
    dots.style.display = 'none';
    return;
  }
  dots.innerHTML = '';
  slides.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'dot' + (i === active ? ' is-active' : '');
    dots.appendChild(d);
  });
}

let index = 0;

function showSlide(i, animate = true) {
  const slide = slides[i];
  const el = $('#slide');
  const apply = () => {
    $('#slide-title').textContent = slide.title;
    $('#slide-body').textContent = slide.body;
    $('#slide-eyebrow').style.display = slide.title ? '' : 'none';
    renderDots(i);
    el.classList.remove('leaving');
    el.classList.add('entering');
  };
  if (animate && !prefersReducedMotion && slides.length > 1) {
    el.classList.add('leaving');
    el.classList.remove('entering');
    setTimeout(apply, 320);
  } else {
    apply();
  }
}

function restartProgress() {
  const bar = $('#progress-bar');
  if (slides.length <= 1 || prefersReducedMotion) {
    bar.style.display = 'none';
    return;
  }
  bar.style.transition = 'none';
  bar.style.width = '0%';
  // Force reflow so the next transition restarts cleanly.
  void bar.offsetWidth;
  bar.style.transition = `width ${config.rotateSeconds}s linear`;
  bar.style.width = '100%';
}

function next() {
  index = (index + 1) % slides.length;
  showSlide(index);
  restartProgress();
}

function start() {
  document.documentElement.lang = config.language;
  $('#masjid-name').textContent = config.masjidName;
  $('#footer-note').textContent = config.footerNote;
  $('#footer-note').style.display = config.footerNote ? '' : 'none';

  updateClock();
  setInterval(updateClock, 1000);

  showSlide(0, false);
  restartProgress();
  if (slides.length > 1) setInterval(next, config.rotateSeconds * 1000);
}

start();
