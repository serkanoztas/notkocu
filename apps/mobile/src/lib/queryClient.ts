import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { // At most one retry, and none for 4xx (retrying can't fix those).
      retry: (failureCount, error) =>
        failureCount < 1 && !(error instanceof ApiError && error.status !== undefined && error.status < 500), staleTime: 10_000 },
  },
});