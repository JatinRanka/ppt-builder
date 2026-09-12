'use client';
/**
 * CHART RENDERER — AI-generated charts from schema data.
 *
 * The schema stores series/categories as plain arrays (see ChartBlock in
 * schema/deck.ts); this transposes them into the row-per-category shape Recharts
 * wants. Keeping the schema in the "series" shape rather than Recharts' shape
 * matters because it is also what PPTX native charts expect, and it is far
 * easier for an LLM to emit correctly.
 *
 * ssr:false via dynamic import at the call site — Recharts measures DOM nodes
 * and throws during server rendering.
 */
import { cloneElement, useEffect, useRef, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  Area, AreaChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { BlockOfType } from '@/lib/schema/deck';
import { getTheme } from '@/lib/themes';

/** Logical slide is 1280x720; a chart typically occupies this much of it. */
const DEFAULT_W = 1050;
const DEFAULT_H = 380;
/** Below this the flex box has genuinely collapsed; fall back to DEFAULT_H. */
const MIN_H = 80;

interface Props {
  block: BlockOfType<'chart'>;
  themeName: string;
  /** Print/export needs fixed pixel sizing; ResponsiveContainer collapses. */
  fixedSize?: { width: number; height: number };
}

export function ChartBlockView({ block, themeName, fixedSize }: Props) {
  const theme = getTheme(themeName);
  // Recharts needs concrete pixel dimensions. ResponsiveContainer measures its
  // parent, but inside this nested flex chain the parent resolves to ~0 height
  // and the chart silently renders axes with no plot area. Measuring the box
  // ourselves is deterministic and also correct in the print view.
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Start from a sensible default rather than 0. Rendering nothing until a
  // measurement arrives deadlocks: the parent's height derives from the child,
  // and the child would be waiting on the parent.
  const [size, setSize] = useState({
    w: fixedSize?.width ?? DEFAULT_W,
    h: fixedSize?.height ?? DEFAULT_H,
  });

  useEffect(() => {
    if (fixedSize || !boxRef.current) return;
    const el = boxRef.current;
    const measure = () => {
      // offsetWidth/Height, NOT getBoundingClientRect: the slide is rendered
      // inside a `scale()` transform, so getBoundingClientRect returns
      // POST-transform pixels (221px at scale 0.62) while the chart lives in
      // the untransformed coordinate space and needs the layout size (462px).
      // Measuring the scaled value made the chart render at ~40% of its box.
      const w = Math.max(el.offsetWidth, 200);
      // The chart is out of flow (see render), so this height is set by the
      // layout and does not depend on what we render — no feedback loop.
      // DEFAULT_H still covers the first paint, before layout has run.
      const measured = el.offsetHeight;
      const h = measured >= MIN_H ? measured : DEFAULT_H;

      setSize((prev) => {
        // Ignore sub-pixel jitter: ResizeObserver fires on fractional changes
        // during transitions, and re-rendering an SVG chart for a 1px delta is
        // wasted work.
        if (Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) return prev;
        return { w, h };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixedSize]);
  const colors = theme.chartColors;

  // Transpose: {series:[{name,data:[1,2]}], categories:['a','b']}
  //         -> [{category:'a', Series1:1}, {category:'b', Series1:2}]
  const data = block.categories.map((cat, i) => {
    const row: Record<string, string | number> = { category: cat };
    for (const s of block.series) row[s.name] = s.data[i] ?? 0;
    return row;
  });

  const axisStyle = { fill: theme.vars['--slide-muted'], fontSize: 12 };
  const grid = theme.vars['--slide-border'];

  const inner = (() => {
    switch (block.chartType) {
      case 'bar':
        return (
          <BarChart data={data}>
            <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="category" tick={axisStyle} stroke={grid} />
            <YAxis tick={axisStyle} stroke={grid} />
            <Tooltip contentStyle={tooltipStyle(theme)} />
            {block.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {block.series.map((s, i) => (
              <Bar key={s.name} dataKey={s.name} fill={colors[i % colors.length]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        );
      case 'line':
        return (
          <LineChart data={data}>
            <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="category" tick={axisStyle} stroke={grid} />
            <YAxis tick={axisStyle} stroke={grid} />
            <Tooltip contentStyle={tooltipStyle(theme)} />
            {block.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {block.series.map((s, i) => (
              <Line key={s.name} type="monotone" dataKey={s.name}
                stroke={colors[i % colors.length]} strokeWidth={2.5} dot={{ r: 3 }}
                isAnimationActive={false} />
            ))}
          </LineChart>
        );
      case 'area':
        return (
          <AreaChart data={data}>
            <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="category" tick={axisStyle} stroke={grid} />
            <YAxis tick={axisStyle} stroke={grid} />
            <Tooltip contentStyle={tooltipStyle(theme)} />
            {block.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {block.series.map((s, i) => (
              <Area key={s.name} type="monotone" dataKey={s.name}
                stroke={colors[i % colors.length]} fill={colors[i % colors.length]}
                fillOpacity={0.25} strokeWidth={2.5} isAnimationActive={false} />
            ))}
          </AreaChart>
        );
      case 'pie': {
        // Pie shows a single series; use the first and colour by category.
        const first = block.series[0];
        const pieData = block.categories.map((cat, i) => ({
          name: cat,
          value: first?.data[i] ?? 0,
        }));
        return (
          <PieChart>
            <Tooltip contentStyle={tooltipStyle(theme)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Pie data={pieData} dataKey="value" nameKey="name" outerRadius="72%"
              isAnimationActive={false}
              label={{ fill: theme.vars['--slide-fg'], fontSize: 12 }}>
              {pieData.map((_, i) => (
                <Cell key={i} fill={colors[i % colors.length]} />
              ))}
            </Pie>
          </PieChart>
        );
      }
    }
  })();

  return (
    /* min-h-0 + flex-1 rather than a hard min-height: a chart sharing a slide
       with other blocks must SHRINK to its allocation. A floor of 240px made
       the chart overflow its flex box and paint over the bullets beneath it
       (observed live: 64px of overlap). */
    <figure className="w-full h-full min-h-0 flex-1 flex flex-col overflow-hidden">
      {/*
        The measured box is `relative` and the chart inside it is absolutely
        positioned, so the chart is OUT OF FLOW and cannot contribute to this
        box's height. That breaks a genuine infinite ResizeObserver loop:
        previously the box's height came from the chart it contained, so
        measure -> render -> resize -> measure oscillated forever
        (observed live on the sample deck's slide 3: 182 -> 87 -> 42 -> 182px
        every ~8ms, a visible flicker and a pinned CPU core).

        With the chart out of flow, the box's height is decided purely by the
        parent flex layout, which makes the measurement a fixed point.
      */}
      {/* `basis-0 grow` + `h-full` gives this box a height from the flex
          layout even though its only child is out of flow. With plain
          `flex-1 min-h-0` and an absolutely-positioned child there is nothing
          in flow to size against, so the box measured 0 and the chart fell
          back to its default size. */}
      <div ref={boxRef} className="w-full min-h-0 basis-0 grow self-stretch relative">
        {/* Explicit numeric width/height — Recharts silently renders an empty
            plot area when given percentage strings it cannot resolve. */}
        <div className="absolute inset-0">
          {cloneElement(inner as React.ReactElement<{ width?: number; height?: number }>, {
            width: size.w,
            height: size.h,
          })}
        </div>
      </div>
      {block.caption && (
        <figcaption
          className="text-[0.7em] mt-2 shrink-0"
          style={{ color: 'var(--slide-muted)' }}
        >
          {block.caption}
        </figcaption>
      )}
    </figure>
  );
}

function tooltipStyle(theme: ReturnType<typeof getTheme>) {
  return {
    background: theme.vars['--slide-bg-alt'],
    border: `1px solid ${theme.vars['--slide-border']}`,
    borderRadius: 8,
    color: theme.vars['--slide-fg'],
    fontSize: 12,
  };
}
