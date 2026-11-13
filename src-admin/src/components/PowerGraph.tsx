import React, { useEffect, useRef, useState } from 'react';

import { Box, useTheme } from '@mui/material';

import type { PhaseEntry, TracePoint } from '../api';
import { getPhaseLabel, t } from '../labels';

const HEIGHT = 180;
const PAD = { top: 12, right: 8, bottom: 20, left: 40 };
/** The trim handles can not get closer than this share of the cycle */
const MIN_TRIM_GAP = 0.05;

const PHASE_COLORS: Record<string, string> = {
    heating: '234,67,53',
    washing: '26,115,232',
    rinsing: '52,168,83',
    spinning: '251,188,4',
    soaking: '154,109,255',
    dryer_drying: '250,123,23',
    cooling: '26,115,232',
    anticrease: '52,168,83',
    prewash: '154,109,255',
    mainwash: '234,67,53',
    finalrinse: '52,168,83',
    dish_drying: '251,188,4',
};
const UNKNOWN_PHASE_COLOR = '153,153,153';
const TRIM_COLOR = '#ea4335';
const SPLIT_COLOR = '#ff9800';

export type GraphSelection =
    | { mode: 'none' }
    | { mode: 'trim'; start: number; end: number }
    | { mode: 'split'; at: number };

function phaseColor(phase: string): string {
    return PHASE_COLORS[phase] || UNKNOWN_PHASE_COLOR;
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, radius: number, color: string): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, HEIGHT / 2, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↔', x, HEIGHT / 2);
}

function drawMarker(ctx: CanvasRenderingContext2D, x: number, color: string, width: number, dash: number[]): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, HEIGHT - PAD.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
}

interface DrawOptions {
    width: number;
    points: TracePoint[];
    phases: PhaseEntry[];
    selection: GraphSelection;
    textColor: string;
    gridColor: string;
    lineColor: string;
}

