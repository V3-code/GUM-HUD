import assert from "node:assert/strict";
import test from "node:test";

import {
  MANEUVER_TIMING_POLICIES,
  evaluateManeuverTiming,
  normalizeManeuverApplication,
  sameManeuverSelection
} from "../scripts/maneuver-state.js";

test("normalizes one persistent HUD maneuver application", () => {
  assert.deepEqual(normalizeManeuverApplication({
    id: " tx-1 ", maneuverUuid: " Item.M ", optionBindingIds: ["a", "a", " b "], userId: "u1", appliedAt: "42"
  }), {
    version: 1,
    id: "tx-1",
    maneuverUuid: "Item.M",
    optionBindingIds: ["a", "b"],
    userId: "u1",
    appliedAt: 42
  });
  assert.equal(normalizeManeuverApplication({ id: "", maneuverUuid: "Item.M" }), null);
});

test("compares maneuver selections without depending on option order", () => {
  assert.equal(sameManeuverSelection(
    { maneuverUuid: "M1", optionBindingIds: ["a", "b"] },
    { maneuverUuid: "M1", optionBindingIds: ["b", "a", "a"] }
  ), true);
  assert.equal(sameManeuverSelection(
    { maneuverUuid: "M1", optionBindingIds: ["a"] },
    { maneuverUuid: "M2", optionBindingIds: ["a"] }
  ), false);
});

test("timing policy lets the GM bypass restrictions and validates player combat context", () => {
  assert.equal(evaluateManeuverTiming({ policy: MANEUVER_TIMING_POLICIES.TURN, isGM: true }).allowed, true);
  assert.equal(evaluateManeuverTiming({ policy: MANEUVER_TIMING_POLICIES.ALWAYS }).allowed, true);
  assert.equal(evaluateManeuverTiming({ policy: MANEUVER_TIMING_POLICIES.COMBAT }).reason, "combatRequired");
  assert.equal(evaluateManeuverTiming({ policy: MANEUVER_TIMING_POLICIES.COMBAT, combatStarted: true, combatantFound: true }).allowed, true);
  assert.equal(evaluateManeuverTiming({ policy: MANEUVER_TIMING_POLICIES.TURN, combatStarted: true, combatantAmbiguous: true }).reason, "combatantAmbiguous");
  assert.equal(evaluateManeuverTiming({ policy: MANEUVER_TIMING_POLICIES.TURN, combatStarted: true, combatantFound: true }).reason, "turnRequired");
  assert.equal(evaluateManeuverTiming({ policy: MANEUVER_TIMING_POLICIES.TURN, combatStarted: true, combatantFound: true, isCurrentTurn: true }).allowed, true);
});
