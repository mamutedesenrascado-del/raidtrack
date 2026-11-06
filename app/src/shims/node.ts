// Substitutos de os/path/util para o browser (ver process.ts)
export const hostname = () => "browser";
export const normalize = (p: string) => p;
export const formatWithOptions = (_o: unknown, ...a: unknown[]) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
export const types = { isNativeError: (e: unknown) => e instanceof Error };
export default { hostname, normalize, formatWithOptions, types };
