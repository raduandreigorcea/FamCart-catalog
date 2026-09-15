// Packs that make no sense on a shopping list: gift sets, and a product sold
// together with an object that is not a grocery.
//
// "Whisky 0.7 l + 2 glasses", "Beer 5 x 0.5 l + cooler bag", "Milk 5 x 1 l +
// toy", "Gift set: shower gel + deodorant + wash bag". A shop lists them beside
// the plain product, in the same grocery department, so no department rule can
// tell them apart -- only the name can. Nobody writes "whisky with two glasses"
// on a list; they write whisky, and the plain bottle is still in the catalog.
//
// This is the ONE rule in the catalog read from a product's name, and it is kept
// narrow on purpose, because a name guesses. Read from every match in the live
// catalog on 2026-09-15 before it was written:
//
//   * a GIFT SET by its own words ("set pentru cadou", "pachet cadou"), which is
//     how the shops label them;
//   * a QUANTITY OF SOMETHING, then "+", then an OBJECT: "0.7 l + 2 pahare";
//   * or "+ OBJECT" at the end of the name of something drunk or eaten, for the
//     names that put the quantity last ("Gin Bombay + pahar, 47.5% alc., 0.7L").
//
// What it deliberately leaves alone: "2 x 2 l + Coca-Cola Zero" (two groceries),
// "+/- 1 kg" and "6 luni+" (not a pack at all), "Men+Care" (a product line), a
// carafe sold with cups (kitchenware, which is kept), and a bottle "+ Gift Box"
// (packaging, not an object).

const fold = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const GIFT_SET = /\b(set|pachet|cutie|caseta)\s+(de\s+|pentru\s+)?cadou\b|\bgift\s*set\b/

const OBJECTS =
  'pahar|pahare|halba|halbe|geanta|tricou|sosete|carte|colorat|ceasca|cesti|farfuri|cana|cani|jucari|' +
  'breloc|umbrel|prosop|minge|sapca|figurin|magnet|termos|boxa|casti|stickere|suport|tava'

const QUANTITY_PLUS_OBJECT = new RegExp(`\\d+([.,]\\d+)?\\s?(l|ml|g|kg|cl)\\b[^+]*\\+[^+]*(${OBJECTS})`)

const PLUS_OBJECT_AT_END =
  /\+[^+]*(pahar|pahare|halba|halbe|geanta|tricou|sosete|carte|colorat|ceasca|jucari|breloc|umbrel|minge|sapca|figurin|magnet)[^+]*$/

const CONSUMABLE =
  /(bere|vin|whisk|coniac|brandy|vodka|vodca|gin|rom|lichior|aperitiv|digestiv|campari|baileys|metaxa|cafea|ceai|ciocolat|bautur|suc|apa|lapte|cereale|biscuit|bomboan|nesquik)/

const KITCHENWARE = /^(set\s+\d+\s+boluri|set\s+carafa|carafa)\b/

export function isBundle(name: string): boolean {
  const n = fold(name)
  if (GIFT_SET.test(n)) return true
  if (!n.includes('+') || KITCHENWARE.test(n)) return false
  return QUANTITY_PLUS_OBJECT.test(n) || (PLUS_OBJECT_AT_END.test(n) && CONSUMABLE.test(n))
}
