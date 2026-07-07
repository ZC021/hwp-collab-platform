import { useEffect, useRef, useState } from "react";
import { createEditor } from "@rhwp/editor";
import CFB from "cfb";
import JSZip from "jszip";
import { api, getStoredAuth } from "./api.js";
import { withAppBasePath } from "./base-path.js";
import {
  isEditorReady,
  loadFileInEditor,
  requestFocus,
  exportDocument,
  dispatchCommand as rpcDispatchCommand
} from "./rhwp-editor-adapter.js";
import { friendlyOpenError } from "./open-error.js";

const EDITOR_CANCELLED = "editor_cancelled";
const EDITOR_READY_TIMEOUT_MS = 12000;
const EDITOR_RACE_PATTERN = /hwpdocument_|not ready|timeout|initializ|cannot read properties/i;
const MAX_LOCAL_DOCUMENT_BYTES = 80 * 1024 * 1024;
const MAX_HWPX_ENTRIES = 500;
const MAX_HWPX_XML_BYTES = 12 * 1024 * 1024;
const MAX_HWPX_TOTAL_UNCOMPRESSED_BYTES = 160 * 1024 * 1024;
const MIN_HWP_CFB_BYTES = 512;
const HWP_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HWP_REQUIRED_STREAMS = ["FileHeader", "DocInfo", "Root Entry/BodyText/Section0"];
const HWPX_HEADERS = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08]
];
const HWPX_REQUIRED_ENTRIES = ["mimetype", "version.xml", "Contents/content.hpf", "META-INF/manifest.xml"];
const HWPX_TEXT_XML_PATTERN = /^Contents\/(?:section\d+|header|footer|footnote|endnote|bodytext\/section\d+)[^/]*\.xml$/i;
const BLANK_TEMPLATE_URL = "/templates/blank.hwp";
const NON_DIRTY_EDITOR_COMMANDS = new Set([
  "edit:select-all",
  "edit:find",
  "edit:find-replace",
  "edit:find-again",
  "edit:goto",
  "file:print"
]);

function newLocalDocument(title = "새 문서") {
  return {
    id: `local_${randomId()}`,
    title,
    originalFileName: null,
    permission: "owner"
  };
}

