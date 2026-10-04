import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { getGymBranding } from "@/lib/gym.functions";
import { CurrencyContext } from "@/lib/currency-context";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "GYM MANAGER" },
      { name: "description", content: "Gym operations, memberships, classes, workouts, and access in one secure workspace." },
      { name: "author", content: "GYM MANAGER" },
      { property: "og:title", content: "GYM MANAGER" },
      { property: "og:description", content: "Gym management in one secure workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "data:," },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const b=JSON.parse(localStorage.getItem("gym-branding-cache")||"null");if(b&&["forge-green","ocean-blue","ember-orange","violet","rose"].includes(b.color_theme))document.documentElement.dataset.theme=b.color_theme}catch{}`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <BrandingSync>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
      </BrandingSync>
    </QueryClientProvider>
  );
}

function BrandingSync({ children }: { children: ReactNode }) {
  const loadBranding = useServerFn(getGymBranding);
  const { data: branding, isPending } = useQuery({ queryKey: ["gym-branding"], queryFn: () => loadBranding(), retry: false });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [minimumSplashElapsed, setMinimumSplashElapsed] = useState(false);
  const [cachedBranding, setCachedBranding] = useState<{
    gym_name: string;
    logo_url: string | null;
    app_title: string;
    color_theme: string;
  }>();

  useEffect(() => {
    try {
      const cached = localStorage.getItem("gym-branding-cache");
      if (!cached) return;
      const value = JSON.parse(cached) as Partial<NonNullable<typeof cachedBranding>>;
      if (typeof value.color_theme !== "string" || !["forge-green", "ocean-blue", "ember-orange", "violet", "rose"].includes(value.color_theme)) return;
      setCachedBranding({
        gym_name: typeof value.gym_name === "string" ? value.gym_name : "GYM MANAGER",
        logo_url: typeof value.logo_url === "string" ? value.logo_url : null,
        app_title: typeof value.app_title === "string" ? value.app_title : "GYM MANAGER",
        color_theme: value.color_theme,
      });
    } catch {
      try {
        localStorage.removeItem("gym-branding-cache");
      } catch {
        // Ignore browser storage restrictions.
      }
    }
  }, []);

  useEffect(() => {
    if (!branding) return;
    try {
      localStorage.setItem("gym-branding-cache", JSON.stringify({
        gym_name: branding.gym_name,
        logo_url: branding.logo_url,
        app_title: branding.app_title,
        color_theme: branding.color_theme,
      }));
    } catch {
      // The live branding response still applies when browser storage is unavailable.
    }
  }, [branding]);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimumSplashElapsed(true), 2000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");
    if (reducedMotion.matches || !finePointer.matches) return;

    let frame = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        document.documentElement.style.setProperty("--pointer-x", `${event.clientX}px`);
        document.documentElement.style.setProperty("--pointer-y", `${event.clientY}px`);
        document.body.dataset.cursorGlow = "true";
        frame = 0;
      });
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      if (frame) window.cancelAnimationFrame(frame);
      delete document.body.dataset.cursorGlow;
      document.documentElement.style.removeProperty("--pointer-x");
      document.documentElement.style.removeProperty("--pointer-y");
    };
  }, []);

  const effectiveBranding = branding ?? cachedBranding;

  useEffect(() => {
    if (!effectiveBranding) return;
    document.title = effectiveBranding.app_title;
    document.documentElement.dataset.theme = effectiveBranding.color_theme;
    let icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.append(icon);
    }
    icon.href = effectiveBranding.logo_url || "data:,";
  }, [effectiveBranding?.app_title, effectiveBranding?.color_theme, effectiveBranding?.logo_url, pathname]);

  if (isPending || !minimumSplashElapsed) return <SetupInitializing branding={effectiveBranding} />;

  return <CurrencyContext.Provider value={branding?.currency ?? "INR"}>{children}</CurrencyContext.Provider>;
}

function SetupInitializing({ branding }: { branding?: { gym_name?: string | null; logo_url?: string | null } }) {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-label="Initializing gym workspace"
      className="fixed inset-0 z-[100] grid min-h-screen place-items-center overflow-hidden bg-background px-6 text-foreground"
    >
      <div className="pointer-events-none absolute -left-24 -top-24 size-72 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 -right-20 size-80 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex flex-col items-center text-center">
        <div className="relative grid size-32 place-items-center">
          <span className="absolute inset-0 rounded-full border border-primary/20" />
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary border-r-primary/50" />
          <span className="absolute inset-2 animate-[spin_3.2s_linear_infinite_reverse] rounded-full border border-dashed border-primary/25" />
          <span className="grid size-20 place-items-center overflow-hidden rounded-2xl border border-white/10 bg-card/85 p-3 shadow-xl shadow-primary/10 backdrop-blur-xl">
            {branding?.logo_url ? (
              <img src={branding.logo_url} alt="" className="size-full object-contain" />
            ) : (
              <span className="text-center font-display text-[10px] font-black leading-tight text-primary">GYM<br />MANAGER</span>
            )}
          </span>
        </div>
        <p className="mt-7 font-display text-lg font-bold uppercase tracking-[0.16em]">
          {branding?.gym_name || "GYM MANAGER"}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">Preparing your gym workspace</p>
        <div className="mt-6 h-1 w-44 overflow-hidden rounded-full bg-muted">
          <span className="block h-full w-2/5 animate-[forge-loading-shimmer_1.15s_ease-in-out_infinite] rounded-full bg-primary" />
        </div>
      </div>
    </main>
  );
}
