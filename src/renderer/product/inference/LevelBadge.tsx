import React from 'react';
import type { TrustLevel } from '../../../shared/types/confidential';
import { CONFIDENTIAL_COPY } from './confidentialCopy';

/** A provider's trust level as a lettered badge, with the level's name in its tooltip (spec decision 8). */
export const LevelBadge: React.FC<{ level: TrustLevel }> = ({ level }) => (
  <span className={`wb-conf-level is-${level.toLowerCase()}`} title={`Level ${level}: ${CONFIDENTIAL_COPY.levels[level].name}`}>
    {level}
  </span>
);
