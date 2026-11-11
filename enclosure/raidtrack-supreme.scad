// RaidTrack — caixa vertical para o LilyGO T-Beam Supreme (ESP32-S3) com 4 botões e besouro.
// OpenSCAD 2021+. Medidas em mm.
// Peças: "caixa" (fundo, com passadores para fita de 25 mm e argola), "tampa" (frente),
//        "suporte" (placa que segura os 4 botões tácteis por baixo da tampa), "teclas".
//
// Orientação: na vertical, antena em cima, ecrã em cima, teclado em baixo, USB-C em baixo.
// Referencial = modelo 3D oficial da LilyGO (T-Beam-Supreme.zip): placa centrada em (0,0),
// y = -50 topo (lado da antena / ecrã) … +50 fundo (lado do USB-C); z = 0 face de baixo da placa.
//
// Para exportar uma peça: openscad -D 'parte="tampa"' -o tampa.stl raidtrack-supreme.scad

parte = "montagem"; // "caixa" | "tampa" | "suporte" | "teclas" | "montagem" | "corte"
$fn = 48;

// ---------- placa e componentes (medidos no modelo da LilyGO) ----------
pcb_w = 32.9;   pcb_l = 100.13;  pcb_t = 1.0;
furos = [[13.85, -47.7], [-13.85, -47.7], [13.85, 47.7], [-13.85, 47.7]]; // M2 (Ø2,1)
oled = [-11.5, -44.5, 11.5, -10.0];      // vidro do ecrã (x0, y0, x1, y1), topo a z = 7,85
oled_janela = [-12.5, -42.5, 12.5, -12.0]; // abertura na tampa (área visível + margem)
sma_x = -9.75;  sma_z = 3.5;  sma_d = 6.9; // conector da antena (rosca 1/4")
usb_x = -7.45;  usb_z = -1.1;              // USB-C (abertura para a ficha)
usb_w = 13.0;   usb_h = 7.5;
btn_x = 16.45;                            // botões laterais da placa (lado direito, vista de frente)
btn_power_y = 9.0; btn_rst_y = 0.7; btn_boot_y = 24.65; btn_z = 2.3;

// ---------- caixa ----------
folga = 0.5;          // folga à volta da placa
parede = 2.2;         // espessura das paredes
fundo_z = -20.0;      // fundo interior (suporte da bateria 18650 por baixo da placa)
tampa_oled_z = 9.6;   // face interior da tampa na zona do ecrã
tampa_tecl_z = 21.5;  // face interior da tampa na zona do teclado (componentes da placa até 9,5 mm + fios)
tampa_t = 2.0;        // espessura da tampa
rampa_y0 = -12.0;     // a tampa sobe da zona do ecrã para a do teclado entre rampa_y0 e rampa_y1
rampa_y1 = -7.0;
topo_extra = 1.0;     // espaço entre a placa e a parede de cima / de baixo
base_extra = 1.0;
lado_raio = 4;

in_x0 = -pcb_w / 2 - folga;  in_x1 = pcb_w / 2 + folga;
in_y0 = -pcb_l / 2 - folga - topo_extra;  in_y1 = pcb_l / 2 + folga + base_extra;
ext_x0 = in_x0 - parede; ext_x1 = in_x1 + parede;
ext_y0 = in_y0 - parede; ext_y1 = in_y1 + parede;
junta_z = 4.0;        // onde a tampa encontra a caixa (acima da placa, abaixo do ecrã)
// Fecho: 4 parafusos M2 pela frente, nos furos da placa (tampa → placa → pilar da caixa).
// Em cima (zona do ecrã) M2x20; em baixo (zona do teclado) M2x30.

