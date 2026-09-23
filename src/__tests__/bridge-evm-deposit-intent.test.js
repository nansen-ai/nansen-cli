import { describe, it, expect } from 'vitest';

import { assertEvmBridgeStepIntent, preflightEvmBridgeSteps, BRIDGE_DEPOSIT_TARGETS } from '../bridge.js';
import { encodeApproveCalldata } from '../trade-validation.js';

// Real captured shapes (base -> hyperliquid, USDC): the Relay router is both
// the approve spender and the deposit `to`, and the deposit call decodes to a
// fixed 4-arg layout (depositor, token, amount, id). See the deposit-leg
// hardening plan for how these were captured (read-only quotes, no funds moved).

const ROUTER = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SIGNER = '0x8cb9c3f23c7d600fb430bbd171a313d9ea61cebc';
const ATTACKER = '0x' + 'ee'.repeat(20);
const MAX_UINT256 = (1n << 256n) - 1n;

const word = h => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const depositCalldata = ({ depositor = SIGNER, token = USDC, amount = 2000000n, id = '0x'.padEnd(66, 'a') } = {}) =>
  '0xe8017952' + word(depositor) + word(token) + word(amount.toString(16)) + word(id);

const approveCalldata = (spender, amount) => '0x095ea7b3' + word(spender) + word(amount.toString(16));

const intent = { chain: 'base', signerAddress: SIGNER, requestedAmountBaseUnits: '2000000' };

// Run `fn`, assert it threw, and return the error — so a single invocation can
// be asserted for both message and code. The alternative (an expect().toThrow()
// followed by a separate try/catch that inspects e.code) passes vacuously if the
// second call ever stops throwing: the code assertion then sits in a catch block
// that is never entered, and the test still goes green. This fails loudly.
function caught(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

describe('assertEvmBridgeStepIntent — approve leg', () => {
  it('refuses an approve sent to a contract other than the origin chain USDC', () => {
    // A spender==ROUTER and amount<=requested calldata that targets some other
    // ERC-20 the wallet holds would otherwise look "safe" by AC1's spender/amount
    // checks alone — the approve's own `to` must also be pinned.
    const otherToken = '0x' + 'cd'.repeat(20);
    const txData = { to: otherToken, data: approveCalldata(ROUTER, 2000000n), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/unexpected contract/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses approve(attacker, MAX_UINT256)', () => {
    const txData = { to: USDC, data: approveCalldata(ATTACKER, MAX_UINT256), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/unexpected spender/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses approve(ROUTER, MAX_UINT256) — proves the MAX guard, not just the spender guard', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, MAX_UINT256), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/unlimited/);
    expect(e.code).toBe('AMOUNT_MISMATCH'); // intentional: unlimited approval is an amount mismatch
  });

  it('refuses an approve amount over the requested cap with AMOUNT_MISMATCH code', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000001n), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/exceeds the request's maximum input/);
    expect(e.code).toBe('AMOUNT_MISMATCH');
    expect(e.message).toMatch(/Request a new quote/);
  });

  it('refuses when requestedAmountBaseUnits is a non-numeric string', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' };
    const badAnchor = { ...intent, requestedAmountBaseUnits: 'not-a-number' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, badAnchor));
    expect(e.message).toMatch(/not a valid integer/);
    expect(e.code).toBe('AMOUNT_MISMATCH');
    expect(e.message).toMatch(/Request a new quote/);
  });

  it('refuses a zero-amount approve without stacking two imperatives in the message', () => {
    // A tampered response could send approve(ROUTER, 0). encodeApproveCalldata
    // rejects it with its own "Refusing to sign an approval." clause; the catch
    // wrapper must not append a second imperative on top of the actionable one.
    const txData = { to: USDC, data: approveCalldata(ROUTER, 0n), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.code).toBe('AMOUNT_MISMATCH');
    expect(e.message).toMatch(/must be positive/);
    expect(e.message).toMatch(/Request a new quote\.$/);
    expect(e.message).not.toMatch(/Refusing to sign/);
  });

  it('re-encodes a valid approve at exactly the requested cap', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' };
    const { data } = assertEvmBridgeStepIntent(txData, intent);
    expect(data).toBe(encodeApproveCalldata(ROUTER, 2000000n, { maxAllowance: 2000000n }));
    expect(data.length).toBe(138);
  });

  it('refuses when no reviewed amount was recorded to cap against', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' };
    const noAnchor = { ...intent, requestedAmountBaseUnits: null };
    const e = caught(() => assertEvmBridgeStepIntent(txData, noAnchor));
    expect(e.message).toMatch(/AMOUNT_MISMATCH|no reviewed amount/);
    expect(e.code).toBe('AMOUNT_MISMATCH');
  });
});

