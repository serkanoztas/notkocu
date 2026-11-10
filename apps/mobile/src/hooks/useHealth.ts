import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    retry: false,
    refetchInterval: 15_000,
  });
}