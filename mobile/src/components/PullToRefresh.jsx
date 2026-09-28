import { useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

const THRESHOLD = 64;

/**
 * Pull-to-refresh for a screen's scroll container. Touch-only (that is where
 * the gesture makes sense); the lists also refresh on their own via socket
 * events, so this is a convenience, never the only path.
 */
export default function PullToRefresh({ onRefresh, children, className = '' }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const startY = useRef(null);
  const scroller = useRef(null);

  const onTouchStart = (e) => {
    if (busy || startY.current != null) return;
    const el = scroller.current;
    if (el && el.scrollTop <= 0) startY.current = e.touches[0].clientY;
  };

  const onTouchMove = (e) => {
    if (startY.current == null || busy) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) {
      // Rubber-band: the further you pull the harder it gets.
      setPull(Math.min(110, dy * 0.45));
    }
  };

  const onTouchEnd = async () => {
    if (startY.current == null) return;
    startY.current = null;
    if (pull >= THRESHOLD) {
      setBusy(true);
      setPull(52);
      try { await onRefresh(); } finally {
        setBusy(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
  };

  return (
    <div
      ref={scroller}
      className={`overflow-y-auto overscroll-contain ${className}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div
        className="flex items-center justify-center overflow-hidden transition-[height] duration-150"
        style={{ height: pull }}
      >
        <LoaderCircle
          className={`h-5 w-5 text-brand ${busy ? 'animate-spin' : ''}`}
          style={{ opacity: busy ? 1 : Math.min(1, pull / THRESHOLD) }}
        />
      </div>
      {children}
    </div>
  );
}
