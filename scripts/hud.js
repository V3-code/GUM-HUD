import { resolveAttackDamageDisplay } from "/systems/gum/module/utils/attack-damage-display.mjs";
import { applyAmmunition, normalizeAmmunitionLoadout } from "/systems/gum/module/utils/ammunition.mjs";
import { buildEquipmentConsumptionUpdate, equipmentAvailableUses, resolveEquipment } from "/systems/gum/module/utils/equipment-resolution.mjs";

const MODULE = "gum-hud";
let pinnedToken = null;
let openSelection = null;
let selectionActorUuid = null;
let selectedCombatOptions = new Set();
let combatOptionsPanelOpen = false;
let combatOptionsPanelExpanded = false;
let combatOptionsManeuverKey = "";
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
  pinnedToken = document;
  render();
  return true;
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
const regionIsExpanded = key => game.settings.get(MODULE, "expandedRegions")?.[key] === true;
const equipmentFor = actor => loadoutFor(actor).map(id => actor.items.get(id)).filter(item => item?.type === "equipment");
const consumablesFor = actor => [...actor.items]
  .filter(item => item.type === "equipment" && item.system?.is_consumable === true)
  .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
const groups = () => game.settings.get("gum", "effectExclusionGroups") || [];
const selectedGroup = () => {
  const choice = game.settings.get(MODULE, "maneuverGroup").trim();
  return groups().find(group => group.id === choice || group.name === choice);
};
const defenseEntries = (actor, kind) => equipmentFor(actor).flatMap(item => Object.entries(item.system?.melee_attacks || {}).map(([id, attack]) => ({ item, id, attack, value: attack[kind] }))).filter(row => row.value != null && !["", "0", "-"].includes(String(row.value).trim()));

function activeManeuverUuids(actor) {
  const configured = new Set(selectedGroup()?.effectUuids || []);
  return new Set([...actor.effects]
    .map(effect => effect.flags?.gum?.effectUuid)
    .filter(uuid => uuid && configured.has(uuid)));
}

