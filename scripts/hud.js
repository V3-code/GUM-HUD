import { resolveAttackDamageDisplay } from "/systems/gum/module/utils/attack-damage-display.mjs";
import { applyAmmunition, normalizeAmmunitionLoadout } from "/systems/gum/module/utils/ammunition.mjs";
import { buildEquipmentConsumptionUpdate, equipmentAvailableUses, resolveEquipment } from "/systems/gum/module/utils/equipment-resolution.mjs";
import { ExecutionOptionsConfig } from "./execution-config.js";
import { CharacterResourceBrowser } from "./character-browser.js";
import {
  EXECUTION_REGISTRY_SETTING,
  LEGACY_MIGRATION_SETTING,
  executionBindingsFor,
  getExecutionRegistry,
  hydrateExecutionSources,
  normalizeExecutionRegistry,
  resolveExecutionSource,
  setExecutionRegistry,
  snapshotExecutionSource
} from "./execution-registry.js";

const MODULE = "gum-hud";
let pinnedToken = null;
let openSelection = null;
let selectionActorUuid = null;
let selectedCombatOptions = new Set();
let combatOptionsPanelOpen = false;
let combatOptionsPanelExpanded = false;
let combatOptionsManeuverKey = "";
let characterBrowser = null;
let characterBrowserQueue = Promise.resolve();
let characterBrowserClosePromise = Promise.resolve();
let preferencesOpen = false;
const VISIBLE_MANEUVERS = 15;

const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const localize = (key, fallback) => {
  const id = `GUMHUD.${key}`;
  const value = game.i18n.localize(id);
  return value === id ? fallback : value;
};
const format = (key, data, fallback) => {
  const id = `GUMHUD.${key}`;
  const value = game.i18n.format(id, data);
  return value === id ? fallback : value;
};
const finiteNumber = value => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const displayNumber = value => finiteNumber(value) ?? "—";

function identityResource(attribute, key) {
  const current = finiteNumber(attribute?.value ?? attribute?.current);
  const maximum = finiteNumber(attribute?.final ?? attribute?.max);
  const percent = maximum > 0 && current != null ? Math.max(0, Math.min(100, current / maximum * 100)) : 0;
  const isLow = maximum > 0 && current != null && current <= maximum / 3;
  const currentLabel = displayNumber(current);
  const maximumLabel = displayNumber(maximum);
  const title = `${key}: ${currentLabel} / ${maximumLabel}`;
  return `<span class="gum-hud-vital ${isLow ? "is-low" : ""}" title="${escape(title)}" aria-label="${escape(title)}"><span class="gum-hud-vital-line"><small>${key}</small><b>${escape(currentLabel)}</b><em>/${escape(maximumLabel)}</em></span><span class="gum-hud-vital-meter" aria-hidden="true"><i style="width:${percent.toFixed(2)}%"></i></span></span>`;
}

function identityMovement(actor) {
  const attributes = actor.system?.attributes || {};
  const definitions = [
    ["basic_move", localize("Identity.GroundMovement", "Terrestre")],
    ["enhanced_move", localize("Identity.EnhancedMovement", "Ampliado")],
    ["air_move", localize("Identity.AirMovement", "Aéreo")],
    ["water_move", localize("Identity.WaterMovement", "Aquático")],
    ["burrow_move", localize("Identity.BurrowMovement", "Escavação")]
  ];
  const modes = definitions.map(([key, label]) => ({
    key, label, value: finiteNumber(attributes[key]?.final ?? attributes[key]?.value)
  })).filter(mode => mode.value != null && (mode.key === "basic_move" || mode.value > 0));
  const ground = modes.find(mode => mode.key === "basic_move");
  const additional = modes.filter(mode => mode.key !== "basic_move");
  const title = modes.length
    ? modes.map(mode => `${mode.label}: ${mode.value}`).join("\n")
    : localize("Identity.MovementUnavailable", "Deslocamento indisponível");
  return `<span class="gum-hud-movement" title="${escape(title)}" aria-label="${escape(title)}"><i class="fas fa-shoe-prints" aria-hidden="true"></i><b>${escape(displayNumber(ground?.value))}</b></span>`;
}
const api = () => game.gum?.api;
const promptRoll = (actor, rollData) => api().rolls.fromHotbar({ actorUuid: actor.uuid, rollData });
const currentToken = () => pinnedToken?.object && canvas?.scene?.id === pinnedToken.parent?.id ? pinnedToken.object : null;
const ownsActor = actor => actor?.isOwner === true;
function openHud(token, { notify = true } = {}) {
  const document = token?.document || token || canvas?.tokens?.controlled?.[0]?.document || null;
  if (!document?.actor || !ownsActor(document.actor)) {
    if (notify) ui.notifications.warn(localize("Permissions.OwnerRequired", "Você precisa ser proprietário do personagem para abrir seu HUD."));
    return false;
  }
  if (characterBrowser && characterBrowser.actorUuid !== document.actor.uuid) closeCharacterBrowser();
  pinnedToken = document;
  render();
  return true;
}
async function closeCharacterBrowser() {
  const browser = characterBrowser;
  characterBrowser = null;
  if (browser) characterBrowserClosePromise = browser.close()
    .catch(error => console.error("GUM HUD | Closing character browser", error))
    .finally(() => document.getElementById(browser.id)?.remove());
  await characterBrowserClosePromise;
}
function retainHudOwnership(actor, { notify = true } = {}) {
  if (ownsActor(actor)) return true;
  pinnedToken = null;
  openSelection = null;
  if (notify) ui.notifications.warn(localize("Permissions.OwnerRequired", "Você precisa ser proprietário do personagem para abrir seu HUD."));
  render();
  return false;
}
const favorites = actor => [...actor.items].filter(item => item.system?.favorite_in_combat === true);
const loadoutFor = actor => game.settings.get(MODULE, "equipmentSlots")?.[actor.uuid] || [];
const loadoutActivityFor = actor => game.settings.get(MODULE, "equipmentActivity")?.[actor.uuid] || {};
const equipmentIsActive = (actor, itemId) => loadoutActivityFor(actor)[itemId] !== false;
const regionIsExpanded = key => game.settings.get(MODULE, "expandedRegions")?.[key] === true;
const equipmentFor = actor => loadoutFor(actor).map(id => actor.items.get(id)).filter(item => item?.type === "equipment" && equipmentIsActive(actor, item.id));
const consumablesFor = actor => [...actor.items]
  .filter(item => item.type === "equipment" && item.system?.is_consumable === true)
  .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
const groups = () => game.settings.get("gum", "effectExclusionGroups") || [];
const selectedGroup = () => {
  const choice = game.settings.get(MODULE, "maneuverGroup").trim();
  return groups().find(group => group.id === choice || group.name === choice);
};
const defenseEntries = (actor, kind) => equipmentFor(actor).flatMap(item => Object.entries(item.system?.melee_attacks || {}).map(([id, attack]) => ({ item, id, attack, value: attack[kind] }))).filter(row => row.value != null && !["", "0", "-"].includes(String(row.value).trim()));

function activeEffectsFor(actor) {
  return [...(actor.effects || [])]
    .filter(effect => !effect.disabled && !effect.suppressed && !effect.isSuppressed && effect.flags?.gum?.hideFromHud !== true)
    .map(effect => {
      const duration = effect.duration || {};
      const gumDuration = effect.flags?.gum?.duration || {};
      const explicitlyPermanent = gumDuration.isPermanent === true;
      const temporary = !explicitlyPermanent && (
        gumDuration.pendingCombat === true || gumDuration.pendingStart === true || gumDuration.inCombat === true ||
        Number(duration.seconds) > 0 || Number(duration.rounds) > 0 || Number(duration.turns) > 0
      );
      let durationLabel = "";
      if (gumDuration.pendingCombat === true) durationLabel = localize("Effects.PendingCombat", "Próximo combate");
      else if (gumDuration.pendingStart === true) durationLabel = localize("Effects.NextTurn", "Próximo turno");
      else if (!explicitlyPermanent && Number(duration.seconds) > 0) durationLabel = format("Effects.Seconds", { count: Math.max(0, Math.ceil(Number(duration.remaining ?? duration.seconds))) }, `${Math.max(0, Math.ceil(Number(duration.remaining ?? duration.seconds)))} s`);
      else if (!explicitlyPermanent && Number(duration.rounds) > 0) durationLabel = format("Effects.Rounds", { count: Math.max(0, Math.ceil(Number(duration.remaining ?? duration.rounds))) }, `${Math.max(0, Math.ceil(Number(duration.remaining ?? duration.rounds)))} rod.`);
      else if (!explicitlyPermanent && Number(duration.turns) > 0) durationLabel = format("Effects.Turns", { count: Math.max(0, Math.ceil(Number(duration.remaining ?? duration.turns))) }, `${Math.max(0, Math.ceil(Number(duration.remaining ?? duration.turns)))} turnos`);
      return {
        effect,
        temporary,
        name: effect.name || localize("Effects.Unnamed", "Efeito sem nome"),
        img: effect.img || effect.icon || "icons/svg/aura.svg",
        durationLabel,
        sourceUuid: String(effect.flags?.gum?.effectUuid || (/\.Item\./.test(effect.origin || "") ? effect.origin : "")).trim()
      };
    })
    .sort((a, b) => Number(b.temporary) - Number(a.temporary) || a.name.localeCompare(b.name, game.i18n.lang));
}

function activeManeuverUuids(actor) {
  const configured = new Set(selectedGroup()?.effectUuids || []);
  return new Set([...actor.effects]
    .map(effect => effect.flags?.gum?.effectUuid)
    .filter(uuid => uuid && configured.has(uuid)));
}

