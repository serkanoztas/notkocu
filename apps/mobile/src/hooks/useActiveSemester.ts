import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export const activeSemesterKey = ["semesters", "active"] as const;

export function useActiveSemester(enabled: boolean) {
  return useQuery({ queryKey: activeSemesterKey, queryFn: api.activeSemester, enabled });
}