export default function App() {
  const [auth, setAuth] = useState(() => getStoredAuth());
  const [authReady, setAuthReady] = useState(false);
  const [config, setConfig] = useState(null);
  const [documentModel, setDocumentModel] = useState(() => newLocalDocument());
  const [error, setError] = useState("");
  const isAuthenticated = Boolean(auth.user && auth.cookieSession);

  useEffect(() => {
    let cancelled = false;
    api("/api/config")
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
    if (/mac/i.test(ua)) {
      document.documentElement.classList.add("platform-mac");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api("/api/me")
      .then((data) => {
        if (cancelled) return;
        if (!data?.user) {
          setError("로컬 세션을 만들지 못했습니다");
          return;
        }
        setAuth({ token: null, user: data.user, cookieSession: true });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authReady) {
    return (
      <main className="focus-app">
        <div className="focus-main">
          <div className="focus-empty">HWP Collab 준비 중</div>
        </div>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="focus-app">
        {error ? (
        <div className="focus-error" role="alert">
          <span>{error}</span>
          <button type="button" className="focus-error-dismiss" onClick={() => setError("")} aria-label="알림 닫기" title="알림 닫기">×</button>
        </div>
      ) : null}
        <div className="focus-main">
          <div className="focus-empty">로컬 세션을 만들지 못했습니다</div>
        </div>
      </main>
    );
  }

  return (
    <main className="focus-app">
      {error ? (
        <div className="focus-error" role="alert">
          <span>{error}</span>
          <button type="button" className="focus-error-dismiss" onClick={() => setError("")} aria-label="알림 닫기" title="알림 닫기">×</button>
        </div>
      ) : null}
      <div className="focus-main">
        <DocumentWorkspace
          config={config}
          initialDocument={documentModel}
          onDocumentChange={setDocumentModel}
          onError={setError}
        />
      </div>
    </main>
  );
}

function StatusBar({ documentTitle, isDirty, documentLoaded, editorReady }) {
  if (!editorReady) return null;
  return (
    <div className="rhwp-statusbar" role="status" aria-label="상태 표시줄">
      {documentLoaded ? (
        <>
          <span>{documentTitle || "새 문서"}</span>
          {isDirty ? <span style={{ color: "var(--warn)" }}>● 변경사항 있음</span> : <span>저장됨</span>}
        </>
      ) : (
        <span>파일을 열어 편집을 시작하세요</span>
      )}
    </div>
  );
}

function DocumentWorkspace({ config, initialDocument, onDocumentChange, onError }) {
  const editorRoot = useRef(null);
  const editorRef = useRef(null);
  const editorReadyRef = useRef(false);
  const openLocalDocumentRef = useRef(null);
  const fileInputRef = useRef(null);
  const documentLoadedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const dirtyRevisionRef = useRef(0);
  const autoBlankCreatedRef = useRef(false);
  const exportInProgressRef = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [documentModel, setDocumentModel] = useState(initialDocument);
  const [status, setStatus] = useState("설정 로딩 중");
  const [editorReady, setEditorReady] = useState(false);
  const [documentLoaded, setDocumentLoaded] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [recentFiles, setRecentFiles] = useState(() => getRecentFiles());

  function refreshRecentFiles() {
    setRecentFiles(getRecentFiles());
  }

  // In-app auto-update banner. The Electron main process (electron-updater)
  // notifies via window.__hwpCollabUpdateEvent (or stashes window.__hwpCollabPendingUpdate
  // before React mounts). Downloads happen in the background and install on quit,
  // so the banner just informs the user; restarting applies the update.
  useEffect(() => {
    function onUpdate(u) { if (u && typeof u === "object") setUpdateInfo(u); }
    window.__hwpCollabUpdateEvent = onUpdate;
    if (window.__hwpCollabPendingUpdate) {
      onUpdate(window.__hwpCollabPendingUpdate);
      window.__hwpCollabPendingUpdate = null;
    }
    return () => { if (window.__hwpCollabUpdateEvent === onUpdate) window.__hwpCollabUpdateEvent = undefined; };
  }, []);

  // "최신 버전입니다" toast is transient — auto-dismiss after a few seconds so a
  // manual update check that finds nothing doesn't leave a sticky banner.
  useEffect(() => {
    if (!updateInfo || updateInfo.type !== "none") return undefined;
    const timer = setTimeout(() => setUpdateInfo(null), 6000);
    return () => clearTimeout(timer);
  }, [updateInfo]);

  // Studio mount URL. While /api/config is still loading (config === null) keep
  // this null so the editor effect waits (avoids a mount→remount churn). Once
  // config has loaded, prefer its rhwpStudioUrl but fall back to the LOCAL
  // /rhwp-studio/ mount if it is missing/empty — this air-gap hardening (S7)
  // guarantees the editor never silently stays blank on a partial config AND
  // never falls through to @rhwp/editor's external GitHub-Pages default.
  const studioUrl = config ? (config.rhwpStudioUrl || withAppBasePath("/rhwp-studio/")) : null;
  const canEdit = true;

  useEffect(() => {
    documentLoadedRef.current = documentLoaded;
  }, [documentLoaded]);

  useEffect(() => {
    editorReadyRef.current = editorReady;
  }, [editorReady]);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    const baseTitle = "HWP Collab";
    const fileTitle = documentModel.title && documentModel.title !== "새 문서"
      ? documentModel.title
      : "";
    const dirtyMark = isDirty ? "● " : "";
    const next = fileTitle
      ? `${dirtyMark}${fileTitle} — ${baseTitle}`
      : `${dirtyMark}${baseTitle}`;
    if (typeof document !== "undefined" && document.title !== next) {
      document.title = next;
    }
  }, [documentModel.title, isDirty]);

  useEffect(() => {
    function onBeforeUnload(event) {
      if (!isDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Stop the OS-default "open dropped file" navigation when files are dropped
  // outside the workspace drop target — without this, dragging a .hwp onto the
  // window edge would silently navigate the Electron window to a file:// URL.
  useEffect(() => {
    function block(event) {
      if (!event.dataTransfer?.types?.includes?.("Files")) return;
      event.preventDefault();
    }
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Bridge for the Electron main process to open a .hwp/.hwpx that the user
  // double-clicked in Finder / chose via "열기 프로그램" (file association).
  // main.cjs reads the file, base64-encodes it, and calls this hook (or stashes
  // it in window.__hwpCollabPendingOpen if React has not mounted yet). We reuse the
  // exact same validation + load path as the in-app "열기" button so a
  // double-clicked file behaves identically to one opened from the toolbar.
  useEffect(() => {
    async function openFromHost(fileName, base64) {
      const name = typeof fileName === "string" && fileName ? fileName : "document.hwp";
      try {
        const deadline = Date.now() + EDITOR_READY_TIMEOUT_MS;
        while (!editorReadyRef.current && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!editorReadyRef.current) {
          setStatus("에디터 준비 중입니다 — 잠시 후 다시 시도해 주세요");
          return false;
        }
        const binary = atob(String(base64 || ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], name, { type: "application/octet-stream" });
        const opener = openLocalDocumentRef.current;
        if (!opener) {
          setStatus("에디터 준비 중입니다 — 잠시 후 다시 시도해 주세요");
          return false;
        }
        await opener(file);
        return true;
      } catch (err) {
        const message = friendlyOpenError(err);
        setStatus(`열기 오류: ${message}`);
        onError?.(message);
        return false;
      }
    }
    window.__hwpCollabOpenLocalFile = openFromHost;
    const pending = window.__hwpCollabPendingOpen;
    if (pending && typeof pending === "object") {
      window.__hwpCollabPendingOpen = null;
      openFromHost(pending.fileName, pending.base64);
    }
    return () => {
      if (window.__hwpCollabOpenLocalFile === openFromHost) {
        try {
          delete window.__hwpCollabOpenLocalFile;
        } catch {
          window.__hwpCollabOpenLocalFile = undefined;
        }
      }
    };
  }, []);

  function updateDocument(nextDocument) {
    setDocumentModel(nextDocument);
    onDocumentChange?.(nextDocument);
  }

  function markDocumentDirty() {
    if (!documentLoadedRef.current) return;
    const wasDirty = isDirtyRef.current;
    isDirtyRef.current = true;
    dirtyRevisionRef.current += 1;
    setIsDirty(true);
    if (!wasDirty) {
      setStatus("변경사항 있음");
    }
  }

  function confirmDiscardUnsavedChanges() {
    if (!isDirtyRef.current) return true;
    return window.confirm("저장하지 않은 변경사항이 있습니다. 계속하면 현재 문서의 변경사항이 사라집니다.");
  }

  useEffect(() => {
    if (!studioUrl) return undefined;
    let destroyed = false;
    async function boot() {
      setStatus("rhwp editor 초기화");
      setEditorReady(false);
      setDocumentLoaded(false);
      documentLoadedRef.current = false;
      const cacheReset = await clearStaleRhwpStudioRuntimeCache(studioUrl);
      if (cacheReset.reloading) return;
      const editor = await createEditor(editorRoot.current, { studioUrl });
      if (destroyed) {
        editor.destroy();
        return;
      }
      editorRef.current = editor;
      setEditorReady(true);
    }
    boot().catch((err) => {
      if (!destroyed) setStatus(formatEditorError(err));
    });
    return () => {
      destroyed = true;
      editorRef.current?.destroy();
      editorRef.current = null;
      setEditorReady(false);
      setDocumentLoaded(false);
      documentLoadedRef.current = false;
    };
  }, [studioUrl]);

  useEffect(() => {
    if (!editorReady || documentLoaded || autoBlankCreatedRef.current) return;
    autoBlankCreatedRef.current = true;
    createBlankInEditor({ automatic: true }).catch((err) => {
      autoBlankCreatedRef.current = false;
      if ((err?.message || String(err)) === EDITOR_CANCELLED) return;
      setStatus(`새 문서 생성 오류: ${err?.message || err}`);
    });
  }, [documentLoaded, editorReady]);

  useEffect(() => {
    function onRhwpMessage(event) {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "rhwp-content-dirty") {
        markDocumentDirty();
        return;
      }
      // The editor lives in an iframe, so a .hwp/.hwpx dropped onto the visible
      // page is caught by the bridge inside the iframe and forwarded here (the
      // parent's own drop zone only covers the chrome around the iframe).
      if (message.type === "rhwp-file-dragover") {
        if (editorReady) setIsDragOver(true);
        return;
      }
      if (message.type === "rhwp-file-dragleave") {
        setIsDragOver(false);
        return;
      }
      if (message.type === "rhwp-file-drop") {
        setIsDragOver(false);
        if (!editorReady) return;
        if (message.file) {
          if (message.count > 1) {
            setStatus(`여러 파일 중 첫 번째만 열었습니다: ${message.file.name}`);
          }
          openDroppedFile(message.file).catch((err) => setStatus(`열기 오류: ${err?.message || err}`));
        }
        return;
      }
      // Ctrl/Cmd+click on a bridge hyperlink. Only open http(s)/mailto — the
      // bridge already normalizes/validates, this is defense in depth.
      if (message.type === "rhwp-open-url") {
        const url = String(message.url || "");
        if (/^(https?:|mailto:)/i.test(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (
        message.type === "rhwp-op" &&
        (message.op?.kind === "text.insert" || message.op?.kind === "text.delete")
      ) {
        markDocumentDirty();
        return;
      }
      if (message.type !== "rhwp-app-shortcut") return;
      if (message.command === "save-hwp") {
        saveRhwpExport("hwp").catch((err) => setStatus(`저장 오류: ${err.message}`));
      } else if (message.command === "save-hwpx") {
        saveRhwpExport("hwpx").catch((err) => setStatus(`저장 오류: ${err.message}`));
      } else if (message.command === "open-file") {
        openLocalFileDialog();
      } else if (message.command === "new-document") {
        createBlankInEditor().catch((err) => setStatus(err.message));
      } else if (message.command === "print-blocked") {
        setStatus("인쇄를 시작할 수 없습니다 — 잠시 후 다시 시도하세요");
      } else if (message.command === "reload-blocked") {
        setStatus(
          isDirtyRef.current
            ? "새로 고침 차단됨 — 먼저 저장하세요"
            : "새로 고침이 비활성화되어 있습니다"
        );
      }
    }
    window.addEventListener("message", onRhwpMessage);
    return () => window.removeEventListener("message", onRhwpMessage);
  }, [documentLoaded, editorReady, documentModel.title]);

  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (!event.metaKey && !event.ctrlKey && event.altKey && event.shiftKey) {
        if (key === "e" || key === "ㄷ") {
          event.preventDefault();
          dispatchEditorCommand("format:font-size-increase").catch((err) => setStatus(`명령 오류: ${err.message}`));
        } else if (key === "r" || key === "ㄱ") {
          event.preventDefault();
          dispatchEditorCommand("format:font-size-decrease").catch((err) => setStatus(`명령 오류: ${err.message}`));
        } else if (key === "p" || key === "ㅔ") {
          event.preventDefault();
          dispatchEditorCommand("format:superscript").catch((err) => setStatus(`명령 오류: ${err.message}`));
        } else if (key === "g" || key === "ㅎ") {
          event.preventDefault();
          dispatchEditorCommand("format:subscript").catch((err) => setStatus(`명령 오류: ${err.message}`));
        }
        return;
      }
      if (event.key === "F5" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setStatus(
          isDirtyRef.current
            ? "새로 고침 차단됨 — 먼저 저장하세요"
            : "새로 고침이 비활성화되어 있습니다"
        );
        return;
      }
      if (event.key === "F6" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        dispatchEditorCommand("format:style-dialog").catch((err) => setStatus(`명령 오류: ${err.message}`));
      }
      if (!event.metaKey && !event.ctrlKey && event.altKey && !event.shiftKey) {
        if (key === "l" || key === "ㄹ") {
          event.preventDefault();
          dispatchEditorCommand("format:char-shape").catch((err) => setStatus(`명령 오류: ${err.message}`));
        } else if (key === "t" || key === "ㅅ") {
          event.preventDefault();
          dispatchEditorCommand("format:para-shape").catch((err) => setStatus(`명령 오류: ${err.message}`));
        }
        return;
      }
      if (event.key === "F1" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setStatus("단축키 도움말: 화면 우측 상단 ? 버튼을 누르세요");
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || event.altKey) return;
      if (key === "z") {
        event.preventDefault();
        dispatchEditorCommand(event.shiftKey ? "edit:redo" : "edit:undo").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "a") {
        event.preventDefault();
        dispatchEditorCommand("edit:select-all").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "f") {
        event.preventDefault();
        dispatchEditorCommand("edit:find").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "l") {
        event.preventDefault();
        dispatchEditorCommand("edit:find-again").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (key === "f2") {
        event.preventDefault();
        dispatchEditorCommand("edit:find-replace").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "b") {
        event.preventDefault();
        dispatchEditorCommand("format:bold").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "i") {
        event.preventDefault();
        dispatchEditorCommand("format:italic").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "u") {
        event.preventDefault();
        dispatchEditorCommand("format:underline").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "y") {
        event.preventDefault();
        dispatchEditorCommand("edit:redo").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (key === "s") {
        event.preventDefault();
        saveRhwpExport(event.shiftKey ? "hwpx" : "hwp").catch((err) => setStatus(`저장 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "o") {
        event.preventDefault();
        openLocalFileDialog();
      } else if (!event.shiftKey && key === "n") {
        event.preventDefault();
        createBlankInEditor().catch((err) => setStatus(err.message));
      } else if (key === "p") {
        // Browser print would render the React shell, not the HWP page. Forward
        // to the editor's real print path (file:print → SVG render + print
        // window), the same path the in-editor Cmd+P uses.
        event.preventDefault();
        dispatchEditorCommand("file:print").catch((err) => setStatus(`인쇄 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "x") {
        event.preventDefault();
        dispatchEditorCommand("edit:cut").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "c") {
        event.preventDefault();
        dispatchEditorCommand("edit:copy").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "v") {
        event.preventDefault();
        dispatchEditorCommand("edit:paste").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "h") {
        event.preventDefault();
        dispatchEditorCommand("edit:find-replace").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (!event.shiftKey && key === "g") {
        event.preventDefault();
        dispatchEditorCommand("edit:goto").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (event.shiftKey && key === "l") {
        event.preventDefault();
        dispatchEditorCommand("format:align-left").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (event.shiftKey && key === "e") {
        event.preventDefault();
        dispatchEditorCommand("format:align-center").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (event.shiftKey && key === "j") {
        event.preventDefault();
        dispatchEditorCommand("format:align-justify").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (event.shiftKey && key === "r") {
        event.preventDefault();
        dispatchEditorCommand("format:align-right").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (key === "r") {
        // Cmd/Ctrl+R (with or without Shift) would reload the renderer and
        // silently throw away the unsaved HWP document. Block it.
        event.preventDefault();
        if (isDirtyRef.current) setStatus("새로 고침 차단됨 — 먼저 저장하세요");
      } else if (!event.shiftKey && key === "enter") {
        event.preventDefault();
        dispatchEditorCommand("page:break").catch((err) => setStatus(`명령 오류: ${err.message}`));
      } else if (event.shiftKey && key === "n") {
        event.preventDefault();
        dispatchEditorCommand("format:toggle-numbering").catch((err) => setStatus(`명령 오류: ${err.message}`));
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [documentLoaded, editorReady, documentModel.title]);

  function openLocalFileDialog() {
    if (!editorReady) {
      setStatus("에디터 준비 중입니다");
      return;
    }
    fileInputRef.current?.click();
  }

  async function openDroppedFile(file) {
    if (!file) return;
    let validationError = "";
    try {
      validationError = await validateLocalDocumentFile(file);
    } catch {
      validationError = "파일 형식 오류: 문서 구조를 확인할 수 없습니다";
    }
    if (validationError) {
      setStatus(validationError);
      onError?.(validationError);
      return;
    }
    if (!confirmDiscardUnsavedChanges()) return;
    const editor = editorRef.current;
    if (!editor) {
      setStatus("에디터 준비 중입니다");
      return;
    }
    await loadValidatedFile(editor, file);
  }

  // Keep a ref to the latest opener so the file-association bridge (registered
  // once, with empty deps) always calls a closure with fresh state.
  openLocalDocumentRef.current = openDroppedFile;

  async function loadValidatedFile(editor, file) {
    try {
      setStatus("로컬 파일 여는 중");
      const buffer = await file.arrayBuffer();
      await withEditorReady(() => loadFileInEditor(editor, buffer, file.name, { skipUnsavedGuard: true }), {
        isCancelled: () => editorRef.current !== editor
      });
      const title = file.name.replace(/\.(hwp|hwpx)$/i, "");
      updateDocument({ ...documentModel, title, originalFileName: file.name });
      documentLoadedRef.current = true;
      setDocumentLoaded(true);
      setIsDirty(false);
      isDirtyRef.current = false;
      setStatus(`${file.name} 열림`);
      addToRecentFiles(file.name);
      setRecentFiles(getRecentFiles());
    } catch (err) {
      const message = friendlyOpenError(err);
      setStatus(`열기 오류: ${message}`);
      onError?.(message);
    }
  }

  async function openLocalFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    await openDroppedFile(file);
  }

  function shouldSkipAutomaticBlank(editor = editorRef.current) {
    return Boolean(documentLoadedRef.current || editorRef.current !== editor);
  }

  async function createBlankInEditor({ automatic = false } = {}) {
    if (!canEdit) throw new Error("view_only");
    if (!editorReady) throw new Error("에디터 준비 중입니다");
    if (!automatic && !confirmDiscardUnsavedChanges()) return false;
    const editor = editorRef.current;
    if (!editor?.loadFile) throw new Error("rhwp_new_document_api_unavailable");
    if (automatic && shouldSkipAutomaticBlank(editor)) return false;
    setStatus("새 문서 생성 중");
    await withEditorReady(() => loadBlankTemplate(editor), {
      isCancelled: () => editorRef.current !== editor || (automatic && shouldSkipAutomaticBlank(editor))
    });
    if (automatic && shouldSkipAutomaticBlank(editor)) return false;
    const nextDocument = newLocalDocument("새 문서");
    updateDocument(nextDocument);
    documentLoadedRef.current = true;
    setDocumentLoaded(true);
    setIsDirty(false);
    isDirtyRef.current = false;
    setStatus("새 문서");
    return true;
  }

  async function loadBlankTemplate(editor) {
    const response = await fetch(withAppBasePath(BLANK_TEMPLATE_URL), { cache: "no-store" });
    if (!response.ok) throw new Error(`blank_template_load_failed:${response.status}`);
    const buffer = await response.arrayBuffer();
    const result = await loadFileInEditor(editor, buffer, "새 문서.hwp", { skipUnsavedGuard: true });
    await requestFocus(editor);
    return result;
  }

  async function saveRhwpExport(format = "hwp") {
    if (!canEdit) throw new Error("view_only");
    if (!documentLoaded) throw new Error("문서를 먼저 열어주세요");
    if (exportInProgressRef.current) {
      setStatus("저장 진행 중…");
      return;
    }
    const editor = editorRef.current;
    if (!isEditorReady(editor)) throw new Error("rhwp_export_api_unavailable");
    exportInProgressRef.current = true;
    try {
      setStatus(`${format.toUpperCase()} 저장 준비`);
      const revisionBeforeExport = dirtyRevisionRef.current;
      const bytes = await exportDocument(editor, format);
      const fileName = `${documentModel.title || "document"}.${format}`;
      downloadBytes(bytes, fileName);
      // Only clear dirty if no new edits arrived during export — otherwise we'd
      // silently throw away the user's in-flight changes and skip the close
      // warning for them.
      if (dirtyRevisionRef.current === revisionBeforeExport) {
        setIsDirty(false);
        isDirtyRef.current = false;
        setStatus(`${format.toUpperCase()} 저장 완료`);
      } else {
        setStatus(`${format.toUpperCase()} 저장 후 추가 변경됨`);
      }
    } finally {
      exportInProgressRef.current = false;
    }
  }

  async function dispatchEditorCommand(commandId) {
    if (!canEdit) throw new Error("view_only");
    if (!documentLoadedRef.current) throw new Error("문서를 먼저 열어주세요");
    const editor = editorRef.current;
    if (!isEditorReady(editor)) throw new Error("rhwp_command_api_unavailable");
    const result = await withEditorReady(() => rpcDispatchCommand(editor, commandId), {
      isCancelled: () => editorRef.current !== editor
    });
    if (result?.ok) {
      if (!NON_DIRTY_EDITOR_COMMANDS.has(commandId)) {
        markDocumentDirty();
      }
      return true;
    }
    if (commandId === "edit:undo") {
      setStatus("되돌릴 작업이 없습니다");
    } else if (commandId === "edit:redo") {
      setStatus("다시 실행할 작업이 없습니다");
    } else if (commandId === "file:print") {
      // Match the in-iframe Cmd+P failure copy (bridge posts "print-blocked").
      setStatus("인쇄를 시작할 수 없습니다 — 잠시 후 다시 시도하세요");
    } else {
      setStatus("명령을 실행할 수 없습니다");
    }
    return false;
  }

  function onWorkspaceDragOver(event) {
    if (!editorReady) return;
    if (!event.dataTransfer?.types?.includes?.("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragOver) setIsDragOver(true);
  }

  function onWorkspaceDragLeave(event) {
    if (event.currentTarget === event.target) setIsDragOver(false);
  }

  function onWorkspaceDrop(event) {
    setIsDragOver(false);
    if (!editorReady) return;
    const files = event.dataTransfer?.files;
    const file = files?.[0];
    if (!file) return;
    event.preventDefault();
    if (files.length > 1) {
      setStatus(`여러 파일 중 첫 번째만 열었습니다: ${file.name}`);
    }
    openDroppedFile(file).catch((err) => setStatus(`열기 오류: ${err?.message || err}`));
  }

  return (
    <div
      className="focus-workspace"
      data-unsaved={isDirty ? "true" : "false"}
      data-drag-over={isDragOver ? "true" : "false"}
      aria-label={`${documentModel.title} 한글 편집기`}
      onDragOver={onWorkspaceDragOver}
      onDragLeave={onWorkspaceDragLeave}
      onDrop={onWorkspaceDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".hwp,.hwpx"
        data-testid="local-document-input"
        onChange={openLocalFile}
        hidden
      />
      {updateInfo && (updateInfo.type === "downloaded" || updateInfo.type === "progress" || updateInfo.type === "error" || updateInfo.type === "none") ? (
        <div className="update-banner" role="status">
          {updateInfo.type === "downloaded" ? (
            <>
              {`새 버전${updateInfo.version ? ` ${updateInfo.version}` : ""}이 준비되었습니다 — 앱을 다시 시작하면 자동으로 설치됩니다.`}
              {updateInfo.releaseName ? <span className="update-banner-note"> — {updateInfo.releaseName}</span> : null}
              {updateInfo.releaseNotes ? <span className="update-banner-note update-banner-notes">{updateInfo.releaseNotes}</span> : null}
            </>
          ) : updateInfo.type === "error" ? (
            `업데이트 확인 실패${updateInfo.feed ? ` (${updateInfo.feed})` : ""}`
          ) : updateInfo.type === "none" ? (
            `최신 버전입니다${updateInfo.version ? ` (${updateInfo.version})` : ""}`
          ) : (
            `업데이트 다운로드 중… ${typeof updateInfo.percent === "number" ? `${updateInfo.percent}%` : ""}`
          )}
          {updateInfo.type === "downloaded" ? (
            <button type="button" className="update-banner-install" onClick={() => { try { window.hwpCollabUpdater?.installNow?.(); } catch {} }}>지금 재시작하여 설치</button>
          ) : null}
          {updateInfo.type === "downloaded" || updateInfo.type === "error" || updateInfo.type === "none" ? (
            <button type="button" className="update-banner-dismiss" onClick={() => setUpdateInfo(null)} aria-label="알림 닫기" title="알림 닫기">×</button>
          ) : null}
        </div>
      ) : null}
      <DocsShell
        document={documentModel}
        status={status}
        isDirty={isDirty}
        canEdit={canEdit}
        editorReady={editorReady}
        documentLoaded={documentLoaded}
        onOpenLocal={openLocalFileDialog}
        onSaveHwp={() => saveRhwpExport("hwp").catch((err) => setStatus(`저장 오류: ${err.message}`))}
        onSaveHwpx={() => saveRhwpExport("hwpx").catch((err) => setStatus(`저장 오류: ${err.message}`))}
        onCreateBlank={() => createBlankInEditor().catch((err) => setStatus(err.message))}
        recentFiles={recentFiles}
        onClearRecent={() => { clearRecentFiles(); setRecentFiles([]); }}
        onMessage={(msg) => setStatus(msg)}
      />
      <Toolbar
        onCommand={dispatchEditorCommand}
        editorReady={editorReady}
        documentLoaded={documentLoaded}
      />
      <div className="focus-editor-stage">
        <div ref={editorRoot} className="rhwp-root" />
        {isDragOver ? (
          <div className="focus-drop-hint" aria-hidden="true">
            <span>HWP/HWPX 파일을 놓아 열기</span>
          </div>
        ) : null}
      </div>
      <StatusBar documentTitle={documentModel.title} isDirty={isDirty} documentLoaded={documentLoaded} editorReady={editorReady} />
    </div>
  );
}

function RecentFilesMenu({ recentFiles, onClearRecent, onMessage }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const items = Array.isArray(recentFiles) ? recentFiles : [];

  useEffect(() => {
    if (!open) return undefined;
    function onDocumentClick(event) {
      if (!menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [open]);

  function showUnavailableMessage() {
    onMessage?.("최근 파일을 직접 열 수 없습니다 — 파일 탐색기에서 해당 파일을 다시 여세요");
    setOpen(false);
  }

  function clearList() {
    onClearRecent?.();
    setOpen(false);
  }

  return (
    <div className="recent-files-menu" ref={menuRef} style={{ position: "relative" }}>
      <button type="button" className="docs-action" onClick={() => setOpen((value) => !value)}>
        최근 파일
      </button>
      {open ? (
        <div
          className="recent-files-dropdown"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 20,
            minWidth: "180px"
          }}
        >
          {items.length === 0 ? (
            <div className="recent-files-item is-empty">{"<없음>"}</div>
          ) : (
            <>
              {items.map((item) => (
                <button key={`${item.name}-${item.timestamp}`} type="button" className="recent-files-item" onClick={showUnavailableMessage}>
                  {item.name}
                </button>
              ))}
              <button type="button" className="recent-files-item recent-files-clear" onClick={clearList}>
                목록 지우기
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DocsShell({
  document,
  status,
  canEdit,
  editorReady,
  documentLoaded,
  onOpenLocal,
  onSaveHwp,
  onSaveHwpx,
  onCreateBlank,
  recentFiles,
  onClearRecent,
  onMessage
}) {
  return (
    <header className="docs-shell" aria-label="HWP Collab 메뉴">
      <div className="docs-title-row">
        <div className="docs-brand">
          <div>
            <strong>HWP Collab</strong>
            <span>{document.title}</span>
          </div>
        </div>
        <div className="docs-title-actions">
          {shouldShowStatus(status) ? (
            <span className={statusIsError(status) ? "status-chip is-alert" : "status-chip is-compact"} title={status} aria-label={status}>
              {statusLabel(status)}
            </span>
          ) : null}
          <RecentFilesMenu recentFiles={recentFiles} onClearRecent={onClearRecent} onMessage={onMessage} />
          <button type="button" className="docs-action" onClick={onOpenLocal} disabled={!canEdit || !editorReady} title="로컬 .hwp/.hwpx 파일 열기 (Ctrl+O)">
            열기
          </button>
          <button type="button" className="docs-action" onClick={onSaveHwp} disabled={!canEdit || !documentLoaded} title={documentLoaded ? "현재 문서를 HWP로 저장 (Ctrl+S)" : "문서를 먼저 열어주세요"}>
            HWP
          </button>
          <button type="button" className="docs-action" onClick={onSaveHwpx} disabled={!canEdit || !documentLoaded} title={documentLoaded ? "현재 문서를 HWPX로 저장 (Ctrl+Shift+S)" : "문서를 먼저 열어주세요"}>
            HWPX
          </button>
          <button
            type="button"
            className="docs-action"
            onClick={onCreateBlank}
            disabled={!canEdit || !editorReady}
            title="빈 새파일 만들기 (Ctrl+N)"
          >
            새파일
          </button>
          <ShortcutHelp />
        </div>
      </div>
    </header>
  );
}

function Toolbar({ onCommand, editorReady, documentLoaded }) {
  const disabled = !editorReady;
  const fmtDisabled = !editorReady || !documentLoaded;

  function cmd(commandId) {
    return () => {
      onCommand(commandId).catch(() => {});
    };
  }

  return (
    <div className="rhwp-toolbar" role="toolbar" aria-label="서식 도구 모음">
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("edit:undo")}
          disabled={disabled}
          title="실행취소 (Ctrl+Z)"
          aria-label="실행취소"
        >
          실행취소
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("edit:redo")}
          disabled={disabled}
          title="다시실행 (Ctrl+Y)"
          aria-label="다시실행"
        >
          다시실행
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:bold")}
          disabled={fmtDisabled}
          title="굵게 (Ctrl+B)"
          aria-label="굵게"
        >
          굵게
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:italic")}
          disabled={fmtDisabled}
          title="기울임 (Ctrl+I)"
          aria-label="기울임"
        >
          기울임
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:underline")}
          disabled={fmtDisabled}
          title="밑줄 (Ctrl+U)"
          aria-label="밑줄"
        >
          밑줄
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:strikethrough")}
          disabled={fmtDisabled}
          title="취소선"
          aria-label="취소선"
        >
          취소선
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:font-size-increase")}
          disabled={fmtDisabled}
          title="크게 (Alt+Shift+E)"
          aria-label="크게"
        >
          크게
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:font-size-decrease")}
          disabled={fmtDisabled}
          title="작게 (Alt+Shift+R)"
          aria-label="작게"
        >
          작게
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("edit:cut")}
          disabled={fmtDisabled}
          title="잘라내기 (Ctrl+X)"
          aria-label="잘라내기"
        >
          잘라내기
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("edit:copy")}
          disabled={fmtDisabled}
          title="복사 (Ctrl+C)"
          aria-label="복사"
        >
          복사
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("edit:paste")}
          disabled={fmtDisabled}
          title="붙여넣기 (Ctrl+V)"
          aria-label="붙여넣기"
        >
          붙여넣기
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:align-left")}
          disabled={fmtDisabled}
          title="왼쪽 맞춤 (Ctrl+Shift+L)"
          aria-label="왼쪽 맞춤"
        >
          왼쪽
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:align-center")}
          disabled={fmtDisabled}
          title="가운데 맞춤 (Ctrl+Shift+E)"
          aria-label="가운데 맞춤"
        >
          가운데
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:align-right")}
          disabled={fmtDisabled}
          title="오른쪽 맞춤 (Ctrl+Shift+R)"
          aria-label="오른쪽 맞춤"
        >
          오른쪽
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:align-justify")}
          disabled={fmtDisabled}
          title="양쪽 맞춤 (Ctrl+Shift+J)"
          aria-label="양쪽 맞춤"
        >
          양쪽
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:zoom-out")}
          disabled={disabled}
          title="축소"
          aria-label="축소"
        >
          축소
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:zoom-100")}
          disabled={disabled}
          title="100%"
          aria-label="100%"
        >
          100%
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:zoom-in")}
          disabled={disabled}
          title="확대"
          aria-label="확대"
        >
          확대
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:zoom-fit-width")}
          disabled={disabled}
          title="너비맞춤"
          aria-label="너비맞춤"
        >
          너비맞춤
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("edit:find")}
          disabled={disabled}
          title="찾기 (Ctrl+F)"
          aria-label="찾기"
        >
          찾기
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("file:print")}
          disabled={disabled}
          title="인쇄 (Ctrl+P)"
          aria-label="인쇄"
        >
          인쇄
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("table:create")}
          disabled={fmtDisabled}
          title="표 삽입"
          aria-label="표 삽입"
        >
          표
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("insert:image")}
          disabled={fmtDisabled}
          title="그림 삽입"
          aria-label="그림 삽입"
        >
          이미지
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("insert:footnote")}
          disabled={fmtDisabled}
          title="각주 삽입"
          aria-label="각주 삽입"
        >
          각주
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("insert:symbols")}
          disabled={fmtDisabled}
          title="특수문자 삽입"
          aria-label="특수문자 삽입"
        >
          기호
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:superscript")}
          disabled={fmtDisabled}
          title="위첨자 (Alt+Shift+P)"
          aria-label="위첨자"
        >
          위첨자
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:subscript")}
          disabled={fmtDisabled}
          title="아래첨자 (Alt+Shift+G)"
          aria-label="아래첨자"
        >
          아래첨자
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:line-spacing-increase")}
          disabled={fmtDisabled}
          title="줄간격 늘리기"
          aria-label="줄간격 늘리기"
        >
          줄간격↑
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:line-spacing-decrease")}
          disabled={fmtDisabled}
          title="줄간격 줄이기"
          aria-label="줄간격 줄이기"
        >
          줄간격↓
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:char-shape")}
          disabled={fmtDisabled}
          title="글자 모양 (Alt+L)"
          aria-label="글자 모양"
        >
          글자모양
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:para-shape")}
          disabled={fmtDisabled}
          title="문단 모양 (Alt+T)"
          aria-label="문단 모양"
        >
          문단모양
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("file:page-setup")}
          disabled={!editorReady}
          title="쪽 설정"
          aria-label="쪽 설정"
        >
          쪽설정
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:header-create")}
          disabled={fmtDisabled}
          title="머리말 만들기"
          aria-label="머리말 만들기"
        >
          머리말
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:footer-create")}
          disabled={fmtDisabled}
          title="꼬리말 만들기"
          aria-label="꼬리말 만들기"
        >
          꼬리말
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:break")}
          disabled={fmtDisabled}
          title="쪽 나누기 (Ctrl+Enter)"
          aria-label="쪽 나누기"
        >
          쪽나누기
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:para-mark")}
          disabled={disabled}
          title="문단 부호 표시/숨김"
          aria-label="문단부호"
        >
          문단부호
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:ctrl-mark")}
          disabled={disabled}
          title="조판 부호 표시/숨김"
          aria-label="조판부호"
        >
          조판부호
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:toolbox-basic")}
          disabled={disabled}
          title="기본 도구 상자"
          aria-label="기본도구"
        >
          기본도구
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("view:toolbox-format")}
          disabled={disabled}
          title="서식 도구 상자"
          aria-label="서식도구"
        >
          서식도구
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:toggle-numbering")}
          disabled={fmtDisabled}
          title="번호 매기기 (Ctrl+Shift+N)"
          aria-label="번호목록"
        >
          번호목록
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:toggle-bullet")}
          disabled={fmtDisabled}
          title="글머리표"
          aria-label="글머리표"
        >
          글머리표
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:level-increase")}
          disabled={fmtDisabled}
          title="수준 증가"
          aria-label="수준↑"
        >
          수준↑
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:level-decrease")}
          disabled={fmtDisabled}
          title="수준 감소"
          aria-label="수준↓"
        >
          수준↓
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:col-1")}
          disabled={fmtDisabled}
          title="1단"
          aria-label="1단"
        >
          1단
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:col-2")}
          disabled={fmtDisabled}
          title="2단"
          aria-label="2단"
        >
          2단
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:col-3")}
          disabled={fmtDisabled}
          title="3단"
          aria-label="3단"
        >
          3단
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:insert-field-pagenum")}
          disabled={fmtDisabled}
          title="쪽 번호 삽입"
          aria-label="쪽번호"
        >
          쪽번호
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:insert-field-totalpage")}
          disabled={fmtDisabled}
          title="전체 쪽수 삽입"
          aria-label="전체쪽수"
        >
          전체쪽수
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("page:insert-field-filename")}
          disabled={fmtDisabled}
          title="파일명 삽입"
          aria-label="파일명"
        >
          파일명
        </button>
      </div>
      <div className="rhwp-toolbar-sep" aria-hidden="true" />
      <div className="rhwp-toolbar-group">
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("insert:equation")}
          disabled={fmtDisabled}
          title="수식 삽입"
          aria-label="수식"
        >
          수식
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("insert:textbox")}
          disabled={fmtDisabled}
          title="텍스트 상자"
          aria-label="텍스트상자"
        >
          텍스트상자
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("insert:shape")}
          disabled={fmtDisabled}
          title="도형 삽입"
          aria-label="도형"
        >
          도형
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("insert:bookmark")}
          disabled={fmtDisabled}
          title="책갈피"
          aria-label="책갈피"
        >
          책갈피
        </button>
        <button
          type="button"
          className="rhwp-toolbar-btn"
          onClick={cmd("format:style-dialog")}
          disabled={!editorReady}
          title="스타일 (F6)"
          aria-label="스타일"
        >
          스타일
        </button>
      </div>
    </div>
  );
}

function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  
  const shortcuts = [
    { group: "파일", items: [
      { key: "Ctrl+N", label: "새 문서" },
      { key: "Ctrl+O", label: "파일 열기" },
      { key: "Ctrl+S", label: "HWP로 저장" },
      { key: "Ctrl+Shift+S", label: "HWPX로 저장" },
      { key: "Ctrl+P", label: "인쇄" },
    ]},
    { group: "편집", items: [
      { key: "Ctrl+Z", label: "실행취소" },
      { key: "Ctrl+Y / Ctrl+Shift+Z", label: "다시실행" },
      { key: "Ctrl+A", label: "모두 선택" },
      { key: "Ctrl+X", label: "잘라내기" },
      { key: "Ctrl+C", label: "복사" },
      { key: "Ctrl+V", label: "붙여넣기" },
      { key: "Ctrl+F", label: "찾기" },
      { key: "Ctrl+H", label: "찾기/바꾸기" },
      { key: "Ctrl+L", label: "다음 찾기" },
      { key: "Ctrl+G", label: "이동" },
    ]},
    { group: "서식", items: [
      { key: "Ctrl+B", label: "굵게" },
      { key: "Ctrl+I", label: "기울임" },
      { key: "Ctrl+U", label: "밑줄" },
      { key: "Alt+Shift+E", label: "글자 크게" },
      { key: "Alt+Shift+R", label: "글자 작게" },
      { key: "Ctrl+Shift+L", label: "왼쪽 맞춤" },
      { key: "Ctrl+Shift+E", label: "가운데 맞춤" },
      { key: "Ctrl+Shift+R", label: "오른쪽 맞춤" },
      { key: "Ctrl+Shift+J", label: "양쪽 맞춤" },
      { key: "Alt+L", label: "글자 모양" },
      { key: "Alt+T", label: "문단 모양" },
      { key: "Alt+Shift+P", label: "위첨자" },
      { key: "Alt+Shift+G", label: "아래첨자" },
      { key: "F6", label: "스타일" },
    ]},
    { group: "쪽", items: [
      { key: "Ctrl+Enter", label: "쪽 나누기" },
    ]},
    { group: "보기", items: [
      { key: "F7", label: "맞춤법 검사" },
    ]},
  ];
  
  return (
    <>
      <button type="button" className="docs-action" onClick={() => setOpen(true)} title="키보드 단축키 도움말">?</button>
      {open ? (
        <div className="shortcut-overlay" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }} role="dialog" aria-modal="true" aria-label="단축키 도움말">
          <div className="shortcut-modal">
            <div className="shortcut-modal-header">
              <strong>키보드 단축키</strong>
              <button type="button" className="shortcut-modal-close" onClick={() => setOpen(false)} aria-label="닫기">×</button>
            </div>
            <div className="shortcut-modal-body">
              {shortcuts.map((group) => (
                <div key={group.group} className="shortcut-group">
                  <div className="shortcut-group-title">{group.group}</div>
                  {group.items.map((item) => (
                    <div key={item.key} className="shortcut-row">
                      <kbd className="shortcut-key">{item.key}</kbd>
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function shouldShowStatus(status) {
  return Boolean(status && !["새 문서", "파일을 열어 편집을 시작하세요"].includes(status));
}

function statusIsError(status) {
  return /오류|실패|error|unavailable|timeout|cancelled/i.test(status || "");
}

function statusLabel(status) {
  if (!status) return "";
  if (status.includes("초기화")) return "준비";
  if (status.includes("로딩")) return "준비";
  if (status.includes("열림")) return "열림";
  if (status.includes("저장 완료")) return "저장됨";
  if (status.includes("저장 후 추가 변경")) return "변경됨";
  if (status.includes("저장 준비")) return "저장";
  if (status.includes("생성 중")) return "새파일";
  if (status.includes("변경사항")) return "변경됨";
  if (statusIsError(status)) return "확인 필요";
  return status.length > 8 ? `${status.slice(0, 8)}...` : status;
}

async function validateLocalDocumentFile(file) {
  const ext = fileExtension(file?.name);
  if (![".hwp", ".hwpx"].includes(ext)) {
    return "HWP/HWPX 파일만 열 수 있습니다";
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "파일 형식 오류: 빈 파일은 열 수 없습니다";
  }
  if (file.size > MAX_LOCAL_DOCUMENT_BYTES) {
    return `파일 크기 초과: 최대 ${Math.floor(MAX_LOCAL_DOCUMENT_BYTES / 1024 / 1024)}MB까지 열 수 있습니다`;
  }
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const valid = ext === ".hwpx" ? hasAnyHeader(header, HWPX_HEADERS) : hasHeader(header, HWP_HEADER);
  if (!valid) return "파일 형식 오류: HWP/HWPX 파일만 열 수 있습니다";
  if (ext === ".hwp") {
    return validateHwpCompoundHeader(file);
  }
  if (ext === ".hwpx") {
    return validateHwpxPackageStructure(file);
  }
  return "";
}

function fileExtension(fileName) {
  const match = String(fileName || "").toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : "";
}

function hasHeader(bytes, header) {
  return bytes.length >= header.length && header.every((value, index) => bytes[index] === value);
}

function hasAnyHeader(bytes, headers) {
  return headers.some((header) => hasHeader(bytes, header));
}

async function validateHwpCompoundHeader(file) {
  if (file.size < MIN_HWP_CFB_BYTES) {
    return "파일 형식 오류: 올바른 HWP 문서 구조가 아닙니다";
  }
  const header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (!hasHeader(header, HWP_HEADER)) {
    return "파일 형식 오류: HWP/HWPX 파일만 열 수 있습니다";
  }
  const majorVersion = readLe16(header, 26);
  const byteOrder = readLe16(header, 28);
  const sectorShift = readLe16(header, 30);
  const miniSectorShift = readLe16(header, 32);
  const miniStreamCutoff = readLe32(header, 56);
  const expectedSectorShift = majorVersion === 4 ? 12 : 9;
  const valid =
    (majorVersion === 3 || majorVersion === 4) &&
    byteOrder === 0xfffe &&
    sectorShift === expectedSectorShift &&
    miniSectorShift === 6 &&
    miniStreamCutoff === 4096;
  if (!valid) return "파일 형식 오류: 올바른 HWP 문서 구조가 아닙니다";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hasDirectoryNames = ["FileHeader", "DocInfo", "BodyText", "Section0"].every((name) =>
    containsUtf16LeAscii(bytes, name)
  );
  if (!hasDirectoryNames) return "파일 형식 오류: 올바른 HWP 문서 구조가 아닙니다";
  try {
    const compound = CFB.read(bytes, { type: "array" });
    const hasRequiredStreams = HWP_REQUIRED_STREAMS.every((name) => CFB.find(compound, name));
    return hasRequiredStreams ? "" : "파일 형식 오류: 올바른 HWP 문서 구조가 아닙니다";
  } catch {
    return "파일 형식 오류: 올바른 HWP 문서 구조가 아닙니다";
  }
}

function containsUtf16LeAscii(bytes, text) {
  const pattern = [];
  for (const char of String(text || "")) {
    pattern.push(char.charCodeAt(0), 0);
  }
  if (!pattern.length || bytes.length < pattern.length) return false;
  outer:
  for (let index = 0; index <= bytes.length - pattern.length; index += 2) {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (bytes[index + offset] !== pattern[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function readLe16(bytes, offset) {
  return (bytes[offset] || 0) | ((bytes[offset + 1] || 0) << 8);
}

function readLe32(bytes, offset) {
  return (
    (bytes[offset] || 0) |
    ((bytes[offset + 1] || 0) << 8) |
    ((bytes[offset + 2] || 0) << 16) |
    ((bytes[offset + 3] || 0) << 24)
  ) >>> 0;
}

async function validateHwpxPackageStructure(file) {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files || {});
    if (entries.length === 0 || entries.length > MAX_HWPX_ENTRIES) {
      return "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
    }
    let hasTextXml = false;
    let totalUncompressedBytes = 0;
    const entryNames = new Set();
    for (const entry of entries) {
      if (!entry || entry.dir) continue;
      const name = String(entry.name || "").replace(/\\/g, "/");
      if (name.startsWith("/") || name.includes("../") || name.includes("/../")) {
        return "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
      }
      entryNames.add(name.toLowerCase());
      const size = entry._data?.uncompressedSize;
      if (!Number.isFinite(size) || size < 0) {
        return "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
      }
      totalUncompressedBytes += size;
      if (totalUncompressedBytes > MAX_HWPX_TOTAL_UNCOMPRESSED_BYTES) {
        return "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
      }
      if (/\.xml$/i.test(name) && size > MAX_HWPX_XML_BYTES) {
        return "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
      }
      if (HWPX_TEXT_XML_PATTERN.test(name)) {
        hasTextXml = true;
      }
    }
    const hasRequiredPackageMarkers = HWPX_REQUIRED_ENTRIES.every((name) => entryNames.has(name.toLowerCase()));
    if (!hasRequiredPackageMarkers) {
      return "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
    }
    return hasTextXml ? "" : "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
  } catch {
    return "파일 형식 오류: 올바른 HWPX 문서 구조가 아닙니다";
  }
}

async function clearStaleRhwpStudioRuntimeCache(studioUrl) {
  const resetKey = `hwp-collab-runtime-cache-reset:${studioUrl}`;
  let changed = false;

  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all(
      (registrations || []).map(async (registration) => {
        changed = (await registration.unregister()) || changed;
      })
    );
  } catch {}

  try {
    if (!window.caches?.keys) return { reloading: false };
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames.map(async (cacheName) => {
        try {
          changed = (await caches.delete(cacheName)) || changed;
        } catch {}
      })
    );
  } catch {}

  try {
    if (changed && navigator.serviceWorker?.controller && sessionStorage.getItem(resetKey) !== "done") {
      sessionStorage.setItem(resetKey, "done");
      window.location.reload();
      return { reloading: true };
    }
  } catch {}

  return { reloading: false };
}

async function withEditorReady(action, { isCancelled = () => false } = {}) {
  const deadline = Date.now() + EDITOR_READY_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error(EDITOR_CANCELLED);
    try {
      return await action();
    } catch (err) {
      lastError = err;
      if (!EDITOR_RACE_PATTERN.test(String(err?.message || err))) {
        throw err;
      }
      await delay(180);
    }
  }
  throw lastError || new Error("editor_ready_timeout");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEditorError(err) {
  const message = err?.message || String(err);
  if (EDITOR_RACE_PATTERN.test(message)) {
    return "에디터 초기화 오류";
  }
  return message;
}

function downloadBytes(bytes, fileName) {
  if (!bytes?.length) {
    throw new Error("export_empty");
  }
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const blob = new Blob([payload], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = fileName;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function addToRecentFiles(fileName) {
  try {
    const recentFiles = getRecentFiles();
    const newest = [{ name: fileName, timestamp: Date.now() }, ...recentFiles];
    const byName = new Map();
    for (const item of newest) {
      if (!item || typeof item.name !== "string" || !item.name) continue;
      const timestamp = Number(item.timestamp) || 0;
      const current = byName.get(item.name);
      if (!current || timestamp > current.timestamp) {
        byName.set(item.name, { name: item.name, timestamp });
      }
    }
    const nextRecentFiles = Array.from(byName.values())
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 8);
    localStorage.setItem("rhwp-recent-files", JSON.stringify(nextRecentFiles));
  } catch {}
}

function getRecentFiles() {
  try {
    const raw = localStorage.getItem("rhwp-recent-files");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clearRecentFiles() {
  try {
    localStorage.removeItem("rhwp-recent-files");
  } catch {}
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}
