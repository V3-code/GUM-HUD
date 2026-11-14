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

test("character quick access uses one reusable browser with four direct category launchers", () => {
  for (const category of ["skill", "spell", "power", "equipment"]) {
    assert.match(hud, new RegExp(`\\["${category}"`));
    assert.match(browser, new RegExp(`"${category}"`));
  }
  assert.match(hud, /let characterBrowser = null/);
  assert.match(hud, /new CharacterResourceBrowser/);
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
  assert.match(browser, /characterBrowserState/);
  assert.match(browser, /this\.position/);
});

test("browser localization stays aligned in Portuguese and English", () => {
  assert.deepEqual(Object.keys(portuguese.GUMHUD.CharacterBrowser).sort(), Object.keys(english.GUMHUD.CharacterBrowser).sort());
  assert.equal(portuguese.GUMHUD.CharacterBrowser.Skills, "Perícias");
  assert.equal(english.GUMHUD.CharacterBrowser.Skills, "Skills");
});
