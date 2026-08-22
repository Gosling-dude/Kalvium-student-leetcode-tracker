'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { useState, type ReactNode } from 'react';

import { ApiError } from '@/lib/api';
import { ScopeFilterProvider } from '@/components/scope-filter';

export function Providers({ children }: { children: ReactNode }) {
  // Created inside state so each browser session gets one client and it is never
  // shared across requests during SSR.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Dashboard figures change only when a sync runs, so a short stale window
            // avoids refetching on every navigation without showing stale data for long.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // 4xx will not fix itself; retrying just delays the error message.
              if (error instanceof ApiError && error.status < 500) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <ScopeFilterProvider>{children}</ScopeFilterProvider>
        <Toaster position="bottom-right" richColors closeButton />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