function combatOptionsFor(actor) {
  const active = activeManeuverUuids(actor);
  if (!active.size) return [];
  return [...actor.items]
    .filter(item => {
      if (item.type !== "gm_modifier" || item.system?.combat_option?.enabled !== true) return false;
      const maneuvers = Array.isArray(item.system.combat_option.maneuver_uuids)
        ? item.system.combat_option.maneuver_uuids.filter(Boolean)
        : [];
      return !maneuvers.length || maneuvers.some(uuid => active.has(uuid));
    })
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

function combatOptionValue(item) {
  const entries = Array.isArray(item.system?.modifier_entries) && item.system.modifier_entries.length
    ? item.system.modifier_entries
    : [{ value: item.system?.modifier }];
  return entries.map(entry => String(entry?.value ?? "0").trim() || "0").join(" · ");
}

function toggleCombatOption(actor, itemId) {
  const available = combatOptionsFor(actor);
  const item = available.find(candidate => candidate.id === itemId);
  if (!item) return;
  if (selectedCombatOptions.has(item.id)) {
    selectedCombatOptions.delete(item.id);
    return;
  }
  const config = item.system?.combat_option || {};
  const group = String(config.selection_group || item.id).trim();
  if ((config.selection_mode || "exclusive") === "exclusive") {
    for (const selectedId of [...selectedCombatOptions]) {
      const selected = actor.items.get(selectedId);
      const selectedGroup = String(selected?.system?.combat_option?.selection_group || selected?.id || "").trim();
      if (selectedGroup === group) selectedCombatOptions.delete(selectedId);
    }
  }
  selectedCombatOptions.add(item.id);
}

const withCombatOptions = rollData => ({ ...rollData, preselectedModifierItemIds: [...selectedCombatOptions] });

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
    return groupedDefenses(actor, openSelection.key).map(({ item, options }) => `<div class="gum-hud-domino gum-hud-defense-domino" data-preview-item="${escape(item.id)}" aria-label="${escape(item.name)}"><div class="gum-hud-domino-source" title="${escape(item.name)}"><img src="${escape(item.img)}" alt=""><span>${escape(item.name)}</span></div><div class="gum-hud-domino-options">${options.map(row => `<button class="gum-hud-domino-defense" data-defense-item="${escape(item.id)}" data-defense-attack="${escape(row.id)}" data-defense-kind="${openSelection.key}" title="${escape(item.name)} · ${escape(row.skill)} · ${escape(row.modes.join(", "))}: ${escape(row.value)}"><strong>${escape(row.value)}</strong><span>${escape(row.skill)}</span></button>`).join("")}</div></div>`).join("");
  }
  if (openSelection.kind === "specialDefense") {
    return specialDefenseEntries(actor).map(({ item, ruleLabel, nh, value }) => `<div class="gum-hud-domino gum-hud-special-defense-domino" data-preview-item="${escape(item.id)}" aria-label="${escape(item.name)}"><div class="gum-hud-domino-source" title="${escape(item.name)}"><img src="${escape(item.img)}" alt=""><span>${escape(item.name)}</span></div><div class="gum-hud-domino-options"><button class="gum-hud-domino-defense" data-special-defense="${escape(item.id)}" ${value == null ? "disabled" : ""} title="${escape(item.name)} · ${escape(ruleLabel)}${Number.isFinite(nh) ? ` · NH ${escape(nh)}` : ""}: ${escape(value ?? "—")}"><strong>${escape(value ?? "—")}</strong><span>${escape(ruleLabel)}</span></button></div></div>`).join("");
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

function maneuverChrome(label, expandable, optionCount) {
  const expanded = regionIsExpanded("maneuvers");
  const regionAction = expanded ? localize("General.Collapse", "Recolher") : localize("General.Expand", "Expandir");
  const regionControl = expandable
    ? `<button type="button" class="gum-hud-region-toggle" data-toggle-region="maneuvers" aria-expanded="${expanded}" title="${escape(regionAction)} ${escape(label.toLocaleLowerCase())}"><span>${label}</span><i class="fas fa-caret-${expanded ? "down" : "up"}" aria-hidden="true"></i></button>`
    : `<span>${label}</span>`;
  const optionsControl = optionCount
    ? `<button type="button" class="gum-hud-combat-options-toggle ${combatOptionsPanelOpen ? "is-selected" : ""}" data-toggle-combat-options aria-expanded="${combatOptionsPanelOpen}" title="${escape(combatOptionsPanelOpen ? localize("CombatOptions.Collapse", "Recolher opções de golpe") : localize("CombatOptions.Expand", "Expandir opções de golpe"))}"><i class="fas fa-crosshairs" aria-hidden="true"></i><b>${selectedCombatOptions.size}/${optionCount}</b><i class="fas fa-caret-${combatOptionsPanelOpen ? "down" : "up"}" aria-hidden="true"></i></button>`
    : "";
  return `<header class="gum-hud-maneuver-footer"><div>${regionControl}${optionsControl}</div></header>`;
}

function combatOptionsPanelMarkup(options) {
  if (!options.length) return "";
  const cards = options.map(item => {
    const selected = selectedCombatOptions.has(item.id);
    const cumulative = item.system?.combat_option?.selection_mode === "cumulative";
    const mode = cumulative ? localize("CombatOptions.Cumulative", "Cumulativa") : localize("CombatOptions.Exclusive", "Exclusiva");
    return `<button type="button" class="gum-hud-combat-option-mini ${selected ? "is-selected" : ""}" data-combat-option="${escape(item.id)}" data-preview-item="${escape(item.id)}" aria-pressed="${selected}" title="${escape(item.name)} · ${escape(mode)} · ${escape(combatOptionValue(item))}"><span><img src="${escape(item.img)}" alt=""><small>${escape(combatOptionValue(item))}</small></span><strong>${escape(item.name)}</strong></button>`;
  }).join("");
  const hiddenCount = Math.max(0, options.length - 4);
  const more = hiddenCount
    ? `<button type="button" class="gum-hud-combat-options-more" data-expand-combat-options aria-expanded="${combatOptionsPanelExpanded}">${combatOptionsPanelExpanded ? localize("CombatOptions.ShowLess", "Mostrar menos") : format("CombatOptions.ShowMore", { count: hiddenCount }, `+${hiddenCount} opções`)}</button>`
    : "";
  return `<aside class="gum-hud-combat-options-panel ${combatOptionsPanelOpen ? "is-open" : ""} ${combatOptionsPanelExpanded ? "is-expanded" : ""}" aria-label="${escape(localize("CombatOptions.StrikeOptions", "Opções de golpe"))}"><div class="gum-hud-combat-options-heading"><i class="fas fa-crosshairs" aria-hidden="true"></i><span>${localize("CombatOptions.StrikeOptions", "Opções de golpe")}</span></div><div class="gum-hud-combat-options-grid">${cards}</div>${more}</aside>`;
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
  const hotbarTop = hotbar?.getClientRects().length ? hotbar.getBoundingClientRect().top : window.innerHeight;
  root.style.bottom = `${hotbarTop < window.innerHeight - 20 ? Math.max(12, window.innerHeight - hotbarTop + 8) : 12}px`;
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
  document.body.classList.toggle("gum-hud-hide-hotbar", Boolean(allowedToken && api() && game.settings.get(MODULE, "hideHotbar")));
  if (!allowedToken || !api()) return;
  const tokenForHud = allowedToken;
  const actor = tokenForHud.actor;
  if (selectionActorUuid !== actor.uuid) {
    openSelection = null;
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
  const combatOptions = combatOptionsFor(actor);
  const availableCombatOptionIds = new Set(combatOptions.map(item => item.id));
  for (const itemId of [...selectedCombatOptions]) if (!availableCombatOptionIds.has(itemId)) selectedCombatOptions.delete(itemId);
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
  const equipmentSlots = Array.from({ length: 5 }, (_, index) => {
    const item = actor.items.get(assigned[index]);
    return `<div class="gum-hud-slot" data-slot="${index}" ${item ? `data-preview-item="${escape(item.id)}"` : ""} title="${item ? escape(item.name) : escape(localize("Slots.DropEquipment", "Arraste um equipamento da ficha"))}">${item ? `<img src="${escape(item.img)}" alt=""><button type="button" data-clear-slot="${index}" title="${escape(localize("Slots.RemoveShortcut", "Remover atalho"))}">×</button>` : `<span>+</span>`}</div>`;
  }).join("");
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
  root.innerHTML = `<div class="gum-hud-region gum-hud-identity-region gum-hud-summary"><div class="gum-hud-loadout" aria-label="${escape(localize("Identity.QuickEquipment", "Equipamentos rápidos"))}">${equipmentSlots}</div><img src="${escape(tokenForHud.document.texture?.src || actor.img)}" alt=""><div class="gum-hud-summary-info"><strong>${escape(actor.name)}</strong><small>HP ${escape(hp.value ?? hp.current ?? "—")} · FP ${escape(fp.value ?? fp.current ?? "—")}</small></div><button data-close title="${escape(localize("General.Close", "Fechar"))}">×</button></div><div class="gum-hud-region gum-hud-maneuver-region ${regionIsExpanded("maneuvers") ? "is-expanded" : ""}">${maneuverChrome(localize("Maneuvers.Title", "MANOBRAS"), maneuverExpandable, combatOptions.length)}<div class="gum-hud-maneuvers">${maneuvers || `<small>${localize("Maneuvers.SelectGroup", "Selecione um grupo nas configurações.")}</small>`}</div><div class="gum-hud-maneuver-palette" hidden>${extraManeuvers}</div>${combatOptionsPanelMarkup(combatOptions)}</div><div class="gum-hud-region gum-hud-combat ${regionIsExpanded("combat") ? "is-expanded" : ""}">${regionChrome(localize("Combat.Title", "OPÇÕES DE COMBATE"), "combat", combatExpandable)}<div class="gum-hud-cards">${itemCards || `<small>${localize("Combat.Empty", "Arraste equipamentos para os slots ou marque outras opções como favoritas.")}</small>`}</div><div class="gum-hud-expanded"></div></div><div class="gum-hud-region gum-hud-defense-region">${regionChrome(localize("Defense.Title", "DEFESAS ATIVAS"), "defenses", false)}<div class="gum-hud-defenses"></div><div class="gum-hud-expanded"></div></div>${consumableRegion}`;
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
      const existing = slots.indexOf(item.id);
      if (existing >= 0) slots[existing] = null;
      slots[Number(slot.dataset.slot)] = item.id;
      const all = { ...game.settings.get(MODULE, "equipmentSlots"), [actor.uuid]: slots };
      await game.settings.set(MODULE, "equipmentSlots", all);
      render();
    } catch (error) { ui.notifications.warn(error.message || localize("Slots.CannotAdd", "Não foi possível adicionar o equipamento.")); }
  });
  root.addEventListener("click", async event => {
    if (!retainHudOwnership(actor)) return;
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.hasAttribute("data-close")) { pinnedToken = null; render(); return; }
      if (button.dataset.toggleRegion) {
        const key = button.dataset.toggleRegion;
        const expanded = { ...game.settings.get(MODULE, "expandedRegions") };
        expanded[key] = expanded[key] !== true;
        await game.settings.set(MODULE, "expandedRegions", expanded);
        render(); return;
      }
      if (button.dataset.clearSlot != null) {
        const slots = [...loadoutFor(actor)];
        slots[Number(button.dataset.clearSlot)] = null;
        await game.settings.set(MODULE, "equipmentSlots", { ...game.settings.get(MODULE, "equipmentSlots"), [actor.uuid]: slots });
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
      if (button.dataset.defense === "dodge") { closeSelectionForRoll(); await promptRoll(actor, { type: "defense", defenseType: "dodge", value: actor.system.attributes.dodge.final, defenseBonusIncluded: true, label: localize("Defense.Dodge", "Esquiva") }); return; }
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
        await promptRoll(actor, { type: "defense", value: entry.value, itemId: entry.item.id, defenseBonusIncluded: false, label: `${entry.item.name}: ${localize("Defense.Active", "Defesa ativa")}` });
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
      if (button.dataset.combatOption) {
        toggleCombatOption(actor, button.dataset.combatOption);
        render();
        return;
      }
      if (button.dataset.consumeItem) {
        const item = actor.items.get(button.dataset.consumeItem);
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
        render();
        return;
      }
      if (button.dataset.defenseItem) {
        const item = actor.items.get(button.dataset.defenseItem), attack = item?.system?.melee_attacks?.[button.dataset.defenseAttack];
        if (!attack) return;
        closeSelectionForRoll();
        await promptRoll(actor, { type: "defense", defenseType: button.dataset.defenseKind === "final_parry" ? "parry" : "block", value: attack[button.dataset.defenseKind], itemId: item.id, attackId: button.dataset.defenseAttack, defenseBonusIncluded: true, label: `${item.name}: ${attack.mode || attack.name || localize("Defense.Defense", "Defesa")}` }); return;
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
        await promptRoll(actor, withCombatOptions({ type: "attack", value: attack.final_nh, itemId: item.id, attackId: button.dataset.attack, attackType: item.system.melee_attacks?.[button.dataset.attack] ? "melee" : "ranged", label: `${item.name}: ${attack.mode || attack.name || localize("Roll.Attack", "Ataque")}` })); return;
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
        await promptRoll(actor, withCombatOptions({ type: "attack", value: item.system.attack_nh, itemId: item.id, attackType: item.system.attack_type, attributeKey: item.system.attack_roll?.skill_name, label: `${item.name}: ${localize("Roll.Attack", "Ataque")}` })); return;
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
        await promptRoll(actor, { type: item.type, value: item.type === "skill" ? item.system.tree_final_nh ?? item.system.final_nh : item.system.final_nh, itemId: item.id, attributeKey: item.type === "skill" ? item.system.tree_base_attribute || item.system.base_attribute : undefined, label: item.name });
      }
    } catch (error) { console.error("GUM HUD", error); ui.notifications.error(error.message); }
  });
}

