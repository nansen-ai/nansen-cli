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
 * parseArgs runs JSON.parse on option values, so `--flag '{}'` /
 * `--flag '[true]'` (or a repeated flag) reach handlers as objects/arrays,
 * not strings. These handlers either crashed with a raw TypeError calling
 * string methods on a non-string option, or silently dropped/passed through
 * bad values instead of raising INVALID_PARAMS.
 */
describe('alerts string/array option validation', () => {
  it('rejects non-string --chains instead of crashing on .split()', () => {
    expect(() => buildSmTokenFlowsData({ chains: true })).toThrow(/--chains/);
  });

  it('rejects a non-string element in a repeated --chains array', () => {
    expect(() => buildSmTokenFlowsData({ chains: ['ethereum', true] })).toThrow(/--chains/);
  });

  it('rejects --chains false/--chains null instead of silently dropping the filter', () => {
    expect(() => buildSmTokenFlowsData({ chains: false })).toThrow(/--chains/);
    expect(() => buildSmTokenFlowsData({ chains: null })).toThrow(/--chains/);
  });

  it('rejects non-string --token instead of crashing on .lastIndexOf()', () => {
    expect(() => buildCommonTokenTransferData({ token: true })).toThrow(/--token/);
  });

  it('rejects a non-string element in a repeated --token array', () => {
    expect(() => buildCommonTokenTransferData({ token: ['0xabc:ethereum', true] })).toThrow(/--token/);
  });

  it('rejects non-string --subject instead of crashing on .indexOf()', () => {
    expect(() => buildCommonTokenTransferData({ subject: true })).toThrow(/--subject/);
  });

  it('rejects non-string --caller/--contract on smart-contract-call', () => {
    expect(() => buildSmartContractCallData({ caller: true })).toThrow(/--caller/);
    expect(() => buildSmartContractCallData({ contract: false })).toThrow(/--contract/);
  });

  it('rejects --events true/[true] instead of passing them through into the payload', () => {
    expect(() => buildCommonTokenTransferData({ events: true })).toThrow(/--events/);
    expect(() => buildCommonTokenTransferData({ events: [true] })).toThrow(/--events/);
    expect(() => buildCommonTokenTransferData({ events: ['send', true] })).toThrow(/--events/);
  });

  it('still splits a valid comma-separated --events string', () => {
    const data = buildCommonTokenTransferData({ events: 'send,receive' });
    expect(data.events).toEqual(['send', 'receive']);
  });

  it('rejects non-string --signature-hash instead of passing it through unchecked', () => {
    expect(() => buildSmartContractCallData({ 'signature-hash': true })).toThrow(/--signature-hash/);
    expect(() => buildSmartContractCallData({ 'signature-hash': [true] })).toThrow(/--signature-hash/);
  });

  it('rejects non-string --token-sector instead of dropping it silently', () => {
    expect(() => buildSmTokenFlowsData({ 'token-sector': true })).toThrow(/--token-sector/);
    expect(() => buildSmTokenFlowsData({ 'token-sector': false })).toThrow(/--token-sector/);
  });

  it('accepts a valid --token-sector value', () => {
    const data = buildSmTokenFlowsData({ 'token-sector': 'real-world-assets' });
    expect(data.inclusion.tokenSectors).toEqual(['real-world-assets']);
  });
});
