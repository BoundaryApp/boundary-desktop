/**
 * Whether a URL is the app's own renderer page. A packaged build loads one file, so only that
 * file matches; the dev server matches by origin.
 */
export function appUrlMatcher(appUrl: URL): (url: string) => boolean {
  return (url) => {
    try {
      const target = new URL(url);
      if (appUrl.protocol === 'file:') {
        return target.protocol === 'file:' && target.pathname === appUrl.pathname;
      }
      return target.origin === appUrl.origin;
    } catch {
      return false;
    }
  };
}
