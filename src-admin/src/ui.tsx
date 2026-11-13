import React from 'react';

import {
    Alert as MuiAlert,
    Button as MuiButton,
    Chip as MuiChip,
    DialogTitle as MuiDialogTitle,
    FormControlLabel as MuiFormControlLabel,
    IconButton as MuiIconButton,
    MenuItem as MuiMenuItem,
    Tab as MuiTab,
    TableCell as MuiTableCell,
    Typography as MuiTypography,
} from '@mui/material';

import { withIcons } from './icons';

/**
 * The components that show texts with emoji. They are the MUI components, only the emoji in their
 * texts become icons. Everything else of MUI is exported as it is.
 */
export * from '@mui/material';

type Coloured = { color?: string; variant?: string };

function iconized<P extends { children?: React.ReactNode }>(
    Component: React.ElementType,
    labelProp?: string,
    inline?: boolean,
    filled?: (props: Coloured) => boolean,
): React.ComponentType<P> {
    const Wrapped = React.forwardRef<unknown, P>((props, ref) => {
        const mono = filled?.(props as unknown as Coloured) ?? false;
        const extra: Record<string, unknown> = {};
        if (labelProp && (props as Record<string, unknown>)[labelProp] !== undefined) {
            const label = withIcons((props as Record<string, unknown>)[labelProp] as React.ReactNode, mono);
            extra[labelProp] = inline ? <span>{label}</span> : label;
        }
        return React.createElement(Component, { ...props, ...extra, ref }, withIcons(props.children, mono));
    });
    return Wrapped as unknown as React.ComponentType<P>;
}

export const Alert = iconized(MuiAlert) as unknown as typeof MuiAlert;
/** A coloured background, where an icon in its own colour would vanish */
const isFilled = (props: Coloured): boolean =>
    props.variant === 'contained' || (!!props.color && props.color !== 'default' && props.variant !== 'outlined');

export const Button = iconized(MuiButton, undefined, false, props => props.variant === 'contained') as unknown as typeof MuiButton;
export const Chip = iconized(MuiChip, 'label', false, isFilled) as unknown as typeof MuiChip;
export const DialogTitle = iconized(MuiDialogTitle) as unknown as typeof MuiDialogTitle;
export const IconButton = iconized(MuiIconButton) as unknown as typeof MuiIconButton;
export const MenuItem = iconized(MuiMenuItem) as unknown as typeof MuiMenuItem;
export const FormControlLabel = iconized(MuiFormControlLabel, 'label') as unknown as typeof MuiFormControlLabel;
// MUI stacks the children of a tab, so icon and text stay together in one element
export const Tab = iconized(MuiTab, 'label', true) as unknown as typeof MuiTab;
export const TableCell = iconized(MuiTableCell) as unknown as typeof MuiTableCell;
export const Typography = iconized(MuiTypography) as unknown as typeof MuiTypography;
