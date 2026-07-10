export interface ActivityEvent {
  timestamp: string;
  torrentName: string;
  lines: string[];
  reviewWorthy: boolean;
}

const MAX_EVENTS = 100;
const events: ActivityEvent[] = [];

/** Newest first. Capped at MAX_EVENTS, oldest evicted first. */
export function recordActivity(event: ActivityEvent): void {
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
}

export function getRecentActivity(): ActivityEvent[] {
  return events;
}
