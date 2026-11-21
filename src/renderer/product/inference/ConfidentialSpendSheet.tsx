import React from 'react';
import { Button } from '../../components/ui/button';
import { formatTokenCount } from '../../../shared/utils/format';
import { Sheet } from '../../components/ui/sheet';
import {
  CONFIDENTIAL_COPY,
  formatSpendCost,
  formatUsd,
} from './confidentialCopy';
import { LevelBadge } from './LevelBadge';
import { useConfidentialSpend } from './useConfidentialSpend';

/** Turns, tokens and estimated cost per provider over the last 30 days (ADR 0047 phase 5). */
export const ConfidentialSpendSheet: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const { spend } = useConfidentialSpend(open);
  const copy = CONFIDENTIAL_COPY.spend;
  if (!open) return null;
  const withoutCounts =
    spend?.rows.reduce((sum, row) => sum + row.turnsWithoutCounts, 0) ?? 0;

  return (
    <Sheet
      open
      onClose={onClose}
      titleId="confidential-spend-title"
      backdropClassName="wb-conf-backdrop"
      title={copy.title}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {/* Main gives every added provider a row, so no turns, not no rows, is the empty case. */}
      {spend && spend.totalTurns === 0 ? <p>{copy.empty}</p> : null}
      {spend && spend.totalTurns > 0 ? (
        <>
          <table className="wb-conf-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Turns</th>
                <th>Tokens in</th>
                <th>Tokens out</th>
                <th>Estimated cost</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {spend.rows.map((row) => (
                <tr key={row.providerId}>
                  <td>
                    <LevelBadge level={row.level} /> {row.name}
                  </td>
                  <td>{row.turns}</td>
                  <td>{formatTokenCount(row.inputTokens)}</td>
                  <td>{formatTokenCount(row.outputTokens)}</td>
                  <td>{formatSpendCost(row.cost)}</td>
                  <td>
                    {row.removed
                      ? copy.removed
                      : row.balance === null
                        ? 'Not reported'
                        : formatUsd(row.balance)}
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <b>Total</b>
                </td>
                <td>{spend.totalTurns}</td>
                <td />
                <td />
                <td>
                  <b>{formatSpendCost(spend.totalCost)}</b>
                </td>
                <td />
              </tr>
            </tbody>
          </table>
          <p className="wb-conf-note">{copy.note}</p>
          {withoutCounts > 0 ? (
            <p className="wb-conf-note">{copy.noCounts(withoutCounts)}</p>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
};
