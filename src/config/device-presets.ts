// ============================================================================
// Device presets for multi-viewport page capture
// ============================================================================

import type { Viewport } from 'puppeteer';

export interface DevicePreset {
  viewport: Viewport;
  userAgent: string;
}

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
// Desktop UA without "HeadlessChrome", which some sites block or serve differently.
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Viewports are CSS pixels; screenshots come out at width × deviceScaleFactor. */
export const DEVICE_PRESETS = {
  'iphone-17': {
    viewport: { width: 402, height: 874, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent: IOS_UA,
  },
  'galaxy-s24': {
    viewport: { width: 360, height: 780, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent: ANDROID_UA,
  },
  'ipad-pro-11': {
    viewport: { width: 834, height: 1210, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: IPAD_UA,
  },
  laptop: {
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    userAgent: DESKTOP_UA,
  },
  desktop: {
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    userAgent: DESKTOP_UA,
  },
} as const satisfies Record<string, DevicePreset>;

export type DevicePresetName = keyof typeof DEVICE_PRESETS;
export const DEVICE_PRESET_NAMES = Object.keys(DEVICE_PRESETS) as [DevicePresetName, ...DevicePresetName[]];
