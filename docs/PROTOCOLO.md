# RaidTrack — Protocolo rádio

RaidTrack corre sobre o **Meshtastic** (fork com módulo próprio). Reaproveita o que o Meshtastic já faz bem e só acrescenta o que falta.

## O que vem do Meshtastic (sem alterações)

| Função | Porta Meshtastic | Notas |
|---|---|---|
| Posição GPS das equipas | `POSITION_APP` (3) | Intervalo fixo de 60 s (perfil de configuração) |
| Mensagens de texto base ↔ equipa | `TEXT_MESSAGE_APP` (1) | DM com ACK; a equipa responde com mensagens pré-definidas (canned messages) |
| Bateria / telemetria | `TELEMETRY_APP` (67) | A cada 5 min |
| Identificação | `NODEINFO_APP` (4) | `short_name` = código da equipa (ex. `EQ1`) |
| Cifra | canal privado AES-256 | PSK próprio por raid |

## O que acrescenta o RaidTrack — porta `PRIVATE_APP` (256)

Todas as mensagens começam com um cabeçalho de 3 bytes. Inteiros em little-endian.

| Byte | Campo | Valor |
|---|---|---|
| 0 | magic | `0x52` ('R') |
| 1 | versão | `0x01` |
| 2 | tipo | ver abaixo |

### `0x01` SOS — equipa → todos (broadcast, prioridade ALERT)

| Offset | Tipo | Campo |
|---|---|---|
| 3 | u16 | `seq` — número do SOS (incrementa a cada novo SOS) |
| 5 | i32 | latitude × 1e7 |
| 9 | i32 | longitude × 1e7 |
| 13 | u8 | bateria % (0–100; 101 = alimentação externa) |
| 14 | u8 | flags: bit0 = posição válida, bit1 = repetição |

15 bytes. Repetido a cada **30 s** até chegar `SOS_ACK` da base ou a equipa cancelar.

### `0x02` SOS_ACK — base → equipa

| Offset | Tipo | Campo |
|---|---|---|
| 3 | u32 | `node` — número do nó da equipa |
| 7 | u16 | `seq` do SOS confirmado |

9 bytes. Enviado pela app quando o operador carrega **"Recebido"** no alarme.

### `0x03` SOS_CANCEL — equipa → todos

| Offset | Tipo | Campo |
|---|---|---|
| 3 | u16 | `seq` |

5 bytes. Equipa mantém o botão SOS 5 s com SOS ativo.

### `0x04` PING — base → todos ou uma equipa

Sem payload (3 bytes). A equipa responde de imediato com a sua posição (`POSITION_APP`). Botão **"Localizar agora"** na app.

### `0x05` ZONE — base → equipa (aviso de zona proibida)
### `0x06` TEXT — base → equipa ou todos (mensagem que fica no ecrã)

| Byte | Tipo | Campo |
|---|---|---|
| 3 | u16 | `id` do aviso |
| 5 | ASCII | texto, até 160 caracteres, sem acentos |

O tracker mostra o aviso no ecrã **até a equipa carregar OK** (botão OK; textos longos têm páginas "Mais >").
- `ZONE`: título "!! ZONA PROIBIDA !!", apita 4× a cada 8 s até OK; passa à frente de mensagens em fila.
- `TEXT`: prefixo "BASE:", apita 2× a cada 30 s até OK.
- Um `id` repetido volta a alertar sem duplicar o aviso. Fila de até 4 avisos.

A base calcula a entrada na zona a partir da posição da equipa e envia `ZONE` à entrada e de 5 em 5 min enquanto lá estiver.

### `0x07` READ — equipa → base

| Byte | Tipo | Campo |
|---|---|---|
| 3 | u16 | `id` do aviso confirmado |

Enviado quando a equipa carrega OK na última página. A app mostra "lida HH:MM" (ou a lista das equipas que leram, se foi para todas).

## Botões do tracker

Cada botão liga entre o GPIO e GND (pull-up interno). O instalador escolhe os pinos certos para a placa detetada.

| Botão | T-Beam V1.x (ESP32) | T-Beam Supreme (ESP32-S3) | Função |
|---|---|---|---|
| SOS (12 mm, vermelho) | 14 | 38 | Premir 2 s → SOS. Premir 5 s com SOS ativo → cancela |
| Cima | 25 | 39 | Navegar mensagens pré-definidas |
| Baixo | 13 | 21 | Navegar |
| OK | 15 | 48 | Enviar mensagem selecionada / confirmar |
| Besouro ativo 3,3 V (opcional) | 2 | 2 | Aviso sonoro de SOS e de mensagens |

No T-Beam Supreme, os pinos 38, 39, 21, 48 e 2 estão no conector de expansão de 2×13 pinos.

## Orçamento de tempo de antena (EU868, 869,525 MHz, ciclo de trabalho 10 %)

Preset `LONG_FAST`: um pacote de posição (~50 bytes) ocupa ≈ 1,3 s.
5 equipas × 1 posição/min = 6,5 s/min ≈ **1,1 %** da hora por equipa — muito abaixo do limite. Um SOS a cada 30 s soma ≈ 2 s/min à equipa em SOS.
