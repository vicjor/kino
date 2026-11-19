import type { ReceiverInfo } from '../../../server/types.js';
import { Tile } from './Tile';
import type { CmdFn } from './shared';

/** The Cast Center's grid: placeholders while it looks around, a hint when there is nothing, else one tile per TV. */
export function DeviceGrid({ list, openId, onCmd, onOpen }: { list: ReceiverInfo[] | null; openId: string | null; onCmd: CmdFn; onOpen: (id: string, rect: DOMRect) => void }) {
  if (!list) return <div className="cc-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="cc-tile skeleton" style={{ ['--i' as string]: i }} />)}</div>;
  return (
    <>
      {!list.length ? <div className="cc-empty">No TVs on this network yet. Turn on the TV and it shows up here.</div> : null}
      <div className="cc-grid">
        {list.map((r, i) => <Tile key={r.id} r={r} idx={i} dimmed={openId != null && openId !== r.id} onCmd={onCmd} onOpen={(rect) => onOpen(r.id, rect)} />)}
      </div>
    </>
  );
}
