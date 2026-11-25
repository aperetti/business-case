import { useRef, type ReactNode } from 'react';

interface Props {
  active: boolean;
  children: ReactNode;
}

/**
 * Keeps a hidden tab mounted (so its local state survives) without re-rendering it.
 *
 * The panel mounts on first activation. While inactive it returns the same element it
 * rendered last; React bails out on an identical element, so prop changes made elsewhere
 * (e.g. switching BCA) don't re-render the hidden subtree. It catches up when shown again.
 */
export function KeepAlivePanel({ active, children }: Props) {
  const last = useRef<ReactNode>(null);
  const mounted = useRef(false);
  if (active) {
    last.current = children;
    mounted.current = true;
  }
  return mounted.current ? <>{last.current}</> : null;
}
