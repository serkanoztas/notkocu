import { useEffect, useState } from "react";
import { DEFAULT_TIME_ZONE } from "@notkocu/shared";
import { useAuth } from "../lib/auth";

/** Current time, refreshed every `intervalMs` (default one minute) while the screen is mounted. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The user's IANA time zone; every day/week calculation in the app uses this, not the device's. */
export function useTimeZone(): string {
  const { user } = useAuth();
  return user?.timeZone ?? DEFAULT_TIME_ZONE;
}
