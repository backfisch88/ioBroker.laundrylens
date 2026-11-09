/**
 * What `<iob-laundrylens-device>` draws: one of the shared views of `src-shared/LaundryView.tsx` - the same as in the
 * vis-2 widget and the tile of the devices app - or, for the automatic layout, all of them, of which the container
 * queries of `styles.ts` show the one that fits the box.
 */
import type { JSX, KeyboardEvent } from 'react';

import {
    LaundryBarView,
    LaundryCompactView,
    LaundryFullView,
    LaundryWideView,
    type LaundryViewProps,
} from '../../src-shared/LaundryView';
import type { Layout } from './constants';

type View = Exclude<Layout, 'auto'>;

/** The views of the automatic layout, in the order of `styles.ts` */
const AUTO_VIEWS: View[] = ['compact', 'wide', 'bar', 'full'];

const VIEWS: Record<View, (props: LaundryViewProps) => JSX.Element> = {
    compact: LaundryCompactView,
    wide: LaundryWideView,
    bar: LaundryBarView,
    full: LaundryFullView,
};

export interface LaundryWidgetProps extends LaundryViewProps {
    layout: Layout;
    /** Opens the full view in a dialog; missing in edit mode and when the settings switch it off */
    onDetails?: () => void;
}

export function LaundryWidget(props: LaundryWidgetProps): JSX.Element {
    const { layout, onDetails, ...viewProps } = props;
    const views = layout === 'auto' ? AUTO_VIEWS : [layout];

    return (
        <div className={layout === 'auto' ? 'laundry auto' : 'laundry'}>
            {views.map(view => {
                const ViewOf = VIEWS[view];
                // the full view shows everything already
                const onClick = view !== 'full' ? onDetails : undefined;
                return (
                    <div
                        key={view}
                        className={`view ${view}${onClick ? ' clickable' : ''}`}
                        role={onClick ? 'button' : undefined}
                        tabIndex={onClick ? 0 : undefined}
                        onClick={onClick}
                        onKeyDown={
                            onClick
                                ? (e: KeyboardEvent) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                          e.preventDefault();
                                          onClick();
                                      }
                                  }
                                : undefined
                        }
                    >
                        <ViewOf {...viewProps} />
                    </div>
                );
            })}
        </div>
    );
}
