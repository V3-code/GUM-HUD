const MODULE_ID = "gum-hud";
const VALID_CATEGORIES = new Set(["skill", "spell", "power", "equipment"]);
const UNGROUPED = "__ungrouped__";

const localize = (key, fallback) => {
  const id = `GUMHUD.CharacterBrowser.${key}`;
  const value = game.i18n.localize(id);
  return value === id ? fallback : value;
};
const categoryLabel = category => ({
  skill: localize("Skills", "Perícias"),
  spell: localize("Spells", "Magias"),
  power: localize("Powers", "Poderes"),
  equipment: localize("Equipment", "Equipamentos")
})[category];
const categoryIcon = category => ({
  skill: "fas fa-list",
  spell: "fas fa-book-open",
  power: "fas fa-bolt",
  equipment: "fas fa-toolbox"
})[category];
const clean = value => String(value ?? "").trim();

function orderedGroups(actor, category, items) {
  if (category === "equipment") {
    const definitions = [
      ["equipped", localize("Equipped", "Equipados")],
      ["carried", localize("Carried", "Carregados")],
      ["stored", localize("Stored", "Guardados")]
    ];
    const rows = new Map(definitions.map(([id, name]) => [id, { id, name, items: [] }]));
    for (const item of items) {
      const location = clean(item.system?.location).toLowerCase();
      const id = location === "equipped" ? "equipped" : location === "carried" ? "carried" : "stored";
      rows.get(id).items.push(item);
    }
    return [...rows.values()].filter(group => group.items.length);
  }

  const raw = actor.system?.[`${category}_organization`] || {};
  const rawGroups = raw.groups && typeof raw.groups === "object" ? raw.groups : {};
  const groupOrder = [...new Set([...(Array.isArray(raw.groupOrder) ? raw.groupOrder : []), ...Object.keys(rawGroups)])]
    .map(clean).filter(id => rawGroups[id]?.name);
  const assignments = raw.assignments && typeof raw.assignments === "object" ? raw.assignments : {};
  const itemOrder = raw.itemOrder && typeof raw.itemOrder === "object" ? raw.itemOrder : {};
  const itemById = new Map(items.map(item => [item.id, item]));
  const used = new Set();
  const groups = [];
  for (const id of groupOrder) {
    const assigned = items.filter(item => assignments[item.id] === id);
    const orderedIds = Array.isArray(itemOrder[id]) ? itemOrder[id] : [];
    const rank = new Map(orderedIds.map((itemId, index) => [itemId, index]));
    assigned.sort((a, b) => (rank.get(a.id) ?? 99999) - (rank.get(b.id) ?? 99999) || a.name.localeCompare(b.name, game.i18n.lang));
    if (!assigned.length) continue;
    assigned.forEach(item => used.add(item.id));
    groups.push({ id, name: clean(rawGroups[id].name), items: assigned });
  }

  const remaining = items.filter(item => !used.has(item.id));
  const byCategory = new Map();
  for (const item of remaining) {
    const name = clean(item.system?.group);
    const key = !name || name.toLocaleLowerCase() === "geral" ? UNGROUPED : name.toLocaleLowerCase();
    if (!byCategory.has(key)) byCategory.set(key, { id: key, name: key === UNGROUPED ? localize("Other", "Outros") : name, items: [] });
    byCategory.get(key).items.push(item);
  }
  for (const group of byCategory.values()) {
    group.items.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    groups.push(group);
  }
  return groups;
}

