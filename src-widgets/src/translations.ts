import translations, { I18N_PREFIX } from '../../src-shared/translations';

// vis-2 adds the prefix to keys that do not start with it - the shared keys already do
export default { ...translations, prefix: I18N_PREFIX };
