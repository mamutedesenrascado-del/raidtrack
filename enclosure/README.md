# Caixa RaidTrack — T-Beam Supreme

![Caixa montada, fundo e corte](caixa-preview.png)

Caixa para usar o rádio **na vertical**, com a antena em cima, o ecrã em cima, o teclado em baixo (▲ · OK · ▼, mais o **SOS** grande com anel de proteção), o besouro e o USB-C em baixo para carregar.
Medidas ≈ **38 × 108 × 43 mm**, sem contar com a antena nem com a argola.
As medidas da placa vêm do modelo 3D e do desenho oficiais da LilyGO, com a placa centrada.

| Ficheiro | O que é | Como imprimir |
|---|---|---|
| `caixa.stl` | fundo (placa + bateria 18650) | de pé, como está; não precisa de suportes |
| `tampa.stl` | frente com ecrã, teclas e gaiolas dos botões | frente para cima, com suportes "árvore" **só por dentro** |
| `teclas.stl` | 3 teclas + a tecla SOS (com "SOS" gravado) | como estão; a SOS em **vermelho** |
| `raidtrack-supreme.scad` | modelo editável (OpenSCAD) | — |

Material: **PETG** (aguenta sol e calor no carro; o PLA amolece). Bico de 0,4 mm, camadas de 0,2 mm, 3 perímetros, enchimento de 20 %.

## Lista de compras (por rádio)

| Qtd | Peça | Nota |
|---|---|---|
| 4 | Botão táctil **12 × 12 × 7,3 mm** (4 pernas) | sem tampa (as teclas são impressas) |
| 1 | Besouro **ativo** 12 mm, 3–5 V (ex. TMB12A03, 12 × 9,5 mm) | tem de ser "ativo", com + e − |
| 2 | Parafuso **M2 × 20** | cantos do lado do ecrã |
| 2 | Parafuso **M2 × 30** | cantos do lado do teclado |
| 1 | Bateria 18650 | as protegidas (mais compridas) podem não caber no suporte da placa |
| — | Fio fino (AWG 26–28) e manga termorretrátil | ~1 m |
| — | Cola quente | para segurar os botões nas gaiolas |

## Ligações

Todos os pinos de que precisa estão na **fila de pinos do lado direito** da placa (vista de frente), ao lado do ecrã.
Cada botão liga **entre o GPIO e o GND** (num táctil de 4 pernas, use duas pernas em diagonal).

| Peça | GPIO |
|---|---|
| SOS | 38 |
| ▲ cima | 39 |
| ▼ baixo | 21 |
| OK | 48 |
| Besouro + | 2 (− ao GND) |

Solde os fios diretamente nos furos e corte as pontas rente à placa. Não use conectores Dupont por cima: não cabem debaixo da tampa.

## Montagem

1. Meta a bateria e aparafuse a placa nos 4 pilares da caixa.
   - Por baixo da placa fica apenas a bateria.
   - O USB-C fica alinhado com a abertura de baixo e a antena com o furo de cima.
2. Na tampa, ponha as teclas nos furos, por dentro: a aba larga fica do lado de dentro.
3. Encaixe cada botão táctil na sua gaiola, de pernas para o ar (a haste encosta à tecla).
   - Fixe-os por trás com cola quente; é a cola que aguenta a força do dedo.
4. Cole o besouro com a face para fora, no furo redondo ao lado das teclas.
5. Solde os fios como na tabela.
6. Feche a tampa e aperte os 4 parafusos M2 pela frente:
   - M2×20 nos cantos do lado do ecrã;
   - M2×30 nos cantos do lado do teclado.

   Os parafusos atravessam a tampa e a placa e enroscam nos pilares da caixa.
7. Enrosque a antena por fora.

O botão de ligar (POWER) e os de RST e BOOT da placa ficam numa ranhura e em dois furos no lado direito; carregam-se com a ponta de uma caneta.
Para atualizar o firmware não é preciso abrir a caixa: basta o USB-C.

## Ajustar ao seu rádio

Os valores estão no início do `raidtrack-supreme.scad`. Os que mais podem precisar de ajuste:

- **`fundo_z`**: profundidade para a bateria (−20 mm).
- **`tampa_tecl_z`**: altura do teclado acima da placa.
- **`tecla_folga`**: folga das teclas nos furos (0,35 mm).
- **`teclas`**: posição de cada tecla.
- **`buzzer`**: posição do besouro.

Recomendação: imprima primeiro só a tampa e experimente-a sobre a placa, antes de imprimir o resto.

Depois de alterar os valores, exporte as peças de novo, por exemplo: `openscad -D 'parte="tampa"' -o tampa.stl raidtrack-supreme.scad`.

## Ecrã na vertical

O firmware de equipa arranca na vertical.
Se o texto aparecer de pernas para o ar, use **Menu → Rodar ecrã** até ficar direito. A escolha fica guardada no rádio.
