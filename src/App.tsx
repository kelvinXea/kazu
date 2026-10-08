import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";

type FileEntry = { name: string; path: string; size: number; isDir: boolean };

type HashEvent =
  | { event: "progress"; data: { bytesDone: number; bytesTotal: number } }
  | { event: "done"; data: { crc32: string; sha1: string; elapsedMs: number } };

type DownloadEvent =
  | { event: "progress"; data: { bytesDone: number; bytesTotal: number | null } }
  | { event: "done"; data: { elapsedMs: number } };

const fmtBytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
};

function useFps() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0, last = performance.now(), raf = 0;
    const loop = (now: number) => {
      frames++;
      if (now - last >= 1000) { setFps(frames); frames = 0; last = now; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}

function ProgressBar({ done, total }: { done: number; total: number | null }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="mt-2">
      <div className="h-3 w-full rounded bg-slate-700">
        <div className="h-3 rounded bg-sky-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-sm text-slate-300">
        {fmtBytes(done)}{total ? ` / ${fmtBytes(total)} (${pct.toFixed(0)}%)` : ""}
      </p>
    </div>
  );
}

export default function App() {
  const fps = useFps();

  // 1) Carpeta y listado
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickFolder() {
    setError(null);
    const result = await open({ directory: true, multiple: false });
    if (typeof result !== "string") return;
    setDir(result);
    try {
      setEntries(await invoke<FileEntry[]>("list_dir", { path: result }));
    } catch (e) { setError(String(e)); }
  }

  // 2) Hash
  const [hashProgress, setHashProgress] = useState<{ done: number; total: number } | null>(null);
  const [hashResult, setHashResult] = useState<string | null>(null);

  async function runHash() {
    if (!selected || selected.isDir) return;
    setHashResult(null);
    setHashProgress({ done: 0, total: selected.size });
    const onEvent = new Channel<HashEvent>();
    onEvent.onmessage = (msg) => {
      if (msg.event === "progress") {
        setHashProgress({ done: msg.data.bytesDone, total: msg.data.bytesTotal });
      } else {
        setHashProgress(null);
        setHashResult(
          `CRC32 ${msg.data.crc32} · SHA-1 ${msg.data.sha1} · ${msg.data.elapsedMs} ms`
        );
      }
    };
    try { await invoke("hash_file", { path: selected.path, onEvent }); }
    catch (e) { setError(String(e)); }
  }

  // 3) Descarga
  const [url, setUrl] = useState("");
  const [dlProgress, setDlProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [dlResult, setDlResult] = useState<string | null>(null);

  async function runDownload() {
    if (!dir || !url) return;
    setDlResult(null);
    setDlProgress({ done: 0, total: null });
    const filename = url.split("/").pop()?.split("?")[0] || "descarga.bin";
    const onEvent = new Channel<DownloadEvent>();
    onEvent.onmessage = (msg) => {
      if (msg.event === "progress") {
        setDlProgress({ done: msg.data.bytesDone, total: msg.data.bytesTotal });
      } else {
        setDlProgress(null);
        setDlResult(`Listo en ${msg.data.elapsedMs} ms`);
      }
    };
    try { await invoke("download_file", { url, dest: `${dir}/${filename}`, onEvent }); }
    catch (e) { setError(String(e)); setDlProgress(null); }
  }

  // 4) Lista virtualizada
  const items = useMemo(
    () => Array.from({ length: 5000 }, (_, i) => `Juego de prueba ${i + 1}`), []
  );
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 8,
  });

  return (
    <main className="min-h-screen bg-slate-900 p-4 text-slate-100">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Spike técnico</h1>
        <span className="rounded bg-slate-700 px-3 py-1 text-lg">{fps} FPS</span>
      </header>

      {error && <p className="mb-4 rounded bg-red-900 p-3">{error}</p>}

      <section className="mb-6">
        <h2 className="text-xl font-semibold">1. Carpeta y listado</h2>
        <button onClick={pickFolder} className="mt-2 rounded bg-sky-600 px-4 py-2">
          Elegir carpeta
        </button>
        {dir && <p className="mt-2 text-sm text-slate-300">{dir} · {entries.length} elementos</p>}
        <ul className="mt-2 max-h-48 overflow-auto rounded border border-slate-700">
          {entries.map((e) => (
            <li
              key={e.path}
              onClick={() => setSelected(e)}
              className={`cursor-pointer px-3 py-1 hover:bg-slate-800 ${
                selected?.path === e.path ? "bg-slate-700" : ""
              }`}
            >
              {e.isDir ? "📁" : "📄"} {e.name}{" "}
              {!e.isDir && <span className="text-slate-400">({fmtBytes(e.size)})</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="text-xl font-semibold">2. Hash del archivo seleccionado</h2>
        <button
          onClick={runHash}
          disabled={!selected || selected.isDir}
          className="mt-2 rounded bg-sky-600 px-4 py-2 disabled:opacity-40"
        >
          Calcular CRC32 + SHA-1
        </button>
        {hashProgress && <ProgressBar done={hashProgress.done} total={hashProgress.total} />}
        {hashResult && <p className="mt-2 break-all font-mono text-sm">{hashResult}</p>}
      </section>

      <section className="mb-6">
        <h2 className="text-xl font-semibold">3. Descarga (a la carpeta elegida)</h2>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="mt-2 w-full rounded bg-slate-800 px-3 py-2"
        />
        <button onClick={runDownload} className="mt-2 rounded bg-sky-600 px-4 py-2">
          Descargar
        </button>
        {dlProgress && <ProgressBar done={dlProgress.done} total={dlProgress.total} />}
        {dlResult && <p className="mt-2">{dlResult}</p>}
      </section>

      <section>
        <h2 className="text-xl font-semibold">4. Lista virtualizada (5.000)</h2>
        <div ref={parentRef} className="mt-2 h-96 overflow-auto rounded border border-slate-700">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => (
              <div
                key={v.key}
                style={{
                  position: "absolute", top: 0, left: 0, width: "100%",
                  height: v.size, transform: `translateY(${v.start}px)`,
                }}
                className="flex items-center border-b border-slate-800 px-4"
              >
                {items[v.index]}
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}