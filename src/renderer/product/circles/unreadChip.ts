export interface RowRect {
  top: number;
  bottom: number;
}

export interface HiddenUnread {
  count: number;
  direction: 'down' | 'up';
  /** Index into the rows passed in: the nearest hidden row in `direction`. */
  target: number;
}

/**
 * Which unread rows lie outside a scroller's view. A row is hidden below when its vertical midpoint
 * is past the view's bottom, above when it is before the view's top. Rows below win: the chip counts
 * and points at them, and only points up when none are below.
 */
export function hiddenUnread(rows: readonly RowRect[], view: RowRect): HiddenUnread | null {
  const below: number[] = [];
  const above: number[] = [];
  rows.forEach((row, index) => {
    const mid = (row.top + row.bottom) / 2;
    if (mid > view.bottom) below.push(index);
    else if (mid < view.top) above.push(index);
  });
  if (below.length) return { count: below.length, direction: 'down', target: below[0] };
  if (above.length) return { count: above.length, direction: 'up', target: above[above.length - 1] };
  return null;
}
