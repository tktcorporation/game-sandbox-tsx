export function ArcadeBack({ onLeave }: { onLeave: () => void }) {
  return (
    <button type="button" className="arcade-back" onClick={onLeave}>
      <span className="arcade-back-mark" aria-hidden>
        ◀
      </span>
      Arcade
    </button>
  );
}