function executionOptionsFor(actor) {
  const bindings = executionBindingsFor(getExecutionRegistry(), { actorUuid: actor.uuid, maneuverUuids: activeManeuverUuids(actor) });
  return bindings.map(binding => ({ binding, item: resolveExecutionSource(binding, actor) }))
    .filter(option => option.item && (option.binding.sourceType === "effect" ? option.item.type === "effect" : option.item.type === "gm_modifier"))
    .sort((a, b) => a.binding.order - b.binding.order || a.item.name.localeCompare(b.item.name, game.i18n.lang));
}

function portableModifierData(option) {
  const system = option.item.system || {};
  const clone = value => foundry.utils.deepClone(value ?? null);
  return {
    id: option.binding.id,
    sourceItemId: option.item.id,
    name: option.item.name,
    system: {
      modifier_entries: clone(system.modifier_entries) || [],
      modifier: system.modifier,
      nh_cap: system.nh_cap,
      contexts: clone(system.contexts),
      context: system.context,
      roll_tags: clone(system.roll_tags) || [],
      roll_tag_match: system.roll_tag_match
    }
  };
}

function modifierOptionValue(item) {
  const entries = Array.isArray(item.system?.modifier_entries) && item.system.modifier_entries.length
    ? item.system.modifier_entries
    : [{ value: item.system?.modifier }];
  return entries.map(entry => String(entry?.value ?? "0").trim() || "0").join(" · ");
}

function effectGroupFor(uuid) {
  return groups().find(group => Array.isArray(group.effectUuids) && group.effectUuids.includes(uuid)) || null;
}

function executionOptionBehavior(option) {
  const exclusion = option.binding.sourceType === "effect" ? effectGroupFor(option.binding.sourceUuid) : null;
  return {
    group: String(exclusion?.name || option.binding.group || "").trim(),
    mode: exclusion ? "exclusive" : option.binding.mode,
    reset: option.binding.reset
  };
}

function effectOptionActive(actor, option) {
  return option.binding.sourceType === "effect" && [...actor.effects].some(effect => effect.flags?.gum?.effectUuid === option.binding.sourceUuid);
}

function executionOptionSelected(actor, option) {
  return option.binding.sourceType === "effect" ? effectOptionActive(actor, option) : selectedCombatOptions.has(option.binding.id);
}

async function toggleExecutionOption(actor, option, token) {
  if (!option) return;
  const selected = executionOptionSelected(actor, option);
  if (selected) {
    if (option.binding.sourceType === "effect") {
      const activeIds = [...actor.effects].filter(effect => effect.flags?.gum?.effectUuid === option.binding.sourceUuid).map(effect => effect.id);
      if (activeIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", activeIds);
    } else selectedCombatOptions.delete(option.binding.id);
    return;
  }
  const behavior = executionOptionBehavior(option);
  const group = behavior.group || option.binding.id;
  if (behavior.mode === "exclusive") {
    const available = executionOptionsFor(actor);
    const effectIds = [];
    for (const peer of available) {
      if (peer.binding.id === option.binding.id || !executionOptionSelected(actor, peer)) continue;
      const peerBehavior = executionOptionBehavior(peer);
      if ((peerBehavior.group || peer.binding.id) !== group) continue;
      if (peer.binding.sourceType === "modifier") selectedCombatOptions.delete(peer.binding.id);
      else effectIds.push(...[...actor.effects].filter(effect => effect.flags?.gum?.effectUuid === peer.binding.sourceUuid).map(effect => effect.id));
    }
    if (effectIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", [...new Set(effectIds)]);
  }
  if (option.binding.sourceType === "effect") await api().effects.apply(option.binding.sourceUuid, [token], {
    actor,
    origin: actor,
    source: "GUM HUD",
    tokenIconPolicyOverride: "always"
  });
  else selectedCombatOptions.add(option.binding.id);
}

const withExecutionOptions = (actor, rollData) => {
  const selected = executionOptionsFor(actor)
    .filter(option => option.binding.sourceType === "modifier" && selectedCombatOptions.has(option.binding.id));
  return {
    ...rollData,
    preselectedModifierData: selected.map(portableModifierData),
    gumHudExecutionBindingIds: selected.map(option => option.binding.id)
  };
};

function specialDefenseEntries(actor) {
  return favorites(actor)
    .filter(item => ["spell", "power"].includes(item.type) && item.system?.active_defense_enabled === true)
    .map(item => {
      const rule = item.system.active_defense_rule || "half_plus_three";
      const nh = Number(item.system.final_nh);
      const fixed = Number(item.system.active_defense_value);
      const value = rule === "fixed" ? fixed : rule === "skill" ? nh : Math.floor(nh / 2) + 3;
      const ruleLabel = rule === "fixed" ? localize("Defense.FixedValue", "Valor fixo") : rule === "skill" ? localize("Defense.SkillLevel", "NH") : localize("Defense.HalfPlusThree", "NH/2 + 3");
      return { item, rule, ruleLabel, nh, value: Number.isFinite(value) ? value : null };
    })
    .sort((a, b) => a.item.name.localeCompare(b.item.name, game.i18n.lang));
}

function consumableState(item) {
  const source = item._source?.system || item.system || {};
  const resolution = item.system?.equipmentResolution || resolveEquipment(source);
  const available = equipmentAvailableUses(item.system || source, resolution);
  const charges = resolution.uses?.mode === "charges";
  return {
    resolution,
    available,
    label: charges ? localize("Consumables.Charges", "Cargas") : localize("Consumables.Quantity", "Quantidade"),
    display: charges && !resolution.uses?.consumeQuantityWhenEmpty
      ? `${resolution.uses.remaining}/${resolution.uses.max}`
      : String(available)
  };
}

async function consumeEquipment(actor, item) {
  if (!item || item.type !== "equipment" || item.system?.is_consumable !== true) return;
  const state = consumableState(item);
  const consumption = buildEquipmentConsumptionUpdate(item.system, state.resolution);
  if (!consumption.consumed) {
    ui.notifications.warn(consumption.reason === "empty_charges"
      ? format("Notifications.NoCharges", { name: item.name }, `"${item.name}" não possui cargas restantes.`)
      : format("Notifications.NoQuantity", { name: item.name }, `"${item.name}" não possui quantidade suficiente para consumir.`));
    return;
  }
  await item.update(consumption.updates);
  await api().effects.applyUseEvent(item, actor, "consume");
  const nextQuantity = consumption.updates["system.quantity"] ?? item.system.quantity;
  const nextSpent = consumption.updates["system.current_uses"] ?? consumption.uses.spent;
  ui.notifications.info(consumption.mode === "charges"
    ? format("Notifications.UsedCharges", { name: item.name, remaining: Math.max(0, consumption.uses.max - nextSpent), exhausted: consumption.exhausted ? localize("Notifications.Exhausted", " (esgotado)") : "" }, `${item.name} usado. Cargas restantes: ${Math.max(0, consumption.uses.max - nextSpent)}${consumption.exhausted ? " (esgotado)" : ""}.`)
    : format("Notifications.ConsumedQuantity", { name: item.name, remaining: nextQuantity }, `${item.name} consumido. Quantidade restante: ${nextQuantity}.`));
}

function characterBrowserActions() {
  return {
    damageLabel: damageText,
    attackDamageLabel: (actor, attack) => attackDamage(actor, attack).main,
    consumableState,
    effectsFor: activeEffectsFor,
    preview: async (actor, item) => api().ui.previewItem(item.id, { actor, sendToChat: true }),
    previewEffect: async (actor, effect) => {
      if (effect.sourceUuid) await api().ui.previewItem(effect.sourceUuid, { actor, sendToChat: true });
    },
    rollAbility: async (actor, item) => {
      closeSelectionForRoll();
      await promptRoll(actor, withExecutionOptions(actor, { type: item.type, value: item.type === "skill" ? item.system.tree_final_nh ?? item.system.final_nh : item.system.final_nh, itemId: item.id, attributeKey: item.type === "skill" ? item.system.tree_base_attribute || item.system.base_attribute : undefined, label: item.name }));
    },
    rollAbilityAttack: async (actor, item) => {
      if (!item.system?.uses_attack) return;
      closeSelectionForRoll();
      await promptRoll(actor, withExecutionOptions(actor, { type: "attack", value: item.system.attack_nh, itemId: item.id, attackType: item.system.attack_type, attributeKey: item.system.attack_roll?.skill_name, label: `${item.name}: ${localize("Roll.Attack", "Ataque")}` }));
    },
    rollAttack: async (actor, item, attackId) => {
      const attack = item.system?.melee_attacks?.[attackId] || item.system?.ranged_attacks?.[attackId];
      if (!attack) return;
      closeSelectionForRoll();
      await promptRoll(actor, withExecutionOptions(actor, { type: "attack", value: attack.final_nh, itemId: item.id, attackId, attackType: item.system.melee_attacks?.[attackId] ? "melee" : "ranged", label: `${item.name}: ${attack.mode || attack.name || localize("Roll.Attack", "Ataque")}` }));
    },
    damageItem: async (actor, item) => {
      if (!item.system?.damage?.formula) return;
      closeSelectionForRoll();
      await api().damage.fromHotbar({ actorUuid: actor.uuid, damageData: { kind: "item", itemId: item.id, itemUuid: item.uuid } });
    },
    damageAttack: async (actor, item, attackId) => {
      if (!item.system?.melee_attacks?.[attackId] && !item.system?.ranged_attacks?.[attackId]) return;
      closeSelectionForRoll();
      await api().damage.fromHotbar({ actorUuid: actor.uuid, damageData: { kind: "item", itemId: item.id, itemUuid: item.uuid, attackId } });
    },
    consume: consumeEquipment,
    categoryChanged: () => render(),
    closed: browser => { if (characterBrowser === browser) { characterBrowser = null; render(); } }
  };
}

async function openCharacterBrowser(actor, category) {
  if (!ownsActor(actor)) return;
  if (characterBrowser?.actorUuid === actor.uuid) {
    if (characterBrowser.category === category) {
      await closeCharacterBrowser();
      render();
      return;
    }
  }
  await closeCharacterBrowser();
  const browser = new CharacterResourceBrowser({ actor, category, actions: characterBrowserActions() });
  characterBrowser = browser;
  browser.render(true);
  await browser.whenRendered();
  if (characterBrowser !== browser) return;
  render();
}

function requestCharacterBrowser(actor, category) {
  characterBrowserQueue = characterBrowserQueue
    .catch(error => console.error("GUM HUD | Character browser queue", error))
    .then(() => openCharacterBrowser(actor, category));
  return characterBrowserQueue;
}

function groupedDefenses(actor, kind) {
  const byItem = new Map();
  for (const row of defenseEntries(actor, kind)) {
    if (!byItem.has(row.item.id)) byItem.set(row.item.id, { item: row.item, options: new Map() });
    const options = byItem.get(row.item.id).options;
    const skill = String(row.attack.resolved_skill_name || row.attack.skill_name || localize("Combat.NoSkill", "Sem perícia")).trim();
    const key = `${skill.toLocaleLowerCase()}\u0000${String(row.value).trim()}`;
    if (!options.has(key)) options.set(key, { ...row, skill, modes: [] });
    options.get(key).modes.push(row.attack.mode || row.attack.name || localize("Combat.UseMode", "Modo de uso"));
  }
  return [...byItem.values()].map(({ item, options }) => ({ item, options: [...options.values()] }));
}

function damageText(actor, damage) {
  if (!damage?.formula) return "";
  const formula = resolveAttackDamageDisplay(damage.formula, actor.system?.attributes || {});
  const divisor = Number(damage.armor_divisor) > 1 ? `(${damage.armor_divisor})` : "";
  return `${formula}${divisor} ${damage.type || ""}`.trim();
}

function attackDamage(actor, attack) {
  const effective = attack.effective_damage || {};
  const profile = {
    main: effective.main?.formula ? effective.main : { formula: attack.effective_damage_formula || attack.damage_formula, type: attack.damage_type, armor_divisor: attack.armor_divisor },
    follow_up: effective.follow_up?.formula ? effective.follow_up : attack.follow_up_damage || {},
    fragmentation: effective.fragmentation?.formula ? effective.fragmentation : attack.fragmentation_damage || {}
  };
  const ammunitionId = normalizeAmmunitionLoadout(attack.ammunition_loadout).ammunitionId;
  const ammunition = ammunitionId ? actor.items.get(ammunitionId) : null;
  const damage = ammunition ? applyAmmunition(profile, ammunition) : profile;
  const followUp = damageText(actor, damage.follow_up);
  const fragmentation = damageText(actor, damage.fragmentation);
  return { main: damageText(actor, damage.main) || "—", extras: [followUp && `${localize("Combat.FollowUpAbbrev", "Acomp.")} ${followUp}`, fragmentation && `${localize("Combat.FragmentationAbbrev", "Frag.")} ${fragmentation}`].filter(Boolean) };
}

const CATEGORY_TYPES = ["skill", "spell", "power"];
const categoryName = type => ({
  skill: localize("Categories.Skills", "Perícias"),
  spell: localize("Categories.Spells", "Magias"),
  power: localize("Categories.Powers", "Poderes")
})[type];
const categoryIcons = {
  skill: "icons/skills/trades/academics-merchant-scribe.webp",
  spell: "icons/skills/trades/academics-book-study-purple.webp",
  power: "icons/skills/social/intimidation-impressing.webp"
};
const categorizedFavorites = actor => {
  const featured = favorites(actor);
  return Object.fromEntries(CATEGORY_TYPES.map(type => [type, featured.filter(item => item.type === type).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))]));
};

