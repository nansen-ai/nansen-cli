/**
 * Alerts command - numeric range validation
 *
 * buildRange() / parseFiniteNumber() feed --*-min/--*-max flags into the
 * alert payload sent to the API. Before this fix, a non-numeric value
 * (typo, empty string, etc.) silently became NaN, which JSON.stringify
 * then turns into `null` — so the filter the user asked for would vanish
 * from the request instead of failing loudly.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSmTokenFlowsData,
  buildCommonTokenTransferData,
  buildSmartContractCallData,
} from '../commands/alerts.js';

describe('alerts numeric range validation', () => {
  it('builds a valid range for sm-token-flows', () => {
    const data = buildSmTokenFlowsData({ 'inflow-1h-min': '1000000', 'inflow-1h-max': '5000000' });
    expect(data.inflow_1h).toEqual({ min: 1000000, max: 5000000 });
  });

  it('allows negative values (net outflow) instead of rejecting all negatives', () => {
    const data = buildSmTokenFlowsData({ 'netflow-1h-min': '-5000', 'netflow-1h-max': '10000' });
    expect(data.netflow_1h).toEqual({ min: -5000, max: 10000 });
  });

  it('rejects non-numeric --usd-min instead of silently sending null', () => {
    expect(() => buildCommonTokenTransferData({ 'usd-min': 'abc' })).toThrow(/--usd-min/);
  });

  it('rejects non-numeric --token-amount-max', () => {
    expect(() => buildCommonTokenTransferData({ 'token-amount-max': 'lots' })).toThrow(/--token-amount-max/);
  });

  it('rejects non-numeric --market-cap-min on sm-token-flows', () => {
    expect(() => buildSmTokenFlowsData({ 'market-cap-min': 'n/a' })).toThrow(/--market-cap-min/);
  });

  it('rejects non-numeric --token-age-max', () => {
    expect(() => buildSmTokenFlowsData({ 'token-age-max': 'seven' })).toThrow(/--token-age-max/);
  });

  it('rejects non-numeric --token-age-min/--token-age-max on common-token-transfer', () => {
    expect(() => buildCommonTokenTransferData({ 'token-age-min': 'x' })).toThrow(/--token-age-min/);
    expect(() => buildCommonTokenTransferData({ 'token-age-max': 'y' })).toThrow(/--token-age-max/);
  });

  it('rejects non-numeric --usd-max on smart-contract-call', () => {
    expect(() => buildSmartContractCallData({ 'usd-max': 'not-a-number' })).toThrow(/--usd-max/);
  });

  it('leaves ranges undefined when no min/max flags are given', () => {
    expect(buildSmTokenFlowsData({}).inflow_1h).toBeUndefined();
  });
});

/**
 * parseArgs JSON.parses option values, so `--chains true` / `--token true`
 * etc. arrive here as JS primitives, not strings. parseChains/parseTokens/
 * parseSubjects used to call .split()/.lastIndexOf()/.indexOf() directly on
 * these values, crashing with a raw TypeError instead of an actionable
 * INVALID_PARAMS error.
 */
