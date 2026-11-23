/** The personal assistant has one conversation per desktop profile. */
export const DOTS_TASK_ID = 'mybuddy-dots'
export const DOTS_NO_CHANGE = '[[dots:no-change]]'

export function isDotsAutomaticInput(requestId: string): boolean {
  return /^cron-[0-9a-f-]{36}-input$/i.test(requestId) || requestId.startsWith('goal-continuation:')
}
