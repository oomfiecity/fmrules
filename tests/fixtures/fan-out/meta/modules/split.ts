/**
 * Synthetic test module: takes a rule whose `subject` matcher resolves to
 * an OR list and fans it out into one rule per subject value. Defined
 * inline so the fixture is self-contained.
 */
export default {
  name: 'split',
  apply(rules: any[]) {
    const out: any[] = [];
    for (const r of rules) {
      const s = r.matchers?.subject;
      let values: string[] = [];
      if (typeof s === 'string') values = [s];
      else if (Array.isArray(s)) values = s;
      else if (s && typeof s === 'object') values = [...(s.any ?? []), ...(s.all ?? [])];

      if (values.length <= 1) {
        out.push(r);
        continue;
      }
      for (const v of values) {
        out.push({
          ...r,
          name: `${r.name} [${v}]`,
          matchers: { ...r.matchers, subject: v },
        });
      }
    }
    return out;
  },
};
