import React from 'react';

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import App from './App';

/**
 * The custom item of admin/jsonTab.json. It only bridges JSON-Config to the app, which renders the
 * tabs itself: the badge, the jump to the review tab and the shared device selection need one
 * component tree, and the native `tabs` item of JSON-Config offers no API for them.
 */
export default class LaundryLensTab extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    renderItem(): React.JSX.Element {
        return <App socket={this.props.oContext.socket} />;
    }
}
