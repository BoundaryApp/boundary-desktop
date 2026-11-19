import React, { useState } from 'react';
import type { CircleSnapshot } from '../../../shared/types/circles';
import { CircleTile, ClockTile, JOINING_NAME } from './CirclesDock';
import { CircleRowMenu } from './CircleRowMenu';
import type { CircleAction } from './circlesNavigation';

export type CircleAreaHeaderProps =
  | { circle: CircleSnapshot; onAction: (action: CircleAction) => void }
  | { joining: true };

/**
 * The top of the Circle area: the open Circle's tile and name with the same ⋯ menu as its row in
 * the dock, or the joining page's clock and name, which has no menu.
 */
export const CircleAreaHeader: React.FC<CircleAreaHeaderProps> = (props) => {
  const [menuOpen, setMenuOpen] = useState(false);
  if ('joining' in props) {
    return (
      <div className="wb-circle-area-head">
        <ClockTile />
        <h2 className="wb-circle-area-name">{JOINING_NAME}</h2>
      </div>
    );
  }
  const { circle, onAction } = props;
  return (
    <div className="wb-circle-area-head">
      <CircleTile circle={circle} size={22} />
      <h2 className="wb-circle-area-name">{circle.name}</h2>
      <CircleRowMenu circle={circle} open={menuOpen} onOpenChange={setMenuOpen} onAction={onAction} />
    </div>
  );
};
