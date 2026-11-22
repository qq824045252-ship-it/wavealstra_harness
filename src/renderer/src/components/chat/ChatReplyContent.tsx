import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReplyChart, ReplyCitation, ReplyTable } from "@shared/chat-reply-content";
import { useAppStore } from "@/store/appStore";
import "./ChatReplyContent.css";

const format = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 21 });
const collator = new Intl.Collator(undefined, { numeric: true });

export function ChatReplyTable({ data }: { data: ReplyTable }) {
  const [sort, setSort] = useState<{ column: number; descending: boolean }>();
  const rows = data.rows.map((cells, index) => ({ cells, index }));
  if (sort) rows.sort((a, b) => {
    const left = a.cells[sort.column];
    const right = b.cells[sort.column];
    if (left === null || right === null) return Number(left === null) - Number(right === null);
    const order = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
    return sort.descending ? -order : order;
  });
  return (
    <div className="chat-reply-surface chat-reply-table" tabIndex={0} role="region" aria-label={data.title}>
      <table>
        <caption>{data.title}</caption>
        <thead><tr>{data.columns.map((column, index) => {
          const direction = sort?.column === index ? sort.descending ? "descending" : "ascending" : undefined;
          return <th key={index} scope="col" aria-sort={direction}>
            <button type="button" onClick={() => setSort({ column: index, descending: direction === "ascending" })}>
              {column.label}{column.type === "number" && column.unit ? ` (${column.unit})` : ""}
              <span aria-hidden="true">{direction === "ascending" ? "↑" : direction === "descending" ? "↓" : "↕"}</span>
            </button>
          </th>;
        })}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.index}>{row.cells.map((cell, index) => (
          <td key={index} className={data.columns[index].type === "number" ? "chat-reply-number" : undefined}>
            {typeof cell === "number" ? format.format(cell) : cell ?? "—"}
          </td>
        ))}</tr>)}</tbody>
      </table>
    </div>
  );
}

const axisFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4, notation: "compact" });
const pointText = (point: ReplyChart["points"][number], unit: string) =>
  `${point.label} · ${point.value === null ? "缺失" : `${format.format(point.value)} ${unit}`}`;

export function ChatReplyChart({ data }: { data: ReplyChart }) {
  const [selected, setSelected] = useState<number>();
  const [viewportWidth, setViewportWidth] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const values = data.points.flatMap(point => point.value === null ? [] : [point.value]);
  const bars = data.type === "bar";
  let min = Math.min(...values), max = Math.max(...values);
  if (bars || min === max) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (max === min) max = 1;
  const width = Math.max(viewportWidth, 360, 90 + data.points.length * 46);
  const left = 66, right = width - 14, top = 14, bottom = 148;
  const step = (right - left) / data.points.length;
  const x = (index: number) => left + step * (index + 0.5);
  const y = (value: number) => bottom - (bottom - top) * ((value - min) / (max - min));
  const zero = bars ? y(0) : bottom;
  const line = data.points.map((point, index) => point.value === null ? ""
    : `${index === 0 || data.points[index - 1].value === null ? "M" : "L"}${x(index)},${y(point.value)}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(data.points.length / 8));
  const labelLength = Math.max(4, Math.floor(step / 8));
  return (
    <figure className="chat-reply-surface chat-reply-chart" aria-labelledby={titleId}>
      <figcaption id={titleId}>{data.title} <span>({data.unit})</span></figcaption>
      <div className="chat-reply-chart-scroll" ref={viewport} tabIndex={0} role="region" aria-label={`${data.title}绘图区`}>
        <svg viewBox={`0 0 ${width} 180`} style={{ minWidth: width }} role="group" aria-label={bars ? "柱状图" : "折线图"}>
          {[0, .25, .5, .75, 1].map(fraction => {
            const value = min + (max - min) * fraction;
            return <g key={fraction} className="chat-reply-axis">
              <line x1={left} x2={right} y1={y(value)} y2={y(value)} />
              <text x={left - 8} y={y(value)} textAnchor="end" dominantBaseline="middle">{axisFormat.format(value)}</text>
            </g>;
          })}
          {bars ? <line className="chat-reply-zero" x1={left} x2={right} y1={zero} y2={zero} /> : <path className="chat-reply-series" d={line} />}
          {data.points.map((point, index) => {
            const value = point.value;
            const details = pointText(point, data.unit);
            return <g key={index}>
              {(index % labelEvery === 0 || index === data.points.length - 1) && <text className="chat-reply-axis" x={x(index)} y={168} textAnchor="middle">
                {point.label.length > labelLength ? `${point.label.slice(0, labelLength - 1)}…` : point.label}
              </text>}
              <g className={`chat-reply-point${selected === index ? " is-selected" : ""}`} tabIndex={0} role="button" aria-label={details}
                onMouseEnter={() => setSelected(index)} onFocus={() => setSelected(index)} onClick={() => setSelected(index)}
                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(index); } }}>
                <title>{details}</title>
                <rect className="chat-reply-hit" x={left + step * index} y={top - 6} width={step} height={bottom - top + 12} />
                {value === null ? null : bars
                  ? value === 0
                    ? <line className="chat-reply-zero" x1={x(index) - 11} x2={x(index) + 11} y1={zero} y2={zero} />
                    : <rect x={x(index) - 11} y={Math.min(y(value), zero)} width={22} height={Math.abs(y(value) - zero)} />
                  : <circle cx={x(index)} cy={y(value)} r={4} />}
              </g>
            </g>;
          })}
        </svg>
      </div>
      <div className="chat-reply-point-value" aria-live="polite">
        {selected !== undefined && data.points[selected] ? pointText(data.points[selected], data.unit) : "查看数据点"}
      </div>
    </figure>
  );
}

const sourceLabels = { page: "已读原文", snippet: "仅搜索摘要", provided: "用户提供的摘录" };

export function ChatReplyCitation({ citation }: { citation: ReplyCitation }) {
  const id = useId();
  return <span className="chat-reply-citation">
    <button type="button" className="chat-reply-citation-chip" popoverTarget={id} aria-label={`来源：${citation.title}`}>
      {new URL(citation.url).hostname}
    </button>
    <span className="chat-reply-citation-popup" id={id} popover="auto">
      <strong>{citation.title}</strong>
      <small>{sourceLabels[citation.kind]}</small>
      <span>{citation.excerpt}</span>
      <a className="md-link" href={citation.url} onClick={event => {
        event.preventDefault();
        event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
        useAppStore.getState().setBrowserUrl(citation.url);
      }}>打开出处 ↗</a>
    </span>
  </span>;
}
