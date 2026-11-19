import React from 'react';
import { CallBar } from './CallBar';
import { useCallNames } from './useCallNames';
import { useCallService } from './useCallService';

const NamedCallBar: React.FC<{ floating?: boolean }> = ({ floating }) => {
  const names = useCallNames();
  return <CallBar floating={floating} names={names.person} />;
};

/**
 * The call bar with names from this user's Circles: at a rail's foot, or floating elsewhere.
 * Circles' state is read only while there is a call or a missed call to show.
 */
export const PlacedCallBar: React.FC<{ floating?: boolean }> = ({ floating }) => {
  const { call, missed } = useCallService();
  return call || missed ? <NamedCallBar floating={floating} /> : null;
};
