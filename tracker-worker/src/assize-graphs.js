// Assize's built-in rule graphs (src/assize-graphs/*.json, the same files build.py inlines into Aethernet) for the
// Worker: the rules editor starts from them. A new file there needs a line here (a test checks).
import awaitingItem from '../../src/assize-graphs/awaiting-item.json' with { type: 'json' };
import buyoutHasCharges from '../../src/assize-graphs/buyout-has-charges.json' with { type: 'json' };
import buyoutNotPhone from '../../src/assize-graphs/buyout-not-phone.json' with { type: 'json' };
import buyoutStillOpen from '../../src/assize-graphs/buyout-still-open.json' with { type: 'json' };
import cciNot15 from '../../src/assize-graphs/cci-not-15.json' with { type: 'json' };
import cciZeroCart from '../../src/assize-graphs/cci-zero-cart.json' with { type: 'json' };
import contactDue from '../../src/assize-graphs/contact-due.json' with { type: 'json' };
import dataRiskNoAgreement from '../../src/assize-graphs/data-risk-no-agreement.json' with { type: 'json' };
import dateNotUpdated from '../../src/assize-graphs/date-not-updated.json' with { type: 'json' };
import foldableSamsungIw from '../../src/assize-graphs/foldable-samsung-iw.json' with { type: 'json' };
import liquidNoAgreement from '../../src/assize-graphs/liquid-no-agreement.json' with { type: 'json' };
import missedContact from '../../src/assize-graphs/missed-contact.json' with { type: 'json' };
import noBin from '../../src/assize-graphs/no-bin.json' with { type: 'json' };
import noDate from '../../src/assize-graphs/no-date.json' with { type: 'json' };
import noIntakeNote from '../../src/assize-graphs/no-intake-note.json' with { type: 'json' };
import noPartLine from '../../src/assize-graphs/no-part-line.json' with { type: 'json' };
import noPricedLines from '../../src/assize-graphs/no-priced-lines.json' with { type: 'json' };
import noQuote from '../../src/assize-graphs/no-quote.json' with { type: 'json' };
import notOrdered from '../../src/assize-graphs/not-ordered.json' with { type: 'json' };
import notStarted from '../../src/assize-graphs/not-started.json' with { type: 'json' };
import notStarted3Days from '../../src/assize-graphs/not-started-3-days.json' with { type: 'json' };
import ntfNoLabor from '../../src/assize-graphs/ntf-no-labor.json' with { type: 'json' };
import oopZeroCart from '../../src/assize-graphs/oop-zero-cart.json' with { type: 'json' };
import parentClosedCleaningOpen from '../../src/assize-graphs/parent-closed-cleaning-open.json' with { type: 'json' };
import phoneOnHomePlus from '../../src/assize-graphs/phone-on-home-plus.json' with { type: 'json' };
import priceOffSheet from '../../src/assize-graphs/price-off-sheet.json' with { type: 'json' };
import shortIntakeNote from '../../src/assize-graphs/short-intake-note.json' with { type: 'json' };
import tvOpenAfterClose from '../../src/assize-graphs/tv-open-after-close.json' with { type: 'json' };
import unknownPartner from '../../src/assize-graphs/unknown-partner.json' with { type: 'json' };
import unresponsive from '../../src/assize-graphs/unresponsive.json' with { type: 'json' };
import vzewDamage from '../../src/assize-graphs/vzew-damage.json' with { type: 'json' };
import vzewNotPhone from '../../src/assize-graphs/vzew-not-phone.json' with { type: 'json' };
import wearableCheckedIn from '../../src/assize-graphs/wearable-checked-in.json' with { type: 'json' };

export const GRAPHS = {
  'awaiting-item': awaitingItem,
  'buyout-has-charges': buyoutHasCharges,
  'buyout-not-phone': buyoutNotPhone,
  'buyout-still-open': buyoutStillOpen,
  'cci-not-15': cciNot15,
  'cci-zero-cart': cciZeroCart,
  'contact-due': contactDue,
  'data-risk-no-agreement': dataRiskNoAgreement,
  'date-not-updated': dateNotUpdated,
  'foldable-samsung-iw': foldableSamsungIw,
  'liquid-no-agreement': liquidNoAgreement,
  'missed-contact': missedContact,
  'no-bin': noBin,
  'no-date': noDate,
  'no-intake-note': noIntakeNote,
  'no-part-line': noPartLine,
  'no-priced-lines': noPricedLines,
  'no-quote': noQuote,
  'not-ordered': notOrdered,
  'not-started': notStarted,
  'not-started-3-days': notStarted3Days,
  'ntf-no-labor': ntfNoLabor,
  'oop-zero-cart': oopZeroCart,
  'parent-closed-cleaning-open': parentClosedCleaningOpen,
  'phone-on-home-plus': phoneOnHomePlus,
  'price-off-sheet': priceOffSheet,
  'short-intake-note': shortIntakeNote,
  'tv-open-after-close': tvOpenAfterClose,
  'unknown-partner': unknownPartner,
  'unresponsive': unresponsive,
  'vzew-damage': vzewDamage,
  'vzew-not-phone': vzewNotPhone,
  'wearable-checked-in': wearableCheckedIn,
};
