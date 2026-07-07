// rhwp-editor-adapter — the SINGLE seam for the @rhwp/editor private postMessage
// RPC (editor._request). Concentrating every _request call here means an upstream
// @rhwp/editor API change is a one-file patch (S5 of
// reports/rhwp-upstream-realignment-plan.md). App.jsx must not call
// editor._request directly — it goes through these functions.

// True when the editor exposes the private RPC channel.
export function isEditorReady(editor) {
  return !!(editor && typeof editor._request === "function");
}

// Low-level: the ONLY place editor._request is named/called.
export async function editorRequest(editor, method, payload) {
  if (!isEditorReady(editor)) throw new Error("rhwp_editor_api_unavailable");
  return payload === undefined ? editor._request(method) : editor._request(method, payload);
}

// Load a file. skipUnsavedGuard bypasses ONLY the studio's duplicate unsaved
// guard after the app-level discard confirmation; otherwise use the public
// editor.loadFile. (The contract pins this function's shape.)
export async function loadFileInEditor(editor, buffer, fileName, { skipUnsavedGuard = false } = {}) {
  if (skipUnsavedGuard && editor?._request) {
    return editor._request("loadFile", {
      data: Array.from(new Uint8Array(buffer)),
      fileName,
      skipUnsavedGuard: true
    });
  }
  return editor.loadFile(buffer, fileName);
}

// Focus the editor (best-effort; never throws).
export function requestFocus(editor) {
  if (!isEditorReady(editor)) return Promise.resolve(null);
  return editor._request("focusEditor").catch(() => null);
}

// Export the document bytes in the given format ("hwp" | "hwpx").
export function exportDocument(editor, format) {
  return editorRequest(editor, format === "hwpx" ? "exportHwpx" : "exportHwp");
}

// Dispatch a studio command by id (returns the studio's {ok,...} result).
export function dispatchCommand(editor, commandId) {
  return editorRequest(editor, "dispatchCommand", { commandId });
}
