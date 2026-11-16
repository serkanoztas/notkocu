import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CreateNoteRequest, NoteItem, UpdateNoteRequest } from "@notkocu/shared";
import { api, type PhotoTarget } from "../lib/api";

/** Notes still being processed by the worker: the screen polls every few seconds until none are left. */
const POLL_MS = 4000;
const isActive = (notes: NoteItem[] | undefined) =>
  !!notes?.some((n) => n.status === "pending" || n.status === "processing");

export const useToday = () => useQuery({ queryKey: ["today"], queryFn: api.today });

export const useInbox = () =>
  useQuery({
    queryKey: ["inbox"],
    queryFn: api.inbox,
    refetchInterval: (q) => (isActive(q.state.data?.notes) ? POLL_MS : false),
  });

export const useCourseDetail = (id: string) =>
  useQuery({ queryKey: ["course", id], queryFn: () => api.course(id), enabled: !!id });

export const useWeek = (id: string, weekNo: number) =>
  useQuery({
    queryKey: ["week", id, weekNo],
    queryFn: () => api.week(id, weekNo),
    enabled: !!id && weekNo > 0,
    refetchInterval: (q) => (isActive(q.state.data?.notes) ? POLL_MS : false),
  });

export const useNote = (id: string) =>
  useQuery({
    queryKey: ["note", id],
    queryFn: () => api.note(id),
    enabled: !!id,
    refetchInterval: (q) => (isActive(q.state.data ? [q.state.data.note] : undefined) ? POLL_MS : false),
  });

export const useStorage = () => useQuery({ queryKey: ["storage"], queryFn: api.storage });

/** A note changed: every list that can contain it is stale (counts, week lists, inbox, today). */
function invalidateNoteViews(queryClient: QueryClient) {
  for (const key of ["today", "inbox", "course", "week", "note", "storage"]) {
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

export function useCreateImageNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uri, target }: { uri: string; target: PhotoTarget }) => api.createImageNote(uri, target),
    onSuccess: () => invalidateNoteViews(queryClient),
  });
}

export function useRetryNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryNote(id),
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
