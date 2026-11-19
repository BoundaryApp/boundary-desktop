import { useEffect, useState } from 'react';

export interface DesktopAgentSwitch {
  /** Whether this platform has the desktop button (macOS, ADR 0058 §16). */
  available: boolean;
  on: boolean;
  /** **Hide button** was chosen; Settings or the Window menu brings it back (§5). */
  hidden: boolean;
  /** The shortcut that toggles the panel from any app, or null for none (§11). */
  shortcut: string | null;
}

/** **Keep the agent button on the desktop** and whether the button is hidden, kept current. Off until main answers. */
export function useDesktopAgentSwitch(): DesktopAgentSwitch {
  const [state, setState] = useState<DesktopAgentSwitch>({ available: false, on: false, hidden: false, shortcut: null });
  useEffect(() => {
    let live = true;
    const api = window.electronAPI.desktopAgent;
    void Promise.resolve()
      .then(() => api.get())
      .then((next) => {
        if (live && next) {
          setState({
            available: next.available,
            on: next.on,
            hidden: next.hidden === true,
            shortcut: typeof next.shortcut === 'string' ? next.shortcut : null,
          });
        }
      })
      .catch((): void => undefined);
    const stopOn = api.onChanged?.((on) => setState((was) => ({ ...was, on })));
    const stopHidden = api.onHiddenChanged?.((hidden) => setState((was) => ({ ...was, hidden })));
    return () => {
      live = false;
      stopOn?.();
      stopHidden?.();
    };
  }, []);
  return state;
}
