/** gws account access is verified by read receipts, never by skill installation. */
export type GoogleWorkspaceErrorCode = 'cli_missing' | 'unsupported_cli' | 'auth_required' | 'permission_denied' | 'api_disabled' | 'timeout' | 'cancelled' | 'invalid_request' | 'invalid_response' | 'service_error';
export type GoogleWorkspaceResult<T> = { ok: true; data: T; checkedAt: number } | { ok: false; error: { code: GoogleWorkspaceErrorCode; message: string; nextStep?: string }; checkedAt: number };
export interface GoogleWorkspaceAccess { state: 'ready' | 'unverified' | 'auth_required' | 'error'; message: string }
export interface GoogleWorkspaceStatus { cliAvailable: boolean; gmail: GoogleWorkspaceAccess; calendar: GoogleWorkspaceAccess; checkedAt: number }
export interface GoogleMailSummary { id: string; subject: string; from: string; date: string; unread: boolean }
export interface GoogleCalendarEvent { id: string; title: string; start: string; end: string; allDay: boolean; location?: string; description?: string; htmlLink?: string }
export interface GoogleWorkspaceApi {
  status(): Promise<GoogleWorkspaceResult<GoogleWorkspaceStatus>>;
  searchMail(request: { query: string; limit?: number }): Promise<GoogleWorkspaceResult<{ messages: GoogleMailSummary[]; limited: boolean }>>;
  readMail(request: { id: string }): Promise<GoogleWorkspaceResult<{ id: string; text: string; truncated: boolean }>>;
  listEvents(request: { from: string; days: number; calendar?: string }): Promise<GoogleWorkspaceResult<{ events: GoogleCalendarEvent[]; limited: boolean; timeZone: string }>>;
}
export const GoogleWorkspaceIpc = { status: 'google-workspace:status', searchMail: 'google-workspace:search-mail', readMail: 'google-workspace:read-mail', listEvents: 'google-workspace:list-events' } as const;
