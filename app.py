import csv
import glob
import json
import os
import signal
import subprocess
import sys
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory

# ------------------------------------------------------------------ paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_DIR = os.path.join(BASE_DIR, "config")
RUNTIME_DIR = os.path.join(BASE_DIR, "runtime")
LOG_DIR = os.path.join(BASE_DIR, "logs")
SAMPLE_DIR = os.path.join(BASE_DIR, "sample-data")
TEMPLATE_DIR = os.path.join(BASE_DIR, "web", "templates")
STATIC_DIR = os.path.join(BASE_DIR, "web", "static")

os.makedirs(RUNTIME_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

# ------------------------------------------------------------------ monitors
MONITORS = {
    "camera": {
        "label": "Camera Monitor",
        "script": os.path.join(BASE_DIR, "monitors", "camera.py"),
        "config_env": "CAMERA_CONFIG",
        "config": os.path.join(CONFIG_DIR, "camera.config.json"),
    },
    "hardware": {
        "label": "Hardware Monitor",
        "script": os.path.join(BASE_DIR, "monitors", "hardware.py"),
        "config_env": "HARDWARE_CONFIG",
        "config": os.path.join(CONFIG_DIR, "hardware.config.json"),
    },
    "services": {
        "label": "Service Monitor",
        "script": os.path.join(BASE_DIR, "monitors", "services.py"),
        "config_env": "SERVICE_CONFIG",
        "config": os.path.join(CONFIG_DIR, "services.config.json"),
    },
}

# ------------------------------------------------------------------ state
procs = {k: None for k in MONITORS}

# ------------------------------------------------------------------ helpers
def load_json(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def is_running(key):
    proc = procs.get(key)
    return proc is not None and proc.poll() is None


def start_monitor(key):
    if is_running(key):
        return False, "Already running"
    monitor = MONITORS[key]
    env = os.environ.copy()
    env[monitor["config_env"]] = monitor["config"]
    log_path = os.path.join(RUNTIME_DIR, f"{key}.log")
    log_file = open(log_path, "a", encoding="utf-8")
    log_file.write(f"\n\n--- START {datetime.now().isoformat()} ---\n")
    log_file.flush()
    proc = subprocess.Popen(
        [sys.executable, monitor["script"]],
        cwd=BASE_DIR,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    procs[key] = proc
    return True, "Started"


def stop_monitor(key):
    proc = procs.get(key)
    if proc is None or proc.poll() is not None:
        procs[key] = None
        return False, "Not running"
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    procs[key] = None
    return True, "Stopped"


def read_csv_rows(path, limit=200):
    if not path or not os.path.exists(path):
        return [], []
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        rows = list(reader)
    if not rows:
        return [], []
    headers = rows[0]
    data = rows[1:][-limit:]
    return headers, data


def latest_file(pattern):
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def read_tail(path, lines=120):
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as fh:
        data = fh.readlines()
    return "".join(data[-lines:])


# ------------------------------------------------------------------ flask
app = Flask(
    __name__,
    template_folder=TEMPLATE_DIR,
    static_folder=STATIC_DIR,
    static_url_path="/static",
)


@app.route("/")
def index():
    return send_from_directory(TEMPLATE_DIR, "index.html")


# ---- status
@app.route("/api/status")
def api_status():
    result = {}
    for key, mon in MONITORS.items():
        result[key] = {
            "label": mon["label"],
            "running": is_running(key),
        }
    return jsonify(result)


# ---- start / stop / restart
@app.route("/api/start/<key>", methods=["POST"])
def api_start(key):
    if key not in MONITORS:
        return jsonify({"ok": False, "msg": "Unknown monitor"}), 404
    ok, msg = start_monitor(key)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/stop/<key>", methods=["POST"])
def api_stop(key):
    if key not in MONITORS:
        return jsonify({"ok": False, "msg": "Unknown monitor"}), 404
    ok, msg = stop_monitor(key)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/restart/<key>", methods=["POST"])
def api_restart(key):
    if key not in MONITORS:
        return jsonify({"ok": False, "msg": "Unknown monitor"}), 404
    stop_monitor(key)
    ok, msg = start_monitor(key)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/start-all", methods=["POST"])
def api_start_all():
    results = {}
    for key in MONITORS:
        ok, msg = start_monitor(key)
        results[key] = {"ok": ok, "msg": msg}
    return jsonify(results)


@app.route("/api/stop-all", methods=["POST"])
def api_stop_all():
    results = {}
    for key in MONITORS:
        ok, msg = stop_monitor(key)
        results[key] = {"ok": ok, "msg": msg}
    return jsonify(results)


# ---- config
@app.route("/api/config/<key>", methods=["GET"])
def api_get_config(key):
    if key not in MONITORS:
        return jsonify({"error": "Unknown monitor"}), 404
    data = load_json(MONITORS[key]["config"])
    return jsonify(data)


@app.route("/api/config/<key>", methods=["POST"])
def api_save_config(key):
    if key not in MONITORS:
        return jsonify({"ok": False, "msg": "Unknown monitor"}), 404
    try:
        data = request.get_json(force=True)
        save_json(MONITORS[key]["config"], data)
        return jsonify({"ok": True, "msg": "Config saved"})
    except Exception as exc:
        return jsonify({"ok": False, "msg": str(exc)}), 400


# ---- logs
@app.route("/api/logs/<key>")
def api_logs(key):
    if key not in MONITORS:
        return jsonify({"error": "Unknown monitor"}), 404
    path = os.path.join(RUNTIME_DIR, f"{key}.log")
    return jsonify({"log": read_tail(path)})


# ---- csv data
@app.route("/api/data/<key>")
def api_data(key):
    if key == "camera":
        cam_cfg = load_json(MONITORS["camera"]["config"])
        log_dir = cam_cfg.get("log_directory", os.path.join(BASE_DIR, "logs"))
        if not os.path.isabs(log_dir):
            log_dir = os.path.join(BASE_DIR, log_dir)
        csv_path = latest_file(os.path.join(log_dir, "log_*.csv"))
    elif key == "hardware":
        hw_cfg = load_json(MONITORS["hardware"]["config"])
        csv_path = hw_cfg.get("csv_file", os.path.join(SAMPLE_DIR, "hardware_metrics.csv"))
        if not os.path.isabs(csv_path):
            csv_path = os.path.join(BASE_DIR, csv_path)
    elif key == "services":
        svc_cfg = load_json(MONITORS["services"]["config"])
        log_dir = svc_cfg.get("log_directory", os.path.join(BASE_DIR, "logs"))
        if not os.path.isabs(log_dir):
            log_dir = os.path.join(BASE_DIR, log_dir)
        csv_path = latest_file(os.path.join(log_dir, "service_log_*.csv"))
    else:
        return jsonify({"error": "Unknown monitor"}), 404

    headers, rows = read_csv_rows(csv_path, 150)
    return jsonify({"headers": headers, "rows": rows, "file": csv_path or ""})


# ------------------------------------------------------------------ main
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
