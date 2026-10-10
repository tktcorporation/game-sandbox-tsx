/*
 * Touch controls for phones and tablets, held in landscape. The left half is a
 * floating stick that appears where the thumb lands; the right half turns the
 * view; buttons sit under the right thumb. A fire button also turns the view
 * while held, so aiming and shooting take one thumb.
 */

export interface TouchSink {
  /** Stick vector: x right, z forward, each -1..1. */
  move: { x: number; z: number };
  look(dx: number, dy: number): void;
  /** One-shot action, like a key press (`Space`, `KeyR`, ...). */
  press(code: string): void;
  /** Held action, like a held key (`KeyC`). */
  hold(code: string, on: boolean): void;
  fire(on: boolean): void;
  toggleAds(): void;
  pause(): void;
}

const STICK_RADIUS = 56;

/**
 * Keep the page at 1:1 on phones. iOS Safari ignores `user-scalable=no` and
 * still zooms on a pinch, so its gesture events are cancelled here; `touch-action`
 * in the stylesheet covers double-tap zoom and the other browsers.
 */
export function blockPageZoom() {
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
}

export function setupTouch(sink: TouchSink) {
  const $ = (id: string) => document.getElementById(id)!;
  const root = $("touch");
  const stickBase = $("t-stick-base");
  const stickKnob = $("t-stick-knob");
  const zoneMove = $("t-zone-move");
  const zoneLook = $("t-zone-look");

  // Each finger is tracked by pointer id with its role.
  const fingers = new Map<number, { role: "move" | "look" | "fire"; x: number; y: number; ox: number; oy: number }>();

  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  zoneMove.addEventListener("pointerdown", (e) => {
    stop(e);
    zoneMove.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, { role: "move", x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY });
    stickBase.style.cssText = `display:block;left:${e.clientX}px;top:${e.clientY}px`;
    stickKnob.style.transform = "translate(-50%, -50%)";
  });
  zoneLook.addEventListener("pointerdown", (e) => {
    stop(e);
    zoneLook.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, { role: "look", x: e.clientX, y: e.clientY, ox: 0, oy: 0 });
  });

  const onMove = (e: PointerEvent) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    e.preventDefault();
    if (f.role === "move") {
      let dx = e.clientX - f.ox;
      let dy = e.clientY - f.oy;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx *= STICK_RADIUS / len;
        dy *= STICK_RADIUS / len;
      }
      stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      sink.move.x = dx / STICK_RADIUS;
      sink.move.z = -dy / STICK_RADIUS;
    } else {
      sink.look(e.clientX - f.x, e.clientY - f.y);
    }
    f.x = e.clientX;
    f.y = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.delete(e.pointerId);
    if (f.role === "move") {
      sink.move.x = sink.move.z = 0;
      stickBase.style.display = "none";
    }
    if (f.role === "fire" && ![...fingers.values()].some((o) => o.role === "fire")) sink.fire(false);
  };
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onUp);

  for (const btn of Array.from(root.querySelectorAll<HTMLElement>("[data-act]"))) {
    const act = btn.dataset.act!;
    btn.addEventListener("pointerdown", (e) => {
      stop(e);
      btn.setPointerCapture(e.pointerId);
      btn.classList.add("down");
      switch (act) {
        case "fire":
          fingers.set(e.pointerId, { role: "fire", x: e.clientX, y: e.clientY, ox: 0, oy: 0 });
          sink.fire(true);
          break;
        case "crouch":
          sink.hold("KeyC", true);
          break;
        case "ads":
          sink.toggleAds();
          break;
        case "pause":
          sink.pause();
          break;
        default:
          sink.press(act);
      }
    });
    const release = () => {
      btn.classList.remove("down");
      if (act === "crouch") sink.hold("KeyC", false);
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
  }

  // Tapping a weapon card selects it.
  for (const i of [0, 1]) {
    $(`slot-${i}`).addEventListener("pointerdown", (e) => {
      stop(e);
      sink.press(`Digit${i + 1}`);
    });
  }
}
