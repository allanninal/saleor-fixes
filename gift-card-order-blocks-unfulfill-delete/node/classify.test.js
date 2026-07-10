import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGiftCardOrderBlock } from "./flag-gift-card-blocks.js";

const order = (over = {}) => ({
  status: "FULFILLED",
  giftCards: [{ id: "R2lmdENhcmQ6MQ==", last4CodeChars: "9F2K" }],
  lines: [{ id: "T3JkZXJMaW5lOjE=", isGift: true, quantity: 1 }],
  fulfillments: [{ id: "RnVsZmlsbG1lbnQ6MQ==", status: "FULFILLED" }],
  ...over,
});

test("blocked with CANNOT_CANCEL_FULFILLMENT when gift card and fulfilled", () => {
  const result = classifyGiftCardOrderBlock(order());
  assert.equal(result.blocked, true);
  assert.equal(result.blockingCode, "CANNOT_CANCEL_FULFILLMENT");
});

test("blocked with NON_REMOVABLE_GIFT_LINE when no blocking fulfillment", () => {
  const result = classifyGiftCardOrderBlock(order({ giftCards: [], fulfillments: [] }));
  assert.equal(result.blocked, true);
  assert.equal(result.blockingCode, "NON_REMOVABLE_GIFT_LINE");
});

test("partially fulfilled still blocks cancel", () => {
  const result = classifyGiftCardOrderBlock(order({ fulfillments: [{ id: "Zg==", status: "PARTIALLY_FULFILLED" }] }));
  assert.equal(result.blockingCode, "CANNOT_CANCEL_FULFILLMENT");
});

test("waiting for approval still blocks cancel", () => {
  const result = classifyGiftCardOrderBlock(order({ fulfillments: [{ id: "Zg==", status: "WAITING_FOR_APPROVAL" }] }));
  assert.equal(result.blockingCode, "CANNOT_CANCEL_FULFILLMENT");
});

test("not blocked when no gift cards and no gift lines", () => {
  const result = classifyGiftCardOrderBlock(order({ giftCards: [], lines: [{ id: "L2", isGift: false, quantity: 1 }] }));
  assert.deepEqual(result, { blocked: false, blockingCode: null, reason: "No gift card lifecycle block found." });
});

test("not blocked when fulfillment is cancelled", () => {
  const result = classifyGiftCardOrderBlock(
    order({ lines: [{ id: "L2", isGift: false, quantity: 1 }], fulfillments: [{ id: "Zg==", status: "CANCELED" }] })
  );
  assert.equal(result.blocked, false);
});

test("gift card present but only unfulfilled fulfillment falls through to line check", () => {
  const result = classifyGiftCardOrderBlock(order({ fulfillments: [{ id: "Zg==", status: "UNFULFILLED" }] }));
  assert.equal(result.blockingCode, "NON_REMOVABLE_GIFT_LINE");
});

test("no gift cards and no lines defaults safely", () => {
  const result = classifyGiftCardOrderBlock({ status: "UNFULFILLED" });
  assert.deepEqual(result, { blocked: false, blockingCode: null, reason: "No gift card lifecycle block found." });
});
