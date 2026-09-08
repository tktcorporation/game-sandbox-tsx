import type { ReactNode } from "react";
import { KENNEY, type KenneyName } from "./kenney";

export function Pixel({
  name,
  size = 32,
  title,
  className,
}: {
  name: KenneyName;
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <img
      src={KENNEY[name]}
      width={size}
      height={size}
      className={["pixel", className].filter(Boolean).join(" ")}
      alt=""
      title={title}
      draggable={false}
    />
  );
}

export function PixelText({
  name,
  size = 16,
  children,
  className,
}: {
  name: KenneyName;
  size?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={["pixel-text", className].filter(Boolean).join(" ")}>
      <Pixel name={name} size={size} />
      {children}
    </span>
  );
}
