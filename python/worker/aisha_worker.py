#!/usr/bin/env python3
"""
AISHA AI-EXECUTIVE capability sidecar (optional, real).

Purpose
-------
Expose Windows automation capabilities that are genuinely better served by the
mature Python libraries than by anything native Node can do:

  * pywinauto      -> real UI Automation tree discovery + semantic control actions
  * pyautogui      -> coordinate input, only used when semantics are unavailable
  * pynput         -> global hotkeys / synthetic key presses
  * mss / Pillow   -> screen capture
  * pytesseract    -> OCR of captured images
  * sounddevice    -> microphone enumeration and capture diagnostics

Contract
--------
Reads newline-delimited JSON requests on stdin, writes newline-delimited JSON
responses on stdout, one line per response:

    -> {"id":"<uuid>","action":"health","params":{},"timeoutMs":5000}
    <- {"id":"<uuid>","ok":true,"result":{...},"ms":12}

Rules that this worker obeys (no-mock policy):
  * If a required package is missing, the response is ok=false with an explicit
    `unavailable` reason and the exact install command. Nothing is simulated.
  * If an action is performed, the response contains real, verifiable evidence
    (captured file path + byte size, element names read back, cursor position,
    OCR text) so the caller can verify rather than assume.
  * Any exception is returned as ok=false with the exception text; the worker
    never exits on a bad request, and never silently swallows an error.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import time
import traceback
from typing import Any, Callable, Dict, List

WORKER_VERSION = "1.0.0"

# ----------------------------------------------------------------------------
# Optional dependency discovery (capability reporting only; nothing is faked)
# ----------------------------------------------------------------------------

def _try_import(module_name: str):
    try:
        return __import__(module_name)
    except Exception:
        return None


MODULES = {
    "pywinauto": _try_import("pywinauto"),
    "pyautogui": _try_import("pyautogui"),
    "pynput": _try_import("pynput"),
    "PIL": _try_import("PIL"),
    "mss": _try_import("mss"),
    "pytesseract": _try_import("pytesseract"),
    "cv2": _try_import("cv2"),
    "numpy": _try_import("numpy"),
    "sounddevice": _try_import("sounddevice"),
    "faster_whisper": _try_import("faster_whisper"),
}


def is_windows() -> bool:
    return sys.platform.startswith("win")


def capabilities() -> List[str]:
    found = ["stdlib"]
    for name, module in MODULES.items():
        if module is not None:
            found.append(name)
    if is_windows():
        found.append("windows-host")
    return found


def unavailable(reason: str, install: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "unavailable": True,
        "reason": reason,
        "install": install,
        "platform": platform.platform(),
    }


# ----------------------------------------------------------------------------
# Actions
# ----------------------------------------------------------------------------

def action_health(params: Dict[str, Any]) -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
        "worker": WORKER_VERSION,
        "capabilities": capabilities(),
        "pid": os.getpid(),
    }
    if MODULES["sounddevice"] is not None:
        try:
            import sounddevice as sd  # type: ignore

            info["audio_inputs"] = [
                {"name": device["name"], "channels": device["max_input_channels"]}
                for device in sd.query_devices()
                if device.get("max_input_channels", 0) > 0
            ]
        except Exception as exc:  # pragma: no cover - device dependent
            info["audio_inputs_error"] = str(exc)
    return info


def require(module_key: str, purpose: str, install: str) -> Any:
    module = MODULES.get(module_key)
    if module is None:
        raise RuntimeError(f"PYTHON_DEPENDENCY_MISSING::{module_key}::{purpose}::{install}")
    return module


def _win_required(action: str) -> Dict[str, Any]:
    return unavailable(
        f'Action "{action}" controls the Windows desktop and cannot run on {platform.system()}.',
        "Run AISHA on Windows 10/11 x64.",
    )


def action_uia_list_windows(params: Dict[str, Any]) -> Dict[str, Any]:
    if not is_windows():
        return _win_required("uia_list_windows")
    try:
        desktop = require("pywinauto", "UI Automation window discovery", "pip install pywinauto")
        from pywinauto import Desktop  # type: ignore

        del desktop  # imported for the capability check above
        windows = []
        for window in Desktop(backend="uia").windows():
            try:
                rect = window.rectangle()
                windows.append(
                    {
                        "title": window.window_text(),
                        "class_name": window.class_name(),
                        "automation_id": getattr(window.element_info, "automation_id", None),
                        "control_type": getattr(window.element_info, "control_type", None),
                        "process_id": getattr(window.element_info, "process_id", None),
                        "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
                        "visible": bool(window.is_visible()),
                        "enabled": bool(window.is_enabled()),
                    }
                )
            except Exception as exc:
                windows.append({"error": str(exc)})
        return {"engine": "pywinauto-uia", "count": len(windows), "windows": windows}
    except RuntimeError as exc:
        parts = str(exc).split("::")
        return unavailable(parts[2] if len(parts) > 2 else str(exc), parts[3] if len(parts) > 3 else "")


def action_uia_tree(params: Dict[str, Any]) -> Dict[str, Any]:
    if not is_windows():
        return _win_required("uia_tree")
    require("pywinauto", "UI Automation tree walk", "pip install pywinauto")
    try:
        from pywinauto import Desktop  # type: ignore

        title = str(params.get("window", ""))
        depth = int(params.get("depth", 3))
        target = Desktop(backend="uia").window(title_re=f".*{title}.*") if title else Desktop(backend="uia").active_window()
        elements: List[Dict[str, Any]] = []

        def walk(control, level: int) -> None:
            if level > depth or len(elements) > 400:
                return
            try:
                rect = control.rectangle()
                elements.append(
                    {
                        "level": level,
                        "control_type": control.element_info.control_type,
                        "name": control.window_text()[:120],
                        "automation_id": getattr(control.element_info, "automation_id", None),
                        "enabled": bool(control.is_enabled()),
                        "focused": bool(control.has_focus()),
                        "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
                    }
                )
                for child in control.children():
                    walk(child, level + 1)
            except Exception as exc:
                elements.append({"level": level, "error": str(exc)})

        walk(target, 0)
        return {"engine": "pywinauto-uia", "window": title or "active", "element_count": len(elements), "elements": elements}
    except Exception as exc:
        return {"ok": False, "reason": f"UI Automation tree walk failed: {exc}"}


def action_uia_invoke(params: Dict[str, Any]) -> Dict[str, Any]:
    """Semantic interaction: invoke a control by name/automation id (NOT coordinates)."""
    if not is_windows():
        return _win_required("uia_invoke")
    require("pywinauto", "semantic UI Automation invocation", "pip install pywinauto")
    try:
        from pywinauto import Desktop  # type: ignore

        window_title = str(params.get("window", ""))
        control_name = str(params.get("control", ""))
        control_id = str(params.get("automationId", ""))
        action = str(params.get("action", "invoke"))
        text_value = params.get("value")

        target_window = Desktop(backend="uia").window(title_re=f".*{window_title}.*") if window_title else Desktop(backend="uia").active_window()
        target_window.set_focus()
        if control_id:
            control = target_window.child_window(auto_id=control_id, found_index=0)
        else:
            control = target_window.child_window(title_re=f".*{control_name}.*", found_index=0)
        evidence: Dict[str, Any] = {"engine": "pywinauto-uia", "window": target_window.window_text(), "control": control_name or control_id}
        if action == "set_text":
            control.set_edit_text(str(text_value if text_value is not None else ""))
            evidence["value_set"] = control.window_text()
            evidence["action"] = "set_text"
        elif action == "select":
            control.select()
            evidence["action"] = "select"
        else:
            control.invoke()
            evidence["action"] = "invoke"
        evidence["resolved_name"] = control.window_text()[:160]
        evidence["control_type"] = control.element_info.control_type
        return evidence
    except Exception as exc:
        return {"ok": False, "reason": f"Semantic invocation failed: {exc}"}


def action_screenshot(params: Dict[str, Any]) -> Dict[str, Any]:
    out_path = str(params.get("path", ""))
    if not out_path:
        raise RuntimeError("screenshot requires an explicit output path")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    engine_used = None
    if MODULES["mss"] is not None:
        import mss  # type: ignore
        from PIL import Image  # type: ignore

        with mss.mss() as capture:
            monitor = capture.monitors[0]
            raw = capture.grab(monitor)
            image = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            image.save(out_path)
        engine_used = "mss"
    elif is_windows() and MODULES["PIL"] is not None:
        from PIL import ImageGrab  # type: ignore

        ImageGrab.grab().save(out_path)
        engine_used = "pillow-ImageGrab"
    if engine_used is None:
        return unavailable(
            "No capture engine available (needs mss or Pillow, and a desktop session on Windows).",
            "pip install mss pillow",
        )
    size = os.path.getsize(out_path)
    if size < 1024:
        return {"ok": False, "reason": f"Capture produced only {size} bytes; treat as failed."}
    return {"engine": engine_used, "path": out_path, "bytes": size}


def action_ocr(params: Dict[str, Any]) -> Dict[str, Any]:
    path = str(params.get("path", ""))
    if not path or not os.path.exists(path):
        return {"ok": False, "reason": f"No image at {path or '<none>'} to read. Capture a screenshot first."}
    if MODULES["pytesseract"] is None:
        return unavailable("pytesseract is not installed, so image text cannot be read.", "pip install pytesseract (plus a Tesseract install)")
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore

        text = pytesseract.image_to_string(Image.open(path))
        return {"engine": "pytesseract", "path": path, "text": text.strip()[:8000], "chars": len(text.strip())}
    except Exception as exc:
        return {"ok": False, "reason": f"OCR failed: {exc}"}


def action_mouse(params: Dict[str, Any]) -> Dict[str, Any]:
    if not is_windows():
        return _win_required("mouse")
    module = MODULES["pyautogui"]
    if module is None:
        return unavailable("pyautogui is not installed, so pointer control is unavailable.", "pip install pyautogui")
    import pyautogui  # type: ignore

    operation = str(params.get("operation", "click"))
    x = params.get("x")
    y = params.get("y")
    before = pyautogui.position()
    if operation == "move" and x is not None and y is not None:
        pyautogui.moveTo(int(x), int(y), duration=0.15)
    elif operation == "click" and x is not None and y is not None:
        pyautogui.click(int(x), int(y))
    elif operation == "double_click" and x is not None and y is not None:
        pyautogui.doubleClick(int(x), int(y))
    elif operation == "right_click" and x is not None and y is not None:
        pyautogui.rightClick(int(x), int(y))
    elif operation == "scroll":
        pyautogui.scroll(int(params.get("clicks", -3)))
    elif operation == "drag":
        pyautogui.moveTo(int(x), int(y))
        pyautogui.dragTo(int(params.get("toX", x)), int(params.get("toY", y)), duration=0.3)
    elif operation == "position":
        pass
    else:
        return {"ok": False, "reason": f"Unsupported mouse operation '{operation}'"}
    after = pyautogui.position()
    return {"engine": "pyautogui-coordinate", "operation": operation, "position_before": list(before), "position_after": list(after)}


def action_keyboard(params: Dict[str, Any]) -> Dict[str, Any]:
    if not is_windows():
        return _win_required("keyboard")
    module = MODULES["pyautogui"]
    if module is None:
        return unavailable("pyautogui is not installed, so keyboard injection is unavailable.", "pip install pyautogui")
    import pyautogui  # type: ignore

    operation = str(params.get("operation", "type"))
    if operation == "type":
        text = str(params.get("text", ""))
        pyautogui.write(text, interval=float(params.get("interval", 0.02)))
        return {"engine": "pyautogui", "operation": "type", "chars_sent": len(text)}
    if operation == "hotkey":
        keys = [str(key) for key in params.get("keys", [])]
        pyautogui.hotkey(*keys)
        return {"engine": "pyautogui", "operation": "hotkey", "keys": keys}
    if operation == "press":
        key = str(params.get("key", "enter"))
        pyautogui.press(key)
        return {"engine": "pyautogui", "operation": "press", "key": key}
    return {"ok": False, "reason": f"Unsupported keyboard operation '{operation}'"}


def action_audio_devices(params: Dict[str, Any]) -> Dict[str, Any]:
    if MODULES["sounddevice"] is None:
        return unavailable("sounddevice is not installed, so audio devices cannot be enumerated.", "pip install sounddevice")
    try:
        import sounddevice as sd  # type: ignore

        devices = []
        for index, device in enumerate(sd.query_devices()):
            if device.get("max_input_channels", 0) > 0:
                devices.append({"index": index, "name": device["name"], "channels": device["max_input_channels"], "sample_rate": device["default_samplerate"]})
        return {"engine": "sounddevice", "count": len(devices), "devices": devices}
    except Exception as exc:
        return {"ok": False, "reason": f"Audio device enumeration failed: {exc}"}


def action_transcribe(params: Dict[str, Any]) -> Dict[str, Any]:
    if MODULES["faster_whisper"] is None:
        return unavailable("faster-whisper is not installed in this Python environment, so no transcription is possible here.", "pip install faster-whisper")
    try:
        from faster_whisper import WhisperModel  # type: ignore

        audio_path = str(params.get("path", ""))
        if not audio_path or not os.path.exists(audio_path):
            return {"ok": False, "reason": f"No audio file at {audio_path or '<none>'}"}
        model_size = str(params.get("model", "small"))
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, word_timestamps=True)
        words = []
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text)
            for word in getattr(segment, "words", []) or []:
                words.append({"word": word.word, "start": word.start, "end": word.end})
        return {"engine": f"faster-whisper:{model_size}", "text": " ".join(text_parts).strip(), "words": words, "language": info.language, "duration": info.duration}
    except Exception as exc:
        return {"ok": False, "reason": f"Transcription failed: {exc}"}


ACTIONS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "health": action_health,
    "capabilities": lambda params: {"capabilities": capabilities(), "platform": platform.platform()},
    "uia_list_windows": action_uia_list_windows,
    "uia_tree": action_uia_tree,
    "uia_invoke": action_uia_invoke,
    "screenshot": action_screenshot,
    "ocr": action_ocr,
    "mouse": action_mouse,
    "keyboard": action_keyboard,
    "audio_devices": action_audio_devices,
    "transcribe": action_transcribe,
}


def handle(request: Dict[str, Any]) -> Dict[str, Any]:
    started = time.time()
    request_id = request.get("id", "unknown")
    action = str(request.get("action", ""))
    params = request.get("params") or {}
    handler = ACTIONS.get(action)
    if handler is None:
        return {"id": request_id, "ok": False, "error": f"Unknown action '{action}'. Known: {', '.join(sorted(ACTIONS))}", "ms": int((time.time() - started) * 1000)}
    try:
        result = handler(params)
        ok = bool(result.get("ok", True))
        if "ok" in result:
            result = {key: value for key, value in result.items() if key != "ok"}
        return {"id": request_id, "ok": ok, "result": result, "ms": int((time.time() - started) * 1000)}
    except RuntimeError as exc:
        message = str(exc)
        if message.startswith("PYTHON_DEPENDENCY_MISSING::"):
            _, module_name, purpose, install = message.split("::", 3)
            return {
                "id": request_id,
                "ok": False,
                "error": f"{purpose} requires the Python package \"{module_name}\", which is not installed.",
                "result": unavailable(f"{purpose} requires the Python package \"{module_name}\".", install),
                "ms": int((time.time() - started) * 1000),
            }
        return {"id": request_id, "ok": False, "error": message, "ms": int((time.time() - started) * 1000)}
    except Exception as exc:  # never crash the worker on a bad request
        return {
            "id": request_id,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc()[-1500:],
            "ms": int((time.time() - started) * 1000),
        }


def main() -> None:
    sys.stderr.write(f"[aisha_worker] v{WORKER_VERSION} up: python {sys.version.split()[0]} on {platform.platform()}; capabilities={capabilities()}\n")
    sys.stderr.flush()
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError as exc:
            sys.stdout.write(json.dumps({"id": "unknown", "ok": False, "error": f"Invalid JSON request: {exc}"}) + "\n")
            sys.stdout.flush()
            continue
        response = handle(request)
        sys.stdout.write(json.dumps(response, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
