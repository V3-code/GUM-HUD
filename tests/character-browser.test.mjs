import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [browser, hud, template, css, portuguese, english] = await Promise.all([
  readFile(new URL("../scripts/character-browser.js", import.meta.url), "utf8"),
  readFile(new URL("../scripts/hud.js", import.meta.url), "utf8"),
  readFile(new URL("../templates/character-browser.hbs", import.meta.url), "utf8"),
  readFile(new URL("../styles/hud.css", import.meta.url), "utf8"),
  readFile(new URL("../lang/pt-BR.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../lang/en.json", import.meta.url), "utf8").then(JSON.parse)
]);

test("character quick access uses one reusable browser with five direct category launchers", () => {
  for (const category of ["skill", "spell", "power", "equipment", "effect"]) {
    assert.match(hud, new RegExp(`\\["${category}"`));
    assert.match(browser, new RegExp(`"${category}"`));
  }
  assert.match(hud, /let characterBrowser = null/);
  assert.match(hud, /new CharacterResourceBrowser/);
  assert.match(hud, /characterBrowser\.category === category/);
  assert.match(hud, /characterBrowserQueue/);
  assert.match(hud, /characterBrowserClosePromise/);
  assert.doesNotMatch(hud, /browser\.close\(\{ animate: false \}\)/);
  assert.match(hud, /document\.getElementById\(browser\.id\)\?\.remove/);
  assert.match(hud, /requestCharacterBrowser/);
  assert.match(browser, /whenRendered/);
  assert.match(hud, /closeCharacterBrowser\(\)/);
  assert.match(template, /data-browser-category/);
  assert.match(css, /\.gum-hud-resource-rail/);
});

test("browser remains operational and read-only", () => {
  assert.match(template, /data-roll-ability/);
  assert.match(template, /data-roll-attack/);
  assert.match(template, /data-roll-damage-attack/);
  assert.match(template, /data-use-consumable/);
  assert.match(browser, /actions\.preview/);
  assert.doesNotMatch(template, /name="system\./);
  assert.doesNotMatch(browser, /item\.update/);
});

test("browser supports search, actor organization, equipment filters, and client position persistence", () => {
  assert.match(browser, /_organization/);
  assert.match(browser, /dataset\.search\.includes/);
  assert.match(template, /data-browser-search/);
  assert.match(template, /data-equipment-filter/);
  assert.match(template, /group\.count/);
  assert.match(template, /data-toggle-browser-group/);
  assert.match(template, /gum-hud-browser-commandbar/);
  assert.doesNotMatch(template, /<footer>/);
  assert.doesNotMatch(template, /gum-hud-browser-tools/);
  assert.match(css, /\.gum-hud-resource-card/);
  assert.match(template, /gum-hud-resource-icon/);
  assert.match(template, /gum-hud-resource-inline-action/);
  assert.match(css, /\.gum-hud-resource-value/);
  assert.doesNotMatch(css, /\.gum-hud-resource-card\.is-expanded \{ grid-column/);
  assert.match(browser, /characterBrowserState/);
  assert.match(browser, /collapsedGroups/);
  assert.match(browser, /this\.position/);
  assert.match(browser, /layoutVersion/);
  assert.match(browser, /await super\.close\(options\)/);
  assert.match(browser, /_saveState\(\)\.catch/);
});

test("browser localization stays aligned in Portuguese and English", () => {
  assert.deepEqual(Object.keys(portuguese.GUMHUD.CharacterBrowser).sort(), Object.keys(english.GUMHUD.CharacterBrowser).sort());
  assert.equal(portuguese.GUMHUD.CharacterBrowser.Skills, "Perícias");
  assert.equal(english.GUMHUD.CharacterBrowser.Skills, "Skills");
});

test("identity summary exposes current and maximum resources plus effective movement", () => {
  assert.match(hud, /identityResource\(hp, "HP"\)/);
  assert.match(hud, /identityResource\(fp, "FP"\)/);
  assert.match(hud, /identityMovement\(actor\)/);
  assert.match(hud, /attribute\?\.final \?\? attribute\?\.max/);
  assert.match(hud, /attributes\[key\]\?\.final \?\? attributes\[key\]\?\.value/);
  assert.match(css, /\.gum-hud-vital-meter/);
  assert.match(css, /\.gum-hud-movement/);
  assert.deepEqual(Object.keys(portuguese.GUMHUD.Identity).sort(), Object.keys(english.GUMHUD.Identity).sort());
});

test("active effects use the character browser and the loadout keeps six independent slots", () => {
  assert.match(hud, /function activeEffectsFor/);
  assert.match(browser, /"effect"/);
  assert.match(browser, /TemporaryEffects/);
  assert.match(template, /item\.isEffect/);
  assert.doesNotMatch(hud, /data-active-effects/);
  assert.doesNotMatch(css, /\.gum-hud-effect-panel/);
  assert.match(hud, /Array\.from\(\{ length: 6 \}/);
  assert.match(hud, /equipmentActivity/);
  assert.match(hud, /data-toggle-equipment/);
  assert.match(css, /\.gum-hud-slot\.is-inactive/);
  assert.deepEqual(Object.keys(portuguese.GUMHUD.Effects).sort(), Object.keys(english.GUMHUD.Effects).sort());
});

test("client HUD preferences can restore and stack above the Foundry hotbar", () => {
  assert.match(hud, /data-hud-preferences/);
  assert.match(hud, /data-toggle-foundry-hotbar/);
  assert.match(hud, /game\.settings\.set\(MODULE, "hideHotbar"/);
  assert.match(hud, /window\.innerHeight - hotbarTop \+ 8/);
  assert.match(hud, /Hooks\.on\("renderHotbar"/);
  assert.match(css, /\.gum-hud-preferences-panel/);
  assert.match(css, /\.gum-hud-resource-divider/);
  assert.deepEqual(Object.keys(portuguese.GUMHUD.Preferences).sort(), Object.keys(english.GUMHUD.Preferences).sort());
});
