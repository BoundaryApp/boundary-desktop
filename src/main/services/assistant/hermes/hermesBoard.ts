import { session, shell, type BrowserWindow, type WebContents } from 'electron';
import { persistDebugLog, serializeError } from '../../../persistDebugLog';
import type { KanbanBoardViewResult } from '../../../../shared/types/hermesKanban';
import { boardPath, browserUrlFor, isBoardUrl } from './hermesBoardLinks';
import { loginToDashboard } from './hermesDashboardAuth';
import { resolveDashboardHandoffSecret, resolveHermesStackEndpoints } from './hermesEndpoints';
import { currentBoardSlug, validTaskId } from './hermesKanban';

// Hermes's kanban board, shown two ways: embedded in the Tasks pane (a <webview> on its own
// session partition, signed in from main) and in the system browser (a one-time sign-in link
// when the stack has a handoff secret). The links, the code format and ?embed=1 are the stack's
// "Dashboard links" contract (docs/extending.md there; CR 0012 here).

/** The board's own cookie jar, so the dashboard session never mixes with the app's. */
export const BOARD_PARTITION = 'persist:hermes-board';

/** A failed sign-in is retried after this long, not on every navigation to /login. */
const REAUTH_INTERVAL_MS = 30_000;

function taskIdOrNull(taskId: unknown): string | null {
  return validTaskId(taskId) ? taskId : null;
}

/**
 * Sign the board partition in with the session a password sign-in gets. Main holds the
 * password; the page only ever sees the cookies. Skipped when the partition already has
 * dashboard cookies, unless `force` (the dashboard sent the view to /login).
 */
async function ensureBoardSession(dashboardBaseUrl: string, force = false): Promise<void> {
  const ses = session.fromPartition(BOARD_PARTITION);
  if (!force && (await ses.cookies.get({ url: dashboardBaseUrl })).length > 0) return;
  const login = await loginToDashboard();
  const nowS = Date.now() / 1000;
  for (const c of login.cookies) {
    await ses.cookies.set({
      url: dashboardBaseUrl,
      name: c.name,
      value: c.value,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      ...(c.maxAgeS === null ? {} : { expirationDate: nowS + c.maxAgeS }),
    });
  }
}

/** The signed-in board URL for the Tasks pane, opened on one task when given. */
export async function prepareBoardView(taskId: unknown): Promise<KanbanBoardViewResult> {
  const id = taskIdOrNull(taskId);
  const { dashboardBaseUrl } = resolveHermesStackEndpoints();
  try {
    await ensureBoardSession(dashboardBaseUrl);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'The board could not sign in.',
    };
  }
  const board = id ? await currentBoardSlug() : null;
  return {
    success: true,
    url: `${dashboardBaseUrl}${boardPath({ taskId: id, board, embed: true })}`,
    partition: BOARD_PARTITION,
  };
}

/** **Open in browser**: the board, or one task on it, signed in when the stack allows. */
export async function openBoardInBrowser(taskId: unknown): Promise<void> {
  const id = taskIdOrNull(taskId);
  const { dashboardBaseUrl } = resolveHermesStackEndpoints();
  const board = id ? await currentBoardSlug() : null;
  const next = boardPath({ taskId: id, board, embed: false });
  await shell.openExternal(
    browserUrlFor(dashboardBaseUrl, next, resolveDashboardHandoffSecret(), Math.floor(Date.now() / 1000))
  );
}

/** Send a URL the board view won't show to the system browser, signed in for dashboard pages. */
function openOutside(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  const { dashboardBaseUrl } = resolveHermesStackEndpoints();
  const target =
    u.origin === new URL(dashboardBaseUrl).origin
      ? browserUrlFor(
          dashboardBaseUrl,
          `${u.pathname}${u.search}`,
          resolveDashboardHandoffSecret(),
          Math.floor(Date.now() / 1000)
        )
      : url;
  void shell.openExternal(target).catch((): void => undefined);
}

/**
 * Keep an attached board view on the board. Hiding the dashboard's nav (?embed=1) doesn't
 * limit what its session can reach, so every other page, whether a link, a client-side route
 * or a new window, goes to the system browser instead.
 */
function guardBoardContents(contents: WebContents): void {
  const base = (): string => resolveHermesStackEndpoints().dashboardBaseUrl;
  let lastBoardUrl: string | null = null;
  let lastReauthAt = 0;

  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isBoardUrl(url, base())) return;
    event.preventDefault();
    openOutside(url);
  });

  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (isBoardUrl(url, base())) {
      lastBoardUrl = url;
      return;
    }
    openOutside(url);
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (lastBoardUrl) {
      contents.loadURL(lastBoardUrl).catch((error: unknown) => {
        persistDebugLog('kanban', 'board view could not return to the board', serializeError(error));
      });
    }
  });

  contents.on('did-navigate', (_event, url) => {
    if (isBoardUrl(url, base())) {
      lastBoardUrl = url;
      return;
    }
    // The dashboard sent the view to /login: the session lapsed or the stack's secret changed.
    // Sign in again and go back to the board, at most once per interval so a refused sign-in
    // leaves the login page showing instead of looping.
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      /* not a URL */
    }
    if (path !== '/login' || Date.now() - lastReauthAt < REAUTH_INTERVAL_MS) return;
    lastReauthAt = Date.now();
    const back = lastBoardUrl ?? `${base()}${boardPath({ embed: true })}`;
    void ensureBoardSession(base(), true)
      .then(() => contents.loadURL(back))
      .catch((): void => undefined);
  });
}

/**
 * Only the board may be embedded. A <webview> attaches only on the board partition, pointed at
 * the dashboard's board, with no preload and a sandbox, whatever the renderer asked for.
 */
export function installBoardWebviewGuards(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const { dashboardBaseUrl } = resolveHermesStackEndpoints();
    if (params.partition !== BOARD_PARTITION || !isBoardUrl(params.src, dashboardBaseUrl)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  win.webContents.on('did-attach-webview', (_event, contents) => guardBoardContents(contents));
}
