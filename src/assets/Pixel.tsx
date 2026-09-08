import type { ReactNode } from "react";

export function Pixel({
  src,
  size = 32,
  title,
  className,
}: {
  src: string;
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <img
      src={src}
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
  src,
  size = 16,
  children,
  className,
}: {
  src: string;
  size?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={["pixel-text", className].filter(Boolean).join(" ")}>
      <Pixel src={src} size={size} />
      {children}
    </span>
  );
}