function categoryMarkup(actor, type) {
  const items = categorizedFavorites(actor)[type] || [];
  return items.map(item => {
    const system = item.system || {};
    const skill = type === "skill";
    const nh = skill ? system.tree_final_nh ?? system.final_nh : system.final_nh;
    const attackNh = !skill && system.uses_attack ? system.attack_nh : null;
    const damage = !skill && system.damage?.formula ? {
      main: damageText(actor, system.damage),
      extras: [system.damage.follow_up_damage?.formula && `${localize("Combat.FollowUpAbbrev", "Acomp.")} ${damageText(actor, system.damage.follow_up_damage)}`, system.damage.fragmentation_damage?.formula && `${localize("Combat.FragmentationAbbrev", "Frag.")} ${damageText(actor, system.damage.fragmentation_damage)}`].filter(Boolean)
    } : null;
    const subtitle = skill ? system.specialization || localize("Categories.Skill", "Perícia") : type === "spell" ? [system.casting_time, system.mana_cost != null && `${localize("Combat.Cost", "Custo")} ${system.mana_cost}`].filter(Boolean).join(" · ") : [system.activation_time, system.activation_cost != null && `${localize("Combat.Cost", "Custo")} ${system.activation_cost}`].filter(Boolean).join(" · ");
    return `<div class="gum-hud-domino gum-hud-ability-domino ${skill ? "is-skill" : ""}" data-preview-item="${escape(item.id)}" aria-label="${escape(item.name)}"><span class="gum-hud-mode-icon"><img src="${escape(item.img)}" alt=""></span><span class="gum-hud-mode-name" title="${escape(item.name)}"><strong>${escape(item.name)}</strong><small>${escape(subtitle)}</small></span><button type="button" class="gum-hud-mode-action gum-hud-mode-stat" data-ability="${escape(item.id)}" title="${escape(format("Roll.RollItem", { name: item.name }, `Rolar ${item.name}`))}"><small>${localize("Roll.SkillLevel", "ROLAR NH")}</small><strong>${escape(nh ?? "—")}</strong></button>${attackNh != null && attackNh !== "" ? `<button type="button" class="gum-hud-mode-action gum-hud-mode-stat" data-ability-attack="${escape(item.id)}" title="${escape(format("Roll.AttackItem", { name: item.name }, `Rolar ataque de ${item.name}`))}"><small>${localize("Roll.Attack", "ATAQUE")}</small><strong>${escape(attackNh)}</strong></button>` : ""}${damage ? `<button type="button" class="gum-hud-mode-action gum-hud-mode-damage" data-damage-item="${escape(item.id)}" title="${escape(format("Roll.DamageItem", { name: item.name }, `Rolar dano de ${item.name}`))}"><small>${localize("Roll.Damage", "ROLAR DANO")}</small><strong>${escape(damage.main)}</strong>${damage.extras.map(extra => `<em>${escape(extra)}</em>`).join("")}</button>` : ""}</div>`;
  }).join("");
}

