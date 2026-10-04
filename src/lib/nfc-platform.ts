type WebNdefRecord = { recordType: string; data: DataView | string | ArrayBuffer | null; encoding?: string };
type WebNdefReader = {
  onreading: ((event: { message: { records: WebNdefRecord[] } }) => void) | null;
  onreadingerror: (() => void) | null;
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(message: { records: Array<{ recordType: "text"; data: string }> }): Promise<void>;
};

const TOKEN_PREFIX = "FGYM1:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function getWebNdefReader() {
  const Constructor = (window as Window & { NDEFReader?: new () => WebNdefReader }).NDEFReader;
  if (!window.isSecureContext || !Constructor) {
    throw new Error("Web NFC is unavailable here. Use Chrome on a supported NFC-enabled Android device.");
  }
  return new Constructor();
}

function webTextRecordValue(record: WebNdefRecord) {
  if (record.recordType !== "text" || !record.data) return null;
  if (typeof record.data === "string") return record.data;
  const view = record.data instanceof DataView ? record.data : new DataView(record.data);
  return new TextDecoder(record.encoding || "utf-8").decode(view);
}

function extractToken(values: Array<string | null>) {
  for (const value of values) {
    if (!value?.startsWith(TOKEN_PREFIX)) continue;
    const token = value.slice(TOKEN_PREFIX.length).trim();
    if (TOKEN_PATTERN.test(token)) return token;
  }
  throw new Error("This card has no valid GYM MANAGER check-in record. Register the card first.");
}

export async function writeMemberNfcToken(token: string) {
  const reader = getWebNdefReader();
  await reader.write({ records: [{ recordType: "text", data: `${TOKEN_PREFIX}${token}` }] });
}

export async function scanMemberNfcToken() {
  const reader = getWebNdefReader();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => finish(new Error("NFC scan timed out. Try again.")), 60_000);
    function finish(error?: Error, token?: string) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      controller.abort();
      if (error) reject(error);
      else resolve(token!);
    }
    reader.onreadingerror = () => finish(new Error("The NFC tag could not be read. Try again."));
    reader.onreading = (event) => {
      try { finish(undefined, extractToken(event.message.records.map(webTextRecordValue))); }
      catch (error) { finish(error instanceof Error ? error : new Error("Could not read this NFC tag.")); }
    };
    void reader.scan({ signal: controller.signal }).catch((error: unknown) => {
      if (!settled) finish(error instanceof Error ? error : new Error("Could not start the NFC scanner."));
    });
  });
}
