import { create } from 'zustand';

/**
 * The reason the last team-session start failed (`503 team_session_failed` → `details.error`),
 * per team, for the TeamSessionBanner's `failed` row (SPEC §14.1.4). Cleared when a start succeeds.
 */
export const useTeamSessionStore = create<{ lastError: Record<string, string | null>; setError: (teamId: string, error: string | null) => void }>()((set) => ({
  lastError: {},
  setError: (teamId, error) => set((s) => ({ lastError: { ...s.lastError, [teamId]: error } })),
}));