function expandedMarkup(actor) {
  if (!openSelection) return "";
  if (openSelection.kind === "defense") {
    const defenseLabel = openSelection.key === "final_parry" ? localize("Defense.Parry", "Aparar") : localize("Defense.Block", "Bloqueio");
    return groupedDefenses(actor, openSelection.key).map(({ item, options }) => `<section class="gum-hud-domino gum-hud-defense-domino" data-preview-item="${escape(item.id)}" aria-label="${escape(item.name)}"><div class="gum-hud-defense-domino-heading" title="${escape(item.name)}"><img src="${escape(item.img)}" alt=""><strong>${escape(item.name)}</strong><small>${escape(defenseLabel)}</small></div><div class="gum-hud-domino-options">${options.map(row => `<button class="gum-hud-domino-defense" data-defense-item="${escape(item.id)}" data-defense-attack="${escape(row.id)}" data-defense-kind="${openSelection.key}" title="${escape(item.name)} · ${escape(row.skill)} · ${escape(row.modes.join(", "))}: ${escape(row.value)}"><strong>${escape(row.value)}</strong><span>${escape(row.skill)}</span></button>`).join("")}</div></section>`).join("");
  }
  if (openSelection.kind === "specialDefense") {
    return specialDefenseEntries(actor).map(({ item, ruleLabel, nh, value }) => `<section class="gum-hud-domino gum-hud-defense-domino gum-hud-special-defense-domino" data-preview-item="${escape(item.id)}" aria-label="${escape(item.name)}"><div class="gum-hud-defense-domino-heading" title="${escape(item.name)}"><img src="${escape(item.img)}" alt=""><strong>${escape(item.name)}</strong><small>${escape(localize("Defense.Special", "Especial"))}</small></div><div class="gum-hud-domino-options"><button class="gum-hud-domino-defense" data-special-defense="${escape(item.id)}" ${value == null ? "disabled" : ""} title="${escape(item.name)} · ${escape(ruleLabel)}${Number.isFinite(nh) ? ` · NH ${escape(nh)}` : ""}: ${escape(value ?? "—")}"><strong>${escape(value ?? "—")}</strong><span>${escape(ruleLabel)}</span></button></div></section>`).join("");
  }
  if (openSelection.kind === "consumables") {
    return consumablesFor(actor).map(item => {
      const state = consumableState(item);
      return `<div class="gum-hud-domino gum-hud-consumable-domino" data-preview-item="${escape(item.id)}" aria-label="${escape(item.name)}"><span class="gum-hud-mode-icon"><img src="${escape(item.img)}" alt=""></span><span class="gum-hud-mode-name" title="${escape(item.name)}"><strong>${escape(item.name)}</strong><small>${escape(state.label)}</small></span><span class="gum-hud-consumable-balance"><small>${escape(state.label)}</small><strong>${escape(state.display)}</strong></span><button type="button" class="gum-hud-mode-action gum-hud-consumable-use" data-consume-item="${escape(item.id)}" ${state.available <= 0 ? "disabled" : ""} title="${escape(format("Consumables.UseItem", { name: item.name }, `Usar ${item.name}`))}"><small>${localize("Consumables.Use", "USAR")}</small><i class="fas fa-hand-pointer" aria-hidden="true"></i></button></div>`;
    }).join("");
  }
  if (openSelection.kind === "category") return categoryMarkup(actor, openSelection.key);
  const item = actor.items.get(openSelection.key);
  if (!item) return "";
  const attacks = Object.entries({ ...item.system?.melee_attacks, ...item.system?.ranged_attacks });
  return attacks.map(([id, attack]) => {
    const mode = attack.mode || attack.name || item.name;
    const skill = attack.resolved_skill_name || attack.skill_name || "";
    const damage = attackDamage(actor, attack);
    const icon = attack.img || attack.icon || attack.mode_image;
    return `<div class="gum-hud-domino gum-hud-attack-domino" data-preview-item="${escape(item.id)}" aria-label="${escape(item.name)} · ${escape(mode)}"><span class="gum-hud-mode-icon">${icon ? `<img src="${escape(icon)}" alt="">` : `<i class="fas ${item.system?.melee_attacks?.[id] ? "fa-swords" : "fa-bullseye"}" aria-hidden="true"></i>`}</span><span class="gum-hud-mode-name" title="${escape(mode)}${skill ? ` · ${escape(skill)}` : ""}"><strong>${escape(mode)}</strong>${skill ? `<small>${escape(skill)}</small>` : ""}</span><button type="button" class="gum-hud-mode-action gum-hud-mode-stat" data-attack="${escape(id)}" data-source="${escape(item.id)}" title="${escape(format("Roll.AttackMode", { item: item.name, mode }, `Rolar ataque: ${item.name} · ${mode}`))}"><small>${localize("Roll.SkillLevel", "ROLAR NH")}</small><strong>${escape(attack.final_nh ?? "—")}</strong></button><button type="button" class="gum-hud-mode-action gum-hud-mode-damage" data-damage-attack="${escape(id)}" data-source="${escape(item.id)}" title="${escape(format("Roll.DamageMode", { item: item.name, mode }, `Rolar dano: ${item.name} · ${mode}`))}" ${damage.main === "—" ? "disabled" : ""}><small>${localize("Roll.Damage", "ROLAR DANO")}</small><strong>${escape(damage.main)}</strong>${damage.extras.map(extra => `<em>${escape(extra)}</em>`).join("")}</button></div>`;
  }).join("") || `<button class="gum-hud-feature" data-ability="${escape(item.id)}" data-preview-item="${escape(item.id)}" title="${escape(format("Consumables.UseItem", { name: item.name }, `Usar ${item.name}`))}"><img src="${escape(item.img)}" alt=""><span>${escape(item.name)}</span></button>`;
}

function toggleSelection(kind, key) {
  openSelection = openSelection?.kind === kind && openSelection.key === key ? null : { kind, key };
  render();
}

function closeSelectionForRoll() {
  if (!openSelection) return;
  openSelection = null;
  render();
}

function regionChrome(label, key, expandable) {
  const header = `<header><span>${label}</span></header>`;
  if (!expandable) return header;
  const expanded = regionIsExpanded(key);
  const action = expanded ? localize("General.Collapse", "Recolher") : localize("General.Expand", "Expandir");
  return `<header><button type="button" class="gum-hud-region-toggle" data-toggle-region="${key}" aria-expanded="${expanded}" title="${escape(action)} ${escape(label.toLocaleLowerCase())}"><span>${label}</span><i class="fas fa-caret-${expanded ? "down" : "up"}" aria-hidden="true"></i></button></header>`;
}

function maneuverChrome(label, expandable, options, actor) {
  const expanded = regionIsExpanded("maneuvers");
  const optionCount = options.length;
  const selectedCount = options.filter(option => executionOptionSelected(actor, option)).length;
  const regionAction = expanded ? localize("General.Collapse", "Recolher") : localize("General.Expand", "Expandir");
  const regionControl = expandable
    ? `<button type="button" class="gum-hud-region-toggle" data-toggle-region="maneuvers" aria-expanded="${expanded}" title="${escape(regionAction)} ${escape(label.toLocaleLowerCase())}"><span>${label}</span><i class="fas fa-caret-${expanded ? "down" : "up"}" aria-hidden="true"></i></button>`
    : `<span>${label}</span>`;
  const optionsControl = optionCount
    ? `<button type="button" class="gum-hud-combat-options-toggle ${combatOptionsPanelOpen ? "is-selected" : ""}" data-toggle-combat-options aria-expanded="${combatOptionsPanelOpen}" title="${escape(combatOptionsPanelOpen ? localize("CombatOptions.Collapse", "Recolher opções de execução") : localize("CombatOptions.Expand", "Expandir opções de execução"))}"><i class="fas fa-crosshairs" aria-hidden="true"></i><b>${selectedCount}/${optionCount}</b><i class="fas fa-caret-${combatOptionsPanelOpen ? "down" : "up"}" aria-hidden="true"></i></button>`
    : "";
  const configControl = game.user.isGM
    ? `<button type="button" class="gum-hud-execution-config-button" data-config-execution title="${escape(localize("CombatOptions.Configure", "Configurar opções de execução"))}"><i class="fas fa-cog" aria-hidden="true"></i></button>`
    : "";
  return `<header class="gum-hud-maneuver-footer"><div>${regionControl}${optionsControl}${configControl}</div></header>`;
}

function combatOptionsPanelMarkup(actor, options) {
  if (!options.length) return "";
  const groups = new Map();
  options.forEach((option, index) => {
    const selected = executionOptionSelected(actor, option);
    const behavior = executionOptionBehavior(option);
    const cumulative = behavior.mode === "cumulative";
    const mode = cumulative ? localize("CombatOptions.Cumulative", "Cumulativa") : localize("CombatOptions.Exclusive", "Exclusiva");
    const groupName = behavior.group;
    const key = groupName ? `named:${groupName}:${cumulative ? "cumulative" : "exclusive"}` : `general:${cumulative ? "cumulative" : "independent"}`;
    const label = groupName || (cumulative ? localize("CombatOptions.CumulativePlural", "Cumulativas") : localize("CombatOptions.General", "Gerais"));
    const qualifier = groupName
      ? (cumulative ? localize("CombatOptions.CumulativePlural", "Cumulativas") : localize("CombatOptions.ExclusivePlural", "Exclusivas"))
      : (cumulative ? localize("CombatOptions.Combine", "Combináveis") : localize("CombatOptions.Independent", "Independentes"));
    if (!groups.has(key)) groups.set(key, { label, qualifier, cumulative, firstIndex: index, cards: [] });
    const value = option.binding.sourceType === "effect" ? localize("CombatOptions.Effect", "Efeito") : modifierOptionValue(option.item);
    const preview = `data-preview-uuid="${escape(option.binding.sourceUuid)}"`;
    groups.get(key).cards.push(`<button type="button" class="gum-hud-combat-option-mini ${option.binding.sourceType === "effect" ? "is-effect" : "is-modifier"} ${selected ? "is-selected" : ""} ${index >= 4 ? "is-overflow" : ""}" data-execution-option="${escape(option.binding.id)}" ${preview} aria-pressed="${selected}" title="${escape(option.item.name)} · ${escape(mode)} · ${escape(value)}"><span><img src="${escape(option.item.img)}" alt=""><small>${escape(value)}</small></span><strong>${escape(option.item.name)}</strong></button>`);
  });
  const sections = [...groups.values()].map(group => `<section class="gum-hud-combat-option-group ${group.cumulative ? "is-cumulative" : "is-exclusive"} ${group.firstIndex >= 4 ? "is-overflow" : ""}"><div class="gum-hud-combat-option-group-label"><span>${escape(group.label)}</span><small>${escape(group.qualifier)}</small></div><div class="gum-hud-combat-options-grid">${group.cards.join("")}</div></section>`).join("");
  const hiddenCount = Math.max(0, options.length - 4);
  const more = hiddenCount
    ? `<button type="button" class="gum-hud-combat-options-more" data-expand-combat-options aria-expanded="${combatOptionsPanelExpanded}">${combatOptionsPanelExpanded ? localize("CombatOptions.ShowLess", "Mostrar menos") : format("CombatOptions.ShowMore", { count: hiddenCount }, `+${hiddenCount} opções`)}</button>`
    : "";
  return `<aside class="gum-hud-combat-options-panel ${combatOptionsPanelOpen ? "is-open" : ""} ${combatOptionsPanelExpanded ? "is-expanded" : ""}" aria-label="${escape(localize("CombatOptions.StrikeOptions", "Opções de execução"))}"><div class="gum-hud-combat-options-heading"><i class="fas fa-crosshairs" aria-hidden="true"></i><span>${localize("CombatOptions.StrikeOptions", "Opções de execução")}</span></div><div class="gum-hud-combat-option-groups">${sections}</div>${more}</aside>`;
}

function anchorHotbar(hotbar, desiredLeft, desiredTop) {
  const rect = hotbar.getBoundingClientRect();
  const previousX = Number.parseFloat(hotbar.style.getPropertyValue("--gum-hud-hotbar-shift-x")) || 0;
  const previousY = Number.parseFloat(hotbar.style.getPropertyValue("--gum-hud-hotbar-shift-y")) || 0;
  hotbar.style.setProperty("--gum-hud-hotbar-shift-x", `${Math.round(previousX + desiredLeft - rect.left)}px`);
  hotbar.style.setProperty("--gum-hud-hotbar-shift-y", `${Math.round(previousY + desiredTop - rect.top)}px`);
}

