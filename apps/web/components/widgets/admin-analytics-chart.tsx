"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);
export default function AdminAnalyticsChart({ rows }: { rows: Array<{ username?: string; modelCalls?: number }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption({ grid: { left: 34, right: 12, top: 12, bottom: 36 }, tooltip: { trigger: "axis" }, xAxis: { type: "category", data: rows.map(x => x.username ?? "Member"), axisLabel: { color: "#71767b" } }, yAxis: { type: "value", axisLabel: { color: "#71767b" }, splitLine: { lineStyle: { color: "rgba(127,127,127,.2)" } } }, series: [{ type: "bar", data: rows.map(x => x.modelCalls ?? 0), itemStyle: { color: "#1d9bf0", borderRadius: [3, 3, 0, 0] }, barMaxWidth: 36 }] });
    const resize = () => chart.resize(); window.addEventListener("resize", resize); return () => { window.removeEventListener("resize", resize); chart.dispose(); };
  }, [rows]);
  return <div ref={ref} data-testid="admin-analytics-chart" className="h-56 w-full" aria-label="Usage by member" />;
}
