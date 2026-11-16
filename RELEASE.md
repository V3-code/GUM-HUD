# Processo de release do GUM HUD

1. Atualize `version` e os endereços versionados em `module.json`.
2. Atualize `README.md` e `CHANGELOG.md`.
3. Execute todos os testes em `tests/`.
4. Faça o merge na branch `main`.
5. Gere o pacote a partir dos arquivos versionados:

```powershell
git archive --format=zip --output=gum-hud.zip HEAD
```

6. Crie a tag `v<VERSÃO>`.
7. Crie uma release com essa tag e anexe `gum-hud.zip` e `module.json`.
8. Confirme uma instalação limpa usando o Manifest URL público.

O ZIP deve conter `module.json` diretamente em sua raiz.