export class CharacterResourceBrowser extends FormApplication {
  constructor({ actor, category = "skill", actions = {} } = {}, options = {}) {
    const state = game.settings.get(MODULE_ID, "characterBrowserState") || {};
    const positionKeys = Number(state.layoutVersion) >= 2 ? ["left", "top", "width", "height"] : ["left", "top"];
    const savedPosition = Object.fromEntries(positionKeys
      .filter(key => Number.isFinite(state[key])).map(key => [key, state[key]]));
    super(actor, { ...options, ...savedPosition });
    this.actor = actor;
    this.actorUuid = actor?.uuid;
    this.category = VALID_CATEGORIES.has(category) ? category : (VALID_CATEGORIES.has(state.category) ? state.category : "skill");
    this.equipmentFilter = state.equipmentFilter || "all";
    this.collapsedGroups = new Set(Array.isArray(state.collapsedGroups) ? state.collapsedGroups : []);
    this.query = "";
    this.expandedItemId = null;
    this.actions = actions;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gum-hud-character-browser",
      template: "modules/gum-hud/templates/character-browser.hbs",
      classes: ["gum-hud-character-browser", "theme-dark"],
      width: 580,
      height: 440,
      resizable: true,
      minimizable: true,
      scrollY: [".gum-hud-browser-content"]
    });
  }

  get title() {
    return `${categoryLabel(this.category)} • ${this.actor?.name || ""}`;
  }

  _actorAvailable() {
    return this.actor?.uuid === this.actorUuid && this.actor?.isOwner === true;
  }

  _items() {
    if (!this._actorAvailable()) return [];
    let items = [...this.actor.items].filter(item => item.type === this.category);
    if (this.category === "equipment") {
      if (this.equipmentFilter === "combat") items = items.filter(item => Object.keys(item.system?.melee_attacks || {}).length || Object.keys(item.system?.ranged_attacks || {}).length);
      else if (this.equipmentFilter === "consumable") items = items.filter(item => item.system?.is_consumable === true);
      else if (this.equipmentFilter === "equipped") items = items.filter(item => clean(item.system?.location).toLowerCase() === "equipped");
    }
    return items;
  }

  _viewItem(item) {
    const system = item.system || {};
    const attacks = Object.entries({ ...(system.melee_attacks || {}), ...(system.ranged_attacks || {}) }).map(([id, attack]) => ({
      id,
      name: attack.mode || attack.name || item.name,
      nh: attack.final_nh ?? "—",
      damage: this.actions.attackDamageLabel?.(this.actor, attack) || "—",
      canDamage: Boolean(attack.damage_formula || attack.effective_damage_formula || attack.effective_damage?.main?.formula)
    }));
    const isAbility = ["skill", "spell", "power"].includes(item.type);
    const nh = item.type === "skill" ? system.tree_final_nh ?? system.final_nh : system.final_nh;
    const directDamage = clean(system.damage?.formula) ? this.actions.damageLabel?.(this.actor, system.damage) || system.damage.formula : "";
    const consumable = item.type === "equipment" && system.is_consumable === true;
    const consumption = consumable ? this.actions.consumableState?.(item) : null;
    const hasAbilityActions = ["spell", "power"].includes(item.type) && (system.uses_attack || directDamage);
    const hasDetails = Boolean(attacks.length || consumable || hasAbilityActions);
    return {
      id: item.id,
      name: item.name,
      img: item.img,
      search: `${item.name} ${system.group || ""}`.toLocaleLowerCase(),
      isAbility,
      isEquipment: item.type === "equipment",
      nh: nh ?? "—",
      canRoll: isAbility && nh != null && nh !== "",
      favorite: system.favorite_in_combat === true,
      quantity: item.type === "equipment" ? system.quantity ?? 1 : null,
      showQuantity: item.type === "equipment" && (consumable || Number(system.quantity) !== 1),
      hasDetails,
      expanded: hasDetails && this.expandedItemId === item.id,
      attacks,
      usesAttack: Boolean(system.uses_attack),
      attackNh: system.attack_nh ?? "—",
      directDamage,
      consumable,
      consumptionDisplay: consumption?.display ?? "",
      canConsume: consumable && Number(consumption?.available || 0) > 0
    };
  }

  async getData() {
    const tabs = [...VALID_CATEGORIES].map(id => ({ id, label: categoryLabel(id), icon: categoryIcon(id), active: id === this.category }));
    const items = this._items();
    const groups = orderedGroups(this.actor, this.category, items).map(group => ({
      ...group,
      count: group.items.length,
      collapseKey: `${this.category}:${group.id}`,
      collapsed: this.collapsedGroups.has(`${this.category}:${group.id}`),
      items: group.items.map(item => this._viewItem(item))
    }));
    return {
      actorName: this.actor?.name || "",
      category: this.category,
      tabs,
      groups,
      query: this.query,
      isEquipment: this.category === "equipment",
      equipmentFilters: [
        ["all", localize("All", "Todos")], ["combat", localize("Combat", "Combate")],
        ["consumable", localize("Consumables", "Consumíveis")], ["equipped", localize("Equipped", "Equipados")]
      ].map(([id, label]) => ({ id, label, active: id === this.equipmentFilter })),
      empty: localize("Empty", "Nenhum item encontrado."),
      searchPlaceholder: localize("Search", "Buscar…"),
      rollLabel: localize("Roll", "Rolar"),
      attackLabel: localize("Attack", "Ataque"),
      damageLabel: localize("Damage", "Dano"),
      useLabel: localize("Use", "Usar"),
      quantityLabel: localize("Quantity", "Qtd."),
      favoriteLabel: localize("Favorite", "Favorito"),
      skillLevelAbbrev: localize("SkillLevelAbbrev", "NH")
    };
  }

  _applySearch(html) {
    const query = this.query.toLocaleLowerCase();
    html.find(".gum-hud-browser-form").toggleClass("is-searching", Boolean(query));
    html.find("[data-browser-item]").each((_index, element) => { element.hidden = Boolean(query && !element.dataset.search.includes(query)); });
    html.find("[data-browser-group]").each((_index, element) => { element.hidden = !element.querySelector("[data-browser-item]:not([hidden])"); });
    const any = html[0]?.querySelector("[data-browser-item]:not([hidden])");
    html.find("[data-browser-search-empty]").prop("hidden", Boolean(any));
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.on("click", "[data-browser-category]", event => this.setCategory(event.currentTarget.dataset.browserCategory));
    html.on("click", "[data-equipment-filter]", event => {
      this.equipmentFilter = event.currentTarget.dataset.equipmentFilter;
      this.expandedItemId = null;
      this._saveState();
      this.render(false);
    });
    html.on("input", "[data-browser-search]", event => { this.query = event.currentTarget.value; this._applySearch(html); });
    html.on("click", "[data-toggle-browser-group]", event => {
      const key = event.currentTarget.dataset.toggleBrowserGroup;
      if (this.collapsedGroups.has(key)) this.collapsedGroups.delete(key);
      else this.collapsedGroups.add(key);
      this._saveState();
      this.render(false);
    });
    html.on("contextmenu", "[data-browser-item]", async event => {
      event.preventDefault(); event.stopPropagation();
      const item = this.actor?.items?.get(event.currentTarget.dataset.browserItem);
      if (item) await this.actions.preview?.(this.actor, item);
    });
    html.on("click", "[data-expand-item]", event => {
      const id = event.currentTarget.dataset.expandItem;
      this.expandedItemId = this.expandedItemId === id ? null : id;
      this.render(false);
    });
    html.on("click", "[data-roll-ability]", event => this._execute("rollAbility", event.currentTarget.dataset.rollAbility));
    html.on("click", "[data-roll-ability-attack]", event => this._execute("rollAbilityAttack", event.currentTarget.dataset.rollAbilityAttack));
    html.on("click", "[data-roll-attack]", event => this._execute("rollAttack", event.currentTarget.dataset.itemId, event.currentTarget.dataset.rollAttack));
    html.on("click", "[data-roll-damage-item]", event => this._execute("damageItem", event.currentTarget.dataset.rollDamageItem));
    html.on("click", "[data-roll-damage-attack]", event => this._execute("damageAttack", event.currentTarget.dataset.itemId, event.currentTarget.dataset.rollDamageAttack));
    html.on("click", "[data-use-consumable]", event => this._execute("consume", event.currentTarget.dataset.useConsumable));
    this._applySearch(html);
  }

  async _execute(action, itemId, secondaryId = null) {
    if (!this._actorAvailable()) return this.close();
    const item = this.actor.items.get(itemId);
    if (!item) return;
    try { await this.actions[action]?.(this.actor, item, secondaryId); }
    catch (error) { console.error("GUM HUD | Character browser", error); ui.notifications.error(error.message); }
  }

  setCategory(category) {
    if (!VALID_CATEGORIES.has(category)) return;
    this.category = category;
    this.expandedItemId = null;
    this.query = "";
    this._saveState();
    this.render(false);
    this.actions.categoryChanged?.(category);
  }

  async _saveState() {
    const position = this.position || {};
    return game.settings.set(MODULE_ID, "characterBrowserState", {
      layoutVersion: 2,
      category: this.category,
      equipmentFilter: this.equipmentFilter,
      collapsedGroups: [...this.collapsedGroups],
      left: position.left,
      top: position.top,
      width: position.width,
      height: position.height
    });
  }

  async close(options = {}) {
    await this._saveState();
    this.actions.closed?.(this);
    return super.close(options);
  }

  async _updateObject() {}
}
