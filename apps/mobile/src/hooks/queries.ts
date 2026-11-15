import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CreateNoteRequest, UpdateNoteRequest } from "@notkocu/shared";
import { api } from "../lib/api";

export const useToday = () => useQuery({ queryKey: ["today"], queryFn: api.today });

export const useInbox = () => useQuery({ queryKey: ["inbox"], queryFn: api.inbox });

export const useCourseDetail = (id: string) =>
  useQuery({ queryKey: ["course", id], queryFn: () => api.course(id), enabled: !!id });

export const useWeek = (id: string, weekNo: number) =>
  useQuery({ queryKey: ["week", id, weekNo], queryFn: () => api.week(id, weekNo), enabled: !!id && weekNo > 0 });

export const useNote = (id: string) =>
  useQuery({ queryKey: ["note", id], queryFn: () => api.note(id), enabled: !!id });

/** A note changed: every list that can contain it is stale (counts, week lists, inbox, today). */
function invalidateNoteViews(queryClient: QueryClient) {
  for (const key of ["today", "inbox", "course", "week", "note"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNoteRequest) => api.createNote(body),
    onSuccess: () => invalidateNoteViews(queryClient),
  });
}

export function useUpdateNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateNoteRequest) => api.updateNote(id, body),
    onSuccess: () => invalidateNoteViews(queryClient),
  });
}

/** Update any note by id (inbox assignment: one hook for the whole list). */
export function useAssignNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateNoteRequest }) => api.updateNote(id, body),
    onSuccess: () => invalidateNoteViews(queryClient),
  });
}

export function useDeleteNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteNote(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["note", id] });
      invalidateNoteViews(queryClient);
    },
  });
}