describe('assertEvmBridgeStepIntent — deposit leg', () => {
  it('refuses a deposit sent to an unexpected `to`', () => {
    const txData = { to: ATTACKER, data: depositCalldata(), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/unexpected contract/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses the real `to` with an unexpected selector', () => {
    const txData = { to: ROUTER, data: '0xdeadbeef' + word(SIGNER), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unexpected method/);
  });

  it('accepts a valid deposit and returns normalized calldata', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0' };
    const { data } = assertEvmBridgeStepIntent(txData, intent);
    expect(data).toBe(txData.data);
  });

  it('normalizes dirty upper bits in depositor/token words while preserving last-20-bytes', () => {
    // Build calldata where the upper 12 bytes of the depositor and token words
    // have non-zero garbage. decodeBridgeDeposit extracts the last 20 bytes only,
    // and encodeBridgeDeposit re-encodes from those clean values — so the output
    // must equal the canonical (zero-padded) encoding even though the input was dirty.
    const dirtyDepositor = 'deadbeef'.repeat(3) + SIGNER.slice(2);   // 12 dirty + 20 clean bytes
    const dirtyToken    = 'cafebabe'.repeat(3) + USDC.slice(2);
    const data266 = '0xe8017952'
      + dirtyDepositor.toLowerCase().padStart(64, '0')
      + dirtyToken.toLowerCase().padStart(64, '0')
      + (2000000n).toString(16).padStart(64, '0')
      + 'a'.repeat(64);
    const txData = { to: ROUTER, data: data266, value: '0' };
    const { data } = assertEvmBridgeStepIntent(txData, intent);
    // The output must be the clean, canonical encoding.
    expect(data).toBe(depositCalldata());
    // And must differ from the dirty input.
    expect(data).not.toBe(txData.data);
  });

  it('refuses when arg0 (depositor) is redirected away from the signer', () => {
    const txData = { to: ROUTER, data: depositCalldata({ depositor: ATTACKER }), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/SIGNER_MISMATCH|signing wallet/);
    expect(e.code).toBe('SIGNER_MISMATCH');
  });

  it('refuses when arg1 (token) is not the origin chain USDC', () => {
    const otherToken = '0x' + 'ab'.repeat(20);
    const txData = { to: ROUTER, data: depositCalldata({ token: otherToken }), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/unexpected token/);
  });

  it('refuses when arg2 (amount) exceeds what was requested', () => {
    const txData = { to: ROUTER, data: depositCalldata({ amount: 2000001n }), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/more than the 2000000 base units/);
    expect(e.code).toBe('AMOUNT_MISMATCH');
  });

  it('refuses a zero-amount deposit', () => {
    const txData = { to: ROUTER, data: depositCalldata({ amount: 0n }), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/deposit amount must be positive/);
    expect(e.code).toBe('AMOUNT_MISMATCH');
  });

  it('accepts arg2 exactly at the requested amount', () => {
    const txData = { to: ROUTER, data: depositCalldata({ amount: 2000000n }), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).not.toThrow();
  });

  it('refuses when no reviewed amount was recorded to check the deposit against', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0' };
    const noAnchor = { ...intent, requestedAmountBaseUnits: null };
    expect(() => assertEvmBridgeStepIntent(txData, noAnchor)).toThrow(/AMOUNT_MISMATCH|no reviewed amount/);
  });

  it('refuses when deposit requested amount is a non-numeric string', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0' };
    const badAnchor = { ...intent, requestedAmountBaseUnits: 'not-a-number' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, badAnchor));
    expect(e.message).toMatch(/not a valid integer/);
    expect(e.code).toBe('AMOUNT_MISMATCH');
    expect(e.message).toMatch(/Request a new quote/);
  });
});