// ---------- botões (12x12 mm tácteis) e besouro ----------
// [x, y, tipo]  tipo: 0 = tecla normal, 1 = SOS (maior, com anel de proteção)
teclas = [[-6, 0.5, 0], [-6, 14.5, 0], [-6, 28.5, 0], [3.5, 44, 1]];
tecla_d = 10.0;  sos_d = 13.0;  tecla_folga = 0.35;
aba = 1.2;        // aba redonda da tecla (fica por dentro da tampa)
aba_extra = 3.0;  // a aba é 3 mm maior que a tecla (1,5 mm de cada lado: não sai pelo furo)
sw = 12.3;        // táctil 12x12 (com folga)
sw_h = 7.3;       // altura total do táctil (corpo + haste)
sw_corpo = 3.6;   // altura do corpo do táctil
// O suporte (placa) segura os tácteis com a haste para cima, a tocar por baixo na aba da tecla.
sup_t = 2.4;                                // espessura do suporte
sw_topo = tampa_tecl_z - aba;               // topo da haste = fundo da tecla
sup_z = sw_topo - sw_h;                     // face de cima do suporte (onde assenta o táctil)
sup_area = [-13.0, -7.5, 12.4, 51.0];       // x0, y0, x1, y1
sup_fix = [[9.5, 4.0], [9.5, 32.5]];        // parafusos M2x8 do suporte à tampa
buzzer = [9.5, 18]; buzzer_d = 12.4; // besouro ativo 12 mm, colado por dentro, som por uma grelha

// ---------- fixação à mochila ----------
fita_l = 27;      // largura do passador (fita / velcro de 25 mm)
fita_h = 3.5;     // folga para a fita
ponte_t = 2.2;    // espessura da ponte do passador
trilho = 3;       // largura dos trilhos
passadores_y = [-36.5, 36.5];
argola_d = 6.5;   // furo da argola (mosquetão / cordão)

function topo_tampa(y) = y < rampa_y0 ? tampa_oled_z + tampa_t : tampa_tecl_z + tampa_t;

module arred(x0, y0, x1, y1, h, r = lado_raio) {
    hull() for (x = [x0 + r, x1 - r], y = [y0 + r, y1 - r]) translate([x, y, 0]) cylinder(r = r, h = h);
}

// Passadores nas costas para uma fita de 25 mm (velcro, ou fita com fivela): a fita passa de lado a lado
// e abraça a alça da mochila, o cinto ou uma fita MOLLE. Em baixo, uma argola grossa para um mosquetão
// ou cordão de segurança (para não se perder se a fita se soltar).
module fixacao_mochila() {
    z0 = fundo_z - parede;                 // face de trás da caixa
    h = fita_h + ponte_t;
    for (c = passadores_y) {
        // trilhos dos dois lados da fita
        for (y = [c - fita_l / 2 - trilho, c + fita_l / 2]) translate([0, 0, z0 - fita_h]) intersection() {
            arred(ext_x0, ext_y0, ext_x1, ext_y1, fita_h + 0.01);
            translate([ext_x0 - 1, y, 0]) cube([ext_x1 - ext_x0 + 2, trilho, fita_h + 0.01]);
        }
        // ponte por cima da fita
        translate([0, 0, z0 - h]) intersection() {
            arred(ext_x0, ext_y0, ext_x1, ext_y1, ponte_t);
            translate([ext_x0 - 1, c - fita_l / 2 - trilho, 0]) cube([ext_x1 - ext_x0 + 2, fita_l + 2 * trilho, ponte_t]);
        }
    }
    // nervura do meio (apoio na impressão e contra a mochila)
    translate([0, 0, z0 - h]) intersection() {
        arred(ext_x0, ext_y0, ext_x1, ext_y1, h + 0.01);
        translate([ext_x0 - 1, -trilho / 2, 0]) cube([ext_x1 - ext_x0 + 2, trilho, h + 0.01]);
    }
    // argola de segurança (em baixo)
    translate([8, ext_y1 - 3, z0 - h]) difference() {
        hull() {
            translate([-7, 0, 0]) cube([14, 1, 10]);
            translate([0, 6.5, 0]) cylinder(d = 14, h = 10);
        }
        translate([0, 6.5, -1]) cylinder(d = argola_d, h = 12);
        // chanfro do furo (não corta o cordão)
        translate([0, 6.5, -0.01]) cylinder(d1 = argola_d + 1.6, d2 = argola_d, h = 0.8);
        translate([0, 6.5, 10 - 0.79]) cylinder(d1 = argola_d, d2 = argola_d + 1.6, h = 0.8);
    }
}

