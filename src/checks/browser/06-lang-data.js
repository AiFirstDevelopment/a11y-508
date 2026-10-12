// Language codes the 11.A / 11.B checks validate the primary language subtag against, as data.
// Loaded after 00-core.js and before the checks (the bundle concatenates the files in name order).
//
// Written from the primary lists, not from any other tool's tables:
// - ISO 639-1 two-letter codes, as published by the ISO 639 Registration Authority (Library of
//   Congress, "Codes for the Representation of Names of Languages",
//   https://www.loc.gov/standards/iso639-2/php/code_list.php) and carried as language subtags in
//   the IANA Language Subtag Registry (https://www.iana.org/assignments/language-subtag-registry).
//   The subtags IANA marks deprecated (in, iw, ji, jw, mo) are kept apart with their replacements.
// - ISO 639-2 three-letter codes (terminological, and the bibliographic variants where they differ)
//   of languages that also have an ISO 639-1 code, from the same Library of Congress table: BCP 47
//   says to use the two-letter code when one exists.
// - A few country codes written in place of a language code (jp for ja, cn for zh ...), the
//   common mistakes the checks name the intended code for.
// Plain script (not a module); it runs inside the audited page.
(() => {
  const A = (window.__a11y508 = window.__a11y508 || {});

  // ISO 639-1: 185 two-letter subtags, bh (a collection) and sh (a macrolanguage) included, which IANA still registers.
  const ISO_639_1 = new Set((
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
    'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu ' +
    'hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb ' +
    'lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om ' +
    'or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg sh si sk sl sm sn so sq sr ss st su sv ' +
    'sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
  ).split(' '));

  // Deprecated two-letter subtags (IANA) and what replaced them.
  const DEPRECATED = { in: 'id', iw: 'he', ji: 'yi', jw: 'jv', mo: 'ro' };

  // Three-letter codes with a two-letter equivalent: ISO 639-2/T, plus /B where it differs.
  const THREE_TO_TWO = {};
  for (const pair of (
    'aar:aa abk:ab ave:ae afr:af aka:ak amh:am ara:ar arg:an asm:as ava:av aym:ay aze:az bak:ba bam:bm bel:be ' +
    'ben:bn bis:bi bod:bo tib:bo bos:bs bre:br bul:bg cat:ca ces:cs cze:cs cha:ch che:ce chu:cu chv:cv ' +
    'cor:kw cos:co cre:cr cym:cy wel:cy dan:da deu:de ger:de div:dv dzo:dz ell:el gre:el eng:en epo:eo ' +
    'est:et eus:eu baq:eu ewe:ee fao:fo fas:fa per:fa fij:fj fin:fi fra:fr fre:fr fry:fy ful:ff gla:gd ' +
    'gle:ga glg:gl glv:gv grn:gn guj:gu hat:ht hau:ha heb:he her:hz hin:hi hmo:ho hrv:hr hun:hu hye:hy ' +
    'arm:hy ibo:ig ido:io iii:ii iku:iu ile:ie ina:ia ind:id ipk:ik isl:is ice:is ita:it jav:jv jpn:ja ' +
    'kal:kl kan:kn kas:ks kat:ka geo:ka kau:kr kaz:kk khm:km kik:ki kin:rw kir:ky kom:kv kon:kg kor:ko ' +
    'kua:kj kur:ku lao:lo lat:la lav:lv lim:li lin:ln lit:lt ltz:lb lub:lu lug:lg mah:mh mal:ml mar:mr ' +
    'mkd:mk mac:mk mlg:mg mlt:mt mon:mn mri:mi mao:mi msa:ms may:ms mya:my bur:my nau:na nav:nv nbl:nr ' +
    'nde:nd ndo:ng nep:ne nld:nl dut:nl nno:nn nob:nb nor:no nya:ny oci:oc oji:oj ori:or orm:om oss:os ' +
    'pan:pa pli:pi pol:pl por:pt pus:ps que:qu roh:rm ron:ro rum:ro run:rn rus:ru sag:sg san:sa sin:si ' +
    'slk:sk slo:sk slv:sl sme:se smo:sm sna:sn snd:sd som:so sot:st spa:es sqi:sq alb:sq srd:sc srp:sr ' +
    'ssw:ss sun:su swa:sw swe:sv tah:ty tam:ta tat:tt tel:te tgk:tg tgl:tl tha:th tir:ti ton:to tsn:tn ' +
    'tso:ts tuk:tk tur:tr twi:tw uig:ug ukr:uk urd:ur uzb:uz ven:ve vie:vi vol:vo wln:wa wol:wo xho:xh ' +
    'yid:yi yor:yo zha:za zho:zh chi:zh zul:zu'
  ).split(' ')) {
    const [three, two] = pair.split(':');
    THREE_TO_TWO[three] = two;
  }

  // Country codes written where a language code belongs, and the language most likely meant.
  // Only codes that are not themselves ISO 639-1 codes (se, kr and uk are languages).
  const LIKELY = { jp: 'ja', cn: 'zh', gr: 'el', ua: 'uk', dk: 'da', cz: 'cs' };

  A.lang = { ISO_639_1, DEPRECATED, THREE_TO_TWO, LIKELY };
})();
