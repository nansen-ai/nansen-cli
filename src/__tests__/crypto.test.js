/**
 * Tests for shared crypto primitives (keccak256, signSecp256k1, rlpEncode).
 */

import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { keccak256, signSecp256k1, rlpEncode } from "../crypto.js";

describe("keccak256", () => {
  it("hashes empty string to known value", () => {
    const hash = keccak256(Buffer.alloc(0));
    expect(hash.toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
  });

  it('hashes "abc" to known value', () => {
    const hash = keccak256(Buffer.from("abc"));
    expect(hash.toString("hex")).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    );
  });

  it("computes ERC-20 transfer selector correctly", () => {
    // keccak256("transfer(address,uint256)") first 4 bytes = 0xa9059cbb
    const hash = keccak256(Buffer.from("transfer(address,uint256)"));
    expect(hash.subarray(0, 4).toString("hex")).toBe("a9059cbb");
  });
});

describe("signSecp256k1", () => {
  const privKey = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "hex"
  );

  it("produces 32-byte r and s with v of 0 or 1", () => {
    const hash = crypto.randomBytes(32);
    const sig = signSecp256k1(hash, privKey);
    expect(sig.r.length).toBe(32);
    expect(sig.s.length).toBe(32);
    expect([0, 1]).toContain(sig.v);
  });

  it("is deterministic (RFC 6979)", () => {
    const hash = Buffer.from(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "hex"
    );
    const sig1 = signSecp256k1(hash, privKey);
    const sig2 = signSecp256k1(hash, privKey);
    expect(sig1.r.toString("hex")).toBe(sig2.r.toString("hex"));
    expect(sig1.s.toString("hex")).toBe(sig2.s.toString("hex"));
    expect(sig1.v).toBe(sig2.v);
  });

  it("enforces low-S normalization (EIP-2)", () => {
    const N =
      0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const halfN = N >> 1n;
    for (let i = 0; i < 10; i++) {
      const hash = crypto.randomBytes(32);
      const sig = signSecp256k1(hash, privKey);
      const s = BigInt("0x" + sig.s.toString("hex"));
      expect(s <= halfN).toBe(true);
    }
  });
});

describe("rlpEncode", () => {
  it("encodes empty buffer as 0x80", () => {
    expect(rlpEncode(Buffer.alloc(0))).toEqual(Buffer.from([0x80]));
  });

  it("encodes single byte < 0x80 as itself", () => {
    expect(rlpEncode(Buffer.from([0x7f]))).toEqual(Buffer.from([0x7f]));
  });

  it("encodes empty list as 0xc0", () => {
    expect(rlpEncode([])).toEqual(Buffer.from([0xc0]));
  });

  it("encodes hex string correctly", () => {
    expect(rlpEncode("0x0400")).toEqual(Buffer.from([0x82, 0x04, 0x00]));
  });
});
