# Changelog

Todas as mudanças relevantes do GUM HUD serão documentadas neste arquivo.

O formato segue uma adaptação de [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e usa [SemVer](https://semver.org/lang/pt-BR/).

## [0.2.0] - 2026-11-21

### Added

- Preparação de manobras e opções de execução antes de uma confirmação explícita pelo botão Aplicar.
- Controles para cancelar a preparação, alterar a aplicação atual e remover somente os efeitos criados pela aplicação do HUD.
- Política mundial para permitir manobras sempre, somente durante combate ou somente no turno do personagem, com isenção para mestres.

### Changed

- Modificadores de execução confirmados agora persistem no ator e continuam respeitando a limpeza após a rolagem.
- Aplicações simultâneas são bloqueadas enquanto o HUD processa a operação, reduzindo alterações redundantes de efeitos.
- Ações de manobra agora ficam acima do título da região, com botão Aplicar destacado, indicadores compactos de estado e painel de opções contextualizado pela manobra preparada.

## [0.1.0] - 2026-11-16

### Added

- Primeira versão funcional do HUD de combate para o GUM.
- Regiões compactas para personagem, manobras, opções de combate, defesas ativas e consumíveis.
- Opções de execução mundiais por manobra, com Modificadores do Mestre e Itens Efeito exclusivos ou cumulativos.
- Acesso resumido a Perícias, Magias, Poderes, Equipamentos e Efeitos ativos.
- Equipamentos rápidos com seis espaços, ativação individual e remoção independente.
- Hotbar do Foundry opcional, compacta e configurável por cliente.
- Abertura do HUD pelo cabeçalho da ficha e atalho `Ctrl + Shift + H`.
- Modos de acompanhamento do token controlado e personagem fixado.
- Suporte a atores mundiais sem token, persistência entre cenas e restauração após recarregar o cliente.
- Interface bilíngue em português do Brasil e inglês.

### Security

- O HUD exige propriedade sobre o ator antes de exibir ou executar suas informações.
- Tokens não vinculados não são persistidos fora do contexto válido de token e cena.