function draw(ctx: CanvasRenderingContext2D, options: DrawOptions): void {
    const { width, points, phases, selection, textColor, gridColor, lineColor } = options;
    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.textBaseline = 'alphabetic';

    if (points.length < 2) {
        ctx.fillStyle = textColor;
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t('No trace data'), width / 2, HEIGHT / 2);
        return;
    }

    const graphWidth = width - PAD.left - PAD.right;
    const graphHeight = HEIGHT - PAD.top - PAD.bottom;
    const t0 = points[0].ts;
    const range = points[points.length - 1].ts - t0 || 1;
    const maxWatts = points.reduce((max, point) => Math.max(max, point.watts), 0) || 1;
    const x = (ts: number): number => PAD.left + ((ts - t0) / range) * graphWidth;
    const y = (watts: number): number => PAD.top + graphHeight - (watts / maxWatts) * graphHeight;
    // Saved phases hold an absolute `ts` or, in older data, an offset `tMs` from the start of the cycle
    const phaseTs = (phase: PhaseEntry): number => phase.ts ?? t0 + (phase.tMs || 0);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, graphWidth, graphHeight);
    ctx.clip();
    phases.forEach((phase, i) => {
        const start = Math.max(x(phaseTs(phase)), PAD.left);
        const next = phases[i + 1];
        const end = next ? Math.min(x(phaseTs(next)), PAD.left + graphWidth) : PAD.left + graphWidth;
        ctx.fillStyle = `rgba(${phaseColor(phase.phase)},0.12)`;
        ctx.fillRect(start, PAD.top, end - start, graphHeight);
        ctx.strokeStyle = `rgb(${phaseColor(phase.phase)})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(start, PAD.top);
        ctx.lineTo(start, PAD.top + graphHeight);
        ctx.stroke();
        ctx.setLineDash([]);
    });
    ctx.restore();

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach((point, i) => {
        if (i === 0) {
            ctx.moveTo(x(point.ts), y(point.watts));
        } else {
            ctx.lineTo(x(point.ts), y(point.watts));
        }
    });
    ctx.stroke();

    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.lineWidth = 0.5;
    [0.25, 0.5, 0.75, 1].forEach(share => {
        const lineY = PAD.top + graphHeight * (1 - share);
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(PAD.left, lineY);
        ctx.lineTo(PAD.left + graphWidth, lineY);
        ctx.stroke();
        ctx.fillStyle = textColor;
        ctx.fillText(`${Math.round(maxWatts * share)}W`, PAD.left - 3, lineY + 3);
    });
    const minutes = range / 60000;
    [0, 0.5, 1].forEach(share => {
        // Centered on the right edge, the last label would be cut off by the canvas
        ctx.textAlign = share === 1 ? 'right' : 'center';
        ctx.fillText(`${Math.round(minutes * share)}min`, PAD.left + share * graphWidth, PAD.top + graphHeight + 12);
    });

    if (selection.mode === 'trim') {
        const start = x(selection.start);
        const end = x(selection.end);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(PAD.left, PAD.top, start - PAD.left, graphHeight);
        ctx.fillRect(end, PAD.top, PAD.left + graphWidth - end, graphHeight);
        [start, end].forEach(handle => {
            drawMarker(ctx, handle, TRIM_COLOR, 2, [5, 4]);
            drawHandle(ctx, handle, 12, TRIM_COLOR);
        });
    } else if (selection.mode === 'split') {
        drawMarker(ctx, x(selection.at), SPLIT_COLOR, 3, [6, 3]);
        drawHandle(ctx, x(selection.at), 14, SPLIT_COLOR);
    }
}

/**
 * Power curve of one cycle with phase backgrounds. In trim and split mode the handles follow mouse
 * and touch through pointer events, which cover both with one code path.
 */
export default function PowerGraph(props: {
    points: TracePoint[];
    phases: PhaseEntry[];
    selection: GraphSelection;
    onSelectionChange: (selection: GraphSelection) => void;
}): React.JSX.Element {
    const { points, phases, selection, onSelectionChange } = props;
    const theme = useTheme();
    const wrapper = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const [width, setWidth] = useState(0);
    const dragging = useRef<'start' | 'end' | 'split' | null>(null);

    useEffect(() => {
        const element = wrapper.current;
        if (!element) {
            return undefined;
        }
        const observer = new ResizeObserver(() => setWidth(element.clientWidth));
        observer.observe(element);
        setWidth(element.clientWidth);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const element = canvas.current;
        const ctx = element?.getContext('2d');
        if (!element || !ctx || !width) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        element.width = width * ratio;
        element.height = HEIGHT * ratio;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        draw(ctx, {
            width,
            points,
            phases,
            selection,
            textColor: theme.palette.text.secondary,
            gridColor: theme.palette.divider,
            lineColor: theme.palette.primary.main,
        });
    }, [width, points, phases, selection, theme]);

    const active = selection.mode !== 'none' && points.length >= 2;

    const eventTs = (e: React.PointerEvent): number => {
        const rect = e.currentTarget.getBoundingClientRect();
        const share = (e.clientX - rect.left - PAD.left) / (rect.width - PAD.left - PAD.right);
        const t0 = points[0].ts;
        return t0 + Math.max(0, Math.min(1, share)) * (points[points.length - 1].ts - t0);
    };

    const onPointerDown = (e: React.PointerEvent): void => {
        if (!active) {
            return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        const ts = eventTs(e);
        if (selection.mode === 'split') {
            dragging.current = 'split';
            onSelectionChange({ mode: 'split', at: ts });
        } else if (selection.mode === 'trim') {
            dragging.current = Math.abs(ts - selection.start) < Math.abs(ts - selection.end) ? 'start' : 'end';
        }
    };

    const onPointerMove = (e: React.PointerEvent): void => {
        if (!active || !dragging.current) {
            return;
        }
        const ts = eventTs(e);
        if (selection.mode === 'split') {
            onSelectionChange({ mode: 'split', at: ts });
        } else if (selection.mode === 'trim') {
            const gap = (points[points.length - 1].ts - points[0].ts) * MIN_TRIM_GAP;
            onSelectionChange(
                dragging.current === 'start'
                    ? { ...selection, start: Math.min(ts, selection.end - gap) }
                    : { ...selection, end: Math.max(ts, selection.start + gap) },
            );
        }
    };

    const legend = [...new Set(phases.map(phase => phase.phase))];

    return (
        <Box ref={wrapper}>
            <canvas
                ref={canvas}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={() => (dragging.current = null)}
                onPointerCancel={() => (dragging.current = null)}
                style={{
                    display: 'block',
                    width: '100%',
                    height: HEIGHT,
                    cursor: active ? 'ew-resize' : 'default',
                    // While a handle can be dragged, a touch moves the handle instead of scrolling the page
                    touchAction: active ? 'none' : 'auto',
                }}
            />
            {legend.length ? (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.75 }}>
                    {legend.map(phase => (
                        <Box
                            key={phase}
                            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: 11 }}
                        >
                            <Box sx={{ width: 8, height: 8, borderRadius: 0.5, bgcolor: `rgb(${phaseColor(phase)})` }} />
                            {getPhaseLabel(phase)}
                        </Box>
                    ))}
                </Box>
            ) : null}
        </Box>
    );
}
