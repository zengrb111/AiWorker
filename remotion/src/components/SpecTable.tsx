import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import { enterProgress, fadeProgress } from "./ChartShell";

export type SpecTableProps = {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: string[][];
  note?: string;
  accent: string;
  textColor: string;
  mutedColor: string;
};

/** 行高。行数多时自动压低，避免表格超出绘图区。 */
const ROW_BASE = 84;

/**
 * 规格表：N 行 N 列。
 *
 * 之前的契约里根本没有「表格」这个概念 —— 一个 OverlaySpec 只能带一个
 * `value` + 一个 `label`，所以「参数 A/参数 B/参数 C 三行对照」这种
 * 最典型的技术/产品介绍画面根本没法表达，只能塞进 text 里糊成一段。
 * columns + rows 是为它专设的。
 */
export const SpecTable: React.FC<SpecTableProps> = ({
  title,
  subtitle,
  columns,
  rows,
  note,
  accent,
  textColor,
  mutedColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cols = (columns ?? []).filter((c) => typeof c === "string" && c.trim());
  const tableRows = (rows ?? [])
    .map((r) => (Array.isArray(r) ? r : []).map((cell) => String(cell ?? "")))
    // 列数不齐的脏数据直接丢：画出来是错位的表格，比不画更糟。
    .filter((r) => r.length === cols.length);
  if (!cols.length || !tableRows.length) return null;

  const rowHeight = Math.min(ROW_BASE, Math.floor(620 / (tableRows.length + 1)));
  // 首列占 34%，其余列均分 —— 首列通常是参数名，最需要空间。
  const firstShare = cols.length === 1 ? 1 : 0.34;
  const restShare = cols.length === 1 ? 0 : (1 - firstShare) / (cols.length - 1);
  const template = cols
    .map((_, i) => (i === 0 ? `${firstShare * 100}%` : `${restShare * 100}%`))
    .join(" ");

  const gridColumns = `${cols.length * 24 + 36}px ${template}`;

  return (
    <div
      style={{
        position: "absolute",
        left: 56,
        right: 56,
        top: 240,
        opacity: fadeProgress(frame, 0, 12),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontFamily: FONT_SANS,
          fontSize: 46,
          fontWeight: 700,
          color: textColor,
        }}
      >
        <div style={{ width: 6, height: 40, borderRadius: 3, background: accent, flexShrink: 0 }} />
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            margin: "14px 0 0 22px",
            fontFamily: FONT_SANS,
            fontSize: 27,
            color: mutedColor,
            opacity: fadeProgress(frame, 3, 12),
          }}
        >
          {subtitle}
        </div>
      ) : null}

      <div
        style={{
          marginTop: 36,
          borderRadius: 22,
          overflow: "hidden",
          border: `1px solid ${accent}3d`,
          background: "rgba(13,16,22,0.80)",
          backdropFilter: "blur(12px)",
          boxShadow: `0 22px 60px rgba(0,0,0,0.5), 0 0 52px ${accent}17`,
        }}
      >
        {/* 表头 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: gridColumns,
            minHeight: rowHeight * 0.86,
            alignItems: "center",
            background: `${accent}26`,
            opacity: fadeProgress(frame, 6, 14),
          }}
        >
          {cols.map((col, i) => (
            <div
              key={`h-${i}`}
              style={{
                padding: "0 20px",
                fontFamily: FONT_SANS,
                fontSize: 27,
                fontWeight: 700,
                color: accent,
              }}
            >
              {col}
            </div>
          ))}
        </div>

        {/* 数据行 */}
        {tableRows.map((row, r) => {
          const grow = enterProgress(frame, fps, 10 + r * 6);
          return (
            <div
              key={`r-${r}`}
              style={{
                display: "grid",
                gridTemplateColumns: gridColumns,
                minHeight: rowHeight,
                alignItems: "center",
                background: r % 2 === 1 ? "#ffffff07" : "transparent",
                borderTop: "1px solid #ffffff0f",
                opacity: grow,
                transform: `translateX(${(1 - grow) * 26}px)`,
              }}
            >
              {row.map((cell, c) => (
                <div
                  key={`c-${r}-${c}`}
                  style={{
                    padding: "0 20px",
                    fontFamily: FONT_SANS,
                    fontSize: c === 0 ? 28 : 27,
                    fontWeight: c === 0 ? 600 : 400,
                    color: c === 0 ? textColor : mutedColor,
                    lineHeight: 1.4,
                  }}
                >
                  {cell}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {note ? (
        <div
          style={{
            marginTop: 24,
            fontFamily: FONT_SANS,
            fontSize: 25,
            lineHeight: 1.5,
            color: mutedColor,
            opacity: fadeProgress(frame, 20, 14),
          }}
        >
          {note}
        </div>
      ) : null}
    </div>
  );
};