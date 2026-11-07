# RaidTrack

Acompanhamento de equipas de escuteiros em raids por rádio LoRa — posição, mensagens e SOS — sem rede móvel, sem SIM, sem subscrições.

```
 Equipas (T-Beam V1.2)            Base (T3-S3)                App da base
 GPS + botões + SOS  ── LoRa 868 ──►  recetor  ── USB ──► PC Windows/Mac (Chrome/Edge)
                      ◄─ mensagens ─            ── BLE ──► Android / iPhone / tablet
```

| Pasta | Conteúdo |
|---|---|
| `firmware/RaidTrack/` | Módulo C++ para o Meshtastic (SOS, confirmação, pedido de posição) |
| `firmware/raidtrack.ini` | Ambientes de compilação `raidtrack-equipa` (T-Beam) e `raidtrack-base` (T3-S3) |
| `app/instalador.html` | **Preparar rádios**: grava e configura pelo browser, sem terminal |
| `firmware/compilar.py` | Alternativa: compila e grava no PC (Windows/Mac) |
| `firmware/configurar.py` | Alternativa: configura cada rádio pela linha de comandos |
| `app/` | App da base: uma só base de código para PC, Android e iOS |
| `docs/PROTOCOLO.md` | Protocolo rádio, botões/GPIO e orçamento de tempo de antena |
| `.github/workflows/publicar.yml` | Compila o firmware e publica app + instalador no GitHub Pages |

Base: Meshtastic **v2.8.2.d5f1619** (estável). O módulo entra pelo mecanismo oficial de módulos opcionais (`src/modules/optional/`) — não altera nenhum ficheiro do Meshtastic, por isso atualizar a versão é só mudar a tag.

---

## 1. Hardware das equipas (T-Beam V1.x ou T-Beam Supreme)

Botões entre o GPIO e GND (o firmware ativa o pull-up interno). O instalador deteta a placa e usa os pinos certos.

| Botão | T-Beam V1.x (ESP32) | T-Beam Supreme (ESP32-S3) |
|---|---|---|
| SOS — 12 mm, vermelho | 14 | 38 |
| Cima | 25 | 39 |
| Baixo | 13 | 21 |
| OK | 15 | 48 |
| Besouro ativo 3,3 V (opcional, + ao GPIO, − ao GND) | 2 | 2 |

SOS: **premir 2 s** dispara (3 bips, ecrã "SOS ENVIADO"); repete a cada 30 s até a base confirmar (bip longo, "BASE RECEBEU O SOS"). **Premir 5 s** com SOS ativo cancela.

## 2. Pôr tudo a funcionar (sem terminal)

**Uma vez só — publicar no GitHub:**
1. Criar uma conta e um repositório no GitHub e enviar esta pasta (Passo 7A do guia).
2. Em **Settings → Pages → Source** escolher **GitHub Actions**.
3. O workflow *Publicar RaidTrack* compila os dois firmwares na cloud e publica, no mesmo endereço:
   - `https://<utilizador>.github.io/<repositório>/` — a app da base;
   - `https://<utilizador>.github.io/<repositório>/instalador.html` — **Preparar rádios**.

Sempre que o código muda no GitHub, o firmware e a app são recompilados e republicados sozinhos.

**Preparar os rádios (Chrome ou Edge, Windows ou Mac):**
1. Abrir **Preparar rádios** (também há um botão na app da base).
2. **Chave do raid:** *Gerar nova* (ou colar a existente). Fica guardada no computador; *Mostrar QR* passa-a a outro computador.
3. Escolher **Equipa** (código EQ1, EQ2… sugerido automaticamente) ou **Base**.
4. Ligar o rádio por USB → **Gravar e configurar** → escolher a porta. O browser grava o firmware e configura: região EU868, canal cifrado, nome, posição, botões e mensagens pré-definidas.
5. "Pronto" → ligar o próximo rádio.

*Só configurar* muda a chave, o nome ou o intervalo de posição sem voltar a gravar o firmware. Sem Internet ou sem o GitHub, o instalador aceita um ficheiro `.factory.bin` compilado à mão.

### Alternativa técnica — terminal
`firmware/compilar.py` (compilar e gravar no PC) e `firmware/configurar.py` (configurar por linha de comandos) continuam disponíveis; ver o guia de implementação.

## 3. App da base

### PC (Windows / Mac) — recomendado
Abrir o endereço publicado (ver secção 2) o endereço em **Chrome ou Edge** → ícone *Instalar app* na barra de endereço. Depois de aberta uma vez com Internet funciona **offline**. Ligar o T3-S3 por USB → **Ligar USB**.

Para testar localmente: `cd app && npm install && npm run dev`.

### Android
Chrome no Android abre a mesma página e liga por **Bluetooth** (Web Bluetooth). Para app instalável na Play Store / APK: `npm run cap:android` (precisa do Android Studio).

### iPhone / iPad
O Safari não suporta Bluetooth Web. Duas vias:
- **Já:** browser gratuito *Bluefy* (App Store), que suporta Web Bluetooth, a abrir o endereço da app.
- **App nativa:** `npm run cap:ios` num Mac com Xcode. Acrescentar ao `ios/App/App/Info.plist`:
  `NSBluetoothAlwaysUsageDescription` = "Ligação ao rádio RaidTrack da base".

### Antes do raid
1. **Mapa offline:** com Internet, enquadrar a zona do raid e carregar **Mapa offline** (guarda os mosaicos OpenTopoMap da zona, até 4000 mosaicos).
2. **Base aqui:** marca a posição da base → distância e rumo de cada equipa.
3. **Demonstração:** 5 equipas simuladas, SOS da EQ2 aos 25 s — serve para treinar os operadores.

### Durante o raid
- Cartões de equipa: última posição, bateria, sinal, distância/rumo à base. Estado *Sinal atrasado* > 3 min, *Sem sinal* > 10 min.
- **Localizar / Localizar todas:** pede posição imediata.
- **SOS:** alarme sonoro + cartão vermelho → **Recebido — avisar equipa** envia a confirmação ao tracker. Se a equipa continuar a repetir, a app volta a confirmar sozinha.
- Mensagens para uma equipa ou para todas: ficam no ecrã do tracker até a equipa carregar **OK**, e a app mostra quando foi lida.
- **Horas de partida e chegada** em cada cartão (escrever `hh:mm` ou **Agora**): a distância, o tempo e a % no percurso contam só entre essas horas.
- **Exportar:** percursos em GPX (abre no Google Earth/QGIS) e registo do raid em CSV.

### Separador Raid — percurso, zonas proibidas e relatório
- **Importar GPX** do percurso teórico (trk, rte ou só pontos): aparece tracejado no mapa, com os postos. Cada equipa mostra a **% no percurso** (distância feita a menos de *corredor* metros do percurso, 50 m por omissão) e a distância atual ao percurso.
- **Zonas proibidas:** dar um nome, **Desenhar no mapa** (clicar nos cantos) e **Concluir**. Quando uma equipa entra numa zona: alarme e aviso na base, e o tracker apita e mostra "ZONA PROIBIDA" até carregarem OK (repete de 5 em 5 min enquanto lá estiverem).
- **Relatório PDF:** resumo de todas as equipas (partida, chegada, duração, distância, % no percurso, cobertura, entradas em zonas, SOS) com mapa geral, e uma página por equipa com o mapa do seu percurso e os eventos. O mapa de fundo precisa de Internet; sem Internet sai com quadrícula e escala.
- **GPX de todas as equipas:** um ficheiro com o percurso teórico, os postos e o rasto de cada equipa.
