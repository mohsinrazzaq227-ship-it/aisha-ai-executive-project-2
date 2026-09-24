#!/usr/bin/env python3
"""
AISHA capability sidecar (optional, real) — Project 2 architecture preserved.

Purpose
-------
Expose Windows automation that Node cannot do properly, plus local speech:

  * pywinauto   -> real UI Automation tree discovery + semantic control actions
  * pyautogui   -> coordinate input, used only when semantics are unavailable
  * mss         -> screen capture with real pixel dimensions
  * pytesseract -> OCR over captured images
  * faster_whisper -> local speech recognition

No-mock policy
--------------
  * A missing package returns ok=false with `unavailable` plus the exact install
    command. Nothing is simulated and nothing is silently degraded.
  * Every successful action returns verifiable evidence (file path + byte size,
    element names read back, cursor position, OCR text) so the caller can verify.
  * Exceptions are returned as ok=false with the exception text.

Wire protocol (one request per process with --one-shot, or NDJSON on stdin)
    -> {"id":"...","action":"health","params":{},"timeoutMs":5000}
    <- {"id":"...","ok":true,"result":{...},"ms":12}
"""
from __future__ import annotations

import base64
import importlib
import json
import os
import platform
import sys
import time
from typing import Any, Dict

IS_WINDOWS = sys.platform.startswith("win")
PACKAGES = ["pywinauto", "pyautogui", "mss", "PIL", "pytesseract", "faster_whisper", "pynput"]


def probe_capabilities() -> Dict[str, bool]:
    found: Dict[str, bool] = {}
    for name in PACKAGES:
        try:
            importlib.import_module(name)
            found[name] = True
        except Exception:
            found[name] = False
    return found


def require(package: str, install: str) -> None:
    try:
        importlib.import_module(package)
    except Exception as exc:  # pragma: no cover - environment dependent
        raise Unavailable(f"{package} is not importable: {exc}", install)


class Unavailable(Exception):
    def __init__(self, message: str, fix: str) -> None:
        super().__init__(message)
        self.message = message
        self.fix = fix


def action_health(params: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "is_windows": IS_WINDOWS,
        "capabilities": probe_capabilities(),
        "detail": f"sidecar online on {platform.system()} {platform.release()}",
    }


