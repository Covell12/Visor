// lib/cite.js (= public/cite-format.js): MLA 9, APA 7 and Chicago entries and
// in-text citations, compared with hand-checked strings.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/cite');

const accessed = '2026-10-12';
const F = {
  one: { type: 'article', title: 'Why Teens Can’t Fall Asleep Before 11', authors: ['Maria Lopez'], published: '2023-09-05', siteName: 'The Example Times', publisher: 'Example Media Group', url: 'https://www.example-times.com/2023/09/05/health/teens-sleep.html' },
  two: { type: 'article', title: 'Later School Start Times Pay Off', authors: ['Maria Lopez', 'Dan Brooks'], published: '2024-01-15', siteName: 'The Example Times', url: 'https://www.example-times.com/2024/01/15/start-times.html' },
  three: { type: 'article', title: 'What Sleep Researchers Agree On', authors: ['Maria Lopez', 'Dan Brooks', 'Priya Shah'], published: '2022-03-02', siteName: 'Science Daily Example', url: 'https://www.sciencedaily.example/news/sleep.htm' },
  noAuthor: { type: 'webpage', title: 'How Much Sleep Do Teens Need?', authors: [], published: '2021-06-10', siteName: 'Sleep Foundation', url: 'https://www.sleepfoundation.example/teens-and-sleep' },
  noDate: { type: 'webpage', title: 'Sleep and Your Health', authors: ['Jordan Reyes'], siteName: 'Healthy Teens Blog', url: 'https://healthyteens.example.org/sleep' },
  journal: { type: 'journal', title: 'Delaying School Start Times and Adolescent Sleep', authors: ['Wahlstrom, Kyla L.', 'Owens, Judith A.'], published: '2017-06-15', journal: 'Journal of Adolescent Health', volume: '60', issue: '6', pages: '627-633', doi: '10.1016/j.jadohealth.2017.01.011', publisher: 'Elsevier', url: 'https://www.jahonline.org/article/x' },
  video: { type: 'video', title: 'Why Do We Sleep?', authors: ['Example Science'], published: '2019-05-12', siteName: 'YouTube', url: 'https://www.youtube.com/watch?v=abc123' }
};

const WANT = {
  mla: {
    one: ['Lopez, Maria. “Why Teens Can’t Fall Asleep Before 11.” The Example Times, Example Media Group, 5 Sept. 2023, www.example-times.com/2023/09/05/health/teens-sleep.html. Accessed 12 Oct. 2026.', '(Lopez)'],
    two: ['Lopez, Maria, and Dan Brooks. “Later School Start Times Pay Off.” The Example Times, 15 Jan. 2024, www.example-times.com/2024/01/15/start-times.html. Accessed 12 Oct. 2026.', '(Lopez and Brooks)'],
    three: ['Lopez, Maria, et al. “What Sleep Researchers Agree On.” Science Daily Example, 2 Mar. 2022, www.sciencedaily.example/news/sleep.htm. Accessed 12 Oct. 2026.', '(Lopez et al.)'],
    noAuthor: ['“How Much Sleep Do Teens Need?” Sleep Foundation, 10 June 2021, www.sleepfoundation.example/teens-and-sleep. Accessed 12 Oct. 2026.', '(“How Much Sleep Do Teens Need?”)'],
    noDate: ['Reyes, Jordan. “Sleep and Your Health.” Healthy Teens Blog, healthyteens.example.org/sleep. Accessed 12 Oct. 2026.', '(Reyes)'],
    journal: ['Wahlstrom, Kyla L., and Judith A. Owens. “Delaying School Start Times and Adolescent Sleep.” Journal of Adolescent Health, vol. 60, no. 6, 2017, pp. 627-33. https://doi.org/10.1016/j.jadohealth.2017.01.011.', '(Wahlstrom and Owens)'],
    video: ['Example Science. “Why Do We Sleep?” YouTube, 12 May 2019, www.youtube.com/watch?v=abc123. Accessed 12 Oct. 2026.', '(Example Science)']
  },
  apa: {
    one: ['Lopez, M. (2023, September 5). Why Teens Can’t Fall Asleep Before 11. The Example Times. https://www.example-times.com/2023/09/05/health/teens-sleep.html', '(Lopez, 2023)'],
    two: ['Lopez, M., & Brooks, D. (2024, January 15). Later School Start Times Pay Off. The Example Times. https://www.example-times.com/2024/01/15/start-times.html', '(Lopez & Brooks, 2024)'],
    three: ['Lopez, M., Brooks, D., & Shah, P. (2022, March 2). What Sleep Researchers Agree On. Science Daily Example. https://www.sciencedaily.example/news/sleep.htm', '(Lopez et al., 2022)'],
    noAuthor: ['How Much Sleep Do Teens Need? (2021, June 10). Sleep Foundation. https://www.sleepfoundation.example/teens-and-sleep', '(How Much Sleep Do Teens Need?, 2021)'],
    noDate: ['Reyes, J. (n.d.). Sleep and Your Health. Healthy Teens Blog. https://healthyteens.example.org/sleep', '(Reyes, n.d.)'],
    journal: ['Wahlstrom, K. L., & Owens, J. A. (2017). Delaying School Start Times and Adolescent Sleep. Journal of Adolescent Health, 60(6), 627–633. https://doi.org/10.1016/j.jadohealth.2017.01.011', '(Wahlstrom & Owens, 2017)'],
    video: ['Example Science. (2019, May 12). Why Do We Sleep? [Video]. YouTube. https://www.youtube.com/watch?v=abc123', '(Example Science, 2019)']
  },
  chicago: {
    one: ['Lopez, Maria. “Why Teens Can’t Fall Asleep Before 11.” The Example Times. Example Media Group, September 5, 2023. https://www.example-times.com/2023/09/05/health/teens-sleep.html.', '(Lopez 2023)'],
    two: ['Lopez, Maria, and Dan Brooks. “Later School Start Times Pay Off.” The Example Times. January 15, 2024. https://www.example-times.com/2024/01/15/start-times.html.', '(Lopez and Brooks 2024)'],
    three: ['Lopez, Maria, Dan Brooks, and Priya Shah. “What Sleep Researchers Agree On.” Science Daily Example. March 2, 2022. https://www.sciencedaily.example/news/sleep.htm.', '(Lopez, Brooks, and Shah 2022)'],
    noAuthor: ['“How Much Sleep Do Teens Need?” Sleep Foundation. June 10, 2021. https://www.sleepfoundation.example/teens-and-sleep.', '(“How Much Sleep Do Teens Need?” 2021)'],
    noDate: ['Reyes, Jordan. “Sleep and Your Health.” Healthy Teens Blog. Accessed October 12, 2026. https://healthyteens.example.org/sleep.', '(Reyes n.d.)'],
    journal: ['Wahlstrom, Kyla L., and Judith A. Owens. “Delaying School Start Times and Adolescent Sleep.” Journal of Adolescent Health 60, no. 6 (2017): 627–33. https://doi.org/10.1016/j.jadohealth.2017.01.011.', '(Wahlstrom and Owens 2017)'],
    video: ['Example Science. “Why Do We Sleep?” YouTube. May 12, 2019. https://www.youtube.com/watch?v=abc123.', '(Example Science 2019)']
  }
};

