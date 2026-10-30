/**
 * next/dynamic shim: React.lazy + Suspense (the migration plan's mapping).
 * The preload-then-render pattern the app actually uses (LazyTerminalPanel)
 * keeps its own state; this shim serves any remaining next/dynamic import.
 */
import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

type DynamicOptions = {
  loading?: () => ReactNode;
  ssr?: boolean;
};

export default function nextDynamic(
  loader: () => Promise<{ default: ComponentType } | ComponentType>,
  options?: DynamicOptions,
): ComponentType {
  const Lazy = lazy(async () => {
    const module = await loader();
    if (typeof module === "function") return { default: module };
    return { default: module.default };
  });
  const fallback = options?.loading ?? (() => null);
  const Wrapped = (props: Record<string, unknown>) => (
    <Suspense fallback={fallback()}>
      <Lazy {...props} />
    </Suspense>
  );
  return Wrapped;
}
