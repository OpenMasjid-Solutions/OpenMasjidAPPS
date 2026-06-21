/*
 * config.js — runtime configuration.
 *
 * This default file ships inside the image. At container start the entrypoint
 * (docker-entrypoint.d/40-omos-config.sh) regenerates it from the environment
 * variables the masjid set when installing the app, so the values below are
 * only used for local development / preview.
 */
window.OMOS_CONFIG = {
  MASJID_NAME: 'Our Masjid',
  LATITUDE: '',
  LONGITUDE: '',
  CALC_METHOD: 'MWL',
  ASR_MADHAB: 'Standard',
  TIMEZONE: '',
  TIME_FORMAT: '12h',
  SCREEN_ORIENTATION: 'landscape',
  LANGUAGE: 'en',
};
