'use strict';

/*
 * MockLlm — a stand-in LLM for tests and offline demos. No network, no key.
 *
 *   new MockLlm()                       -> keyword parser for statement questions,
 *                                          fixed JSON for flag explanations
 *   new MockLlm({ fixedResponse: '...'}) -> always returns exactly that string
 *                                          (used to simulate a confused or
 *                                          "jailbroken" model in tests)
 *
 * It returns the same kind of JSON a real model is asked for, so the code that
 * validates LLM output is exercised exactly as in production.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NOT_NAMES = new Set([...MONTHS.map((m) => m[0].toUpperCase() + m.slice(1)), 'Last', 'This', 'Today', 'Yesterday', 'I', 'My', 'Me', 'The', 'In']);

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));

function parseDateRange(q, today) {
  const [y, m, d] = today.split('-').map(Number);
  const now = utc(y, m - 1, d);
  const lower = q.toLowerCase();

  const between = lower.match(/(?:between|from)\s+(\d{4}-\d{2}-\d{2})\s+(?:and|to)\s+(\d{4}-\d{2}-\d{2})/);
  if (between) return { from: between[1], to: between[2] };
  if (/\blast month\b/.test(lower)) return { from: iso(utc(y, m - 2, 1)), to: iso(utc(y, m - 1, 0)) };
  if (/\bthis month\b/.test(lower)) return { from: iso(utc(y, m - 1, 1)), to: today };
  if (/\bthis year\b/.test(lower)) return { from: `${y}-01-01`, to: today };
  if (/\btoday\b/.test(lower)) return { from: today, to: today };
  if (/\byesterday\b/.test(lower)) {
    const yd = iso(utc(y, m - 1, d - 1));
    return { from: yd, to: yd };
  }
  const lastDays = lower.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (lastDays) return { from: iso(new Date(now - (Number(lastDays[1]) - 1) * 86400000)), to: today };
  if (/\blast week\b/.test(lower)) return { from: iso(new Date(now - 6 * 86400000)), to: today };

  const monthName = lower.match(new RegExp(`\\b(${MONTHS.join('|')})\\b(?:\\s+(\\d{4}))?`));
  if (monthName) {
    const mi = MONTHS.indexOf(monthName[1]);
    // "in August" means the most recent August that has started.
    const year = monthName[2] ? Number(monthName[2]) : mi <= m - 1 ? y : y - 1;
    return { from: iso(utc(year, mi, 1)), to: iso(utc(year, mi + 1, 0)) };
  }
  return { from: iso(new Date(now - 29 * 86400000)), to: today }; // default: last 30 days
}

function parseCounterparty(q) {
  const re = /\b(?:to|from|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  let match;
  while ((match = re.exec(q))) {
    const words = match[1].split(/\s+/).filter((w) => !NOT_NAMES.has(w));
    if (words.length) return words.join(' ');
  }
  return null;
}

function parseStatementQuestion(question, today) {
  const q = String(question || '');
  const lower = q.toLowerCase();
  let type = 0;
  if (/\b(largest|biggest|highest|maximum|max)\b/.test(lower)) type = 3;
  else if (/\bhow many\b|\bnumber of\b|\bcount\b/.test(lower)) type = 4;
  else if (/\b(receive|received|got|credited)\b/.test(lower)) type = 2;
  else if (/\b(send|sent|paid|pay|spent|spend)\b/.test(lower)) type = 1;
  if (type === 0) return { type: 0 };
  return { type, counterparty: parseCounterparty(q), ...parseDateRange(q, today) };
}

const FIXED_EXPLANATION = {
  explanation:
    'This transfer matched a configured risk rule, and the amount or pattern differs from the wallet\'s recent activity shown in the data. A reviewer should confirm it with the customer before it is treated as normal.',
  label: 'review',
};

class MockLlm {
  constructor({ fixedResponse } = {}) {
    this.name = 'mock';
    this.fixedResponse = fixedResponse;
    this.calls = [];
  }

  async complete(args) {
    this.calls.push(args);
    if (this.fixedResponse !== undefined) return this.fixedResponse;
    if (args.task === 'statement_intent') return JSON.stringify(parseStatementQuestion(args.question, args.today));
    if (args.task === 'flag_explanation') return JSON.stringify(FIXED_EXPLANATION);
    return '{}';
  }
}

module.exports = { MockLlm, parseStatementQuestion, parseDateRange };
