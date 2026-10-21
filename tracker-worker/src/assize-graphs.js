// Assize's built-in rule graphs (src/assize-graphs/*.json, the same files build.py inlines into Aethernet) for the
// Worker: the rules editor starts from them. A new file there needs a line here (a test checks).
import cciNot15 from '../../src/assize-graphs/cci-not-15.json' with { type: 'json' };
import cciZeroCart from '../../src/assize-graphs/cci-zero-cart.json' with { type: 'json' };
import noIntakeNote from '../../src/assize-graphs/no-intake-note.json' with { type: 'json' };
import oopZeroCart from '../../src/assize-graphs/oop-zero-cart.json' with { type: 'json' };
import shortIntakeNote from '../../src/assize-graphs/short-intake-note.json' with { type: 'json' };

export const GRAPHS = { 'cci-not-15': cciNot15, 'cci-zero-cart': cciZeroCart, 'no-intake-note': noIntakeNote, 'oop-zero-cart': oopZeroCart, 'short-intake-note': shortIntakeNote };