// ===================== CAIXA (fundo) =====================
module caixa() {
    difference() {
        union() {
            translate([0, 0, fundo_z - parede]) arred(ext_x0, ext_y0, ext_x1, ext_y1, junta_z - fundo_z + parede);
            fixacao_mochila();
        }
        // interior
        translate([0, 0, fundo_z]) arred(in_x0, in_y0, in_x1, in_y1, 60, 2);
        // encaixe da tampa: a parede fica só com a metade de fora nos últimos 2 mm
        translate([0, 0, junta_z - 2]) arred(ext_x0 + 1.1, ext_y0 + 1.1, ext_x1 - 1.1, ext_y1 - 1.1, 5);
        aberturas();
        // nome gravado na ponte de baixo
        translate([0, passadores_y[1], fundo_z - parede - fita_h - ponte_t - 0.01]) mirror([1, 0, 0])
            linear_extrude(0.6) text("RAIDTRACK", size = 4.2, halign = "center", valign = "center", font = "Liberation Sans:style=Bold");
    }
    // pilares da placa (M2, parafuso por cima)
    for (f = furos) translate([f[0], f[1], fundo_z - 0.01]) difference() {
        cylinder(d = 5.0, h = -fundo_z);
        cylinder(d = 1.7, h = -fundo_z + 1);
    }
}

module aberturas() {
    // antena (topo)
    translate([sma_x, ext_y0 - 1, sma_z]) rotate([-90, 0, 0]) cylinder(d = sma_d, h = parede + topo_extra + 3);
    // USB-C (fundo)
    translate([usb_x - usb_w / 2, in_y1 - 1, usb_z - usb_h / 2]) cube([usb_w, parede + 3, usb_h]);
    // botão POWER e furos para RST / BOOT (lado direito)
    translate([in_x1 - 1, btn_power_y - 3.5, btn_z - 2.5]) cube([parede + 2, 7, 5]);
    for (y = [btn_rst_y, btn_boot_y]) translate([in_x1 - 1, y, btn_z]) rotate([0, 90, 0]) cylinder(d = 2.2, h = parede + 2);
}

