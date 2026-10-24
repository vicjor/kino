/** What this screen is called in the "Play on" list, from its user agent: "This iPhone", "This Mac". */
export function thisDeviceName(ua: string, touchPoints = 0): string {
  if (/iPhone|iPod/.test(ua)) return 'This iPhone';
  // iPadOS asks for desktop pages and says Macintosh; only the touch screen gives it away.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'This iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'This phone' : 'This tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return 'This Mac';
  return 'This computer';
}
