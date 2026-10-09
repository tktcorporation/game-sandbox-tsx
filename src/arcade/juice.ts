import { useEffect, useRef, useState } from "react";

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Screen shake whose amplitude grows with the size of what happened (log-scaled). */
export function shake(el: Element | null, size: number) {
  if (!el || reduced() || size <= 0) return;
  const a = Math.min(14, 2 + Math.log2(1 + size) * 2.2);
  const frames = [0, 1, 2, 3, 4, 5].map((i) => {
    const k = a * (1 - i / 6);
    return { transform: `translate(${(i % 2 ? -1 : 1) * k}px, ${(i % 3 === 0 ? 1 : -1) * k * 0.5}px)` };
  });
  el.animate([...frames, { transform: "none" }], { duration: 320, easing: "ease-out" });
}

/** A number that climbs to its target instead of jumping. */
export function useCountUp(target: number, ms = 500) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    if (a === target || reduced()) {
      from.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const v = Math.round(a + (target - a) * (1 - Math.pow(1 - p, 3)));
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
  }, [target, ms]);
  return shown;
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
