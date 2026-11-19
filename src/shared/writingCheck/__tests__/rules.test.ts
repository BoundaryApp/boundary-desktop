import { describe, expect, it } from 'vitest';
import { checkText } from '../checkText';
import { RULES } from '../rules';

/** [rule id, text that trips it, a near miss that doesn't]. */
const CASES: Array<[string, string, string]> = [
  ['significance', 'The launch marked a pivotal moment for the team.', 'The launch moved the date by a week.'],
  ['ai-vocabulary', 'We delve into the intricate details.', 'We dig into the details of the landscape painting.'],
  ['cliches', 'At the end of the day, the build passed.', 'By the end of the day the build passed.'],
  ['promotional', 'The cabin is nestled in breathtaking hills.', 'The cabin sits in the hills.'],
  ['copula-avoidance', 'The room serves as a studio.', 'The room is a studio. It serves lunch.'],
  ['vague-attribution', 'Experts believe the river matters.', 'A 2019 survey found three fish species.'],
  ['authority-tropes', 'At its core, this is about trust.', 'The core team met on Tuesday.'],
  ['filler', 'In order to start, run the script.', 'To start, run the script in order.'],
  ['hedging', 'The change could potentially help.', 'The change could help.'],
  ['negative-parallelism', "It's not just a tool, it's a mindset.", 'The tool is fast, and the docs are short.'],
  ['tailing-negation', 'The options come from the selected item, no guessing.', 'No one guessed the options.'],
  ['ing-tail', 'The colors match the hills, reflecting a deep bond with the land.', 'Reflecting on it, the colors match.'],
  [
    'rule-of-three',
    'It brings speed, focus, and clarity. Teams gain trust, insight, and momentum.',
    'Use red, green, and blue for the three states.',
  ],
  [
    'false-range',
    'We went from the Big Bang to cosmic webs, from stars to dark matter.',
    'Prices run from 5 to 10 dollars.',
  ],
  ['em-dashes', 'One — two — three words here.', 'One — two, three words here and many more after that to dilute it well past a hundred words. ' + 'word '.repeat(100)],
  ['dramatic-fragments', 'The catalog is priced by use. Pay less. No promises. It works.', 'It works. The catalog is priced by how much you use it each month.'],
  ['rhetorical-question', 'What makes an API good? Predictability.', 'Is the API stable? We tested it for two weeks across three releases and found no breaks.'],
  ['chatbot-artifacts', 'Here is the plan. I hope this helps!', 'Here is the plan for Tuesday.'],
  ['chatbot-opener', 'Certainly! The file is ready.', 'It is certainly ready.'],
  ['cutoff-disclaimer', 'Based on available information, it opened in 1994.', 'Its registration says it opened in 1994.'],
  ['signposting', "Let's dive into caching.", 'Next.js caches data in three layers.'],
  ['generic-conclusion', 'In conclusion, the future looks bright.', 'The conclusion section lists two open bugs.'],
  ['opener-tics', 'Interestingly, adoption rose.', 'Adoption rose, interestingly enough.'],
  ['reassurance', "You might not have tests yet. And that's okay.", 'You might not have tests yet.'],
  ['challenges-section', 'Despite these challenges, the town thrives.', 'The town faces a flood every spring.'],
  [
    'even-rhythm',
    'The team met on Monday morning. The plan was set by noon today. The build ran for an hour then. The tests all passed on first try. The release went out that evening.',
    'We met. The plan took most of the morning because nobody agreed on the order. Then the build ran. The tests passed on the first try, which surprised everyone in the room. Release went out at six.',
  ],
  [
    'inline-header-list',
    '- **Speed:** faster\n- **Quality:** better\n- **Security:** stronger',
    '- Speed is faster\n- **Quality:** better\n- Security is stronger',
  ],
  ['emoji', '## 🚀 Launch plan\n\nText here.', '## Launch plan\n\nShipped it 🎉 on time.'],
  ['title-case-heading', '## Strategic Negotiations And Global Partnerships', '## Strategic negotiations and global partnerships'],
  [
    'bold-overuse',
    'It blends **OKRs**, **KPIs** and the **Business Model Canvas** in one plan.',
    'It blends **OKRs** and KPIs with the Business Model Canvas into one plan for the whole quarter ahead.',
  ],
  [
    'fragmented-header',
    '## Performance\n\nSpeed matters.\n\nWhen pages are slow, people leave.',
    '## Performance\n\nWhen pages are slow, people leave.\n\nWe cut load time in half.',
  ],
];

const rulesFound = (text: string) => new Set(checkText(text).flags.map((f) => f.rule));

describe('writing check rules', () => {
  it('has a case for every rule', () => {
    expect(new Set(CASES.map(([id]) => id))).toEqual(new Set(RULES.map((r) => r.id)));
  });

  it.each(CASES)('%s trips on its example', (id, trips) => {
    expect(rulesFound(trips)).toContain(id);
  });

  it.each(CASES)('%s ignores its near miss', (id, _trips, nearMiss) => {
    expect(rulesFound(nearMiss)).not.toContain(id);
  });

  it('never flags code, inline code or quoted text', () => {
    const markdown = [
      'Plain words here.',
      '',
      '```',
      "Let's dive in. I hope this helps! It delves into a rich tapestry.",
      '```',
      '',
      'Run `delve --tapestry` now.',
      '',
      '> Certainly! In conclusion, the future looks bright.',
    ].join('\n');
    expect(checkText(markdown).flags).toEqual([]);
  });

  it('points each flag at the source characters, through markup', () => {
    const markdown = 'Intro line.\n\n- **Note:** we *delve* into the [intricate](https://x.test) parts';
    const words = checkText(markdown)
      .flags.filter((f) => f.rule === 'ai-vocabulary')
      .map((f) => markdown.slice(f.start, f.end));
    expect(words).toEqual(['delve', 'intricate']);
  });

  it('leaves decision lists with bold lead sentences alone', () => {
    const markdown = [
      '1. **Replies are inline.** A reply sits under the post it answers.',
      '2. **Same channel only.** A reply never crosses into another channel.',
      '3. **Format 3 adds a field.** Older peers ignore it.',
    ].join('\n');
    expect(rulesFound(markdown)).not.toContain('inline-header-list');
  });

  it('does not read label lines as dramatic fragments', () => {
    const markdown = 'Status: Accepted. Date: 3 Nov. Spec: [link](../spec.md). Owner: the app team.';
    expect(rulesFound(markdown)).not.toContain('dramatic-fragments');
  });

  it('withholds the density under 50 words', () => {
    const short = checkText('I hope this helps!');
    expect(short.flags.length).toBe(1);
    expect(short.perHundredWords).toBeNull();
  });
});
