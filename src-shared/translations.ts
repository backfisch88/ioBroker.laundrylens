/**
 * Words of the views and of the widget settings. Every key carries the `laundrylens_` prefix already, so the devices
 * app (which adds no prefix) and vis-2 (which leaves prefixed keys alone) use the same files. They are separate from
 * `admin/i18n`, which Admin loads for the tab and the backend reads for the notifications.
 */
import en from './i18n/en.json';
import de from './i18n/de.json';
import ru from './i18n/ru.json';
import pt from './i18n/pt.json';
import nl from './i18n/nl.json';
import fr from './i18n/fr.json';
import it from './i18n/it.json';
import es from './i18n/es.json';
import pl from './i18n/pl.json';
import uk from './i18n/uk.json';
import zhCn from './i18n/zh-cn.json';

export const I18N_PREFIX = 'laundrylens_';

const translations: Record<ioBroker.Languages, Record<string, string>> = {
    en,
    de,
    ru,
    pt,
    nl,
    fr,
    it,
    es,
    pl,
    uk,
    'zh-cn': zhCn,
};

export default translations;
