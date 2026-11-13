import React from 'react';

import { useTheme } from '@mui/material/styles';
import {
    ArrowDown,
    ArrowsClockwise,
    ArrowsLeftRight,
    ArrowUp,
    ArrowUUpLeft,
    Bell,
    Basket,
    ChartBar,
    ChartLine,
    CaretDown,
    CaretRight,
    Check,
    CheckCircle,
    Circle,
    Clock,
    Drop,
    Fire,
    FloppyDisk,
    Folders,
    GameController,
    Gear,
    House,
    Lightbulb,
    Lightning,
    Link,
    type Icon,
    PencilSimple,
    Question,
    Robot,
    Scissors,
    Shower,
    Snowflake,
    Sparkle,
    Spiral,
    Stop,
    Tag,
    ThermometerHot,
    TShirt,
    TrashSimple,
    Warning,
    WashingMachine,
    Wind,
    X,
} from '@phosphor-icons/react';

type Tone = 'green' | 'blue' | 'orange' | 'red' | 'muted';

/** The icon and its colour for every emoji that the texts of the tab use. Duotone icons of Phosphor (MIT). */
const ICON_MAP: Record<string, [Icon, Tone]> = {
    '✅': [CheckCircle, 'green'],
    '🧺': [WashingMachine, 'blue'],
    '📊': [ChartBar, 'blue'],
    '🔔': [Bell, 'orange'],
    '🗑': [TrashSimple, 'red'],
    '🌀': [Spiral, 'green'],
    '🔄': [ArrowsClockwise, 'blue'],
    '⚡': [Lightning, 'orange'],
    '✓': [Check, 'green'],
    '💾': [FloppyDisk, 'blue'],
    '⚠': [Warning, 'orange'],
    '🏷': [Tag, 'blue'],
    '💡': [Lightbulb, 'orange'],
    '❓': [Question, 'orange'],
    '↻': [ArrowsClockwise, 'blue'],
    '🤖': [Robot, 'blue'],
    '✏': [PencilSimple, 'blue'],
    '🗂': [Folders, 'blue'],
    '🕐': [Clock, 'blue'],
    '🎮': [GameController, 'blue'],
    '⬇': [ArrowDown, 'blue'],
    '⬆': [ArrowUp, 'blue'],
    '🟢': [Circle, 'green'],
    '🫧': [Drop, 'blue'],
    '🔗': [Link, 'blue'],
    '✖': [X, 'red'],
    '↩': [ArrowUUpLeft, 'blue'],
    '📈': [ChartLine, 'blue'],
    '🏠': [House, 'blue'],
    '↔': [ArrowsLeftRight, 'blue'],
    '⚙': [Gear, 'blue'],
    '✕': [X, 'muted'],
    '✂': [Scissors, 'blue'],
    '⏹': [Stop, 'red'],
    // Opens and closes a row of a table
    '▶': [CaretRight, 'blue'],
    '▼': [CaretDown, 'blue'],
    // Phases of a cycle, see admin/phaseLabels.json
    '🔥': [Fire, 'orange'],
    '💧': [Drop, 'blue'],
    '🪣': [Basket, 'blue'],
    '♨': [ThermometerHot, 'orange'],
    '❄': [Snowflake, 'blue'],
    '👕': [TShirt, 'blue'],
    '🚿': [Shower, 'blue'],
    '✨': [Sparkle, 'orange'],
    '💨': [Wind, 'blue'],
};

/** An emoji, optionally with the variation selector, then at most one space that the icon replaces with its own gap */
const ICON_RE = new RegExp(`(${Object.keys(ICON_MAP).join('|')})\\uFE0F?( ?)`, 'g');

const TONE_COLOR: Record<Tone, string> = {
    green: 'success.main',
    blue: 'primary.main',
    orange: 'warning.main',
    red: 'error.main',
    muted: 'text.secondary',
};

function Glyph(props: { emoji: string; gap: boolean; mono?: boolean }): React.JSX.Element {
    const theme = useTheme();
    const [Component, tone] = ICON_MAP[props.emoji];
    const [group, shade] = TONE_COLOR[tone].split('.');
    const palette = theme.palette as unknown as Record<string, Record<string, string>>;
    // On a coloured background the icon takes the colour of the text
    const color = props.mono ? 'currentColor' : shade ? palette[group][shade] : theme.palette.text.secondary;
    return (
        <Component
            aria-hidden="true"
            weight="duotone"
            color={color}
            size="1.15em"
            style={{
                verticalAlign: '-0.2em',
                flexShrink: 0,
                marginRight: props.gap ? '0.4em' : undefined,
            }}
        />
    );
}

function fromString(text: string, mono?: boolean): React.ReactNode {
    ICON_RE.lastIndex = 0;
    if (!ICON_RE.test(text)) {
        return text;
    }
    ICON_RE.lastIndex = 0;
    const parts: React.ReactNode[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = ICON_RE.exec(text))) {
        if (match.index > last) {
            parts.push(text.slice(last, match.index));
        }
        parts.push(
            <Glyph
                key={match.index}
                emoji={match[1]}
                gap={!!match[2]}
                mono={mono}
            />,
        );
        last = match.index + match[0].length;
    }
    if (last < text.length) {
        parts.push(text.slice(last));
    }
    return parts;
}

/**
 * Replaces the emoji in the texts of a node by icons. Texts, lists of texts and the text of elements
 * that sit directly in it are handled, everything else is left alone.
 *
 * @param node what a component renders as its text
 * @param mono the icons take the colour of the text, for a coloured background
 */
export function withIcons(node: React.ReactNode, mono?: boolean): React.ReactNode {
    if (typeof node === 'string') {
        return fromString(node, mono);
    }
    if (Array.isArray(node)) {
        return node.map((item, index) => (
            <React.Fragment key={index}>{withIcons(item as React.ReactNode, mono)}</React.Fragment>
        ));
    }
    if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
        const children = node.props.children;
        if (typeof children === 'string' || Array.isArray(children)) {
            return React.cloneElement(node, undefined, withIcons(children, mono));
        }
    }
    return node;
}
