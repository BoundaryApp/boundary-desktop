import { useEffect, useState } from 'react';
import { CallCheck, electronCallCheckTransport } from './callCheck';

let instance: CallCheck | null = null;
let enabled: Promise<boolean> | null = null;

/**
 * The call transport check for this window, or null while it is off. The first caller starts it,
 * and from then on it answers other members' offers wherever the user is in the app.
 */
export function useCallCheck(): CallCheck | null {
  const [check, setCheck] = useState<CallCheck | null>(instance);
  useEffect(() => {
    if (instance) return;
    let live = true;
    enabled ??= window.electronAPI.circles.callCheckEnabled().catch(() => false);
    void enabled.then((on) => {
      if (!on || !live) return;
      instance ??= new CallCheck(electronCallCheckTransport);
      setCheck(instance);
    });
    return () => {
      live = false;
    };
  }, []);
  return check;
}

/** For tests: forget the instance and whether the check is on. */
export function resetCallCheckForTests(): void {
  instance?.dispose();
  instance = null;
  enabled = null;
}
