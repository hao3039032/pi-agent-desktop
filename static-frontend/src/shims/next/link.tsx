/**
 * next/link shim: a plain anchor with client-side navigation (the static
 * app has one document; Links are rare in the shell UI).
 */
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { useCallback } from "react";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children: ReactNode;
  replace?: boolean;
  prefetch?: boolean;
};

export default function Link({ href, replace, onClick, children, ...rest }: LinkProps) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (href.startsWith("http:") || href.startsWith("https:") || href.startsWith("mailto:")) return;
      event.preventDefault();
      if (replace) window.history.replaceState(null, "", href);
      else window.history.pushState(null, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [href, onClick, replace],
  );
  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
