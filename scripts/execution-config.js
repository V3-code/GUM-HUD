import { getExecutionRegistry, hydrateExecutionSources, removeExecutionBinding, setExecutionRegistry, snapshotExecutionSource, upsertExecutionBinding } from "./execution-registry.js";

const t = (key, fallback) => {
  const id = `GUMHUD.ExecutionConfig.${key}`;
  const value = game.i18n.localize(id);
  return value === id ? fallback : value;
};
const selectedManeuverGroup = () => {
  const choice = String(game.settings.get("gum-hud", "maneuverGroup") || "").trim();
  return (game.settings.get("gum", "effectExclusionGroups") || []).find(group => group.id === choice || group.name === choice);
};

export class ExecutionOptionsConfig extends FormApplication {
  constructor({ maneuverUuid = null } = {}, options = {}) {
    super({}, options);
    this.maneuverUuid = maneuverUuid;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gum-hud-execution-options-config", title: "GUMHUD.ExecutionConfig.Title",
      template: "modules/gum-hud/templates/execution-options-config.hbs",
      classes: ["gum-hud-execution-config", "theme-dark"], width: 720, height: 620,
      resizable: true, scrollY: ["[data-binding-list]"]
    });
  }
  async getData() {
    const maneuverUuids = selectedManeuverGroup()?.effectUuids || [];
    const maneuverItems = await Promise.all(maneuverUuids.map(uuid => fromUuid(uuid).catch(() => null)));
    const maneuvers = maneuverUuids.map((uuid, index) => ({ uuid, name: maneuverItems[index]?.name || uuid }));
    if (!maneuvers.some(entry => entry.uuid === this.maneuverUuid)) this.maneuverUuid = maneuvers[0]?.uuid || null;
    const registry = getExecutionRegistry();
    const relevant = registry.bindings.filter(binding => binding.maneuverUuid === this.maneuverUuid && !binding.actorUuid);
    const sources = await Promise.all(relevant.map(binding => fromUuid(binding.sourceUuid).catch(() => null)));
    const exclusionGroups = game.settings.get("gum", "effectExclusionGroups") || [];
    const bindings = relevant.map((binding, index) => {
      const exclusion = binding.sourceType === "effect"
        ? exclusionGroups.find(group => Array.isArray(group.effectUuids) && group.effectUuids.includes(binding.sourceUuid)) : null;
      return { ...binding, group: exclusion?.name || binding.group, mode: exclusion ? "exclusive" : binding.mode,
        behaviorLocked: Boolean(exclusion), name: sources[index]?.name || binding.sourceUuid,
        img: sources[index]?.img || "icons/svg/hazard.svg", missing: !sources[index],
        isModifier: binding.sourceType === "modifier", isEffect: binding.sourceType === "effect" };
    });
    return { maneuvers: maneuvers.map(entry => ({ ...entry, selected: entry.uuid === this.maneuverUuid })), bindings,
      hasContext: Boolean(this.maneuverUuid), labels: {
        source: t("Source", "Item Efeito ou Modificador do Mestre"), sourcePlaceholder: t("SourcePlaceholder", "Cole o UUID ou arraste o item aqui"),
        addSource: t("AddSource", "Adicionar"), empty: t("Empty", "Nenhuma opção configurada."), group: t("Group", "Grupo"),
        mode: t("Mode", "Modo"), reset: t("Reset", "Limpeza"), exclusive: t("Exclusive", "Exclusiva"), cumulative: t("Cumulative", "Cumulativa"),
        afterRoll: t("AfterRoll", "Após a rolagem"), sticky: t("Sticky", "Manter selecionada"), effectItem: t("EffectItem", "Item Efeito"),
        gmModifier: t("GMModifier", "Modificador do Mestre"), remove: t("Remove", "Remover"),
        dropHint: t("DropAnyHint", "Arraste um Item Efeito ou Modificador do Mestre, ou informe seu UUID."),
        noManeuvers: t("NoManeuvers", "Nenhuma manobra disponível no grupo configurado.")
      } };
  }
  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-maneuver-tag]").on("click", event => { this.maneuverUuid = event.currentTarget.dataset.maneuverTag || null; this.render(false); });
    html.find("[data-add-source]").on("click", async () => {
      const sourceUuid = String(html.find("[data-source-uuid]").val() || "").trim();
      if (sourceUuid) await this._addSource(sourceUuid);
    });
    html.on("click", "[data-remove-binding]", async event => {
      await setExecutionRegistry(removeExecutionBinding(getExecutionRegistry(), event.currentTarget.dataset.removeBinding));
      await hydrateExecutionSources(); this.render(false);
    });
    html.on("change", "[data-binding-field]", async event => {
      const row = event.currentTarget.closest("[data-binding-id]");
      const binding = getExecutionRegistry().bindings.find(entry => entry.id === row?.dataset.bindingId);
      if (!binding) return;
      binding[event.currentTarget.dataset.bindingField] = event.currentTarget.value;
      await setExecutionRegistry(upsertExecutionBinding(getExecutionRegistry(), binding)); await hydrateExecutionSources();
    });
    html.on("dragover", event => event.preventDefault());
    html.on("drop", async event => {
      event.preventDefault(); const data = TextEditor.getDragEventData(event.originalEvent || event);
      if (data?.uuid) await this._addSource(data.uuid);
    });
  }
  async _addSource(sourceUuid) {
    const item = await fromUuid(sourceUuid).catch(() => null);
    if (!item || !["effect", "gm_modifier"].includes(item.type)) return ui.notifications.warn(t("SourceRequired", "Informe um Item Efeito ou Modificador do Mestre válido."));
    if (item.uuid === this.maneuverUuid) return ui.notifications.warn(t("SelfReference", "A manobra não pode ser sua própria opção de execução."));
    await this._addBinding({ sourceType: item.type === "effect" ? "effect" : "modifier", sourceUuid: item.uuid, sourceData: snapshotExecutionSource(item) });
  }
  async _addBinding(data) {
    if (!game.user.isGM || !this.maneuverUuid) return;
    const registry = getExecutionRegistry();
    const duplicate = registry.bindings.some(binding => binding.maneuverUuid === this.maneuverUuid && !binding.actorUuid && binding.sourceUuid === data.sourceUuid);
    if (duplicate) return ui.notifications.warn(t("Duplicate", "Esta opção já está vinculada à manobra."));
    const binding = { id: foundry.utils.randomID(), maneuverUuid: this.maneuverUuid, actorUuid: null, sourceType: data.sourceType,
      sourceUuid: data.sourceUuid, sourceData: data.sourceData, group: "", mode: data.sourceType === "effect" ? "cumulative" : "exclusive", reset: "after_roll", order: registry.bindings.length };
    await setExecutionRegistry(upsertExecutionBinding(registry, binding)); await hydrateExecutionSources(); this.render(false);
  }
  async _updateObject() {}
}
