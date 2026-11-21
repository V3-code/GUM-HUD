import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [hud, css, portuguese, english] = await Promise.all([
  readFile(new URL("../scripts/hud.js", import.meta.url), "utf8"),
  readFile(new URL("../styles/hud.css", import.meta.url), "utf8"),
  readFile(new URL("../lang/pt-BR.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../lang/en.json", import.meta.url), "utf8").then(JSON.parse)
]);

test("maneuvers are prepared before one explicit application", () => {
  assert.match(hud, /const maneuverDrafts = new Map/);
  assert.match(hud, /data-apply-maneuver/);
  assert.match(hud, /data-cancel-maneuver-draft/);
  assert.match(hud, /applyPreparedManeuver/);
  assert.doesNotMatch(hud, /api\(\)\.effects\.apply\(group\.effectUuids/);
  assert.match(css, /\.gum-hud-maneuver\.is-prepared/);
  assert.match(hud, /gum-hud-maneuver-actions[\s\S]*gum-hud-maneuver-controls/);
  assert.match(hud, /gum-hud-maneuver-status[\s\S]*fa-pen-to-square/);
  assert.match(css, /\.gum-hud-combat-options-grid > :only-child/);
  assert.match(css, /\.gum-hud-maneuver\.active::before/);
});

test("confirmed applications are persistent, identifiable, and exactly removable", () => {
  assert.match(hud, /gumHudApplicationId/);
  assert.match(hud, /MANEUVER_APPLICATION_FLAG/);
  assert.match(hud, /actor\.setFlag\(MODULE, MANEUVER_APPLICATION_FLAG/);
  assert.match(hud, /actor\.unsetFlag\(MODULE, MANEUVER_APPLICATION_FLAG/);
  assert.match(hud, /applicationEffectIds/);
  assert.match(hud, /data-edit-maneuver/);
  assert.match(hud, /data-remove-maneuver/);
});

test("world timing policy has three modes and revalidates mutations", () => {
  assert.match(hud, /MANEUVER_TIMING_POLICIES\.ALWAYS/);
  assert.match(hud, /MANEUVER_TIMING_POLICIES\.COMBAT/);
  assert.match(hud, /MANEUVER_TIMING_POLICIES\.TURN/);
  assert.match(hud, /const timing = maneuverTimingStatus\(actor, token\)/);
  assert.match(hud, /"updateCombat"/);
  assert.deepEqual(Object.keys(portuguese.GUMHUD.Settings.ManeuverTiming).sort(), Object.keys(english.GUMHUD.Settings.ManeuverTiming).sort());
});

test("maneuver workflow localization stays aligned", () => {
  assert.deepEqual(Object.keys(portuguese.GUMHUD.Maneuvers).sort(), Object.keys(english.GUMHUD.Maneuvers).sort());
  assert.deepEqual(Object.keys(portuguese.GUMHUD.CombatOptions).sort(), Object.keys(english.GUMHUD.CombatOptions).sort());
  assert.equal(portuguese.GUMHUD.Maneuvers.Apply, "Aplicar");
  assert.equal(english.GUMHUD.Maneuvers.Remove, "Remove");
});
