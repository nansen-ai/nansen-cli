import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateSubcommandHelp } from '../cli.js';

// Vendored from the public OpenAPI document. Refresh it when the API's
// FeedbackReport model changes; these tests then show what the CLI must update.
const contract = JSON.parse(fs.readFileSync(new URL('./fixtures/feedback-v1-report.json', import.meta.url))).schemas;
const schema = JSON.parse(fs.readFileSync(new URL('../schema.json', import.meta.url)));
const feedback = schema.commands.feedback;
const report = feedback.subcommands.submit.report;
const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const skill = fs.readFileSync(new URL('../../skills/nansen-agent-guide/SKILL.md', import.meta.url), 'utf8');
const fields = Object.keys(contract.FeedbackReport.properties);
const categories = contract.FeedbackCategory.enum;

function resolve(node) {
  return node.$ref ? contract[node.$ref.split('/').pop()] : node;
}

// Enough of JSON Schema to check the FeedbackReport model, which is all the CLI documents.
function validate(value, node, at = 'body') {
  node = resolve(node);
  if (node.anyOf) {
    const results = node.anyOf.map(option => validate(value, option, at));
    return results.find(errors => !errors.length) ?? results.flat();
  }
  if (node.enum && !node.enum.includes(value)) return [`${at}: not one of ${node.enum.join(', ')}`];
  switch (node.type) {
    case 'null': return value === null ? [] : [`${at}: expected null`];
    case 'string': {
      if (typeof value !== 'string') return [`${at}: expected string`];
      const length = [...value].length;
      if (length < (node.minLength ?? 0) || length > (node.maxLength ?? Infinity)) return [`${at}: length ${length}`];
      return [];
    }
    case 'array':
      if (!Array.isArray(value)) return [`${at}: expected array`];
      if (value.length > (node.maxItems ?? Infinity)) return [`${at}: ${value.length} items`];
      return value.flatMap((item, index) => validate(item, node.items, `${at}.${index}`));
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected object`];
      const missing = (node.required ?? []).filter(name => !(name in value)).map(name => `${at}.${name}: required`);
      const unknown = node.additionalProperties === false
        ? Object.keys(value).filter(name => !(name in node.properties)).map(name => `${at}.${name}: unknown field`) : [];
      const nested = Object.entries(value).filter(([name]) => name in node.properties)
        .flatMap(([name, item]) => validate(item, node.properties[name], `${at}.${name}`));
      return [...missing, ...unknown, ...nested];
    }
    default: return [];
  }
}

// Every documented number a field's description must repeat.
function limits(node) {
  node = resolve(node);
  if (node.anyOf) return node.anyOf.flatMap(limits);
  if (node.type === 'string') return node.maxLength ? [node.maxLength] : [];
  if (node.type === 'array') return [node.maxItems, ...limits(node.items)];
  if (node.type === 'object') return [...new Set(Object.values(node.properties).flatMap(limits))];
  return [];
}

function jsonBlocks(markdown) {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]).filter(block => block.includes('"category"')).map(block => JSON.parse(block));
}

describe('feedback report contract', () => {
  it('rejects the invented categories and fields agents used before the list existed', () => {
    for (const category of ['product_gap', 'feature_request']) {
      expect(validate({ category, description: 'x' }, contract.FeedbackReport)).toEqual([`body.category: not one of ${categories.join(', ')}`]);
    }
    expect(validate({ category: 'bug', description: 'x', title: 't', component: 'c', summary: 's' }, contract.FeedbackReport))
      .toEqual(['body.title: unknown field', 'body.component: unknown field', 'body.summary: unknown field']);
    expect(validate({ category: 'bug', description: 'x', request_ids: Array(11).fill('r') }, contract.FeedbackReport)).toContain('body.request_ids: 11 items');
  });

  it('lists exactly the contract fields, required flags, categories and limits in submit help data', () => {
    expect(Object.keys(report.fields)).toEqual(fields);
    for (const name of fields) {
      expect(Boolean(report.fields[name].required), name).toBe(contract.FeedbackReport.required.includes(name));
      for (const limit of limits(contract.FeedbackReport.properties[name])) {
        expect(report.fields[name].description, name).toContain(`up to ${limit.toLocaleString('en-US')}`);
      }
    }
    expect(report.fields.category.enum).toEqual(categories);
    expect(contract.FeedbackReport.additionalProperties).toBe(false);
  });

  it('ships examples the API accepts', () => {
    const examples = [report.example, ...jsonBlocks(readme), ...jsonBlocks(skill)];
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const example of examples) expect(validate(example, contract.FeedbackReport), JSON.stringify(example)).toEqual([]);
  });

  it.each([
    ['README', readme, name => `\`${name}\``],
    ['agent skill', skill, name => `\`${name}\``],
    ['schema notes', feedback.notes, name => new RegExp(`\\b${name}\\b`)],
  ])('names every category and field in the %s', (_label, text, pattern) => {
    for (const name of [...categories, ...fields]) {
      const expected = pattern(name);
      if (expected instanceof RegExp) expect(text, name).toMatch(expected);
      else expect(text, name).toContain(expected);
    }
  });

  it('prints the report format in submit help and the feedback ID in get help', () => {
    const submit = generateSubcommandHelp('feedback', 'submit');
    expect(submit).toContain('Report (* required):');
    expect(submit).toMatch(/^ {2}category\* +.*One of: bug, data_quality, documentation, missing_capability, usability, other\.$/m);
    expect(submit).toMatch(/^ {2}description\* /m);
    for (const name of fields.filter(name => !contract.FeedbackReport.required.includes(name))) expect(submit).toMatch(new RegExp(`^ {2}${name} `, 'm'));
    expect(submit).toContain(`Report example: ${JSON.stringify(report.example)}`);
    expect(generateSubcommandHelp('feedback', 'get')).toMatch(/^Params \(\* required\): <feedback-id>\*, --json/m);
  });
});
