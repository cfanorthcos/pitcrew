// Inline SVG icons for the kiosk, in one place so stroke weight and grid stay
// consistent. All are drawn on a 24px grid with 1.6–2.2 stroke, rounded caps,
// and paint with `currentColor` unless a colour is passed — so an icon inherits
// whatever the surrounding row or pill is already using.
//
// Drawn rather than emoji: an emoji renders as somebody else's artwork at
// somebody else's weight, changes between OS versions, and cannot be recoloured
// to match a status.

const svg = (size, body, color) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true"${
    color ? ` style="color:${color}"` : ''
  }>${body}</svg>`;

const CAR_BODY = `
  <path d="M4 16.5v2.2a.8.8 0 00.8.8h1.9a.8.8 0 00.8-.8v-1.2M20 16.5v2.2a.8.8 0 01-.8.8h-1.9a.8.8 0 01-.8-.8v-1.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M3.6 16.5h16.8a.6.6 0 00.6-.6v-3.1c0-1-.7-1.9-1.7-2.1l-1.5-.3-1.7-3.3a2 2 0 00-1.8-1.1H9.7a2 2 0 00-1.8 1.1L6.2 10.4l-1.5.3c-1 .2-1.7 1.1-1.7 2.1v3.1c0 .3.3.6.6.6z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  <path d="M7 13.4h1.4M15.6 13.4H17" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`;

const BAG_BODY = `
  <path d="M5.6 8.5h12.8l1 11a1.4 1.4 0 01-1.4 1.5H6a1.4 1.4 0 01-1.4-1.5l1-11z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  <path d="M8.8 8.5V6.8a3.2 3.2 0 016.4 0v1.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`;

const CLOCK_BODY = `
  <circle cx="12" cy="12.6" r="8.4" stroke="currentColor" stroke-width="1.7"/>
  <path d="M12 8.2v4.6l3 1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;

const WARN_BODY = `
  <path d="M12 9v4.4M12 16.8v.2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
  <path d="M10.4 4.2L2.9 17.5c-.6 1.1.2 2.5 1.5 2.5h15.2c1.3 0 2.1-1.4 1.5-2.5L13.6 4.2c-.7-1.2-2.5-1.2-3.2 0z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`;

const CHECK_BODY = `<path d="M5.5 12.5l4.2 4.2L18.5 7.5" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;

const CHEVRON_BODY = `<path d="M9.5 5.5L16 12l-6.5 6.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;

const PLUS_BODY = `<path d="M12 5.5v13M5.5 12h13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`;

// Sliders rather than a cog: the admin screens are settings and records, and a
// cog reads as "device settings" on an iPad, which is the one place a driver
// should never end up.
const SLIDERS_BODY = `
  <path d="M4 7.5h10M18 7.5h2M4 16.5h2M10 16.5h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="16" cy="7.5" r="2.3" stroke="currentColor" stroke-width="1.8"/>
  <circle cx="8" cy="16.5" r="2.3" stroke="currentColor" stroke-width="1.8"/>`;

export const icon = {
  car: (size = 32, color) => svg(size, CAR_BODY, color),
  bag: (size = 32, color) => svg(size, BAG_BODY, color),
  clock: (size = 32, color) => svg(size, CLOCK_BODY, color),
  warning: (size = 15, color) => svg(size, WARN_BODY, color),
  check: (size = 24, color) => svg(size, CHECK_BODY, color),
  chevron: (size = 22, color) => svg(size, CHEVRON_BODY, color),
  plus: (size = 26, color) => svg(size, PLUS_BODY, color),
  sliders: (size = 22, color) => svg(size, SLIDERS_BODY, color),
};
