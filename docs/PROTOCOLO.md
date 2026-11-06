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

## Botões do tracker (T-Beam)

| Botão | GPIO | Função |
|---|---|---|
| SOS (12 mm, vermelho) | 14 | Premir 2 s → SOS. Premir 5 s com SOS ativo → cancela |
| Cima | 25 | Navegar mensagens pré-definidas |
| Baixo | 13 | Navegar |
| OK | 15 | Enviar mensagem selecionada / confirmar |
| Besouro ativo (opcional) | 2 | Aviso sonoro de SOS e de mensagens |

Todos os botões ligam entre o GPIO e GND (pull-up interno).

## Orçamento de tempo de antena (EU868, 869,525 MHz, ciclo de trabalho 10 %)

Preset `LONG_FAST`: um pacote de posição (~50 bytes) ocupa ≈ 1,3 s.
5 equipas × 1 posição/min = 6,5 s/min ≈ **1,1 %** da hora por equipa — muito abaixo do limite. Um SOS a cada 30 s soma ≈ 2 s/min à equipa em SOS.
