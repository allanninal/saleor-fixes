import { test } from "node:test";
import assert from "node:assert/strict";
import { detectVoucherOverage } from "./detect-voucher-overage.js";

const V1 = "gid://saleor/Voucher/1";

const voucher = (over = {}) => ({ id: V1, code: "SALE50", usageLimit: 50, used: 50, ...over });
const order = (id, over = {}) => ({ id, voucherId: V1, status: "FULFILLED", ...over });

test("no limit returns null", () => {
  assert.equal(detectVoucherOverage(voucher({ usageLimit: null }), []), null);
});

test("under limit returns null", () => {
  const orders = Array.from({ length: 10 }, (_, i) => order(`o${i}`));
  assert.equal(detectVoucherOverage(voucher({ usageLimit: 50, used: 10 }), orders), null);
});

test("exactly at limit returns null", () => {
  const orders = Array.from({ length: 50 }, (_, i) => order(`o${i}`));
  assert.equal(detectVoucherOverage(voucher({ usageLimit: 50, used: 50 }), orders), null);
});

test("one order over limit is flagged", () => {
  const orders = Array.from({ length: 51 }, (_, i) => order(`o${i}`));
  const result = detectVoucherOverage(voucher({ usageLimit: 50, used: 51 }), orders);
  assert.equal(result.overageCount, 1);
  assert.equal(result.actualRedemptions, 51);
  assert.equal(result.affectedOrderIds.length, 51);
});

test("retried payment double count flagged even if orders match limit", () => {
  const orders = Array.from({ length: 50 }, (_, i) => order(`o${i}`));
  const result = detectVoucherOverage(voucher({ usageLimit: 50, used: 52 }), orders);
  assert.notEqual(result, null);
  assert.equal(result.overageCount, 0);
  assert.equal(result.actualRedemptions, 50);
});

test("canceled orders excluded from count", () => {
  const orders = [
    ...Array.from({ length: 50 }, (_, i) => order(`o${i}`)),
    order("o-canceled-1", { status: "CANCELED" }),
    order("o-canceled-2", { status: "CANCELED" }),
    order("o-draft-1", { status: "DRAFT" }),
  ];
  assert.equal(detectVoucherOverage(voucher({ usageLimit: 50, used: 50 }), orders), null);
});

test("orders for other vouchers are ignored", () => {
  const orders = [
    ...Array.from({ length: 30 }, (_, i) => order(`o${i}`)),
    order("other-1", { voucherId: "gid://saleor/Voucher/999" }),
    order("other-2", { voucherId: "gid://saleor/Voucher/999" }),
  ];
  assert.equal(detectVoucherOverage(voucher({ usageLimit: 50, used: 30 }), orders), null);
});

test("overage count never negative when used inflated but orders low", () => {
  const orders = Array.from({ length: 5 }, (_, i) => order(`o${i}`));
  const result = detectVoucherOverage(voucher({ usageLimit: 50, used: 51 }), orders);
  assert.notEqual(result, null);
  assert.equal(result.overageCount, 0);
  assert.equal(result.actualRedemptions, 5);
});

test("affected order ids match counted orders only", () => {
  const orders = [
    ...Array.from({ length: 51 }, (_, i) => order(`o${i}`)),
    order("draft-1", { status: "DRAFT" }),
  ];
  const result = detectVoucherOverage(voucher({ usageLimit: 50, used: 51 }), orders);
  assert.ok(!result.affectedOrderIds.includes("draft-1"));
  assert.equal(result.affectedOrderIds.length, 51);
});
