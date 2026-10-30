/**
 * next/image shim: a plain <img> (the migration plan: next/image 改为普通
 * 图片). The app's only next/image use is the web-only login page; any
 * straggler import keeps compiling and renders an unoptimized image.
 */
import type { ImgHTMLAttributes } from "react";

type ImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  priority?: boolean;
  fill?: boolean;
  sizes?: string;
  quality?: number;
  loader?: unknown;
  unoptimized?: boolean;
};

export default function Image({ src, alt, width, height, ...rest }: ImageProps) {
  // eslint-disable-next-line @next/next/no-img-element -- this IS the shim
  return <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async" {...rest} />;
}
