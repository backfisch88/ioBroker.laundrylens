/**
 * The styles of the shadow roots. The element fills the box of the host; it has a transparent background and inherits
 * `color` and `font`, so it follows the theme of the host. The views of `src-shared/LaundryView.tsx` take their colors
 * from `currentColor` and fixed signal colors, so they fit a light and a dark theme alike.
 *
 * The automatic layout is chosen by container queries on the box, with the same limits as the vis-2 widget: `full`
 * from 560 x 420 px, `bar` when it is flat (at most 110 px high and 2.5 times as wide as high), `wide` from 1.5 times
 * as wide as high, `compact` otherwise. All candidate views are in the DOM; only the matching one is shown.
 */
export const STYLES = `
:host {
    display: block;
    width: 100%;
    height: 100%;
}
.mount {
    width: 100%;
    height: 100%;
    /* the size of the box does not depend on what is in it */
    container-type: size;
    container-name: laundrylens;
}
.laundry {
    width: 100%;
    height: 100%;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
}
.view {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: clamp(4px, 4cqmin, 12px);
    display: flex;
    align-items: center;
    overflow: hidden;
}
.view.bar {
    padding-top: 0;
    padding-bottom: 0;
}
.view.full {
    align-items: flex-start;
    overflow: auto;
}
.view.clickable {
    cursor: pointer;
}
.view.clickable:focus-visible {
    outline: 2px solid var(--iob-primary);
    outline-offset: -2px;
    border-radius: var(--iob-border-radius);
}
.auto > .view {
    display: none;
}
.auto > .view.compact {
    display: flex;
}
@container laundrylens (aspect-ratio >= 3 / 2) {
    .auto > .view.compact {
        display: none;
    }
    .auto > .view.wide {
        display: flex;
    }
}
@container laundrylens (aspect-ratio >= 5 / 2) and (height <= 110px) {
    .auto > .view.wide {
        display: none;
    }
    .auto > .view.bar {
        display: flex;
    }
}
@container laundrylens (width >= 560px) and (height >= 420px) {
    .auto > .view.compact,
    .auto > .view.wide,
    .auto > .view.bar {
        display: none;
    }
    .auto > .view.full {
        display: flex;
    }
}
.hint {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: 8px;
    display: flex;
    color: var(--iob-text-secondary);
}
`;

/** The full view in a dialog of the host: it inherits the colors and the font of the dialog */
export const DIALOG_STYLES = `
:host {
    display: block;
}
.details {
    width: 100%;
    color: inherit;
    font: inherit;
}
`;
