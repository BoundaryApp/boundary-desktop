import React, { useCallback, useEffect, useState } from 'react';
import { MENTIONS_FORMAT } from '../../../shared/circleMentions';
import type { CircleNotifyLevel, CircleNotifyPrefs, CircleSnapshot } from '../../../shared/types/circles';
import { Segmented } from '../../components/ui/segmented';
import { announceNotifyPrefs } from './useCircleChat';
import { Switch } from '../../components/ui/switch';

const api = () => window.electronAPI.circles;

interface NotifyState {
  prefs: CircleNotifyPrefs;
  resolved: 'all' | 'mentions' | 'nothing';
  people: number;
}

export const NOTIFY_LEVELS = [
  { value: 'default', label: 'Default' },
  { value: 'all', label: 'All' },
  { value: 'mentions', label: 'Mentions' },
  { value: 'nothing', label: 'Nothing' },
] as const;

/**
 * This device's notification preferences for one Circle, read from main while `enabled`, and a
 * save that tells every reader. The Circle tab's section and a Circle row's menu both use it.
 */
export function useCircleNotifyPrefs(circle: CircleSnapshot, enabled = true) {
  const [state, setState] = useState<NotifyState | null>(null);
  const count = circle.members.length;

  // The default level depends on the people count, so a join or leave asks again.
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void api()
      .notifyPrefs({ key: circle.key })
      .then((next) => {
        if (live) setState({ prefs: next.prefs, resolved: next.resolved, people: next.people });
      });
    return () => {
      live = false;
    };
  }, [circle.key, count, enabled]);

  const save = useCallback(
    (prefs: CircleNotifyPrefs) => {
      void Promise.resolve(api().setNotifyPrefs({ key: circle.key, prefs })).then(() => {
        announceNotifyPrefs(circle.key);
        return api()
          .notifyPrefs({ key: circle.key })
          .then((next) => setState({ prefs: next.prefs, resolved: next.resolved, people: next.people }));
      });
    },
    [circle.key],
  );
  return { state, save };
}

/** This device's notification level for one Circle, and whether @channel counts as a mention of the user. */
export const CircleNotifySection: React.FC<{ circle: CircleSnapshot }> = ({ circle }) => {
  const { state, save } = useCircleNotifyPrefs(circle);

  if (!state) return null;
  const { prefs } = state;
  const needsUpdate = state.resolved === 'mentions' && circle.format < MENTIONS_FORMAT ? 'Mentions need this Circle updated by an admin.' : null;
  const help =
    prefs.level === 'default'
      ? `Default: ${state.resolved === 'mentions' ? 'mentions only' : 'all messages'}, because this Circle has ${state.people} people.` +
        (needsUpdate ? ` ${needsUpdate}` : '')
      : needsUpdate;
  return (
    <>
      <h3 className="wb-circle-insp-head">Notifications</h3>
      <Segmented<CircleNotifyLevel>
        aria-label="Notifications"
        value={prefs.level}
        onChange={(level) => save({ ...prefs, level })}
        options={[...NOTIFY_LEVELS]}
      />
      {help ? <p className="wb-circle-insp-note">{help}</p> : null}
      <div className="wb-circle-insp-row">
        <span className="wb-circle-insp-copy">
          <span>@channel notifies me</span>
          <small>When someone mentions #channel, treat it as a mention of you.</small>
        </span>
        <Switch
          checked={prefs.channelMentions}
          label="@channel notifies me"
          onChange={(channelMentions) => save({ ...prefs, channelMentions })}
        />
      </div>
    </>
  );
};
