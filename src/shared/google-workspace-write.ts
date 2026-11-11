import type { GoogleCalendarEvent, GoogleWorkspaceErrorCode } from './google-workspace';
export type GoogleWorkspaceWriteResult<T> = { ok: true; data: T; checkedAt: number } | { ok: false; error: { code: GoogleWorkspaceErrorCode | 'conflict' | 'idempotency_conflict' | 'unknown_outcome'; message: string; nextStep?: string; outcome: 'not_started' | 'failed' | 'unknown' }; checkedAt: number };
export interface GoogleSendMailRequest { operationId: string; to: string[]; cc?: string[]; subject: string; body: string }
export interface GoogleGetEventRequest { calendar?: string; id: string }
export interface GoogleCreateEventRequest { operationId: string; calendar?: string; title: string; start: string; end: string; allDay: boolean; timeZone?: string; description?: string; location?: string; attendees?: string[]; notifyAttendees?: boolean }
export interface GoogleUpdateEventRequest extends GoogleGetEventRequest { operationId: string; etag: string; title?: string; start?: string; end?: string; allDay?: boolean; timeZone?: string; description?: string; location?: string; attendees?: string[]; notifyAttendees?: boolean }
export interface GoogleWrittenEvent extends GoogleCalendarEvent { etag: string; calendar: string; operationId?: string; timeZone?: string; attendees: string[]; receiptOnly?: boolean }
export interface GoogleSentMail { id: string; threadId?: string; operationId: string }
export interface GoogleWorkspaceWriteApi {
  sendMail(request: GoogleSendMailRequest): Promise<GoogleWorkspaceWriteResult<GoogleSentMail>>;
  createEvent(request: GoogleCreateEventRequest): Promise<GoogleWorkspaceWriteResult<GoogleWrittenEvent>>;
  updateEvent(request: GoogleUpdateEventRequest): Promise<GoogleWorkspaceWriteResult<GoogleWrittenEvent>>;
  getEvent(request: GoogleGetEventRequest): Promise<GoogleWorkspaceWriteResult<GoogleWrittenEvent>>;
}
export const GoogleWorkspaceWriteIpc = { sendMail: 'google-workspace:send-mail', createEvent: 'google-workspace:create-event', updateEvent: 'google-workspace:update-event', getEvent: 'google-workspace:get-event' } as const;
