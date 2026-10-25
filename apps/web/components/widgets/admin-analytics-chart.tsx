"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

// Canvas cannot read CSS variables, so resolve the shared tokens when drawing and again on theme change.
function tokens() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string) => css.getPropertyValue(name).trim();
  return { bar: read("--chart-1"), axis: read("--muted-foreground"), grid: read("--border"), popover: read("--popover"), popoverText: read("--popover-foreground") };
}

export default function AdminAnalyticsChart({ rows }: { rows: Array<{ username?: string; modelCalls?: number }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const draw = () => {
      const t = tokens();
      chart.setOption({
        animation: false,
        grid: { left: 34, right: 12, top: 12, bottom: 36 },
        tooltip: { trigger: "axis", backgroundColor: t.popover, borderColor: t.grid, textStyle: { color: t.popoverText } },
        xAxis: { type: "category", data: rows.map(x => x.username ?? "Member"), axisLabel: { color: t.axis }, axisLine: { lineStyle: { color: t.grid } } },
        yAxis: { type: "value", axisLabel: { color: t.axis }, splitLine: { lineStyle: { color: t.grid } } },
        series: [{ type: "bar", data: rows.map(x => x.modelCalls ?? 0), itemStyle: { color: t.bar, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 36 }],
      });
    };
    draw();
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => { theme.disconnect(); window.removeEventListener("resize", resize); chart.dispose(); };
  }, [rows]);
  return <div ref={ref} data-testid="admin-analytics-chart" role="img" className="h-56 w-full" aria-label="Usage by member" />;
}
