import { Callout } from '../components/ui/alert';
import { Button } from '../components/ui/button';

/** After a coding folder goes to the Trash: where it went, Show in Trash and a way to dismiss. */
export function TrashNotice({ notice, onDismiss, iconDismiss = false }: { notice: string; onDismiss: () => void; iconDismiss?: boolean }) {
  return (
    <Callout layout="row" size="sm" className="wb-insp-callout" role="status">
      <p>{notice}</p>
      <Button variant="secondary" size="sm" type="button" onClick={() => void window.electronAPI.codingFolders.showTrash()}>
        Show in Trash
      </Button>
      <Button variant="secondary" size="sm" type="button" aria-label={iconDismiss ? 'Dismiss' : undefined} onClick={onDismiss}>
        {iconDismiss ? '✕' : 'Dismiss'}
      </Button>
    </Callout>
  );
}
