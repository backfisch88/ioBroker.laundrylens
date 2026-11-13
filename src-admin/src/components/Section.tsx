import React from 'react';

import { Box, Paper, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';

/** A titled card. Tables pass `noPadding` so that they reach the edges of the card. */
export function Section(props: {
    title?: React.ReactNode;
    right?: React.ReactNode;
    noPadding?: boolean;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <Paper
            variant="outlined"
            sx={{ mb: 2, overflow: 'hidden' }}
        >
            {props.title ? (
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 1,
                        px: 2,
                        py: 1,
                        borderBottom: 1,
                        borderColor: 'divider',
                        bgcolor: 'action.hover',
                    }}
                >
                    <Typography
                        variant="overline"
                        sx={{ lineHeight: 1.6, color: 'text.secondary', fontWeight: 600 }}
                    >
                        {props.title}
                    </Typography>
                    {props.right}
                </Box>
            ) : null}
            <Box sx={props.noPadding ? undefined : { p: 2 }}>{props.children}</Box>
        </Paper>
    );
}

export function Empty(props: { children: React.ReactNode }): React.JSX.Element {
    return <Typography sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>{props.children}</Typography>;
}

/** Two columns: a muted label and its value. */
export function FactTable(props: { rows: [string, React.ReactNode][] }): React.JSX.Element {
    return (
        <Table size="small">
            <TableBody>
                {props.rows.map(([label, value]) => (
                    <TableRow key={label}>
                        <TableCell sx={{ width: 130, color: 'text.secondary' }}>{label}</TableCell>
                        <TableCell>{value}</TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}
