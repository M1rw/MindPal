import React from 'react';
import type { WellnessActivityPoint, WellnessMoodPoint } from '../../../types/index.ts';

function formatDay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const VALENCE_RANK: Record<string, number> = { heavy: 1, mixed: 2, lighter: 3 };

export const WellnessMoodChart: React.FC<{ points: WellnessMoodPoint[] }> = ({ points }) => {
  if (!points.length) return null;
  const width = Math.max(280, points.length * 36 + 48);
  const height = 120;
  const padX = 8;
  const padY = 12;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2 - 18;
  const barW = Math.min(22, innerW / points.length - 6);

  const summary = points
    .map((point) => `${formatDay(point.date)} ${point.label.toLowerCase()}`)
    .join('; ');

  return (
    <div className="wellness-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Mood from your words: ${summary}. Heavier, mixed, or lighter — not a score.`}
        className="wellness-chart__svg"
      >
        {[1, 2, 3].map((rank) => {
          const y = padY + innerH - (rank / 3) * innerH;
          return (
            <line
              key={rank}
              x1={padX}
              x2={width - padX}
              y1={y}
              y2={y}
              className="wellness-chart__grid"
            />
          );
        })}
        {points.map((point, index) => {
          const rank = VALENCE_RANK[point.valence] ?? 2;
          const barH = (rank / 3) * innerH;
          const x = padX + (index + 0.5) * (innerW / points.length) - barW / 2;
          const y = padY + innerH - barH;
          return (
            <g key={point.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(4, barH)}
                rx={4}
                className={`wellness-chart__bar wellness-chart__bar--${point.valence}`}
              >
                <title>{`${formatDay(point.date)}: ${point.label}`}</title>
              </rect>
              <text x={x + barW / 2} y={height - 4} textAnchor="middle" className="wellness-chart__tick">
                {formatDay(point.date)}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="wellness-chart__legend">
        <li>
          <span className="wellness-chart__swatch wellness-chart__bar--heavy" /> Heavier
        </li>
        <li>
          <span className="wellness-chart__swatch wellness-chart__bar--mixed" /> Mixed
        </li>
        <li>
          <span className="wellness-chart__swatch wellness-chart__bar--lighter" /> Lighter
        </li>
      </ul>
    </div>
  );
};

export const WellnessActivityChart: React.FC<{ points: WellnessActivityPoint[] }> = ({ points }) => {
  if (!points.length) return null;
  const max = Math.max(...points.map((point) => point.turn_count), 1);
  const summary = points.map((point) => `${formatDay(point.date)} ${point.turn_count}`).join('; ');
  return (
    <div className="wellness-chart">
      <div
        className="wellness-activity"
        role="img"
        aria-label={`Messages you sent: ${summary}. Counts only, not a mood score.`}
      >
        {points.map((point) => {
          const pct = Math.max(8, Math.round((point.turn_count / max) * 100));
          return (
            <div key={point.date} className="wellness-activity__col">
              <div className="wellness-activity__track">
                <div className="wellness-activity__fill" style={{ height: `${pct}%` }} />
              </div>
              <span className="wellness-activity__label">{formatDay(point.date)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export function formatWellnessDay(iso: string): string {
  return formatDay(iso);
}