function fitToFoundry(root) {
  const sidebar = document.querySelector("#sidebar");
  const chat = document.querySelector("#chat-form");
  const rightEdge = [sidebar, chat]
    .filter(element => element && element.getClientRects().length)
    .map(element => element.getBoundingClientRect().left)
    .filter(left => left > 300);
  const available = Math.min(window.innerWidth - 16, (rightEdge.length ? Math.min(...rightEdge) : window.innerWidth) - 16);
  root.style.maxWidth = `${Math.max(320, available)}px`;
  const hotbar = document.querySelector("#hotbar");
  const equipmentHotbar = document.body.classList.contains("gum-hud-hotbar-equipment");
  const belowHotbar = document.body.classList.contains("gum-hud-hotbar-below");
  if (equipmentHotbar) {
    root.style.bottom = "12px";
    const loadout = root.querySelector(".gum-hud-loadout");
    const loadoutRect = loadout?.getBoundingClientRect();
    if (loadoutRect && hotbar?.getClientRects().length) {
      document.body.style.setProperty("--gum-hud-hotbar-left", `${Math.max(8, Math.round(loadoutRect.left))}px`);
      document.body.style.setProperty("--gum-hud-hotbar-bottom", `${Math.max(8, Math.round(window.innerHeight - loadoutRect.top + 5))}px`);
      const hotbarRect = hotbar.getBoundingClientRect();
      anchorHotbar(hotbar, loadoutRect.left, loadoutRect.top - hotbarRect.height - 5);
    }
  } else if (belowHotbar) {
    root.style.bottom = "48px";
    if (hotbar?.getClientRects().length) {
      const rootRect = root.getBoundingClientRect();
      const desiredLeft = rootRect.left + 238;
      const desiredTop = window.innerHeight - 40;
      anchorHotbar(hotbar, desiredLeft, desiredTop);
    }
  } else {
    document.body.style.removeProperty("--gum-hud-hotbar-left");
    document.body.style.removeProperty("--gum-hud-hotbar-bottom");
    hotbar?.style.removeProperty("--gum-hud-hotbar-shift-x");
    hotbar?.style.removeProperty("--gum-hud-hotbar-shift-y");
    const hotbarTop = hotbar?.getClientRects().length ? hotbar.getBoundingClientRect().top : window.innerHeight;
    root.style.bottom = `${hotbarTop < window.innerHeight - 20 ? Math.max(12, window.innerHeight - hotbarTop + 8) : 12}px`;
  }
  fitExpandedPanels(root);
}

function fitExpandedPanels(root) {
  const panels = root.querySelectorAll(".gum-hud-expanded:not(:empty), .gum-hud-maneuver-palette:not([hidden]), .gum-hud-combat-options-panel.is-open:not(.is-suspended)");
  for (const panel of panels) {
    panel.classList.toggle("is-multicolumn", panel.classList.contains("gum-hud-expanded") && panel.children.length > 6 && window.innerWidth >= 1100);
    panel.style.removeProperty("transform");
    const rect = panel.getBoundingClientRect();
    const leftCorrection = Math.max(0, 8 - rect.left);
    const rightCorrection = Math.max(0, rect.right - (window.innerWidth - 8));
    const delta = leftCorrection - rightCorrection;
    if (delta) panel.style.transform = `translateX(${delta}px)`;
  }
}