def action_windows_list(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pywinauto", "pip install pywinauto")
    from pywinauto import Desktop  # type: ignore

    windows = []
    for window in Desktop(backend="uia").windows():
        try:
            windows.append(
                {
                    "title": window.window_text(),
                    "handle": getattr(window, "handle", None),
                    "process_id": window.process_id(),
                    "visible": window.is_visible(),
                    "rect": [window.rectangle().left, window.rectangle().top, window.rectangle().right, window.rectangle().bottom],
                }
            )
        except Exception:
            continue
    return {"windows": windows, "count": len(windows), "backend": "uia"}


def action_windows_focus(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pywinauto", "pip install pywinauto")
    from pywinauto import Desktop  # type: ignore

    title = (params.get("title") or "").lower()
    for window in Desktop(backend="uia").windows():
        try:
            if title and title in window.window_text().lower():
                window.set_focus()
                time.sleep(0.3)
                return {"focused": window.window_text(), "requested": params.get("title")}
        except Exception:
            continue
    raise Unavailable(f"no window matched '{params.get('title')}'", "check the window title substring")


def _window(params: Dict[str, Any]):
    from pywinauto import Application  # type: ignore

    title = params.get("window_title") or ""
    app = Application(backend="uia").connect(title_re=f".*{title}.*" if title else ".*", timeout=10)
    return app.window(title_re=f".*{title}.*" if title else ".*")


def action_uia_find(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pywinauto", "pip install pywinauto")
    window = _window(params)
    criteria: Dict[str, Any] = {}
    if params.get("name"):
        criteria["title"] = params["name"]
    controls = window.descendants(**criteria) if criteria else window.descendants()
    matches = []
    for control in controls[:400]:
        info = control.element_info
        matches.append({"name": info.name, "control_type": info.control_type, "automation_id": info.automation_id, "enabled": info.enabled})
        if params.get("control_type") and info.control_type != params["control_type"]:
            matches.pop()
    return {"count": len(matches), "matches": matches[:50], "criteria": criteria}


def action_uia_read(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pywinauto", "pip install pywinauto")
    window = _window(params)
    control = window.child_window(title=params.get("name"), control_type=params.get("control_type")) if params.get("name") else window
    text = control.window_text()
    value = ""
    try:
        value = control.get_value()  # type: ignore[attr-defined]
    except Exception:
        value = ""
    return {"text": text, "value": value, "control_type": getattr(control.element_info, "control_type", "unknown")}


def action_uia_invoke(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pywinauto", "pip install pywinauto")
    window = _window(params)
    control = window.child_window(title=params.get("name"), control_type=params.get("control_type"))
    control.invoke()
    time.sleep(0.5)
    return {"invoked": True, "control": params.get("name"), "window": params.get("window_title"), "readback": control.window_text()}


def action_uia_fill(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pywinauto", "pip install pywinauto")
    window = _window(params)
    control = window.child_window(title=params.get("name"), control_type=params.get("control_type"))
    control.set_text(params.get("value", ""))
    time.sleep(0.3)
    try:
        verified_value = control.get_value()
    except Exception:
        verified_value = control.window_text()
    return {"verifiedValue": verified_value, "requested": params.get("value"), "control": params.get("name")}


def action_screen_capture(params: Dict[str, Any]) -> Dict[str, Any]:
    require("mss", "pip install mss pillow")
    import mss  # type: ignore
    from PIL import Image  # type: ignore

    target = params.get("path")
    if not target:
        raise Unavailable("path parameter is required", "caller must supply an absolute output path")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with mss.mss() as sct:
        monitor = sct.monitors[1]
        raw = sct.grab(monitor)
        image = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        image.save(target, "PNG")
    size = os.path.getsize(target)
    return {"path": target, "bytes": size, "width": raw.size[0], "height": raw.size[1], "monitor": monitor}


def action_input(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pyautogui", "pip install pyautogui")
    import pyautogui  # type: ignore

    action = params.get("action")
    if action in {"move", "click", "double_click", "right_click"}:
        x, y = params.get("x"), params.get("y")
        if x is None or y is None:
            raise Unavailable("x and y are required for pointer actions", "supply target coordinates")
        pyautogui.moveTo(x, y, duration=0.2)
        if action == "click":
            pyautogui.click()
        elif action == "double_click":
            pyautogui.doubleClick()
        elif action == "right_click":
            pyautogui.rightClick()
        position = [pyautogui.position().x, pyautogui.position().y]
        return {"action": action, "position": position, "size": pyautogui.size()}
    if action == "scroll":
        pyautogui.scroll(int(params.get("amount") or -3))
        return {"action": "scroll", "amount": params.get("amount"), "position": [pyautogui.position().x, pyautogui.position().y]}
    if action == "type":
        text = params.get("text") or ""
        pyautogui.write(text, interval=0.02)
        return {"action": "type", "sent": len(text)}
    if action == "hotkey" or action == "key":
        keys = params.get("keys") or ([params.get("text")] if params.get("text") else [])
        if len(keys) > 1:
            pyautogui.hotkey(*keys)
        elif keys:
            pyautogui.press(keys[0])
        else:
            raise Unavailable("keys are required for hotkey/key actions", "supply keys, e.g. ['ctrl','s']")
        return {"action": action, "sent": len(keys), "keys": keys}
    raise Unavailable(f"unsupported input action '{action}'", "use move|click|double_click|right_click|scroll|type|hotkey|key")


def action_vision_ocr(params: Dict[str, Any]) -> Dict[str, Any]:
    require("pytesseract", "pip install pytesseract pillow && install the tesseract binary")
    from PIL import Image  # type: ignore
    import pytesseract  # type: ignore

    target = params.get("path")
    if not target or not os.path.exists(target):
        raise Unavailable(f"image not found: {target}", "capture a screenshot first or pass an existing path")
    with Image.open(target) as image:
        text = pytesseract.image_to_string(image)
        width, height = image.size
    return {"text": text, "chars": len(text.strip()), "width": width, "height": height, "path": target}


def action_audio_transcribe(params: Dict[str, Any]) -> Dict[str, Any]:
    require("faster_whisper", "pip install faster-whisper")
    from faster_whisper import WhisperModel  # type: ignore

    target = params.get("path")
    if not target or not os.path.exists(target):
        raise Unavailable(f"audio not found: {target}", "provide a real audio file path")
    model_size = os.environ.get("AISHA_WHISPER_MODEL", "base")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(target, language=params.get("language") or None)
    collected = [{"start": seg.start, "end": seg.end, "text": seg.text} for seg in segments]
    return {"text": " ".join(seg["text"].strip() for seg in collected).strip(), "segments": collected, "language": info.language, "model": model_size}


def action_audio_tts(params: Dict[str, Any]) -> Dict[str, Any]:
    # A real local engine is required; pyttsx3 plays through the OS but cannot
    # return an audio artifact, so it is reported explicitly as such.
    require("pyttsx3", "pip install pyttsx3  (or run a piper/kokoro HTTP endpoint and set TTS_URL)")
    import pyttsx3  # type: ignore

    text = params.get("text") or ""
    if not text:
        raise Unavailable("text is required", "supply the text to speak")
    engine = pyttsx3.init()
    engine.say(text)
    engine.runAndWait()
    return {"spoken": True, "chars": len(text), "artifact": None, "note": "OS speech synthesis played locally; no audio file is produced by pyttsx3"}


ACTIONS = {
    "health": action_health,
    "windows.list": action_windows_list,
    "windows.focus": action_windows_focus,
    "uia.find": action_uia_find,
    "uia.read": action_uia_read,
    "uia.invoke": action_uia_invoke,
    "uia.fill": action_uia_fill,
    "screen.capture": action_screen_capture,
    "input.action": action_input,
    "vision.ocr": action_vision_ocr,
    "audio.transcribe": action_audio_transcribe,
    "audio.tts": action_audio_tts,
}


def handle(request: Dict[str, Any]) -> Dict[str, Any]:
    started = time.time()
    request_id = request.get("id", "unknown")
    action = request.get("action", "")
    params = request.get("params") or {}
    handler = ACTIONS.get(action)
    if handler is None:
        return {"id": request_id, "ok": False, "error": f"unknown action '{action}'", "ms": int((time.time() - started) * 1000)}
    if action != "health" and action.startswith(("windows.", "uia.")) and not IS_WINDOWS:
        return {
            "id": request_id,
            "ok": False,
            "unavailable": f"{action} requires Windows UI Automation; this host is {platform.system()}",
            "fix": "run AISHA on Windows 10/11",
            "ms": int((time.time() - started) * 1000),
        }
    try:
        result = handler(params)
        return {"id": request_id, "ok": True, "result": result, "ms": int((time.time() - started) * 1000)}
    except Unavailable as exc:
        return {"id": request_id, "ok": False, "unavailable": exc.message, "fix": exc.fix, "ms": int((time.time() - started) * 1000)}
    except Exception as exc:  # real error, reported verbatim
        return {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}", "ms": int((time.time() - started) * 1000)}


def main() -> None:
    if "--one-shot" in sys.argv:
        line = sys.stdin.readline()
        if not line.strip():
            print(json.dumps({"id": "unknown", "ok": False, "error": "no request received on stdin"}), flush=True)
            return
        print(json.dumps(handle(json.loads(line))), flush=True)
        return
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            print(json.dumps(handle(json.loads(line))), flush=True)
        except Exception as exc:
            print(json.dumps({"id": "unknown", "ok": False, "error": f"bad request: {exc}"}), flush=True)


if __name__ == "__main__":
    main()
