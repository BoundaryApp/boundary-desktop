import React from 'react';
import { Button } from '../../components/ui/button';
import { queueChipLabel, type QueuedPrompt } from './runQueue';

/**
 * Messages waiting to send, above the input (run-control spec 2.4–2.5): dashed while they
 * wait, solid amber once Stop paused them. The head offers Send now while a reply runs or
 * the queue is paused.
 */
export const QueueChips: React.FC<{
  items: QueuedPrompt[];
  paused: boolean;
  canSendHead: boolean;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}> = ({ items, paused, canSendHead, onSendNow, onEdit, onRemove }) => {
  if (items.length === 0) return null;
  return (
    <ul className="wb-queue" aria-label={paused ? 'Queued messages, paused' : 'Queued messages'}>
      {items.map((item, index) => (
        <li key={item.id} className={`wb-qchip${paused ? ' is-paused' : ''}`}>
          <span className="wb-qchip-label">{queueChipLabel(index, paused)}</span>
          <span className="wb-qchip-text" title={item.text}>
            {item.text}
          </span>
          {index === 0 && canSendHead ? (
            <Button type="button" variant="quiet" size="sm" onClick={() => onSendNow(item.id)}>
              Send now
            </Button>
          ) : null}
          <Button type="button" variant="quiet" size="sm" onClick={() => onEdit(item.id)}>
            Edit
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            aria-label="Remove from queue"
            onClick={() => onRemove(item.id)}
          >
            ×
          </Button>
        </li>
      ))}
    </ul>
  );
};
