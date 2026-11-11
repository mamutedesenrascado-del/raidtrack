// Tipos partilhados: estado do raid (guardado no browser) e plano (guardado no ficheiro .raidtrack)
import type { Dest } from "./link";
import type { LatLon } from "./geo";

export type Pt = [number, number, number]; // lat, lon, t(ms)

export interface Sos { seq: number; lat: number | null; lon: number | null; bat: number; since: number; last: number; acked: boolean; ackAt?: number }

export interface Team {
  num: number; short: string; long: string; color: string;
  lat?: number; lon?: number; posAt?: number; heard?: number;
  bat?: number; snr?: number; rssi?: number; hops?: number | null;
  track: Pt[]; sos?: Sos;
  /** hora de partida e de chegada (ms), introduzidas pela base */
  start?: number; end?: number;
  /** zonas proibidas onde a equipa está agora, e quando foi avisada (id do aviso + hora) */
  inZones?: Record<string, { id: number; since: number; sentAt: number }>;
  /** zonas de perigo de que a equipa está perto (id da zona → desde) */
  nearDanger?: Record<string, number>;
  /** passagem nos postos (id do posto → hora) */
  posts?: Record<string, number>;
  /** último sítio onde a equipa estava quando se mexeu, e quando */
  anchor?: LatLon; movedAt?: number;
  /** desde quando está fora do corredor do percurso */
  offSince?: number;
  /** alertas ativos (tipo → desde) */
  alerts?: Partial<Record<AlertKind, number>>;
  /** hora (do computador) da última posição e do último sinal rádio, para o mapa de cobertura */
  posRx?: number; radioRx?: number; covAt?: number;
}

export type AlertKind = "parada" | "silencio" | "desvio" | "bateria";

export interface Msg {
  t: number; from: number; to: Dest; text: string; dir: "in" | "out"; st?: "a enviar" | "entregue" | "enviada" | "falhou";
  /** id do aviso no tracker e quem já carregou OK (nó → hora) */
  id?: number; reads?: Record<string, number>;
}
export interface LogEv { t: number; kind: "sos" | "msg" | "info" | "ligacao" | "zona" | "posto" | "alerta"; text: string }

// ───────────── Plano ─────────────
export interface Route { name: string; pts: LatLon[]; ele?: number[]; /** postos do GPX (versões antigas) */ wpts: { name: string; lat: number; lon: number }[] }
export interface Recon { id: string; name: string; pts: LatLon[] }
export interface Post { id: string; name: string; lat: number; lon: number; notes?: string; /** raio de passagem (m) */ radius?: number }
export interface Zone {
  id: string; name: string; poly: LatLon[];
  /** proibida (tracker apita até OK) ou perigo (aviso quando se aproximam) */
  kind?: "proibida" | "perigo";
  notes?: string;
  /** perigo: distância de aviso (m) e se avisa também o tracker */
  warn?: number; notifyTracker?: boolean;
}
export interface PlanTeam { id: string; code: string; name: string; members: string; /** partida prevista hh:mm */ start: string }
export interface Sched { id: string; at: string; text: string; /** "all" ou código da equipa */ dest: string; sent?: number }
export interface Alerts { stillMin: number; silentMin: number; offMin: number; bat: number }
export interface Safety { meet: string; hospital: string; contacts: string }

export const DEFAULT_ALERTS: Alerts = { stillMin: 20, silentMin: 15, offMin: 10, bat: 20 };

export interface Plan {
  name?: string; date?: string;
  route?: Route; recon?: Recon[]; posts?: Post[]; zones?: Zone[];
  corridor?: number; speed?: number;
  notes?: string; safety?: Safety;
  planTeams?: PlanTeam[]; sched?: Sched[]; alerts?: Alerts;
}

/** Ponto do mapa de cobertura: lat, lon, SNR (dB), RSSI (dBm), saltos, hora */
export type CovPt = [number, number, number, number, number | null, number];

export interface Raid extends Plan {
  started: number; teams: Record<number, Team>; msgs: Msg[]; log: LogEv[]; base?: [number, number];
  cov?: CovPt[];
}

export const PLAN_KEYS = ["name", "date", "route", "recon", "posts", "zones", "corridor", "speed", "notes", "safety", "planTeams", "sched", "alerts"] as const;
