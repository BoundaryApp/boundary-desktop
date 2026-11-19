/**
 * The Circles rail from fixture data, for check.mjs. `?theme=light` picks the light palette.
 * The check drives it through `window.__rail`, so no control changes the layout being measured.
 */
import React, { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { CircleChannel, CircleSnapshot } from '../../src/shared/types/circles';
import { CircleAreaHeader } from '../../src/renderer/product/circles/CircleAreaHeader';
import { CirclesDock } from '../../src/renderer/product/circles/CirclesDock';
import { CirclesRail } from '../../src/renderer/product/circles/CirclesRail';
import { AREA_MIN_PX, DOCK_MIN_PX, ROW_PX, saveDockHeight } from '../../src/renderer/product/circles/dockHeight';
import { useScrollToTopOn } from '../../src/renderer/product/circles/useScrollToTopOn';
import '../../src/index.css';
import '../../src/renderer/product/chat/workbench.css';
import '../../src/renderer/product/circles/circles.css';
import '../../src/renderer/product/chat/circle/circleChat.css';

if (new URLSearchParams(window.location.search).get('theme') === 'light') {
  document.documentElement.dataset.theme = 'light';
}
document.documentElement.dataset.platform = 'darwin';

const COUNT = 25;
const pad = (n: number) => String(n).padStart(2, '0');
const heavy = (index: number) => index % 2 === 0;

const circles: CircleSnapshot[] = Array.from({ length: COUNT }, (_, index) => ({
  key: pad(index + 1).repeat(32).slice(0, 64),
  name: `Circle ${pad(index + 1)} ${heavy(index) ? 'garden plots and the shared shed' : 'book club'}`,
  myRole: 'admin',
  members: [],
  invites: [],
  offers: [],
  needsUpdate: false,
  writable: true,
  format: 3,
}));

const channelCount = (index: number) => (heavy(index) ? 5 : 2);
const folderCount = (index: number) => (heavy(index) ? 3 : 0);

declare global {
  interface Window {
    __rail: {
      limits: { rowPx: number; dockMinPx: number; areaMinPx: number };
      openCircle: (index: number) => void;
      markOpenRead: () => void;
      addUnread: (index: number) => void;
      setHeight: (px: number | null) => void;
      /** Sets the dock height the person wants, as a drag would have kept it, and remounts the rail. */
      setWanted: (px: number) => void;
    };
  }
}

const Sections: React.FC<{ index: number }> = ({ index }) => (
  <>
    <div className="wb-sect is-sub">
      <span className="wb-sect-name">Channels</span>
    </div>
    {Array.from({ length: channelCount(index) }, (_, c) => (
      <button key={c} type="button" className={`wb-row has-mark${c === 0 ? ' is-on' : ''}`}>
        <span className="wb-row-title">{c === 0 ? 'General' : `Channel ${c + 1}`}</span>
      </button>
    ))}
    <div className="wb-sect is-sub">
      <span className="wb-sect-name">Direct messages</span>
    </div>
    {Array.from({ length: heavy(index) ? 2 : 1 }, (_, d) => (
      <button key={d} type="button" className="wb-row has-mark wb-direct-row">
        <span className="wb-row-title">Person {d + 1}</span>
      </button>
    ))}
    <div className="wb-sect is-sub">
      <span className="wb-sect-name">Folders</span>
    </div>
    {folderCount(index) === 0 ? (
      <button type="button" className="wb-row has-mark wb-folder-share-row">
        <span className="wb-row-title">Share a folder…</span>
      </button>
    ) : (
      Array.from({ length: folderCount(index) }, (_, f) => (
        <button key={f} type="button" className="wb-row has-mark">
          <span className="wb-row-title">Folder {f + 1}</span>
        </button>
      ))
    )}
  </>
);

const App: React.FC = () => {
  const [open, setOpen] = useState(0);
  const [unread, setUnread] = useState<number[]>(() => Array(COUNT).fill(0));
  const [height, setHeight] = useState<number | null>(null);
  const [railKey, setRailKey] = useState(0);
  const sectionsRef = useRef<HTMLDivElement>(null);
  useScrollToTopOn(sectionsRef, open);

  useEffect(() => {
    window.__rail = {
      limits: { rowPx: ROW_PX, dockMinPx: DOCK_MIN_PX, areaMinPx: AREA_MIN_PX },
      openCircle: (index) => flushSync(() => setOpen(index)),
      markOpenRead: () => flushSync(() => setUnread((was) => was.map((n, i) => (i === open ? 0 : n)))),
      addUnread: (index) => flushSync(() => setUnread((was) => was.map((n, i) => (i === index ? n + 1 : n)))),
      setHeight: (px) => flushSync(() => setHeight(px)),
      setWanted: (px) => {
        saveDockHeight(px);
        flushSync(() => setRailKey((was) => was + 1));
      },
    };
  });

  const channels: Record<string, CircleChannel[]> = {};
  circles.forEach((circle, index) => {
    channels[circle.key] = [{ id: 'general', name: 'General', unread: unread[index], mentioned: false }];
  });

  return (
    <div className="workbench" style={{ display: 'flex', height: height ?? '100vh', width: '100vw', background: 'var(--surface-0, var(--bg))' }}>
      <CirclesRail
        key={railKey}
        area={
          <>
            <CircleAreaHeader circle={circles[open]} onAction={() => undefined} />
            <div ref={sectionsRef} className="wb-circle-area-sections" role="group" aria-label={`${circles[open].name} channels, direct messages and folders`}>
              <Sections index={open} />
            </div>
          </>
        }
        dock={
          <CirclesDock
            circles={circles}
            channels={channels}
            openKey={circles[open].key}
            onOpenCircle={(key) => setOpen(circles.findIndex((c) => c.key === key))}
            onCircleAction={() => undefined}
            joiningOpen={false}
            onJoining={() => undefined}
            onStart={() => undefined}
            onJoin={() => undefined}
          />
        }
      />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