// ===================== TAMPA (frente) =====================
module tampa() {
    difference() {
        union() {
            // aba que entra no rebaixo da caixa
            translate([0, 0, junta_z - 2]) difference() {
                arred(ext_x0 + 1.25, ext_y0 + 1.25, ext_x1 - 1.25, ext_y1 - 1.25, 2.01);
                translate([0, 0, -1]) arred(in_x0, in_y0, in_x1, in_y1, 5, 2);
            }
            // corpo: zona do ecrã (baixa) + zona do teclado (alta), com rampa entre as duas
            translate([0, 0, junta_z]) arred(ext_x0, ext_y0, ext_x1, rampa_y0 + 2 * lado_raio, tampa_oled_z + tampa_t - junta_z);
            hull() {
                translate([0, 0, junta_z]) arred(ext_x0, rampa_y0, ext_x1, rampa_y0 + 2 * lado_raio, tampa_oled_z + tampa_t - junta_z);
                translate([0, 0, junta_z]) arred(ext_x0, rampa_y1, ext_x1, ext_y1, tampa_tecl_z + tampa_t - junta_z);
            }
        }
        // interior oco (respeita a altura dos componentes)
        translate([0, 0, junta_z - 0.01]) arred(in_x0, in_y0, in_x1, rampa_y0 + 4, tampa_oled_z - junta_z, 2);
        translate([0, 0, junta_z - 0.01]) hull() {
            arred(in_x0, rampa_y0, in_x1, rampa_y0 + 4, tampa_oled_z - junta_z, 2);
            arred(in_x0, rampa_y1, in_x1, in_y1, tampa_tecl_z - junta_z, 2);
        }
        // janela do ecrã com chanfro
        hull() {
            translate([oled_janela[0], oled_janela[1], tampa_oled_z - 0.1]) cube([oled_janela[2] - oled_janela[0], oled_janela[3] - oled_janela[1], 0.1]);
            translate([oled_janela[0] - 1.5, oled_janela[1] - 1.5, tampa_oled_z + tampa_t + 0.01])
                cube([oled_janela[2] - oled_janela[0] + 3, oled_janela[3] - oled_janela[1] + 3, 0.1]);
        }
        // teclas e besouro
        for (k = teclas) translate([k[0], k[1], tampa_tecl_z - 1]) cylinder(d = (k[2] ? sos_d : tecla_d) + 2 * tecla_folga, h = tampa_t + 5);
        // grelha do besouro (furo do meio + 6 à volta)
        translate([buzzer[0], buzzer[1], tampa_tecl_z - 1]) {
            cylinder(d = 2.6, h = tampa_t + 5);
            for (a = [0:60:300]) rotate([0, 0, a]) translate([3.6, 0, 0]) cylinder(d = 1.6, h = tampa_t + 5);
        }
        // mesmas aberturas laterais que a caixa (a tampa também cobre a parte de cima das paredes)
        aberturas();
        // parafusos M2 pela frente (cabeça embutida)
        for (f = furos) translate([f[0], f[1], 0]) {
            cylinder(d = 2.4, h = 40);
            translate([0, 0, topo_tampa(f[1]) - 1.6]) cylinder(d = 4.4, h = 5);
        }
        // símbolos ao lado das teclas
        for (s = [["^", teclas[0]], ["OK", teclas[1]], ["v", teclas[2]]])
            translate([s[1][0] - 8.7, s[1][1], tampa_tecl_z + tampa_t - 0.6])
                rotate([0, 0, 180]) linear_extrude(1) text(s[0], size = 3, halign = "center", valign = "center", font = "Liberation Sans:style=Bold");
    }
    // anel de proteção do SOS (evita carregar sem querer)
    translate([teclas[3][0], teclas[3][1], tampa_tecl_z + tampa_t - 0.01]) difference() {
        cylinder(d = sos_d + 6, h = 2.5);
        translate([0, 0, -1]) cylinder(d = sos_d + 2.5, h = 5);
    }
    // anéis-guia das teclas (centram a aba redonda)
    for (k = teclas) let(d = (k[2] ? sos_d : tecla_d) + aba_extra + 0.8)
        translate([k[0], k[1], tampa_tecl_z - aba - 0.4]) difference() {
            cylinder(d = d + 2.4, h = aba + 0.41);
            translate([0, 0, -1]) cylinder(d = d, h = aba + 3);
        }
    // copo do besouro (encaixa à pressão; uma gota de cola quente segura-o)
    translate([buzzer[0], buzzer[1], tampa_tecl_z - 4]) difference() {
        cylinder(d = buzzer_d + 2.4, h = 4.01);
        translate([0, 0, -1]) cylinder(d = buzzer_d, h = 6);
    }
    // pilares onde aparafusa o suporte dos botões
    for (f = sup_fix) translate([f[0], f[1], sup_z]) difference() {
        cylinder(d = 6, h = tampa_tecl_z - sup_z + 0.01);
        translate([0, 0, -1]) cylinder(d = 1.7, h = 8);
    }
    // pilares dos parafusos: da tampa até à face de cima da placa (apertam a placa contra a caixa)
    for (f = furos) translate([f[0], f[1], pcb_t + 0.2]) difference() {
        cylinder(d = 5, h = topo_tampa(f[1]) - tampa_t - pcb_t - 0.2 + 0.01);
        translate([0, 0, -1]) cylinder(d = 2.4, h = 40);
    }
}