describe('alerts string option validation', () => {
  it('rejects non-string --chains instead of crashing on .split()', () => {
    expect(() => buildSmTokenFlowsData({ chains: true })).toThrow(/--chains/);
  });

  it('rejects non-string --token instead of crashing on .lastIndexOf()', () => {
    expect(() => buildSmTokenFlowsData({ token: true })).toThrow(/--token/);
  });

  it('rejects a non-string element in a repeated --token flag', () => {
    expect(() => buildSmTokenFlowsData({ token: ['0x1:ethereum', true] })).toThrow(/--token/);
  });

  it('rejects non-string --subject instead of crashing on .indexOf()', () => {
    expect(() => buildCommonTokenTransferData({ subject: true })).toThrow(/--subject/);
  });

  it('rejects non-string --caller/--contract on smart-contract-call', () => {
    expect(() => buildSmartContractCallData({ caller: true })).toThrow(/--subject/);
    expect(() => buildSmartContractCallData({ contract: true })).toThrow(/--subject/);
  });

  it('accepts valid string --chains/--token/--subject unaffected by the guard', () => {
    expect(buildSmTokenFlowsData({ chains: 'ethereum,base' }).chains).toEqual(['ethereum', 'base']);
    expect(buildCommonTokenTransferData({ token: '0x1:ethereum' }).inclusion.tokens).toEqual([
      { address: '0x1', chain: 'ethereum' },
    ]);
    expect(buildCommonTokenTransferData({ subject: 'wallet:0x1' }).subjects).toEqual([
      { type: 'wallet', value: '0x1' },
    ]);
  });

  it('rejects a non-string element in a repeated --chains flag instead of accepting it silently', () => {
    // parseArgs turns repeated `--chains ethereum --chains true` into
    // ['ethereum', true]; the array branch used to skip type-checking entirely.
    expect(() => buildSmTokenFlowsData({ chains: ['ethereum', true] })).toThrow(/--chains/);
  });

  it('accepts a repeated --chains flag where every element is a string', () => {
    expect(buildSmTokenFlowsData({ chains: ['ethereum', 'base'] }).chains).toEqual(['ethereum', 'base']);
  });

  it('rejects falsy non-string --token/--subject/--chains (false/null) instead of silently dropping the filter', () => {
    expect(() => buildCommonTokenTransferData({ token: false })).toThrow(/--token/);
    expect(() => buildCommonTokenTransferData({ token: null })).toThrow(/--token/);
    expect(() => buildCommonTokenTransferData({ subject: false })).toThrow(/--subject/);
    expect(() => buildCommonTokenTransferData({ subject: null })).toThrow(/--subject/);
    expect(() => buildSmTokenFlowsData({ chains: false })).toThrow(/--chains/);
    expect(() => buildSmTokenFlowsData({ chains: null })).toThrow(/--chains/);
  });

  it('rejects a non-string/boolean-containing --events instead of sending it as-is', () => {
    expect(() => buildCommonTokenTransferData({ events: true })).toThrow(/--events/);
    expect(() => buildCommonTokenTransferData({ events: [true] })).toThrow(/--events/);
    expect(() => buildCommonTokenTransferData({ events: ['send', true] })).toThrow(/--events/);
  });

  it('accepts valid --events as CSV string or array', () => {
    expect(buildCommonTokenTransferData({ events: 'send,receive' }).events).toEqual(['send', 'receive']);
    expect(buildCommonTokenTransferData({ events: ['send', 'receive'] }).events).toEqual(['send', 'receive']);
  });

  it('rejects non-string --token-sector/--exclude-token-sector values', () => {
    expect(() => buildSmTokenFlowsData({ 'token-sector': true })).toThrow(/--token-sector/);
    expect(() => buildSmTokenFlowsData({ 'token-sector': [true] })).toThrow(/--token-sector/);
    expect(() => buildCommonTokenTransferData({ 'exclude-token-sector': false })).toThrow(/--exclude-token-sector/);
    expect(() => buildCommonTokenTransferData({ 'exclude-token-sector': ['defi', null] })).toThrow(/--exclude-token-sector/);
  });

  it('rejects non-string --signature-hash values', () => {
    expect(() => buildSmartContractCallData({ 'signature-hash': true })).toThrow(/--signature-hash/);
    expect(() => buildSmartContractCallData({ 'signature-hash': ['0xa9059cbb', true] })).toThrow(/--signature-hash/);
  });

  it('accepts valid --signature-hash as single string or array', () => {
    expect(buildSmartContractCallData({ 'signature-hash': '0xa9059cbb' }).signatureHash).toEqual(['0xa9059cbb']);
    expect(buildSmartContractCallData({ 'signature-hash': ['0xa9059cbb', '0x23b872dd'] }).signatureHash).toEqual([
      '0xa9059cbb', '0x23b872dd',
    ]);
  });
});
