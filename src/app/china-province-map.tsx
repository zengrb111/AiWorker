"use client";

import { useEffect, useRef } from "react";

/**
 * 省级粉丝分布地图（合并各渠道后的省份粉丝数）。
 *
 * 合规说明：地图边界数据采用阿里云 DataV.GeoAtlas 提供的中国省级行政边界
 * （基于高德开放平台行政边界数据，包含台湾、香港、澳门及南海诸岛，符合国家标准）。
 * 文件随应用打包在 `public/china-provinces.json`，不依赖任何境外地图服务或瓦片。
 */

type MapDatum = { name: string; value: number };

let geoPromise: Promise<any> | null = null;
function loadGeo(): Promise<any> {
  if (!geoPromise) {
    geoPromise = fetch("/china-provinces.json").then((r) => r.json());
  }
  return geoPromise;
}

let echartsPromise: Promise<any> | null = null;
function loadEcharts(): Promise<any> {
  if (!echartsPromise) {
    echartsPromise = (async () => {
      const echarts = await import("echarts/core");
      const { MapChart } = await import("echarts/charts");
      const { TooltipComponent, VisualMapComponent } = await import("echarts/components");
      const { CanvasRenderer } = await import("echarts/renderers");
      echarts.use([MapChart, TooltipComponent, VisualMapComponent, CanvasRenderer]);
      return echarts;
    })();
  }
  return echartsPromise;
}

// 短名 → GeoJSON 全名（用于匹配省份边界）
const SAR: Record<string, string> = { 香港: "香港特别行政区", 澳门: "澳门特别行政区" };
const AUTONOMOUS: Record<string, string> = {
  内蒙古: "内蒙古自治区",
  广西: "广西壮族自治区",
  西藏: "西藏自治区",
  宁夏: "宁夏回族自治区",
  新疆: "新疆维吾尔自治区",
};
const MUNICIPALITIES = ["北京", "天津", "上海", "重庆"];

function toFullName(short: string): string {
  const s = String(short || "").trim();
  if (!s) return s;
  if (/(省|市|自治区|特别行政区)$/.test(s)) return s;
  if (SAR[s]) return SAR[s];
  if (AUTONOMOUS[s]) return AUTONOMOUS[s];
  if (MUNICIPALITIES.includes(s)) return s + "市";
  return s + "省";
}

let mapRegistered = false;

export default function ChinaProvinceMap({ data }: { data: MapDatum[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    let disposed = false;
    const el = hostRef.current;

    (async () => {
      const [echarts, geo] = await Promise.all([loadEcharts(), loadGeo()]);
      if (disposed || !hostRef.current) return;

      if (!mapRegistered) {
        echarts.registerMap("china-fans", geo);
        mapRegistered = true;
      }

      if (!chartRef.current) {
        chartRef.current = echarts.init(hostRef.current);
        const ro = new ResizeObserver(() => chartRef.current?.resize());
        ro.observe(hostRef.current);
        (chartRef.current as any).__ro = ro;
      }

      const maxVal = Math.max(1, ...data.map((d) => (Number.isFinite(d.value) ? d.value : 0)));
      const seriesData = data.map((d) => ({
        name: toFullName(d.name),
        value: Number.isFinite(d.value) ? d.value : 0,
        short: d.name,
      }));

      chartRef.current.setOption(
        {
          tooltip: {
            trigger: "item",
            backgroundColor: "rgba(255,255,255,0.97)",
            borderColor: "#e2e8f0",
            borderWidth: 1,
            padding: [7, 10],
            textStyle: { color: "#1f2d3d", fontSize: 12 },
            formatter: (p: any) => {
              const short = p?.data?.short || p?.name || "";
              const v = p?.data?.value;
              return `<b>${short}</b><br/>粉丝：${Number.isFinite(v) ? Number(v).toLocaleString() : "—"} 人`;
            },
          },
          visualMap: {
            type: "continuous",
            min: 0,
            max: maxVal,
            orient: "horizontal",
            left: 10,
            bottom: 6,
            itemWidth: 10,
            itemHeight: 112,
            text: ["高", "低"],
            textGap: 6,
            textStyle: { color: "#9aa7b5", fontSize: 10 },
            inRange: { color: ["#eaf2fb", "#cfe2f5", "#a3c8e9", "#6ba6db", "#2f7fc4"] },
            calculable: false,
          },
          series: [
            {
              type: "map",
              map: "china-fans",
              roam: false,
              aspectScale: 0.85,
              layoutCenter: ["50%", "50%"],
              layoutSize: "96%",
              itemStyle: { areaColor: "#eef4fb", borderColor: "#dfe8f3", borderWidth: 0.6 },
              emphasis: {
                label: { show: true, color: "#fff", fontSize: 10 },
                itemStyle: { areaColor: "#1f6fc4" },
              },
              label: { show: false },
              data: seriesData,
            },
          ],
        },
        true
      );
    })();

    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(
    () => () => {
      const c = chartRef.current;
      if (c?.__ro) c.__ro.disconnect();
      c?.dispose?.();
      chartRef.current = null;
    },
    []
  );

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