// ===================== SUPORTE DOS BOTÕES =====================
// Placa que fica por baixo do teclado: os tácteis assentam nela com a haste para cima.
// Montagem: teclas nos furos da tampa (por dentro) → tácteis nos encaixes → suporte aparafusado à tampa.
module suporte() {
    difference() {
        union() {
            translate([0, 0, sup_z - sup_t]) arred(sup_area[0], sup_area[1], sup_area[2], sup_area[3], sup_t, 2);
            // molduras que seguram cada táctil
            for (k = teclas) translate([k[0] - sw / 2 - 1, k[1] - sw / 2 - 1, sup_z - 0.01]) cube([sw + 2, sw + 2, 1.6]);
        }
        for (k = teclas) translate([k[0], k[1], 0]) {
            translate([-sw / 2, -sw / 2, sup_z]) cube([sw, sw, 5]);
            // ranhuras para as pernas (12x12: pernas nos lados, a ±6,25 mm) e para os fios
            for (x = [-6.25, 6.25]) translate([x - 1.2, -4.5, sup_z - sup_t - 1]) cube([2.4, 9, sup_t + 4]);
        }
        // passagem do besouro
        translate([buzzer[0], buzzer[1], sup_z - 5]) cylinder(d = buzzer_d + 3, h = 10);
        // parafusos de fixação à tampa
        for (f = sup_fix) translate([f[0], f[1], sup_z - 5]) cylinder(d = 2.4, h = 10);
        // pilares dos parafusos da tampa
        for (f = furos) translate([f[0], f[1], sup_z - 5]) cylinder(d = 6.5, h = 10);
    }
}

// ===================== TECLAS =====================
module tecla(d, rotulo = "") {
    difference() {
        union() {
                    cylinder(d = d + aba_extra, h = aba - 0.15);          // aba redonda (fica por dentro)
            cylinder(d = d, h = aba + tampa_t + 1.6);            // sai 1,6 mm da tampa
            translate([0, 0, aba + tampa_t + 1.6]) cylinder(d1 = d, d2 = d - 1.2, h = 0.6);
        }
        if (rotulo != "") translate([0, 0, aba + tampa_t + 2.2 - 0.6]) rotate([0, 0, 180])
            linear_extrude(1) text(rotulo, size = 3.6, halign = "center", valign = "center", font = "Liberation Sans:style=Bold");
    }
}
module teclas_impressao() {
    for (i = [0:2]) translate([i * 16, 0, 0]) tecla(tecla_d);
    translate([52, 0, 0]) tecla(sos_d, "SOS"); // imprimir esta em vermelho
}

// ===================== saída =====================
if (parte == "caixa") translate([0, 0, -(fundo_z - parede)]) caixa(); // fundo na mesa
else if (parte == "tampa") translate([0, 0, -(pcb_t + 0.2)]) tampa(); // frente para cima, suportes "árvore" só por dentro
else if (parte == "teclas") teclas_impressao();
else if (parte == "suporte") translate([0, 0, -(sup_z - sup_t)]) suporte();
else if (parte == "corte") intersection() { montagem(); translate([-6 - 100, -100, -50]) cube([100, 200, 100]); }
else montagem();

module montagem() {
    color("#3a4b3f") caixa();
    color("#5b7a63", 0.9) tampa();
    color("#c2410c") suporte();
    color("#111") for (k = teclas) translate([k[0] - 6, k[1] - 6, sup_z]) cube([12, 12, sw_corpo]);
    color("#222") translate([buzzer[0], buzzer[1], tampa_tecl_z - 9.5]) cylinder(d = 12, h = 9.5);
    color("#cfd8d2") for (k = teclas) translate([k[0], k[1], tampa_tecl_z - aba]) tecla(k[2] ? sos_d : tecla_d, k[2] ? "SOS" : "");
    color("#1d4ed8", 0.6) translate([-pcb_w / 2, -pcb_l / 2, 0]) cube([pcb_w, pcb_l, pcb_t]);
    color("black") translate([oled[0], oled[1], 6.3]) cube([oled[2] - oled[0], oled[3] - oled[1], 1.55]);
}