function render() {
  document.getElementById("gum-hud-bar")?.remove();
  const token = currentToken();
  if (token && !ownsActor(token.actor)) {
    pinnedToken = null;
    openSelection = null;
    combatOptionsPanelOpen = false;
  }
  const allowedToken = token && ownsActor(token.actor) ? token : null;
  const hudAvailable = Boolean(allowedToken && api());
  const hideHotbar = game.settings.get(MODULE, "hideHotbar");
  const hotbarLayout = game.settings.get(MODULE, "hotbarLayout");
  document.body.classList.toggle("gum-hud-hide-hotbar", hudAvailable && hideHotbar);
  document.body.classList.toggle("gum-hud-compact-hotbar", hudAvailable && !hideHotbar && hotbarLayout !== "native");
  document.body.classList.toggle("gum-hud-hotbar-equipment", hudAvailable && !hideHotbar && hotbarLayout === "equipment");
  document.body.classList.toggle("gum-hud-hotbar-below", hudAvailable && !hideHotbar && hotbarLayout === "below");
  if (!allowedToken || !api()) { closeCharacterBrowser(); return; }
  const tokenForHud = allowedToken;
  const actor = tokenForHud.actor;
  if (selectionActorUuid !== actor.uuid) {
    openSelection = null;
    preferencesOpen = false;
    selectedCombatOptions = new Set();
    combatOptionsPanelOpen = false;
    combatOptionsPanelExpanded = false;
    combatOptionsManeuverKey = "";
    selectionActorUuid = actor.uuid;
  }
  const group = selectedGroup();
  const active = new Set([...actor.effects].filter(effect => effect.flags?.gum?.stackingDomain === "direct").map(effect => effect.flags?.gum?.effectUuid));
  const combatItems = [...equipmentFor(actor), ...favorites(actor).filter(item => item.type !== "equipment" && !CATEGORY_TYPES.includes(item.type))];
  const groupedItems = categorizedFavorites(actor);
  const specialDefenses = specialDefenseEntries(actor);
  const consumables = consumablesFor(actor);
  const combatOptions = executionOptionsFor(actor);
  const availableCombatOptionIds = new Set(combatOptions.filter(option => option.binding.sourceType === "modifier").map(option => option.binding.id));
  for (const bindingId of [...selectedCombatOptions]) if (!availableCombatOptionIds.has(bindingId)) selectedCombatOptions.delete(bindingId);
  const maneuverKey = [...activeManeuverUuids(actor)].sort().join("|");
  if (!combatOptions.length) {
    combatOptionsPanelOpen = false;
    combatOptionsPanelExpanded = false;
    combatOptionsManeuverKey = maneuverKey;
  } else if (maneuverKey !== combatOptionsManeuverKey) {
    combatOptionsManeuverKey = maneuverKey;
    combatOptionsPanelOpen = true;
    combatOptionsPanelExpanded = false;
  }
  const visibleCategories = CATEGORY_TYPES.filter(type => groupedItems[type].length);
  const categoryCards = visibleCategories.map(type => {
    const label = categoryName(type);
    const selected = openSelection?.kind === "category" && openSelection.key === type;
    return `<button data-category="${type}" class="gum-hud-card gum-hud-category ${selected ? "is-selected" : ""}" aria-expanded="${selected}" title="${label}: ${groupedItems[type].length}"><img src="${categoryIcons[type]}" alt=""><span>${label}</span><b>${groupedItems[type].length}</b></button>`;
  }).join("");
  const itemCards = combatItems.map(item => `<button data-item="${escape(item.id)}" class="gum-hud-card ${openSelection?.kind === "item" && openSelection.key === item.id ? "is-selected" : ""}" aria-expanded="${openSelection?.kind === "item" && openSelection.key === item.id}" title="${escape(item.name)}"><img src="${escape(item.img)}" alt=""><span>${escape(item.name)}</span></button>`).join("") + categoryCards;
  const assigned = loadoutFor(actor);
  const equipmentSlots = Array.from({ length: 6 }, (_, index) => {
    const item = actor.items.get(assigned[index]);
    const active = item ? equipmentIsActive(actor, item.id) : false;
    const stateLabel = active ? localize("Slots.Deactivate", "Ocultar das opções de combate") : localize("Slots.Activate", "Exibir nas opções de combate");
    return `<div class="gum-hud-slot ${item ? (active ? "is-active" : "is-inactive") : ""}" data-slot="${index}" ${item ? `data-preview-item="${escape(item.id)}"` : ""} title="${item ? `${escape(item.name)} · ${escape(stateLabel)}` : escape(localize("Slots.DropEquipment", "Arraste um equipamento da ficha"))}">${item ? `<img src="${escape(item.img)}" alt=""><button type="button" class="gum-hud-slot-activity" data-toggle-equipment="${escape(item.id)}" aria-pressed="${active}" title="${escape(stateLabel)}"><i aria-hidden="true"></i></button><button type="button" data-clear-slot="${index}" title="${escape(localize("Slots.RemoveShortcut", "Remover atalho"))}">×</button>` : `<span>+</span>`}</div>`;
  }).join("");
  const activeEffects = activeEffectsFor(actor);
  const allManeuvers = group?.effectUuids || [];
  const activeIndex = allManeuvers.findIndex(uuid => active.has(uuid));
  const visibleIndices = allManeuvers.length <= 16 ? allManeuvers.map((_, index) => index) : allManeuvers.slice(0, VISIBLE_MANEUVERS).map((_, index) => index);
  if (activeIndex >= VISIBLE_MANEUVERS && !visibleIndices.includes(activeIndex)) visibleIndices[VISIBLE_MANEUVERS - 1] = activeIndex;
  const maneuverCard = index => {
    const uuid = allManeuvers[index], item = game.gumHud.maneuverItems.get(uuid);
    const label = item?.name || format("Maneuvers.FallbackName", { number: index + 1 }, `Manobra ${index + 1}`);
    return `<button data-maneuver="${index}" data-preview-uuid="${escape(uuid)}" class="gum-hud-maneuver ${active.has(uuid) ? "active" : ""}" data-tooltip="${escape(label)}" aria-label="${escape(label)}"><img src="${escape(item?.img || "icons/svg/aura.svg")}" alt=""></button>`;
  };
  const maneuvers = visibleIndices.map(maneuverCard).join("") + (allManeuvers.length > 16 ? `<button data-more-maneuvers class="gum-hud-maneuver gum-hud-more" title="${escape(localize("Maneuvers.All", "Todas as manobras"))}">+${allManeuvers.length - visibleIndices.length}</button>` : "");
  const extraManeuvers = allManeuvers.length > 16 ? allManeuvers.map((_, index) => index).filter(index => !visibleIndices.includes(index)).map(maneuverCard).join("") : "";
  const maneuverCardCount = visibleIndices.length + (allManeuvers.length > 16 ? 1 : 0);
  const maneuverColumns = Math.min(4, Math.max(1, maneuverCardCount));
  const maneuverExpandable = maneuverCardCount > maneuverColumns * 3;
  const combatCardCount = combatItems.length + visibleCategories.length;
  const combatColumns = Math.min(4, Math.max(1, combatCardCount));
  const combatExpandable = combatCardCount > combatColumns;
  const hp = actor.system?.attributes?.hp || {}, fp = actor.system?.attributes?.fp || {};
  const root = document.createElement("section");
  root.id = "gum-hud-bar";
  root.style.setProperty("--maneuver-columns", maneuverColumns);
  root.style.setProperty("--combat-columns", combatColumns);
  const consumablesLabel = localize("Consumables.Title", "Consumíveis");
  const consumableRegion = consumables.length ? `<div class="gum-hud-region gum-hud-consumable-region">${regionChrome(consumablesLabel.toLocaleUpperCase(game.i18n.lang), "consumables", false)}<div class="gum-hud-consumables"><button class="gum-hud-card gum-hud-consumable-card ${openSelection?.kind === "consumables" ? "is-selected" : ""}" data-consumables aria-expanded="${openSelection?.kind === "consumables"}" title="${escape(format("Consumables.Count", { count: consumables.length }, `${consumablesLabel}: ${consumables.length}`))}"><img src="icons/containers/bags/pack-leather-white-tan.webp" alt=""></button></div><div class="gum-hud-expanded"></div></div>` : "";
  const resourceRail = [
    ["skill", "fa-list", localize("CharacterBrowser.Skills", "Perícias"), 0],
    ["spell", "fa-book-open", localize("CharacterBrowser.Spells", "Magias"), 0],
    ["power", "fa-bolt", localize("CharacterBrowser.Powers", "Poderes"), 0],
    ["equipment", "fa-toolbox", localize("CharacterBrowser.Equipment", "Equipamentos"), 0],
    ["effect", "fa-sparkles", localize("CharacterBrowser.Effects", "Efeitos"), activeEffects.length]
  ].map(([category, icon, label, count]) => `<button type="button" data-character-browser="${category}" class="${characterBrowser?.actorUuid === actor.uuid && characterBrowser.category === category ? "is-active" : ""}" title="${escape(count ? `${label}: ${count}` : label)}"><i class="fas ${icon}" aria-hidden="true"></i>${count ? `<b>${count}</b>` : ""}</button>`).join("");
  const showFoundryHotbar = !game.settings.get(MODULE, "hideHotbar");
  const hotbarLayouts = [
    ["equipment", "fa-table-cells", localize("Preferences.HotbarEquipment", "Acima dos equipamentos")],
    ["below", "fa-grip-lines", localize("Preferences.HotbarBelow", "Uma linha abaixo")],
    ["native", "fa-window-maximize", localize("Preferences.HotbarNative", "Padrão do Foundry")]
  ].map(([value, icon, label]) => `<button type="button" class="${hotbarLayout === value ? "is-selected" : ""}" data-hotbar-layout="${value}" aria-pressed="${hotbarLayout === value}" title="${escape(label)}"><i class="fas ${icon}" aria-hidden="true"></i><span>${escape(label)}</span></button>`).join("");
  const preferences = `<span class="gum-hud-resource-divider" aria-hidden="true"></span><button type="button" class="gum-hud-preferences-trigger ${preferencesOpen ? "is-active" : ""}" data-hud-preferences aria-expanded="${preferencesOpen}" title="${escape(localize("Preferences.Open", "Configurar HUD"))}"><i class="fas fa-cog" aria-hidden="true"></i></button><aside class="gum-hud-preferences-panel ${preferencesOpen ? "is-open" : ""}" aria-label="${escape(localize("Preferences.Title", "Preferências do HUD"))}"><header><i class="fas fa-cog" aria-hidden="true"></i><span>${localize("Preferences.Title", "Preferências do HUD")}</span></header><button type="button" class="gum-hud-preference-toggle ${showFoundryHotbar ? "is-enabled" : ""}" data-toggle-foundry-hotbar aria-pressed="${showFoundryHotbar}"><span><strong>${localize("Preferences.FoundryHotbar", "Hotbar do Foundry")}</strong><small>${localize("Preferences.FoundryHotbarHint", "Exibir com o GUM HUD")}</small></span><i aria-hidden="true"><b></b></i></button><div class="gum-hud-hotbar-layout ${showFoundryHotbar ? "" : "is-disabled"}"><small>${localize("Preferences.HotbarPosition", "Posição")}</small><div>${hotbarLayouts}</div></div></aside>`;
  const identityVitals = `${identityResource(hp, "HP")}${identityResource(fp, "FP")}${identityMovement(actor)}`;
  root.innerHTML = `<div class="gum-hud-region gum-hud-identity-region gum-hud-summary"><div class="gum-hud-loadout" aria-label="${escape(localize("Identity.QuickEquipment", "Equipamentos rápidos"))}">${equipmentSlots}</div><img src="${escape(tokenForHud.document.texture?.src || actor.img)}" alt=""><div class="gum-hud-summary-info"><strong>${escape(actor.name)}</strong><div class="gum-hud-vitals">${identityVitals}</div></div><button data-close title="${escape(localize("General.Close", "Fechar"))}">×</button></div><nav class="gum-hud-resource-rail" aria-label="${escape(localize("CharacterBrowser.Access", "Acesso rápido"))}">${resourceRail}${preferences}</nav><div class="gum-hud-region gum-hud-maneuver-region ${regionIsExpanded("maneuvers") ? "is-expanded" : ""}">${maneuverChrome(localize("Maneuvers.Title", "MANOBRAS"), maneuverExpandable, combatOptions, actor)}<div class="gum-hud-maneuvers">${maneuvers || `<small>${localize("Maneuvers.SelectGroup", "Selecione um grupo nas configurações.")}</small>`}</div><div class="gum-hud-maneuver-palette" hidden>${extraManeuvers}</div>${combatOptionsPanelMarkup(actor, combatOptions)}</div><div class="gum-hud-region gum-hud-combat ${regionIsExpanded("combat") ? "is-expanded" : ""}">${regionChrome(localize("Combat.Title", "OPÇÕES DE COMBATE"), "combat", combatExpandable)}<div class="gum-hud-cards">${itemCards || `<small>${localize("Combat.Empty", "Arraste equipamentos para os slots ou marque outras opções como favoritas.")}</small>`}</div><div class="gum-hud-expanded"></div></div><div class="gum-hud-region gum-hud-defense-region">${regionChrome(localize("Defense.Title", "DEFESAS ATIVAS"), "defenses", false)}<div class="gum-hud-defenses"></div><div class="gum-hud-expanded"></div></div>${consumableRegion}`;
  if (openSelection?.kind === "defense" && !defenseEntries(actor, openSelection.key).length) openSelection = null;
  if (openSelection?.kind === "specialDefense" && !specialDefenses.length) openSelection = null;
  if (openSelection?.kind === "consumables" && !consumables.length) openSelection = null;
  const specialDefenseCard = specialDefenses.length ? `<button class="gum-hud-defense ${openSelection?.kind === "specialDefense" ? "is-selected" : ""}" data-special-defenses aria-expanded="${openSelection?.kind === "specialDefense"}" title="${escape(localize("Defense.SpecialPlural", "Defesas especiais"))}"><img src="modules/gum-hud/icons/special-defense.svg" alt=""><span>${localize("Defense.Special", "Especial")}</span></button>` : "";
  root.querySelector(".gum-hud-defenses").innerHTML = `<button class="gum-hud-defense" data-defense="dodge" title="${escape(localize("Defense.RollDodge", "Rolar Esquiva"))}"><img src="modules/gum-hud/icons/dodge.svg" alt=""><span>${localize("Defense.Dodge", "Esquiva")}</span><b>${escape(actor.system?.attributes?.dodge?.final ?? "—")}</b></button><button class="gum-hud-defense ${openSelection?.kind === "defense" && openSelection.key === "final_parry" ? "is-selected" : ""}" data-expand-defense="final_parry" aria-expanded="${openSelection?.kind === "defense" && openSelection.key === "final_parry"}" ${defenseEntries(actor, "final_parry").length ? "" : "disabled"} title="${escape(localize("Defense.ParryOptions", "Opções de Aparar"))}"><img src="modules/gum-hud/icons/parry.svg" alt=""><span>${localize("Defense.Parry", "Aparar")}</span></button><button class="gum-hud-defense ${openSelection?.kind === "defense" && openSelection.key === "final_block" ? "is-selected" : ""}" data-expand-defense="final_block" aria-expanded="${openSelection?.kind === "defense" && openSelection.key === "final_block"}" ${defenseEntries(actor, "final_block").length ? "" : "disabled"} title="${escape(localize("Defense.BlockOptions", "Opções de Bloqueio"))}"><img src="modules/gum-hud/icons/block.svg" alt=""><span>${localize("Defense.Block", "Bloqueio")}</span></button>${specialDefenseCard}`;
  if (openSelection) {
    const target = openSelection.kind === "defense" || openSelection.kind === "specialDefense"
      ? ".gum-hud-defense-region .gum-hud-expanded"
      : openSelection.kind === "consumables"
        ? ".gum-hud-consumable-region .gum-hud-expanded"
        : ".gum-hud-combat .gum-hud-expanded";
    root.querySelector(target).innerHTML = expandedMarkup(actor);
  }
  document.body.append(root);
  fitToFoundry(root);
  root.addEventListener("contextmenu", async event => {
    if (!retainHudOwnership(actor)) return;
    const target = event.target.closest("[data-preview-item], [data-preview-uuid], [data-item]");
    if (!target || target.hasAttribute("data-category")) return;
    const reference = target.dataset.previewUuid || target.dataset.previewItem || target.dataset.item;
    if (!reference) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      await api().ui.previewItem(reference, { actor, sendToChat: true });
    } catch (error) {
      console.error("GUM HUD | Quick view", error);
      ui.notifications.error(error.message);
    }
  });
  root.addEventListener("dragover", event => { if (event.target.closest("[data-slot]")) event.preventDefault(); });
  root.addEventListener("drop", async event => {
    if (!retainHudOwnership(actor)) return;
    const slot = event.target.closest("[data-slot]");
    if (!slot) return;
    event.preventDefault();
    try {
      const data = JSON.parse(event.dataTransfer.getData("text/plain"));
      const item = data.uuid ? await fromUuid(data.uuid).catch(() => null) : actor.items.get(data.id);
      if (item?.type !== "equipment" || item.parent?.uuid !== actor.uuid) throw new Error(localize("Slots.WrongActor", "Arraste um equipamento deste personagem."));
      const slots = [...loadoutFor(actor)];
      const targetIndex = Number(slot.dataset.slot);
      const existing = slots.indexOf(item.id);
      const replacedId = slots[targetIndex];
      if (existing >= 0) slots[existing] = null;
      slots[targetIndex] = item.id;
      const all = { ...game.settings.get(MODULE, "equipmentSlots"), [actor.uuid]: slots };
      await game.settings.set(MODULE, "equipmentSlots", all);
      const actorActivity = { ...loadoutActivityFor(actor) };
      if (replacedId && replacedId !== item.id) delete actorActivity[replacedId];
      if (existing < 0) actorActivity[item.id] = true;
      await game.settings.set(MODULE, "equipmentActivity", { ...game.settings.get(MODULE, "equipmentActivity"), [actor.uuid]: actorActivity });
      render();
    } catch (error) { ui.notifications.warn(error.message || localize("Slots.CannotAdd", "Não foi possível adicionar o equipamento.")); }
  });
  root.addEventListener("click", async event => {
    if (!retainHudOwnership(actor)) return;
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.hasAttribute("data-close")) { pinnedToken = null; preferencesOpen = false; closeCharacterBrowser(); render(); return; }
      if (button.dataset.characterBrowser) { await requestCharacterBrowser(actor, button.dataset.characterBrowser); return; }
      if (button.hasAttribute("data-hud-preferences")) { preferencesOpen = !preferencesOpen; render(); return; }
      if (button.hasAttribute("data-toggle-foundry-hotbar")) { await game.settings.set(MODULE, "hideHotbar", !game.settings.get(MODULE, "hideHotbar")); return; }
      if (button.dataset.hotbarLayout) { await game.settings.set(MODULE, "hotbarLayout", button.dataset.hotbarLayout); return; }
      if (button.dataset.toggleRegion) {
        const key = button.dataset.toggleRegion;
        const expanded = { ...game.settings.get(MODULE, "expandedRegions") };
        expanded[key] = expanded[key] !== true;
        await game.settings.set(MODULE, "expandedRegions", expanded);
        render(); return;
      }
      if (button.dataset.clearSlot != null) {
        const slots = [...loadoutFor(actor)];
        const itemId = slots[Number(button.dataset.clearSlot)];
        slots[Number(button.dataset.clearSlot)] = null;
        await game.settings.set(MODULE, "equipmentSlots", { ...game.settings.get(MODULE, "equipmentSlots"), [actor.uuid]: slots });
        if (itemId) {
          const actorActivity = { ...loadoutActivityFor(actor) };
          delete actorActivity[itemId];
          await game.settings.set(MODULE, "equipmentActivity", { ...game.settings.get(MODULE, "equipmentActivity"), [actor.uuid]: actorActivity });
        }
        render(); return;
      }
      if (button.dataset.toggleEquipment) {
        const itemId = button.dataset.toggleEquipment;
        const actorActivity = { ...loadoutActivityFor(actor), [itemId]: !equipmentIsActive(actor, itemId) };
        await game.settings.set(MODULE, "equipmentActivity", { ...game.settings.get(MODULE, "equipmentActivity"), [actor.uuid]: actorActivity });
        render(); return;
      }
      if (button.hasAttribute("data-more-maneuvers")) {
        const palette = root.querySelector(".gum-hud-maneuver-palette");
        const optionsPanel = root.querySelector(".gum-hud-combat-options-panel");
        palette.hidden = !palette.hidden;
        if (optionsPanel) optionsPanel.classList.toggle("is-suspended", !palette.hidden);
        return;
      }
      if (button.dataset.maneuver != null) { await api().effects.apply(group.effectUuids[Number(button.dataset.maneuver)], [tokenForHud], { actor, origin: actor, source: "GUM HUD" }); render(); return; }
      if (button.dataset.defense === "dodge") { closeSelectionForRoll(); await promptRoll(actor, withExecutionOptions(actor, { type: "defense", defenseType: "dodge", value: actor.system.attributes.dodge.final, defenseBonusIncluded: true, label: localize("Defense.Dodge", "Esquiva") })); return; }
      if (button.dataset.expandDefense) {
        toggleSelection("defense", button.dataset.expandDefense);
        return;
      }
      if (button.hasAttribute("data-special-defenses")) {
        toggleSelection("specialDefense", "active");
        return;
      }
      if (button.dataset.specialDefense) {
        const entry = specialDefenseEntries(actor).find(row => row.item.id === button.dataset.specialDefense);
        if (!entry || entry.value == null) return;
        closeSelectionForRoll();
        await promptRoll(actor, withExecutionOptions(actor, { type: "defense", value: entry.value, itemId: entry.item.id, defenseBonusIncluded: false, label: `${entry.item.name}: ${localize("Defense.Active", "Defesa ativa")}` }));
        return;
      }
      if (button.hasAttribute("data-consumables")) {
        toggleSelection("consumables", "equipment");
        return;
      }
      if (button.hasAttribute("data-toggle-combat-options")) {
        combatOptionsPanelOpen = !combatOptionsPanelOpen;
        if (!combatOptionsPanelOpen) combatOptionsPanelExpanded = false;
        render();
        return;
      }
      if (button.hasAttribute("data-expand-combat-options")) {
        combatOptionsPanelExpanded = !combatOptionsPanelExpanded;
        render();
        return;
      }
      if (button.hasAttribute("data-config-execution")) {
        const activeManeuver = [...activeManeuverUuids(actor)][0] || null;
        new ExecutionOptionsConfig({ maneuverUuid: activeManeuver }).render(true);
        return;
      }
      if (button.dataset.executionOption) {
        const option = executionOptionsFor(actor).find(candidate => candidate.binding.id === button.dataset.executionOption);
        await toggleExecutionOption(actor, option, tokenForHud);
        render();
        return;
      }
      if (button.dataset.consumeItem) {
        const item = actor.items.get(button.dataset.consumeItem);
        await consumeEquipment(actor, item);
        render();
        return;
      }
      if (button.dataset.defenseItem) {
        const item = actor.items.get(button.dataset.defenseItem), attack = item?.system?.melee_attacks?.[button.dataset.defenseAttack];
        if (!attack) return;
        closeSelectionForRoll();
        await promptRoll(actor, withExecutionOptions(actor, { type: "defense", defenseType: button.dataset.defenseKind === "final_parry" ? "parry" : "block", value: attack[button.dataset.defenseKind], itemId: item.id, attackId: button.dataset.defenseAttack, defenseBonusIncluded: true, label: `${item.name}: ${attack.mode || attack.name || localize("Defense.Defense", "Defesa")}` })); return;
      }
      if (button.dataset.item) {
        toggleSelection("item", button.dataset.item);
        return;
      }
      if (button.dataset.category) {
        toggleSelection("category", button.dataset.category);
        return;
      }
      if (button.dataset.attack) {
        const item = actor.items.get(button.dataset.source), attack = item?.system?.melee_attacks?.[button.dataset.attack] || item?.system?.ranged_attacks?.[button.dataset.attack];
        if (!attack) return;
        closeSelectionForRoll();
        await promptRoll(actor, withExecutionOptions(actor, { type: "attack", value: attack.final_nh, itemId: item.id, attackId: button.dataset.attack, attackType: item.system.melee_attacks?.[button.dataset.attack] ? "melee" : "ranged", label: `${item.name}: ${attack.mode || attack.name || localize("Roll.Attack", "Ataque")}` })); return;
      }
      if (button.dataset.damageAttack) {
        const item = actor.items.get(button.dataset.source);
        if (!item?.system?.melee_attacks?.[button.dataset.damageAttack] && !item?.system?.ranged_attacks?.[button.dataset.damageAttack]) return;
        closeSelectionForRoll();
        await api().damage.fromHotbar({ actorUuid: actor.uuid, damageData: { kind: "item", itemId: item.id, itemUuid: item.uuid, attackId: button.dataset.damageAttack } }); return;
      }
      if (button.dataset.abilityAttack) {
        const item = actor.items.get(button.dataset.abilityAttack);
        if (!item || !item.system?.uses_attack) return;
        closeSelectionForRoll();
        await promptRoll(actor, withExecutionOptions(actor, { type: "attack", value: item.system.attack_nh, itemId: item.id, attackType: item.system.attack_type, attributeKey: item.system.attack_roll?.skill_name, label: `${item.name}: ${localize("Roll.Attack", "Ataque")}` })); return;
      }
      if (button.dataset.damageItem) {
        const item = actor.items.get(button.dataset.damageItem);
        if (!item?.system?.damage?.formula) return;
        closeSelectionForRoll();
        await api().damage.fromHotbar({ actorUuid: actor.uuid, damageData: { kind: "item", itemId: item.id, itemUuid: item.uuid } }); return;
      }
      if (button.dataset.ability) {
        const item = actor.items.get(button.dataset.ability);
        if (!item) return;
        closeSelectionForRoll();
        await promptRoll(actor, withExecutionOptions(actor, { type: item.type, value: item.type === "skill" ? item.system.tree_final_nh ?? item.system.final_nh : item.system.final_nh, itemId: item.id, attributeKey: item.type === "skill" ? item.system.tree_base_attribute || item.system.base_attribute : undefined, label: item.name }));
      }
    } catch (error) { console.error("GUM HUD", error); ui.notifications.error(error.message); }
  });
}