Hooks.once("init", () => {
  game.settings.register(MODULE, "maneuverGroup", { name: "GUMHUD.Settings.ManeuverGroup.Name", hint: "GUMHUD.Settings.ManeuverGroup.Hint", scope: "world", config: true, type: String, default: "", onChange: () => { if (pinnedToken) refreshManeuverNames(); } });
  game.settings.register(MODULE, "hideHotbar", { name: "GUMHUD.Settings.HideHotbar.Name", hint: "GUMHUD.Settings.HideHotbar.Hint", scope: "client", config: true, type: Boolean, default: true, onChange: render });
  game.settings.register(MODULE, "equipmentSlots", { name: "GUMHUD.Settings.EquipmentSlots.Name", scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE, "expandedRegions", { name: "GUMHUD.Settings.ExpandedRegions.Name", scope: "client", config: false, type: Object, default: { maneuvers: false, combat: false } });
  game.keybindings.register(MODULE, "toggle", { name: "GUMHUD.Keybindings.Toggle", editable: [{ key: "KeyH", modifiers: ["CONTROL", "SHIFT"] }], onDown: () => { if (pinnedToken) { pinnedToken = null; render(); } else openHud(null); return true; } });
});
async function refreshManeuverNames() {
  const items = new Map();
  for (const uuid of selectedGroup()?.effectUuids || []) {
    const item = await fromUuid(uuid).catch(() => null);
    items.set(uuid, { name: item?.name || localize("General.ItemNotFound", "Item não encontrado"), img: item?.img });
  }
  game.gumHud.maneuverItems = items;
  render();
}

Hooks.once("ready", () => {
  game.gumHud = { maneuverItems: new Map(), open: token => openHud(token), close: () => { pinnedToken = null; render(); } };
  refreshManeuverNames();
});
Hooks.on("gum.rollCompleted", context => {
  const usedIds = Array.isArray(context?.metadata?.rollData?.preselectedModifierItemIds)
    ? context.metadata.rollData.preselectedModifierItemIds
    : [];
  if (!usedIds.length || !context?.actor || context.actor.uuid !== currentToken()?.actor?.uuid) return;
  let changed = false;
  for (const itemId of usedIds) {
    const item = context.actor.items.get(itemId);
    if (item?.system?.combat_option?.reset !== "sticky" && selectedCombatOptions.delete(itemId)) changed = true;
  }
  if (changed) render();
});
for (const hook of ["updateActor", "createActiveEffect", "deleteActiveEffect", "updateActiveEffect", "canvasReady"]) Hooks.on(hook, () => { if (pinnedToken) render(); });
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, item => {
  if (pinnedToken && item?.parent?.uuid === currentToken()?.actor?.uuid) render();
});
window.addEventListener("resize", () => { const root = document.getElementById("gum-hud-bar"); if (root) fitToFoundry(root); });
