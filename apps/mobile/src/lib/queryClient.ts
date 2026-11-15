import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/** How long a persisted cache stays usable; gcTime must be at least this long or entries vanish before restore. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // At most one retry, and none for 4xx (retrying can't fix those).
      retry: (failureCount, error) =>
        failureCount < 1 && !(error instanceof ApiError && error.status !== undefined && error.status < 500),
      staleTime: 10_000,
      gcTime: CACHE_MAX_AGE_MS,
    },
  },
});
