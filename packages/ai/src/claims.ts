/**
 * Coverage claims: statements about what the brand does or does not offer ("we only ship within the United States",
 * "we do not accept Bitcoin"). A model that is asked something the policies do not cover tends to answer from general
 * knowledge, which for a customer reads as the brand's official position. A claim is allowed only when the policy
 * sources actually mention what it is about.
 */
import { splitSentences } from './procedure.js';

/** "we ... do not / only / cannot ... ship / accept / offer ..." and "we accept various ...". */
const COVERAGE_CLAIM = new RegExp(
  String.raw`\b(?:we|our\s+(?:store|shop|company|team|website|site))\b[^.!?]{0,30}?\b(?:(?:do\s+not|don['’]t|does\s+not|doesn['’]t|cannot|can['’]t|never|currently\s+only|only|no\s+longer)\s+(?:currently\s+)?(?:ship|deliver|accept|offer|sell|provide|support|take|carry|serve)|(?:accept|offer|ship\s+to|deliver\s+to)\s+(?:various|several|many|most|all|any|multiple|other)\b)(?<rest>[^.!?]*)`,
  'i',
);
/** Cases like "we only ship within ..." where the verb itself follows "only". */
const ONLY_SHIP =
  /\b(?:we|our\s+\w+)\s+(?:currently\s+)?only\s+(?:ship|deliver)\b(?<rest>[^.!?]*)/i;

const GENERIC = new Set(
  (
    'about above also another because being below could currently customer customers does doesnt dont each from ' +
    'have here into items item just like make many more most much must never only option options order orders other ' +
    'others please present service services should some such than that their them then there these they this those ' +
    'time very various want were what when where which while will with within without would your yours you ' +
    'ship ships shipping shipped deliver delivery delivers accept accepts offer offers sell provide support method ' +
    'methods available moment right now since'
  ).split(' '),
);

const SOURCE_PREFIX = 6;

/** Distinctive words of a claim (names, places, products, methods) that the sources never mention. */
function missingTerms(rest: string, sourceLower: string): string[] {
  const words = rest.toLowerCase().match(/[\p{L}][\p{L}'’-]{3,}/gu) ?? [];
  return [
    ...new Set(
      words.filter((w) => !GENERIC.has(w) && !sourceLower.includes(w.slice(0, SOURCE_PREFIX))),
    ),
  ];
}

export interface UnsupportedClaim {
  sentence: string;
  missing: string[];
}

export function findUnsupportedCoverageClaims(
  reply: string,
  sourceText: string,
): UnsupportedClaim[] {
  const sourceLower = sourceText.toLowerCase();
  const out: UnsupportedClaim[] = [];
  for (const sentence of splitSentences(reply)) {
    const m = COVERAGE_CLAIM.exec(sentence) ?? ONLY_SHIP.exec(sentence);
    if (!m) continue;
    const missing = missingTerms(m.groups?.rest ?? '', sourceLower);
    if (missing.length > 0) out.push({ sentence, missing });
  }
  return out;
}