describe('assertEvmBridgeStepIntent — cross-cutting', () => {
  it('refuses a non-zero native value on an approve step', () => {
    const txData = { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0x1' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/non-zero native value/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses a non-zero native value on a deposit step', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0x1' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).toThrow(/non-zero native value/);
  });

  it('refuses missing transaction data', () => {
    const e = caught(() => assertEvmBridgeStepIntent({ to: ROUTER }, intent));
    expect(e.message).toMatch(/no transaction data/);
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('refuses a deposit-selector call with malformed (wrong-length) calldata', () => {
    const txData = { to: ROUTER, data: '0xe8017952' + word(SIGNER), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/malformed deposit calldata/);
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('refuses a deposit whose id word contains non-hex characters', () => {
    const nonHexId = 'gg'.repeat(32); // 64 chars but not valid hex
    const data = '0xe8017952' + word(SIGNER) + word(USDC) + word((2000000n).toString(16)) + nonHexId;
    const txData = { to: ROUTER, data, value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/malformed deposit calldata/);
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('refuses a deposit whose amount word is not valid hex, instead of throwing a raw SyntaxError', () => {
    const badAmount = '0xe8017952' + word(SIGNER) + word(USDC) + 'zz'.repeat(32) + word('a');
    const txData = { to: ROUTER, data: badAmount, value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/malformed deposit calldata/);
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('refuses an approve whose amount word is not valid hex, instead of throwing a raw SyntaxError', () => {
    const txData = { to: USDC, data: '0x095ea7b3' + word(ROUTER) + 'zz'.repeat(32), value: '0' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/malformed approve calldata/);
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('refuses an unparseable native value, instead of throwing a raw SyntaxError', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0x' };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/malformed native value/);
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('refuses a step addressed `from` a wallet other than the signer', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0', from: ATTACKER };
    const e = caught(() => assertEvmBridgeStepIntent(txData, intent));
    expect(e.message).toMatch(/signing wallet is/);
    expect(e.code).toBe('SIGNER_MISMATCH');
  });

  it('accepts a step whose `from` matches the signer', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0', from: SIGNER };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).not.toThrow();
  });

  it('accepts a step with no `from` at all (quotes may omit it)', () => {
    const txData = { to: ROUTER, data: depositCalldata(), value: '0' };
    expect(() => assertEvmBridgeStepIntent(txData, intent)).not.toThrow();
  });
});

describe('preflightEvmBridgeSteps — plan-level bound', () => {
  const approveStep = () => ({
    id: 'approve',
    items: [{ status: 'incomplete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } }],
  });
  const depositStep = () => ({
    id: 'deposit',
    items: [{ status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0' } }],
  });

  it('accepts the legitimate [approve, deposit] plan', () => {
    expect(() => preflightEvmBridgeSteps([approveStep(), depositStep()], intent)).not.toThrow();
  });

  it('accepts a deposit-only plan (no approve needed)', () => {
    expect(() => preflightEvmBridgeSteps([depositStep()], intent)).not.toThrow();
  });

  it('refuses a plan with an incomplete approve after the deposit', () => {
    const e = caught(() => preflightEvmBridgeSteps([depositStep(), approveStep()], intent));
    expect(e.message).toMatch(/approve transaction after the deposit/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses a single step that bundles deposit before approve', () => {
    const bundled = {
      id: 'bundle',
      items: [
        { status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0' } },
        { status: 'incomplete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } },
      ],
    };
    const e = caught(() => preflightEvmBridgeSteps([bundled], intent));
    expect(e.message).toMatch(/approve transaction after the deposit/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses deposit, complete approve, then incomplete approve', () => {
    const completeApprove = {
      id: 'complete-approve',
      items: [{ status: 'complete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } }],
    };
    const e = caught(() => preflightEvmBridgeSteps([depositStep(), completeApprove, approveStep()], intent));
    expect(e.message).toMatch(/approve transaction after the deposit/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses a plan that repeats [approve, deposit] to amplify past the cap', () => {
    // Every item passes per-item binding (spender/router/token/amount all valid),
    // but two deposits of `requested` each would pull 2x what the user reviewed —
    // ERC-20 approve overwrites the allowance, so the second pair drains again.
    const plan = [approveStep(), depositStep(), approveStep(), depositStep()];
    const e = caught(() => preflightEvmBridgeSteps(plan, intent));
    expect(e.message).toMatch(/approve transaction after the deposit/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses [approve, approve, deposit] — two approves before the deposit', () => {
    // Both approves are incomplete and precede the deposit, so the order guard
    // (sawDeposit) never fires — this is the shape that exercises the count
    // check's `approveCount > 1` branch on its own.
    const e = caught(() => preflightEvmBridgeSteps([approveStep(), approveStep(), depositStep()], intent));
    expect(e.message).toMatch(/at most one approve and exactly one deposit/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses a plan with two deposits sharing one approve', () => {
    expect(() => preflightEvmBridgeSteps([approveStep(), depositStep(), depositStep()], intent))
      .toThrow(/at most one approve and exactly one deposit/);
  });

  it('refuses multiple approve/deposit items bundled in a single step', () => {
    const bundled = {
      id: 'bundle',
      items: [
        { status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0' } },
        { status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0' } },
      ],
    };
    expect(() => preflightEvmBridgeSteps([bundled], intent)).toThrow(/at most one approve and exactly one deposit/);
  });

  it('does not count already-complete (resumed) items toward the bound', () => {
    // A resumed plan may carry a completed approve/deposit plus the remaining
    // leg; the completed ones are skipped for signing, so they must not trip the
    // amplification guard.
    const resumed = [
      { id: 'approve', items: [{ status: 'complete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } }] },
      { id: 'approve2', items: [{ status: 'incomplete', data: { to: USDC, data: approveCalldata(ROUTER, 2000000n), value: '0' } }] },
      depositStep(),
    ];
    expect(() => preflightEvmBridgeSteps(resumed, intent)).not.toThrow();
  });

  it('refuses an approve-only plan — no live allowance without a reviewed deposit', () => {
    // A compromised API/Relay response that drops the deposit step entirely
    // would otherwise pass preflight (0 > 1 is false) and get the approve
    // signed and broadcast with nothing ever pulling from it.
    const e = caught(() => preflightEvmBridgeSteps([approveStep()], intent));
    expect(e.message).toMatch(/at most one approve and exactly one deposit/);
    expect(e.code).toBe('UNEXPECTED_ACTION');
  });

  it('refuses a plan whose deposit step is addressed from a different wallet, before the approve step ever signs', () => {
    // Regression: the from/signer check used to live only in processEvmStep,
    // per-step, during the broadcast loop — so [valid approve, deposit with a
    // tampered `from`] passed preflight, the approve broadcast for real, and
    // only the deposit was later refused. The check now runs inside
    // assertEvmBridgeStepIntent, which preflightEvmBridgeSteps calls on every
    // step up front, so this whole plan is refused before anything signs.
    const tamperedDeposit = {
      id: 'deposit',
      items: [{ status: 'incomplete', data: { to: ROUTER, data: depositCalldata(), value: '0', from: ATTACKER } }],
    };
    const e = caught(() => preflightEvmBridgeSteps([approveStep(), tamperedDeposit], intent));
    expect(e.message).toMatch(/signing wallet is/);
    expect(e.code).toBe('SIGNER_MISMATCH');
  });
});

describe('BRIDGE_DEPOSIT_TARGETS — constant invariant', () => {
  // The approve-branch catch in assertEvmBridgeStepIntent codes everything it
  // sees as AMOUNT_MISMATCH, on the premise that the spender was already
  // validated against a well-formed entry here. A malformed entry would make
  // encodeApproveCalldata's spender-shape error surface as AMOUNT_MISMATCH at
  // runtime; a non-lowercased one would silently break the `.has(spender
  // .toLowerCase())` lookup. Pin both invariants so a careless edit to the
  // constant fails at CI instead.
  it('every entry is a valid, lowercased 20-byte address', () => {
    for (const [chain, set] of Object.entries(BRIDGE_DEPOSIT_TARGETS)) {
      expect(set).toBeInstanceOf(Set);
      for (const addr of set) {
        expect(addr, `${chain} entry ${addr}`).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
  });
});
