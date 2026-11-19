import React from 'react';
import { Check, KeyRound, ListTodo, Mail, MoreHorizontal, Network, Pause, Users, Wallet, Workflow } from 'lucide-react';
import { cn } from '../../lib/utils';
import { STORE_CATEGORIES, type StoreItem, type StoreKey } from './storeItems';

const ICONS: Record<StoreKey, React.FC<{ className?: string }>> = {
  twenty: Users,
  actual: Wallet,
  bitwarden: KeyRound,
  email: Mail,
  vikunja: ListTodo,
  n8n: Workflow,
  lightrag: Network,
};

const SIZES = {
  sm: { box: 'size-8 rounded-lg', icon: 'size-4', mark: 'size-4', markIcon: 'size-2.5' },
  md: { box: 'size-11 rounded-xl', icon: 'size-5', mark: 'size-4', markIcon: 'size-2.5' },
  lg: { box: 'size-16 rounded-2xl', icon: 'size-8', mark: 'size-4', markIcon: 'size-2.5' },
  xl: { box: 'size-24 rounded-[24px]', icon: 'size-10', mark: 'size-6', markIcon: 'size-3.5' },
} as const;

/**
 * The entry's icon on its category's tint, with a corner mark for its state (store spec
 * decision 2). The store's cards and the Services screen's tiles both draw it.
 */
export const StoreTile: React.FC<{ item: StoreItem; size?: keyof typeof SIZES }> = ({ item, size = 'md' }) => {
  const Icon = ICONS[item.key];
  const hue = STORE_CATEGORIES[item.category].hue;
  const k = item.state.kind;
  const sz = SIZES[size];
  const mark =
    k === 'on' || k === 'restart'
      ? { icon: Check, className: 'bg-ok', label: 'Installed' }
      : k === 'start'
        ? { icon: Pause, className: 'bg-warn', label: 'Not running' }
        : k === 'installing' || k === 'removing'
          ? { icon: MoreHorizontal, className: 'bg-brand', label: 'Working' }
          : null;
  return (
    <span
      aria-hidden
      className={cn('relative grid shrink-0 place-items-center', sz.box)}
      style={{
        background: `hsl(${hue} var(--tile-s) var(--tile-l))`,
        color: `hsl(${hue} var(--tile-fs) var(--tile-fl))`,
      }}
    >
      <Icon className={sz.icon} />
      {mark ? (
        <span
          data-mark={mark.label}
          className={cn(
            'absolute -right-1 -bottom-1 grid place-items-center rounded-full text-surface-1 ring-2 ring-surface-1',
            sz.mark,
            mark.className
          )}
        >
          <mark.icon className={sz.markIcon} />
        </span>
      ) : null}
    </span>
  );
};

/** Install progress as a ring. */
export const Ring: React.FC<{ percent: number; className?: string }> = ({ percent, className = 'size-5' }) => {
  const c = 2 * Math.PI * 8;
  return (
    <svg viewBox="0 0 20 20" className={cn('-rotate-90', className)} aria-hidden>
      <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.5" className="stroke-line" />
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-brand"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - percent / 100)}
      />
    </svg>
  );
};
