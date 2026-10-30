/**
 * next/dynamic shim: React.lazy + Suspense (the migration plan's mapping).
 * Generic over the component's props so call sites keep contextual typing
 * (the app's loaders return either a bare component or a module).
 */
import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

type DynamicOptions = {
  loading?: () => ReactNode;
  ssr?: boolean;
};

export default function nextDynamic<P>(
  loader: () => Promise<ComponentType<P> | { default: ComponentType<P> }>,
  options?: DynamicOptions,
): ComponentType<P> {
  const Lazy = lazy(async () => {
    const loaded = await loader();
    const component: ComponentType<P> =
      typeof loaded === "function" ? loaded : loaded.default;
    return { default: component };
  });
  const fallback = options?.loading ?? (() => null);
  const Wrapped = (props: P): ReactNode => (
    <Suspense fallback={fallback()}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Lazy {...(props as any)} />
    </Suspense>
  );
  return Wrapped as ComponentType<P>;
}
