/** Resolve calendar words in the user's local calendar, including across DST and year boundaries. */
export function dotsCalendarContext(text: string, receivedAt: number): string | undefined {
  const terms = text.match(/上上(?:周|星期)|下下(?:周|星期)|(?:上|这|本|下)(?:个)?(?:周|星期)|\b(?:last|this|next) week\b/gi);
  if (!terms?.length || !Number.isFinite(receivedAt)) return;
  const local = new Date(receivedAt);
  const format = (date: Date) => [date.getFullYear(), String(date.getMonth()+1).padStart(2,"0"), String(date.getDate()).padStart(2,"0")].join("-");
  const monday = new Date(local.getFullYear(), local.getMonth(), local.getDate() - (local.getDay()+6)%7, 12);
  const ranges = [...new Set(terms)].map(term => {
    const weeks = /^上上/.test(term) ? -2 : /^下下/.test(term) ? 2 : /^(上|last)/i.test(term) ? -1 : /^(下|next)/i.test(term) ? 1 : 0;
    const start = new Date(monday);
    start.setDate(start.getDate()+7*weeks);
    const end = new Date(start);
    end.setDate(end.getDate()+6);
    return `「${term}」所在自然周为 ${format(start)} 至 ${format(end)}`;
  });
  return `原消息的本地日期为 ${format(local)}。${ranges.join("。")}。保留用户指定的日期、星期或例外。`;
}