Hooks.once("init", () => {
  game.settings.register(MODULE, "maneuverGroup", { name: "GUMHUD.Settings.ManeuverGroup.Name", hint: "GUMHUD.Settings.ManeuverGroup.Hint", scope: "world", config: true, type: String, default: "", onChange: async () => { await migrateLegacyCombatOptions(); if (pinnedToken) refreshManeuverNames(); } });
  game.settings.register(MODULE, "hideHotbar", { name: "GUMHUD.Settings.HideHotbar.Name", hint: "GUMHUD.Settings.HideHotbar.Hint", scope: "client", config: true, type: Boolean, default: true, onChange: render });
  game.settings.register(MODULE, "hotbarLayout", { name: "GUMHUD.Settings.HotbarLayout.Name", hint: "GUMHUD.Settings.HotbarLayout.Hint", scope: "client", config: true, type: String, choices: { equipment: "GUMHUD.Preferences.HotbarEquipment", below: "GUMHUD.Preferences.HotbarBelow", native: "GUMHUD.Preferences.HotbarNative" }, default: "equipment", onChange: render });
  game.settings.register(MODULE, "equipmentSlots", { name: "GUMHUD.Settings.EquipmentSlots.Name", scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE, "equipmentActivity", { name: "GUMHUD.Settings.EquipmentActivity.Name", scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE, "expandedRegions", { name: "GUMHUD.Settings.ExpandedRegions.Name", scope: "client", config: false, type: Object, default: { maneuvers: false, combat: false } });
  game.settings.register(MODULE, "characterBrowserState", { name: "GUMHUD.Settings.CharacterBrowserState.Name", scope: "client", config: false, type: Object, default: { category: "skill", equipmentFilter: "all" } });
  game.settings.register(MODULE, EXECUTION_REGISTRY_SETTING, { scope: "world", config: false, type: Object, default: { version: 2, bindings: [] }, onChange: async () => { await hydrateExecutionSources(); if (pinnedToken) render(); } });
  game.settings.register(MODULE, LEGACY_MIGRATION_SETTING, { scope: "world", config: false, type: Boolean, default: false });
  game.settings.registerMenu(MODULE, "executionOptions", {
    name: "GUMHUD.ExecutionConfig.MenuName", hint: "GUMHUD.ExecutionConfig.MenuHint", label: "GUMHUD.ExecutionConfig.MenuLabel",
    icon: "fas fa-crosshairs", type: ExecutionOptionsConfig, restricted: true
  });
  game.keybindings.register(MODULE, "toggle", { name: "GUMHUD.Keybindings.Toggle", editable: [{ key: "KeyH", modifiers: ["CONTROL", "SHIFT"] }], onDown: () => { if (pinnedToken) { pinnedToken = null; preferencesOpen = false; closeCharacterBrowser(); render(); } else openHud(null); return true; } });
});

const legacyEnabled = value => value === true || value === 1 || ["true", "1", "on"].includes(String(value ?? "").trim().toLocaleLowerCase());
const legacyManeuvers = config => {
  const raw = config?.maneuver_uuids;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n|,/) : [];
  return [...new Set(values.map(value => String(value ?? "").trim()).filter(Boolean))];
};

async function migrateLegacyCombatOptions() {
  if (!game.user.isGM || game.settings.get(MODULE, LEGACY_MIGRATION_SETTING)) return;
  const fallbackManeuvers = selectedGroup()?.effectUuids || [];
  if (!fallbackManeuvers.length) return;
  const registry = getExecutionRegistry();
  const bindings = [...registry.bindings];
  for (const actor of game.actors) for (const item of actor.items) {
    if (item.type !== "gm_modifier") continue;
    const config = item._source?.system?.combat_option || item.system?.combat_option;
    if (!legacyEnabled(config?.enabled)) continue;
    const maneuvers = legacyManeuvers(config);
    for (const maneuverUuid of maneuvers.length ? maneuvers : fallbackManeuvers) {
      if (bindings.some(binding => binding.maneuverUuid === maneuverUuid && !binding.actorUuid && binding.sourceUuid === item.uuid)) continue;
      bindings.push({
        id: foundry.utils.randomID(), maneuverUuid, actorUuid: null, sourceType: "modifier", sourceUuid: item.uuid, sourceData: snapshotExecutionSource(item),
        group: String(config.selection_group || "").trim(), mode: config.selection_mode === "cumulative" ? "cumulative" : "exclusive",
        reset: config.reset === "sticky" ? "sticky" : "after_roll", order: bindings.length
      });
    }
  }
  await setExecutionRegistry(normalizeExecutionRegistry({ bindings }));
  await game.settings.set(MODULE, LEGACY_MIGRATION_SETTING, true);
}
async function upgradeExecutionRegistryToWorldDefaults() {
  if (!game.user.isGM) return;
  const raw = game.settings.get(MODULE, EXECUTION_REGISTRY_SETTING) || {};
  if (Number(raw.version) >= 2 && !(raw.bindings || []).some(binding => binding.actorUuid)) return;
  const seen = new Set();
  const bindings = [];
  for (const original of normalizeExecutionRegistry(raw).bindings) {
    const source = original.sourceData ? null : await fromUuid(original.sourceUuid).catch(() => null);
    const binding = { ...original, actorUuid: null, sourceData: original.sourceData || snapshotExecutionSource(source) };
    const key = `${binding.maneuverUuid}\u0000${binding.sourceUuid}`;
    if (seen.has(key)) continue;
    seen.add(key); bindings.push(binding);
  }
  await setExecutionRegistry({ version: 2, bindings });
}
async function refreshManeuverNames() {
  const items = new Map();
  for (const uuid of selectedGroup()?.effectUuids || []) {
    const item = await fromUuid(uuid).catch(() => null);
    items.set(uuid, { name: item?.name || localize("General.ItemNotFound", "Item não encontrado"), img: item?.img });
  }
  game.gumHud.maneuverItems = items;
  render();
}

Hooks.once("ready", async () => {
  game.gumHud = {
    maneuverItems: new Map(), open: token => openHud(token), close: () => { pinnedToken = null; preferencesOpen = false; closeCharacterBrowser(); render(); },
    configureExecutionOptions: options => { if (game.user.isGM) new ExecutionOptionsConfig(options).render(true); }
  };
  await migrateLegacyCombatOptions();
  await upgradeExecutionRegistryToWorldDefaults();
  await hydrateExecutionSources();
  await refreshManeuverNames();
});
Hooks.on("gum.rollCompleted", context => {
  const usedIds = Array.isArray(context?.metadata?.rollData?.gumHudExecutionBindingIds)
    ? context.metadata.rollData.gumHudExecutionBindingIds
    : [];
  if (!usedIds.length || !context?.actor || context.actor.uuid !== currentToken()?.actor?.uuid) return;
  let changed = false;
  const registry = getExecutionRegistry();
  for (const bindingId of [...selectedCombatOptions]) {
    const binding = registry.bindings.find(entry => entry.id === bindingId);
    if (binding && usedIds.includes(binding.id) && binding.reset !== "sticky" && selectedCombatOptions.delete(bindingId)) changed = true;
  }
  if (changed) render();
});
Hooks.on("updateActor", actor => {
  const relevant = actor?.uuid === currentToken()?.actor?.uuid;
  if (pinnedToken && relevant) render();
  if (actor?.uuid === characterBrowser?.actorUuid) {
    if (!ownsActor(actor)) closeCharacterBrowser();
    else characterBrowser.render(false);
  }
});
for (const hook of ["createActiveEffect", "deleteActiveEffect", "updateActiveEffect"]) Hooks.on(hook, effect => {
  const actorUuid = effect?.parent?.uuid;
  if (pinnedToken && actorUuid === currentToken()?.actor?.uuid) render();
  if (actorUuid === characterBrowser?.actorUuid) characterBrowser.render(false);
});
Hooks.on("canvasReady", () => { if (pinnedToken) render(); if (characterBrowser) characterBrowser.render(false); });
Hooks.on("renderHotbar", () => { const root = document.getElementById("gum-hud-bar"); if (root) requestAnimationFrame(() => fitToFoundry(root)); });
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, item => {
  if (!pinnedToken) return;
  const relevantSource = getExecutionRegistry().bindings.some(binding => binding.sourceUuid === item?.uuid);
  if (item?.parent?.uuid === currentToken()?.actor?.uuid || relevantSource) render();
  if (item?.parent?.uuid === characterBrowser?.actorUuid) characterBrowser.render(false);
});
window.addEventListener("resize", () => { const root = document.getElementById("gum-hud-bar"); if (root) fitToFoundry(root); });