for (const style of ['mla', 'apa', 'chicago']) {
  for (const [name, meta] of Object.entries(F)) {
    test(`${style}: ${name}`, () => {
      const r = C.format(meta, style, { accessed });
      assert.strictEqual(r.text, WANT[style][name][0]);
      assert.strictEqual(r.inText, WANT[style][name][1]);
    });
  }
}

test('italics: MLA site, APA title and journal volume, Chicago journal', () => {
  assert.match(C.format(F.one, 'mla', { accessed }).html, /<i>The Example Times<\/i>/);
  assert.match(C.format(F.one, 'apa', { accessed }).html, /<i>Why Teens Can’t Fall Asleep Before 11<\/i>/);
  assert.match(C.format(F.journal, 'apa', { accessed }).html, /<i>Journal of Adolescent Health<\/i>, <i>60<\/i>\(6\)/);
  assert.match(C.format(F.journal, 'chicago', { accessed }).html, /<i>Journal of Adolescent Health<\/i> 60/);
  assert.ok(!/<script/.test(C.format({ title: '<script>x</script>', url: 'https://a.example/' }, 'mla', { accessed }).html));
});

test('missing author or date is flagged for the student to check', () => {
  assert.deepStrictEqual(C.format(F.noAuthor, 'mla').check, ['no author found']);
  assert.deepStrictEqual(C.format(F.noDate, 'apa').check, ['no date found']);
  assert.deepStrictEqual(C.format(F.one, 'chicago').check, []);
});

test('a bibliography is sorted and headed for its style', () => {
  const b = C.bibliography([F.video, F.noAuthor, F.journal, F.one], 'mla');
  assert.strictEqual(b.heading, 'Works Cited');
  assert.deepStrictEqual(b.items.map(i => i.text.slice(0, 12)), ['Example Scie', '“How Much Sl', 'Lopez, Maria', 'Wahlstrom, K']);
  assert.strictEqual(C.bibliography([], 'apa').heading, 'References');
  assert.strictEqual(C.bibliography([], 'chicago').heading, 'Bibliography');
});

test('names: inverted, initials, organizations and particles', () => {
  assert.deepStrictEqual(C.parseName('Ludwig van Beethoven'), { last: 'van Beethoven', first: 'Ludwig', suffix: '' });
  assert.deepStrictEqual(C.parseName('Centers for Disease Control and Prevention'), { org: 'Centers for Disease Control and Prevention' });
  assert.strictEqual(C.format({ type: 'webpage', title: 'Sleep', authors: ['Martin Luther King Jr.'], published: '2020', url: 'https://a.example/' }, 'apa').text.slice(0, 18), 'King, M. L., Jr. (');
});

test('the server copy is identical to the browser copy', () => {
  const root = path.join(__dirname, '..');
  assert.ok(fs.readFileSync(path.join(root, 'lib', 'cite.js')).equals(fs.readFileSync(path.join(root, 'public', 'cite-format.js'))), 'run `npm run sync-engine`');
});
