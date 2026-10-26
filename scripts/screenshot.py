"""Capture the Concurrency Pacer panel in light and dark themes through the bb web UI.

Needs the bb app running on 127.0.0.1:38886, a headless Chromium (Playwright's chromium_headless_shell), and the
`websocket-client` Python package. Usage: python3 scripts/screenshot.py <output-dir>
Writes light.png and dark.png into <output-dir>. Nothing is written to the plugin or the host.
"""
import base64, glob, json, os, subprocess, sys, tempfile, time, urllib.request
import websocket

OUT = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: screenshot.py <output-dir>")
BIN = sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))[-1]
URL = "http://127.0.0.1:38886/plugins/concurrency-pacer/concurrency-pacer"
PORT = 9333
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="pacer-profile-")
proc = subprocess.Popen([BIN, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    f"--remote-debugging-port={PORT}", "--window-size=1280,1100", f"--user-data-dir={profile}", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def page_ws():
    for _ in range(60):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=2))
            pages = [t for t in tabs if t.get("type") == "page"]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit("no devtools page")


ws = websocket.create_connection(page_ws(), timeout=30)
_id = 0


def send(method, params=None):
    global _id
    _id += 1
    ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id:
            return msg.get("result", msg)


def evaluate(expr):
    r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return r.get("result", {}).get("value")


def wait_for(expr, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if evaluate(expr):
            return True
        time.sleep(1)
    return False


def shot(scheme, path):
    send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": scheme}]})
    time.sleep(1.5)
    data = send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
    open(path, "wb").write(base64.b64decode(data["data"]))
    print(scheme, "->", path, os.path.getsize(path))


try:
    send("Page.enable")
    send("Runtime.enable")
    send("Page.navigate", {"url": URL})
    # The panel shows its own sections once the RPC has answered. Wait for the Inputs section, which holds the memory gauge.
    ok = wait_for("document.body && document.body.innerText.includes('Last decision') && document.body.innerText.includes('Free memory')", 60)
    print("panel rendered:", ok)
    print(evaluate("document.body.innerText.slice(0, 900)"))
    shot("light", os.path.join(OUT, "light.png"))
    shot("dark", os.path.join(OUT, "dark.png"))
finally:
    ws.close()
    proc.terminate()
