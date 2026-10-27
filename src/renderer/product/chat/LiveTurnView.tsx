import React from 'react';
import type { HermesChatPhase, HermesProjectRecord } from '../../../shared/types/hermesChat';
import type { formatTurnStatsLine } from '../../../shared/hermesToolPaths';
import { SetupOfferCard } from './SetupOfferCard';
import { clearSetupOffer } from './setupOffers';
import { ToolCard, type ToolCardState } from './ToolCards';

/** After the transcript: the live turn's phase line and tool cards, a setup offer, the turn's stats. */
export const LiveTurnView: React.FC<{
  phase: HermesChatPhase;
  phaseLine: string;
  toolCards: ToolCardState[];
  onToggleTool: (toolId: string) => void;
  project: HermesProjectRecord | null;
  onNotice: (text: string) => void;
  /** The chat a setup offer was made in, or null for none. */
  setupOfferChatId: string | null;
  statsRows: ReturnType<typeof formatTurnStatsLine>;
}> = ({ phase, phaseLine, toolCards, onToggleTool, project, onNotice, setupOfferChatId, statsRows }) => (
  <>
    {phase === 'preparing' || phase === 'restarting' ? (
      <div className="wb-msg">
        <div className="wb-phase-line">
          <i className="wb-spin" aria-hidden />
          {phaseLine || 'Preparing…'}
        </div>
      </div>
    ) : null}

    {toolCards.length > 0 ? (
      <div className="wb-msg" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toolCards.map((card) => (
          <ToolCard
            project={project}
            onNotice={onNotice}
            key={card.toolId}
            card={card}
            onToggle={() => onToggleTool(card.toolId)}
          />
        ))}
      </div>
    ) : null}

    {setupOfferChatId ? (
      <div className="wb-msg">
        <SetupOfferCard onDismiss={() => clearSetupOffer(setupOfferChatId)} />
      </div>
    ) : null}

    {statsRows.length > 0 ? (
      <div className="wb-msg">
        <div className="wb-stats">
          {statsRows.map((row) => (
            <div key={row.label}>
              <b>{row.value}</b>
              {row.label}
            </div>
          ))}
        </div>
      </div>
    ) : null}
  </>
);
