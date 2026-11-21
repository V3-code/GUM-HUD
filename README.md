<div align="center">

# GUM HUD

### HUD de combate compacto e contextual para o sistema GUM

![Versão](https://img.shields.io/badge/versão-0.2.0-8a7d5f)
![Foundry VTT](https://img.shields.io/badge/Foundry_VTT-13–14-8a7d5f)
![GUM](https://img.shields.io/badge/GUM-1.6.3--beta%2B-4f6b58)
![Idiomas](https://img.shields.io/badge/idiomas-PT--BR_%7C_EN-596878)

</div>

O GUM HUD é um módulo opcional para o [GUM](https://github.com/V3-code/GUM). Ele concentra as ações mais frequentes do personagem em uma interface minimalista, sem substituir a ficha nem duplicar as regras do sistema.

## Instalação

No Foundry VTT, acesse **Add-on Modules → Install Module**, cole a URL abaixo em **Manifest URL** e clique em **Install**:

```text
https://raw.githubusercontent.com/V3-code/GUM-HUD/main/module.json
```

O módulo requer **GUM 1.6.3-beta ou superior**.

## Recursos

- Manobras configuradas pelo mundo e opções de execução vinculadas a Modificadores do Mestre ou Itens Efeito.
- Preparação de manobras e opções secundárias com confirmação explícita, alteração e remoção precisa da aplicação do HUD.
- Modos de ataque, dano, defesas ativas, defesas especiais e consumíveis em painéis contextuais compactos.
- Seis atalhos de equipamentos com ativação individual, sem precisar remover a configuração do personagem.
- Acesso rápido e somente leitura a Perícias, Magias, Poderes, Equipamentos e Efeitos ativos.
- Visualização rápida dos Itens diretamente pelo HUD.
- Recursos atuais e máximos, deslocamento e informações essenciais do personagem.
- Hotbar nativa opcional, com apresentação compacta e posições configuráveis por cliente.
- HUD capaz de acompanhar o token próprio controlado ou permanecer fixado em um ator mundial.
- Abertura direta pelo cabeçalho da ficha, inclusive sem token ou cena ativa.
- Interface em português do Brasil e inglês.

## Uso básico

- Abra uma ficha própria e clique no ícone do **GUM HUD** no cabeçalho para fixar aquele personagem.
- Use **Ctrl + Shift + H** para abrir ou fechar o HUD quando houver um token controlado, personagem atribuído ou um único ator próprio disponível.
- Use o cadeado aberto para acompanhar a seleção de tokens; feche-o para manter o personagem atual.
- Clique com o botão direito em um Item do HUD para abrir sua visualização rápida.
- Arraste equipamentos da ficha para os seis espaços acima do retrato.
- Selecione uma manobra e suas opções de execução e clique em **Aplicar** para confirmar o conjunto. Use **Alterar** para preparar mudanças ou **Remover** para desfazer a aplicação do HUD.

O mestre pode definir nas configurações do módulo se jogadores aplicam manobras sempre, somente durante combate ou somente no turno do próprio personagem. A preparação continua disponível fora do momento permitido; apenas a confirmação e a remoção ficam bloqueadas.

Tokens não vinculados permanecem disponíveis somente enquanto seu token e sua cena continuarem válidos. Atores mundiais e tokens vinculados podem manter o HUD aberto entre cenas e após recarregar o cliente.

## Permissões e escopo

O HUD só pode ser criado para atores que o usuário possui. Ele utiliza as APIs públicas do GUM para executar rolagens, efeitos e consumos, preservando no sistema as regras e os dados mecânicos.

## Compatibilidade

| Informação | Estado atual |
| --- | --- |
| Versão do módulo | 0.2.0 |
| GUM mínimo | 1.6.3-beta |
| Foundry VTT mínimo | 13 |
| Foundry VTT verificado | 14 |
| Idiomas | Português (Brasil) e inglês |

## Suporte

- [Histórico de alterações](CHANGELOG.md)
- [Repositório do GUM](https://github.com/V3-code/GUM)
- [Relatar problema ou sugerir melhoria](https://github.com/V3-code/GUM-HUD/issues)

## Aviso

Projeto independente, gratuito e não oficial. GURPS é marca registrada da Steve Jackson Games. O GUM HUD não é afiliado, licenciado ou endossado pela Steve Jackson Games e não distribui conteúdo de publicações de GURPS.
