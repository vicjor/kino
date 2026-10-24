import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';

/**
 * Kino has no colour of its own: the artwork on screen lights the page. The current picture, blown up and blurred far
 * past recognition, sits behind everything and fades out down the page, so the black and the glass take on the film's
 * colour, the way the Apple TV app lights a title. A new picture cross-fades in over the old; none fades it all out.
 */
export function Ambient() {
  const url = useStore((s) => s.ambient ?? null);
  const [layers, setLayers] = useState<string[]>(() => (url ? [url] : []));
  useEffect(() => {
    if (!url) return;
    setLayers((l) => [...l.filter((u) => u !== url).slice(-1), url]);
    const t = window.setTimeout(() => setLayers((l) => l.slice(-1)), 1000);   // the one underneath, once covered
    return () => window.clearTimeout(t);
  }, [url]);
  return (
    <div className={`ambient${url ? '' : ' off'}`} aria-hidden="true">
      {layers.map((u) => <div key={u} className="ambient-layer" style={{ backgroundImage: `url(${u})` }} />)}
    </div>
  );
}
