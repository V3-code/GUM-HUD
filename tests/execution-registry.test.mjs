import assert from "node:assert/strict";
import test from "node:test";
import { executionBindingsFor, normalizeExecutionRegistry, resolveExecutionSource } from "../scripts/execution-registry.js";

test("normalizes world execution bindings without coupling them to GUM item data", () => {
  const registry = normalizeExecutionRegistry({ bindings: [
    { id: "mod", maneuverUuid: " M1 ", actorUuid: "Actor.A", sourceType: "modifier", sourceUuid: "Actor.A.Item.X", mode: "cumulative", reset: "sticky", order: 2 },
    { id: "effect", maneuverUuid: "M1", sourceType: "effect", sourceUuid: "Compendium.effects.Item.Y", order: 1 },
    { id: "invalid", maneuverUuid: "", sourceType: "effect", sourceUuid: "" }
  ] });
  assert.equal(registry.version, 2);
  assert.deepEqual(registry.bindings.map(binding => binding.id), ["effect", "mod"]);
  assert.equal(registry.bindings[1].maneuverUuid, "M1");
  assert.equal(registry.bindings[1].mode, "cumulative");
  assert.equal(registry.bindings[1].reset, "sticky");
});

test("retains a portable source snapshot for world-wide modifier bindings", () => {
  const sourceData = { id: "M", type: "gm_modifier", name: "Rapid Strike", system: { modifier: -6 } };
  const [binding] = normalizeExecutionRegistry({ bindings: [{ id: "global", maneuverUuid: "M1", sourceType: "modifier", sourceUuid: "Actor.A.Item.M", sourceData }] }).bindings;
  assert.deepEqual(resolveExecutionSource(binding, null), sourceData);
});

test("merges world defaults with any remaining actor-specific bindings", () => {
  const registry = normalizeExecutionRegistry({ bindings: [
    { id: "global-effect", maneuverUuid: "M1", sourceType: "effect", sourceUuid: "Item.E" },
    { id: "global-mod", maneuverUuid: "M1", sourceType: "modifier", sourceUuid: "Item.M" },
    { id: "actor-effect", maneuverUuid: "M1", actorUuid: "Actor.A", sourceType: "effect", sourceUuid: "Item.AE" },
    { id: "actor-mod", maneuverUuid: "M1", actorUuid: "Actor.A", sourceType: "modifier", sourceUuid: "Actor.A.Item.M" },
    { id: "other-mod", maneuverUuid: "M1", actorUuid: "Actor.B", sourceType: "modifier", sourceUuid: "Actor.B.Item.M" }
  ] });
  assert.deepEqual(executionBindingsFor(registry, { actorUuid: "Actor.A", maneuverUuids: ["M1"] }).map(binding => binding.id), ["global-effect", "global-mod", "actor-effect", "actor-mod"]);
  assert.deepEqual(executionBindingsFor(registry, { actorUuid: "Actor.B", maneuverUuids: ["M1"] }).map(binding => binding.id), ["global-effect", "global-mod", "other-mod"]);
});
