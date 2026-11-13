import {
  getExecutionRegistry,
  hydrateExecutionSources,
  removeExecutionBinding,
  setExecutionRegistry,
  upsertExecutionBinding
} from "./execution-registry.js";

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
  constructor({ actorUuid = null, maneuverUuid = null } = {}, options = {}) {
    super({}, options);
    this.actorUuid = actorUuid;
    this.maneuverUuid = maneuverUuid;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gum-hud-execution-options-config",
      title: "GUMHUD.ExecutionConfig.Title",
      template: "modules/gum-hud/templates/execution-options-config.hbs",
      classes: ["gum-hud-execution-config", "theme-dark"],
      width: 720,
      height: 620,
      resizable: true,
      scrollY: ["[data-binding-list]"]
    });
  }

  async getData() {
    const actors = [...game.actors]
      .filter(actor => actor.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    if (!actors.some(actor => actor.uuid === this.actorUuid)) this.actorUuid = actors[0]?.uuid || null;
    const actor = actors.find(entry => entry.uuid === this.actorUuid) || null;

    const maneuverUuids = selectedManeuverGroup()?.effectUuids || [];
    const maneuverItems = await Promise.all(maneuverUuids.map(uuid => fromUuid(uuid).catch(() => null)));
    const maneuvers = maneuverUuids.map((uuid, index) => ({ uuid, name: maneuverItems[index]?.name || uuid }));
    if (!maneuvers.some(entry => entry.uuid === this.maneuverUuid)) this.maneuverUuid = maneuvers[0]?.uuid || null;

    const registry = getExecutionRegistry();
    const relevant = registry.bindings.filter(binding => binding.maneuverUuid === this.maneuverUuid
      && (binding.sourceType === "effect" ? !binding.actorUuid || binding.actorUuid === this.actorUuid : binding.actorUuid === this.actorUuid));
    const sources = await Promise.all(relevant.map(binding => fromUuid(binding.sourceUuid).catch(() => null)));
    const exclusionGroups = game.settings.get("gum", "effectExclusionGroups") || [];
    const bindings = relevant.map((binding, index) => {
      const exclusion = binding.sourceType === "effect"
        ? exclusionGroups.find(group => Array.isArray(group.effectUuids) && group.effectUuids.includes(binding.sourceUuid))
        : null;
      return {
        ...binding,
        group: exclusion?.name || binding.group,
        mode: exclusion ? "exclusive" : binding.mode,
        behaviorLocked: Boolean(exclusion),
        name: sources[index]?.name || binding.sourceUuid,
        img: sources[index]?.img || "icons/svg/hazard.svg",
        missing: !sources[index],
        isModifier: binding.sourceType === "modifier",
        isEffect: binding.sourceType === "effect"
      };
    });
    const boundModifierUuids = new Set(relevant.filter(binding => binding.sourceType === "modifier").map(binding => binding.sourceUuid));
    const modifiers = [...(actor?.items || [])]
      .filter(item => item.type === "gm_modifier" && !boundModifierUuids.has(item.uuid))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .map(item => ({ uuid: item.uuid, name: item.name }));

    return {
      actors: actors.map(entry => ({ uuid: entry.uuid, name: entry.name, selected: entry.uuid === this.actorUuid })),
      maneuvers: maneuvers.map(entry => ({ ...entry, selected: entry.uuid === this.maneuverUuid })),
      bindings,
      modifiers,
      actorName: actor?.name || "",
      hasContext: Boolean(actor && this.maneuverUuid),
      labels: {
        actor: t("Actor", "Personagem"), maneuver: t("Maneuver", "Manobra"), modifier: t("Modifier", "Modificador"),
        addModifier: t("AddModifier", "Adicionar modificador"), effectUuid: t("EffectUuid", "UUID do Item Efeito"),
        addEffect: t("AddEffect", "Adicionar efeito"), empty: t("Empty", "Nenhuma opção configurada."),
        group: t("Group", "Grupo"), mode: t("Mode", "Modo"), reset: t("Reset", "Limpeza"),
        exclusive: t("Exclusive", "Exclusiva"), cumulative: t("Cumulative", "Cumulativa"),
        afterRoll: t("AfterRoll", "Após a rolagem"), sticky: t("Sticky", "Manter selecionada"),
        globalEffect: t("GlobalEffect", "Efeito global"), remove: t("Remove", "Remover"),
        dropHint: t("DropHint", "Arraste um Item Efeito para esta janela ou informe seu UUID."),
        noActors: t("NoActors", "Nenhum personagem disponível."), noManeuvers: t("NoManeuvers", "Nenhuma manobra disponível no grupo configurado.")
      }
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-actor]").on("change", event => { this.actorUuid = event.currentTarget.value || null; this.render(false); });
    html.find("[data-maneuver]").on("change", event => { this.maneuverUuid = event.currentTarget.value || null; this.render(false); });
    html.find("[data-add-modifier]").on("click", async () => {
      const sourceUuid = html.find("[data-modifier-source]").val();
      if (!sourceUuid) return;
      await this._addBinding({ sourceType: "modifier", sourceUuid, actorUuid: this.actorUuid });
    });
    html.find("[data-add-effect]").on("click", async () => {
      const sourceUuid = String(html.find("[data-effect-uuid]").val() || "").trim();
      if (!sourceUuid) return;
      await this._addEffect(sourceUuid);
    });
    html.on("click", "[data-remove-binding]", async event => {
      await setExecutionRegistry(removeExecutionBinding(getExecutionRegistry(), event.currentTarget.dataset.removeBinding));
      await hydrateExecutionSources();
      this.render(false);
    });
    html.on("change", "[data-binding-field]", async event => {
      const row = event.currentTarget.closest("[data-binding-id]");
      const binding = getExecutionRegistry().bindings.find(entry => entry.id === row?.dataset.bindingId);
      if (!binding) return;
      binding[event.currentTarget.dataset.bindingField] = event.currentTarget.value;
      await setExecutionRegistry(upsertExecutionBinding(getExecutionRegistry(), binding));
      await hydrateExecutionSources();
    });
    html.on("dragover", event => event.preventDefault());
    html.on("drop", async event => {
      event.preventDefault();
      const data = TextEditor.getDragEventData(event.originalEvent || event);
      const item = data?.uuid ? await fromUuid(data.uuid).catch(() => null) : null;
      if (item?.type !== "effect") return ui.notifications.warn(t("EffectRequired", "Arraste um Item Efeito."));
      await this._addEffect(item.uuid);
    });
  }

  async _addEffect(sourceUuid) {
    const item = await fromUuid(sourceUuid).catch(() => null);
    if (item?.type !== "effect") return ui.notifications.warn(t("EffectRequired", "Item Efeito não encontrado."));
    if (item.uuid === this.maneuverUuid) return ui.notifications.warn(t("SelfReference", "A manobra não pode ser sua própria opção de execução."));
    await this._addBinding({ sourceType: "effect", sourceUuid: item.uuid, actorUuid: null, mode: "cumulative" });
  }

  async _addBinding(data) {
    if (!game.user.isGM || !this.maneuverUuid) return;
    const registry = getExecutionRegistry();
    const duplicate = registry.bindings.some(binding => binding.maneuverUuid === this.maneuverUuid
      && binding.actorUuid === (data.actorUuid || null) && binding.sourceUuid === data.sourceUuid);
    if (duplicate) return ui.notifications.warn(t("Duplicate", "Esta opção já está vinculada à manobra."));
    const binding = {
      id: foundry.utils.randomID(), maneuverUuid: this.maneuverUuid, actorUuid: data.actorUuid || null,
      sourceType: data.sourceType, sourceUuid: data.sourceUuid, group: "", mode: data.mode || "exclusive",
      reset: "after_roll", order: registry.bindings.length
    };
    await setExecutionRegistry(upsertExecutionBinding(registry, binding));
    await hydrateExecutionSources();
    this.render(false);
  }

  async _updateObject() {}
}
