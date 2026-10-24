import { api, type StateRecovered, type StateRepaired } from '../lib/api';
import { toast } from '../lib/store';
import { fileName, repairedText, repairedTitle } from '../lib/state-notice';

/** A one-time callout about the state file. Dismiss tells the server (one endpoint clears either notice), and /health stops saying so. */
function StateNotice({ title, text, onDismissed }: { title: string; text: string; onDismissed: () => void }) {
  const dismiss = () => api.dismissRecovered().then(onDismissed).catch((e) => toast((e as Error).message, 'error'));
  return (
    <div className="callout" role="status">
      <strong>{title}</strong>
      <p>{text}</p>
      <button className="btn small" style={{ marginTop: 10 }} onClick={dismiss}>Dismiss</button>
    </div>
  );
}

/**
 * /health says Kino found its state file damaged and started fresh. Said once, in Settings and in the first-run
 * walkthrough (a fresh state is not set up, so that is where you land).
 */
export function RecoveredNotice({ recovered, onDismissed, why }: { recovered: StateRecovered; onDismissed: () => void; why?: string }) {
  return <StateNotice title="Settings were reset" text={`Kino found a damaged settings file and started fresh.${recovered.movedTo ? ` The old file was kept as ${fileName(recovered.movedTo)}.` : ''}${why ? ` ${why}` : ''}`} onDismissed={onDismissed} />;
}

/** /health says the last load repaired or pruned the state file: what it did and where the copy from before is. Said once, in Settings. */
export function RepairedNotice({ repaired, onDismissed }: { repaired: StateRepaired; onDismissed: () => void }) {
  return <StateNotice title={repairedTitle(repaired)} text={repairedText(repaired)} onDismissed={onDismissed} />;
}
