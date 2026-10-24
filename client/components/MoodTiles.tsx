import { MOODS, moodUrl, type Mood } from './moods';
import { navigate } from '../lib/router';
import '../styles/browse.css';

function MoodTile({ m }: { m: Mood }) {
  return (
    <button className="mood" style={{ ['--h' as string]: m.hue }} onClick={() => navigate(moodUrl(m))}>
      <span className="mood-title">{m.title}</span>
      <span className="mood-sub">{m.sub}</span>
    </button>
  );
}

/** All the moods as a grid (Search) or, with `limit`, the first few for a rail on Home. */
export function MoodTiles({ limit }: { limit?: number }) {
  const list = limit ? MOODS.slice(0, limit) : MOODS;
  return <>{list.map((m) => <MoodTile key={m.key} m={m} />)}</>;
}
