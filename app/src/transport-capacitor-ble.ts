// Transporte Bluetooth nativo (Android/iOS) para a app empacotada com Capacitor.
// O iOS não tem Web Bluetooth no Safari; dentro da app nativa usamos o plugin BLE do Capacitor.
// Segue o mesmo contrato e a mesma lógica do @meshtastic/transport-web-bluetooth.
import { BleClient, numbersToDataView } from "@capacitor-community/bluetooth-le";
import { Types } from "@meshtastic/core";

const SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
const TO_RADIO = "f75c76d2-129e-4dad-a1dd-7866124401e7";
const FROM_RADIO = "2c55e69e-4993-11ed-b878-0242ac120002";
const FROM_NUM = "ed9da18c-a800-4f66-a670-aa7547e34453";

export const isNative = () =>
  !!(globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

export class TransportCapacitorBle implements Types.Transport {
  private ctrl?: ReadableStreamDefaultController<Types.DeviceOutput>;
  private last = Types.DeviceStatusEnum.DeviceDisconnected;
  private reading = false;
  private closing = false;
  readonly fromDevice: ReadableStream<Types.DeviceOutput>;
  readonly toDevice: WritableStream<Uint8Array>;

  static async create(): Promise<TransportCapacitorBle> {
    await BleClient.initialize({ androidNeverForLocation: true });
    const dev = await BleClient.requestDevice({ services: [SERVICE] });
    const t = new TransportCapacitorBle(dev.deviceId);
    t.emit(Types.DeviceStatusEnum.DeviceConnecting);
    await BleClient.connect(dev.deviceId, () => {
      if (!t.closing) t.emit(Types.DeviceStatusEnum.DeviceDisconnected, "ble-disconnected");
    });
    try {
      await BleClient.startNotifications(dev.deviceId, SERVICE, FROM_NUM, () => void t.drain());
    } catch (e) {
      t.emit(Types.DeviceStatusEnum.DeviceDisconnected, "notify-failed");
      throw e;
    }
    t.emit(Types.DeviceStatusEnum.DeviceConnected);
    void t.drain();
    return t;
  }

  private constructor(private id: string) {
    this.fromDevice = new ReadableStream({ start: (ctrl) => void (this.ctrl = ctrl) });
    this.toDevice = new WritableStream({
      write: async (chunk) => {
        try {
          await BleClient.write(this.id, SERVICE, TO_RADIO, numbersToDataView([...chunk]));
          void this.drain();
        } catch (e) {
          this.emit(Types.DeviceStatusEnum.DeviceDisconnected, "write-error");
          throw e;
        }
      },
    });
  }

  /** Lê FROM_RADIO até vir vazio (protocolo BLE do Meshtastic) */
  private async drain() {
    if (this.reading) return;
    this.reading = true;
    try {
      for (;;) {
        const v = await BleClient.read(this.id, SERVICE, FROM_RADIO);
        if (v.byteLength === 0) break;
        this.ctrl?.enqueue({ type: "packet", data: new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice() });
      }
    } catch {
      if (!this.closing) this.emit(Types.DeviceStatusEnum.DeviceDisconnected, "read-error");
    } finally {
      this.reading = false;
    }
  }

  private emit(status: Types.DeviceStatusEnum, reason?: string) {
    if (status === this.last) return;
    this.last = status;
    this.ctrl?.enqueue({ type: "status", data: { status, reason } });
  }

  async disconnect() {
    this.closing = true;
    this.emit(Types.DeviceStatusEnum.DeviceDisconnected, "user");
    try { await BleClient.stopNotifications(this.id, SERVICE, FROM_NUM); } catch { /* já desligado */ }
    try { await BleClient.disconnect(this.id); } finally { this.closing = false; }
  }
}
