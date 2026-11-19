/**
 * The writing check's rules (writing check spec, phase 1).
 *
 * Each rule finds one pattern common in model output. Rule ids follow the numbered patterns of
 * the `humanizer` skill bundled with Hermes Agent, so a flag here and a humanizer pass use the
 * same names. That skill is a port of blader/humanizer (MIT, copyright (c) 2025 Siqi Chen),
 * based on Wikipedia's "Signs of AI writing"; the phrase lists below are drawn from it.
 *
 * Patterns left out because a rule can't tell them from ordinary writing: notability claims
 * (2), synonym cycling (11), passive voice (13), curly quotes (19, which macOS and Word add to
 * human text), hyphenated pairs (26) and forced metaphors (30).
 *
 * Every pattern is linear: alternations of literals and bounded lazy gaps, no nested
 * quantifiers.
 */

import { sourceSpan, type ProseBlock } from './prose';

export type Category = 'words' | 'shapes' | 'framing' | 'rhythm' | 'formatting';

export interface Span {
  start: number;
  end: number;
}

export interface Rule {
  id: string;
  /** The humanizer skill's pattern number; none for rules it doesn't number. */
  pattern?: number;
  category: Category;
  title: string;
  reason: string;
  find(blocks: ProseBlock[]): Span[];
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function countWords(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

interface Sentence {
  start: number;
  end: number;
  words: number;
  question: boolean;
}

/** Sentences of a block's text, split after . ! ? (and closing quotes) followed by space. */
function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const ends = /[.!?]+["'’”)\]]*(?=\s|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;
  const push = (from: number, to: number) => {
    const lead = /^\s*/.exec(text.slice(from, to))?.[0].length ?? 0;
    const piece = text.slice(from + lead, to);
    if (piece.trim()) {
      out.push({ start: from + lead, end: to, words: countWords(piece), question: /\?["'’”)\]]*$/.test(piece) });
    }
  };
  while ((match = ends.exec(text)) !== null) {
    push(start, match.index + match[0].length);
    start = match.index + match[0].length;
  }
  push(start, text.trimEnd().length);
  return out;
}

const PROSE_KINDS = new Set(['paragraph', 'listItem']);

function matchSpans(blocks: ProseBlock[], regex: RegExp, kinds = PROSE_KINDS): Span[] {
  const spans: Span[] = [];
  for (const block of blocks) {
    if (!kinds.has(block.kind)) continue;
    for (const match of block.text.matchAll(regex)) {
      const at = match.index ?? 0;
      const lead = match[0].length - match[0].trimStart().length;
      const end = at + match[0].trimEnd().length;
      if (end > at + lead) spans.push(sourceSpan(block, at + lead, end));
    }
  }
  return spans;
}

/** Whole-word, case-insensitive alternation of regex fragments; spaces match any run of spaces. */
function phrases(list: string[]): RegExp {
  const body = list.map((p) => p.replace(/ /g, '\\s+')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}'’])(?:${body})(?![\\p{L}\\p{N}])`, 'giu');
}

/** Like `phrases`, but only at the start of a sentence. */
function openers(list: string[]): RegExp {
  return new RegExp(`(?<=^|[.!?]["'’”)\\]]?\\s+)(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

function phraseRule(
  id: string,
  pattern: number | undefined,
  category: Category,
  title: string,
  reason: string,
  regex: RegExp
): Rule {
  return { id, pattern, category, title, reason, find: (blocks) => matchSpans(blocks, regex) };
}

const totalWords = (blocks: ProseBlock[]) => blocks.reduce((n, b) => n + countWords(b.text), 0);

// ---- Words -------------------------------------------------------------------------------

const significance = phraseRule(
  'significance',
  1,
  'words',
  'Inflated significance',
  'Claims that something marks a turning point or shows a broader trend, where a plain fact would do.',
  phrases([
    'stands as a testament',
    '(?:is|was|serves as|remains) a testament to',
    '(?:a|an) (?:enduring|lasting|powerful) testament',
    '(?:pivotal|vital|crucial|key|significant) (?:role|moment)',
    '(?:underscores|highlights|underscoring|highlighting) (?:the|its|their) (?:importance|significance)',
    'reflects broader',
    'setting the stage for',
    '(?:marking|marks|marked) a (?:pivotal |significant |key )?(?:shift|turning point|milestone)',
    'evolving landscape',
    'indelible mark',
    'deeply rooted',
    'enduring legacy',
  ])
);

const vocabulary = phraseRule(
  'ai-vocabulary',
  7,
  'words',
  'Model vocabulary',
  'A word that shows up far more often in model output than in human writing.',
  phrases([
    'delve',
    'delves',
    'delved',
    'delving',
    'tapestry',
    'testament',
    'intricate',
    'intricacies',
    'interplay',
    'pivotal',
    'underscores?',
    'underscored',
    'underscoring',
    'fosters?',
    'fostered',
    'fostering',
    'garner(?:s|ed|ing)?',
    'showcases?',
    'showcased',
    'showcasing',
    'multifaceted',
    'realm',
    'meticulous(?:ly)?',
    'seamless(?:ly)?',
    '(?:digital|evolving|ever-changing|ever-evolving|competitive|technological|modern|regulatory|business) landscape',
    'navigat(?:e|ing) the (?:complexities|intricacies)',
  ])
);

const cliches = phraseRule(
  'cliches',
  7,
  'words',
  'Stock phrase',
  'A blog or marketing cliché that stands in for a specific statement.',
  phrases([
    'at the end of the day',
    'in a world where',
    'game[- ]changer',
    'deep dive',
    'double down',
    'lean into',
    'make no mistake',
    'let me be clear',
    'moving forward',
    'circle back',
  ])
);

const promotional = phraseRule(
  'promotional',
  4,
  'words',
  'Promotional tone',
  'Advertising language where a neutral description would do.',
  phrases([
    'boasts (?:a|an)',
    'nestled',
    'in the heart of',
    'breathtaking',
    'must-visit',
    'rich (?:cultural )?(?:heritage|history|tapestry)',
    'commitment to excellence',
    'renowned',
    'stunning',
    'groundbreaking',
  ])
);

const copula = phraseRule(
  'copula-avoidance',
  8,
  'words',
  'Avoids "is"',
  'An elaborate verb where "is" or "has" says the same thing.',
  phrases(['(?:serves|stands|functions) as (?:a|an|the)'])
);

const attribution = phraseRule(
  'vague-attribution',
  5,
  'words',
  'Vague attribution',
  'An opinion credited to unnamed experts or reports.',
  phrases([
    'experts (?:say|believe|argue|agree|note)',
    '(?:industry )?observers (?:have )?(?:noted|cited|said)',
    'industry reports',
    'some critics (?:argue|say)',
  ])
);

const authority = phraseRule(
  'authority-tropes',
  27,
  'words',
  'False depth',
  'A phrase that promises a deeper truth before an ordinary point.',
  phrases(['the real question is', 'at its core', 'what really matters', 'the heart of the matter', 'the deeper issue'])
);

const filler = phraseRule(
  'filler',
  23,
  'words',
  'Filler phrase',
  'Words that can go without changing the meaning.',
  phrases([
    'in order to',
    'due to the fact that',
    'at this point in time',
    'in the event that',
    'has the ability to',
    "it(?:'|’)?s important to note(?: that)?",
    'it is important to note(?: that)?',
    "it(?:'|’)?s worth (?:noting|mentioning)(?: that)?",
    'it is worth (?:noting|mentioning)(?: that)?',
  ])
);

const hedging = phraseRule(
  'hedging',
  24,
  'words',
  'Stacked hedges',
  'More qualifiers than the claim needs.',
  phrases(['(?:could|might|may) potentially', 'could possibly', 'potentially possibly', 'it could be argued'])
);

// ---- Sentence shapes ---------------------------------------------------------------------

const negativeParallelism = phraseRule(
  'negative-parallelism',
  9,
  'shapes',
  '"Not X, but Y"',
  'A contrast set up only to be knocked down.',
  phrases([
    "not just (?:about )?[^.?!]{1,60}?[,;—–]\\s*(?:it(?:'|’)?s|it is|but)",
    'not only[^.?!]{1,80}?but(?: also)?',
    'not merely',
    "(?:it(?:'|’)?s|it is|this is) not [^.?!]{1,40}?[,;—–]\\s*(?:it(?:'|’)?s|it is|this is)",
  ])
);

const tailingNegation = phraseRule(
  'tailing-negation',
  9,
  'shapes',
  'Tacked-on "no X"',
  'A clipped "no X" fragment at the end of a sentence instead of a clause.',
  /,\s+no\s+[\p{L}'’-]+(?:\s+[\p{L}'’-]+)?(?=[.!])/gu
);

const ingTail = phraseRule(
  'ing-tail',
  3,
  'shapes',
  'Trailing "-ing" commentary',
  'A participle clause added after the fact to sound insightful.',
  /,\s+(?:highlighting|underscoring|emphasizing|reflecting|symbolizing|showcasing|fostering|ensuring|contributing to|cementing|solidifying)(?![\p{L}])/giu
);

const TRIPLE = /(?<![\p{L}\p{N}])[\p{L}'’-]+(?: [\p{L}'’-]+)?, [\p{L}'’-]+(?: [\p{L}'’-]+)?,? and [\p{L}'’-]+(?: [\p{L}'’-]+)?(?![\p{L}])/gu;

const ruleOfThree: Rule = {
  id: 'rule-of-three',
  pattern: 10,
  category: 'shapes',
  title: 'Groups of three',
  reason: 'Ideas forced into threes again and again in one paragraph.',
  find(blocks) {
    return blocks.flatMap((block) => {
      if (!PROSE_KINDS.has(block.kind)) return [];
      const hits = matchSpans([block], TRIPLE);
      return hits.length >= 2 && hits.length * 40 >= countWords(block.text) ? hits : [];
    });
  },
};

const falseRange = phraseRule(
  'false-range',
  12,
  'shapes',
  'False range',
  '"From X to Y" pairs where X and Y are not ends of a scale.',
  /\bfrom [^.?!,]{1,40}? to [^.?!,]{1,40}?, from [^.?!,]{1,40}? to\b/giu
);

const DASH = /—|\s–\s|\s--\s/g;

const emDashes: Rule = {
  id: 'em-dashes',
  pattern: 14,
  category: 'shapes',
  title: 'Many dashes',
  reason: 'More than one dash per 100 words; most read better as commas, periods or parentheses.',
  find(blocks) {
    const spans = matchSpans(blocks, DASH);
    const words = totalWords(blocks);
    return spans.length >= 2 && spans.length * 100 > words ? spans : [];
  },
};

const fragments: Rule = {
  id: 'dramatic-fragments',
  pattern: 31,
  category: 'shapes',
  title: 'Dramatic fragments',
  reason: 'A run of very short sentences used for punch.',
  find(blocks) {
    const spans: Span[] = [];
    for (const block of blocks) {
      if (block.kind !== 'paragraph') continue;
      let run: Sentence[] = [];
      const close = () => {
        if (run.length >= 3) spans.push(sourceSpan(block, run[0].start, run[run.length - 1].end));
        run = [];
      };
      for (const sentence of sentences(block.text)) {
        if (sentence.words <= 3 && !block.text.slice(sentence.start, sentence.end).includes(':')) run.push(sentence);
        else close();
      }
      close();
    }
    return spans;
  },
};

const rhetorical: Rule = {
  id: 'rhetorical-question',
  pattern: 32,
  category: 'shapes',
  title: 'Question answered at once',
  reason: 'A question posed only to be answered in the next breath.',
  find(blocks) {
    const spans: Span[] = matchSpans(blocks, phrases(['think about it']));
    for (const block of blocks) {
      if (!PROSE_KINDS.has(block.kind)) continue;
      const list = sentences(block.text);
      list.forEach((sentence, index) => {
        const next = list[index + 1];
        if (sentence.question && sentence.words <= 10 && next && !next.question && next.words <= 8) {
          spans.push(sourceSpan(block, sentence.start, next.end));
        }
      });
    }
    return spans;
  },
};

// ---- Framing -----------------------------------------------------------------------------

const chatbot = phraseRule(
  'chatbot-artifacts',
  20,
  'framing',
  'Chatbot phrasing',
  'Correspondence with the reader (praise, offers, sign-offs) left in the text.',
  phrases([
    'great question',
    'excellent question',
    "you(?:'|’)?re absolutely right",
    'you are absolutely right',
    'i hope this helps',
    'let me know if',
    'feel free to (?:ask|reach out)',
    'happy to help',
    'would you like me to',
    'here is (?:a|an) (?:overview|summary|breakdown)',
    "here(?:'|’)?s (?:a|an) (?:overview|summary|breakdown)",
  ])
);

const certainly = phraseRule(
  'chatbot-opener',
  20,
  'framing',
  'Chatbot opener',
  'An eager one-word reply opening the text.',
  openers(['Certainly!', 'Of course!', 'Absolutely!'].map((w) => w.replace('!', '(?=!)')))
);

const cutoff = phraseRule(
  'cutoff-disclaimer',
  21,
  'framing',
  'Knowledge-cutoff disclaimer',
  'A model disclaimer about missing information left in the text.',
  phrases([
    'as of my (?:last|latest) (?:training|knowledge) (?:update|cutoff)',
    'my knowledge cutoff',
    'up to my last training',
    'while specific details (?:are|about [^.?!]{1,60}? are) (?:limited|scarce)',
    'based on (?:the )?available information',
    'not extensively documented',
  ])
);

const signposting = phraseRule(
  'signposting',
  28,
  'framing',
  'Announces instead of saying',
  'A line that says what is coming instead of saying it.',
  phrases([
    "let(?:'|’)?s dive (?:in|into)",
    "let(?:'|’)?s explore",
    "let(?:'|’)?s break (?:this|it) down",
    "let(?:'|’)?s take a (?:closer )?look",
    "here(?:'|’)?s what you need to know",
    'without further ado',
    "now let(?:'|’)?s look at",
  ])
);

const conclusion: Rule = {
  id: 'generic-conclusion',
  pattern: 25,
  category: 'framing',
  title: 'Summary or upbeat ending',
  reason: 'A closing summary or a vague positive ending that adds nothing new.',
  find: (blocks) => [
    ...matchSpans(blocks, openers(['In conclusion', 'In summary', 'To sum up', 'All in all', 'Overall(?=,)', 'Ultimately(?=,)'])),
    ...matchSpans(
      blocks,
      phrases([
        'the future (?:looks|is) bright',
        'exciting times (?:lie|are) ahead',
        '(?:a|an) (?:major |important )?step in the right direction',
        'journey toward',
      ])
    ),
  ],
};

const openerTics = phraseRule(
  'opener-tics',
  33,
  'framing',
  'Adverb opener',
  'A sentence that opens by telling the reader how to feel about it.',
  openers(['Interestingly', 'Importantly', 'Notably', 'Crucially', 'Essentially', 'Additionally', 'Furthermore', 'Moreover'].map((w) => `${w}(?=,)`))
);

const reassurance = phraseRule(
  'reassurance',
  34,
  'framing',
  'Unasked reassurance',
  'Comfort the reader did not ask for.',
  phrases([
    "and that(?:'|’)?s (?:okay|ok|fine)",
    "there(?:'|’)?s nothing wrong with that",
    "you(?:'|’)?re not alone",
    "it(?:'|’)?s (?:completely|perfectly) normal",
    'no shame in',
  ])
);

const challenges = phraseRule(
  'challenges-section',
  6,
  'framing',
  'Formulaic challenges',
  'A stock "despite its challenges, it thrives" passage.',
  phrases([
    'despite (?:these|its|the|their) challenges',
    'faces (?:several|many|numerous) challenges',
    'challenges and (?:future )?(?:prospects|outlook)',
    'future outlook',
  ])
);

// ---- Rhythm ------------------------------------------------------------------------------

const evenRhythm: Rule = {
  id: 'even-rhythm',
  category: 'rhythm',
  title: 'Even sentence lengths',
  reason: 'Five or more sentences of nearly the same length in a row.',
  find(blocks) {
    const spans: Span[] = [];
    for (const block of blocks) {
      if (block.kind !== 'paragraph') continue;
      const list = sentences(block.text);
      if (list.length < 5) continue;
      const lengths = list.map((s) => s.words);
      const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
      if (mean > 0 && sd / mean < 0.25) spans.push(sourceSpan(block, list[0].start, list[list.length - 1].end));
    }
    return spans;
  },
};

// ---- Formatting --------------------------------------------------------------------------

const BOLD_LEAD = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\p{Extended_Pictographic}️?\s*)?)(?:(\*\*|__)[^*_\n:.]{1,40}?:\2|(\*\*|__)[^*_\n:.]{1,40}?\3:)/u;

const inlineHeaders: Rule = {
  id: 'inline-header-list',
  pattern: 16,
  category: 'formatting',
  title: 'Bold lead-in on every bullet',
  reason: 'Most items of a list start with a bold label and a colon, where a sentence or table would read better.',
  find(blocks) {
    const spans: Span[] = [];
    let run: ProseBlock[] = [];
    const close = () => {
      const leads = run.flatMap((item) => {
        const match = BOLD_LEAD.exec(item.raw);
        if (!match) return [];
        const start = item.sourceStart + match[1].length;
        return [{ start, end: start + match[0].length - match[1].length }];
      });
      if (run.length >= 3 && leads.length * 3 >= run.length * 2) spans.push(...leads);
      run = [];
    };
    for (const block of blocks) {
      if (block.kind === 'listItem') run.push(block);
      else close();
    }
    close();
    return spans;
  },
};

const EMOJI = /\p{Extended_Pictographic}/gu;

const emoji: Rule = {
  id: 'emoji',
  pattern: 18,
  category: 'formatting',
  title: 'Emoji decoration',
  reason: 'Emoji used to decorate headings or bullets.',
  find(blocks) {
    const spans: Span[] = [];
    for (const block of blocks) {
      if (block.kind === 'heading') spans.push(...matchSpans([block], EMOJI, new Set(['heading'])));
      else if (block.kind === 'listItem' && /^\p{Extended_Pictographic}/u.test(block.text)) {
        spans.push(sourceSpan(block, 0, (block.text.codePointAt(0) ?? 0) > 0xffff ? 2 : 1));
      }
    }
    return spans;
  },
};

const SMALL_WORDS = new Set(
  'a an and as at but by for from in into nor of on or per the to vs via with'.split(' ')
);

const titleCase: Rule = {
  id: 'title-case-heading',
  pattern: 17,
  category: 'formatting',
  title: 'Title Case heading',
  reason: 'Every main word of the heading is capitalized.',
  find(blocks) {
    return blocks.flatMap((block) => {
      if (block.kind !== 'heading') return [];
      const words = block.text.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
      const rest = words.slice(1).filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
      const capitalized = rest.filter((w) => /^\p{Lu}/u.test(w) && w !== w.toUpperCase());
      return words.length >= 4 && rest.length >= 3 && capitalized.length === rest.length
        ? [sourceSpan(block, 0, block.text.length)]
        : [];
    });
  },
};

const BOLD = /(\*\*|__)(?=\S)[^*_\n]{1,80}?\1/g;

const boldOveruse: Rule = {
  id: 'bold-overuse',
  pattern: 15,
  category: 'formatting',
  title: 'Heavy bold',
  reason: 'More than two bold phrases per 100 words of a paragraph.',
  find(blocks) {
    return blocks.flatMap((block) => {
      if (block.kind !== 'paragraph') return [];
      const hits = [...block.raw.matchAll(BOLD)].map((m) => ({
        start: block.sourceStart + (m.index ?? 0),
        end: block.sourceStart + (m.index ?? 0) + m[0].length,
      }));
      return hits.length >= 3 && hits.length * 100 > 2 * countWords(block.text) ? hits : [];
    });
  },
};

const fragmentedHeader: Rule = {
  id: 'fragmented-header',
  pattern: 29,
  category: 'formatting',
  title: 'Warm-up line after a heading',
  reason: 'A one-line paragraph under a heading before the real content starts.',
  find(blocks) {
    const spans: Span[] = [];
    blocks.forEach((block, index) => {
      const next = blocks[index + 1];
      const after = blocks[index + 2];
      if (block.kind !== 'heading' || next?.kind !== 'paragraph' || !after || after.kind === 'heading') return;
      const list = sentences(next.text);
      if (list.length !== 1) return;
      const stems = (text: string) =>
        new Set(
          (text.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []).map((w) => w.slice(0, 4))
        );
      const headingStems = stems(block.text);
      const echoes = [...stems(next.text)].some((s) => headingStems.has(s));
      if (list[0].words <= 4 || (list[0].words <= 8 && echoes)) {
        spans.push(sourceSpan(next, 0, next.text.length));
      }
    });
    return spans;
  },
};

/** Bumped when a rule is added, removed or retuned, so cached results go stale. */
export const RULE_SET_VERSION = 1;

export const RULES: Rule[] = [
  significance,
  vocabulary,
  cliches,
  promotional,
  copula,
  attribution,
  authority,
  filler,
  hedging,
  negativeParallelism,
  tailingNegation,
  ingTail,
  ruleOfThree,
  falseRange,
  emDashes,
  fragments,
  rhetorical,
  chatbot,
  certainly,
  cutoff,
  signposting,
  conclusion,
  openerTics,
  reassurance,
  challenges,
  evenRhythm,
  inlineHeaders,
  emoji,
  titleCase,
  boldOveruse,
  fragmentedHeader,
];
