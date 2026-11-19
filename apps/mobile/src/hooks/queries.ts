import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoteItem, UpdateNoteRequest } from "@notkocu/shared";
import { api } from "../lib/api";

/** Notes still being processed by the worker: the screen polls every few seconds until none are left. */
const POLL_MS = 4000;
const isActive = (notes: NoteItem[] | undefined) =>
  !!notes?.some((n) => n.status === "pending" || n.status === "processing" || n.suggesting);

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
    // Also while the weekly summary is being written (opening the page queued it).
    refetchInterval: (q) => (isActive(q.state.data?.notes) || q.state.data?.summary?.generating ? POLL_MS : false),
  });

/** "Tekrar dene" on the summary card: queues a fresh summary job. */
export function useRefreshWeekSummary(id: string, weekNo: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshWeekSummary(id, weekNo),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["week", id, weekNo] }),
  });
}

export const useNote = (id: string) =>
  useQuery({
    queryKey: ["note", id],
    queryFn: () => api.note(id),
    enabled: !!id,
    refetchInterval: (q) => (isActive(q.state.data ? [q.state.data.note] : undefined) ? POLL_MS : false),
  });

export const useStorage = () => useQuery({ queryKey: ["storage"], queryFn: api.storage });

/** A note changed: every list that can contain it is stale (counts, week lists, inbox, today). */
export function invalidateNoteViews(queryClient: QueryClient): Promise<unknown> {
  return Promise.all(
    ["today", "inbox", "course", "week", "note", "storage"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
  );
}

export function useRetryNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryNote(id),
    onSuccess: () => void invalidateNoteViews(queryClient),
  });
}

export function useUpdateNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateNoteRequest) => api.updateNote(id, body),
    onSuccess: () => void invalidateNoteViews(queryClient),
  });
}

/** Update any note by id (inbox assignment: one hook for the whole list). */
export function useAssignNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateNoteRequest }) => api.updateNote(id, body),
    onSuccess: () => void invalidateNoteViews(queryClient),
  });
}

/** "Hepsini onayla" / "Onayla": assigns inbox notes to their AI-suggested course and week. */
export function useApproveSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noteIds: string[]) => api.approveSuggestions(noteIds),
    onSuccess: () => void invalidateNoteViews(queryClient),
  });
}

/** "Geri al": puts notes back into the inbox. */
export function useUndoAssign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noteIds: string[]) => Promise.all(noteIds.map((id) => api.updateNote(id, { courseId: null }))),
    onSuccess: () => void invalidateNoteViews(queryClient),
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
