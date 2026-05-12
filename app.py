import csv
import glob
import json
import os
import signal
import subprocess
import sys
import hashlib
import secrets
import time
from functools import wraps
from datetime import datetime

from flask import Flask, jsonify, redirect, render_template, request, session, url_for

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

AUTH_FILE = os.path.join(CONFIG_DIR, "auth.config.json")

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
APP_BOOT_ID = secrets.token_hex(16)
ADMIN_IDLE_TIMEOUT_SECONDS = 300

# ------------------------------------------------------------------ helpers
def load_json(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def _hash_password(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def pid_file_path(key):
    return os.path.join(RUNTIME_DIR, f"{key}.pid")


def read_pid_file(key):
    path = pid_file_path(key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            pid = int(fh.read().strip())
        return pid if pid > 0 else None
    except Exception:
        return None


def write_pid_file(key, pid):
    with open(pid_file_path(key), "w", encoding="utf-8") as fh:
        fh.write(str(pid))


def remove_pid_file(key):
    path = pid_file_path(key)
    if os.path.exists(path):
        os.remove(path)


def pid_is_running(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def get_live_pid(key):
    pid = read_pid_file(key)
    if pid and pid_is_running(pid):
        return pid
    if pid:
        remove_pid_file(key)
    return None


def clear_session():
    session.clear()


def ensure_auth_file():
    if os.path.exists(AUTH_FILE):
        return
    default_auth = {
        "users": [
            {
                "username": "admin",
                "password_sha256": "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9",
                "role": "admin",
                "display_name": "Administrator",
            },
            {
                "username": "user",
                "password_sha256": "e606e38b0d8c19b24cf0ee3808183162ea7cd63ff7912dbb22b5e803286b4446",
                "role": "user",
                "display_name": "Viewer",
            },
        ]
    }
    save_json(AUTH_FILE, default_auth)


def load_auth_users():
    ensure_auth_file()
    return load_json(AUTH_FILE).get("users", [])


def authenticate(username, password):
    for user in load_auth_users():
        if user.get("username") == username and user.get("password_sha256") == _hash_password(password):
            return user
    return None


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "username" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "msg": "Authentication required"}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if session.get("role") != "admin":
            return jsonify({"ok": False, "msg": "Admin access required"}), 403
        return view(*args, **kwargs)

    return wrapped


def is_running(key):
    proc = procs.get(key)
    if proc is not None and proc.poll() is None:
        return True
    if proc is not None and proc.poll() is not None:
        procs[key] = None
    return get_live_pid(key) is not None


def start_monitor(key):
    if is_running(key):
        pid = get_live_pid(key)
        if pid:
            procs[key] = None
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
    time.sleep(0.3)
    if proc.poll() is not None:
        procs[key] = None
        remove_pid_file(key)
        return False, "Failed to start or another instance is already active"
    procs[key] = proc
    write_pid_file(key, proc.pid)
    return True, "Started"


def stop_monitor(key):
    proc = procs.get(key)
    stopped = False
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        stopped = True
    else:
        pid = get_live_pid(key)
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
                stopped = True
            except OSError:
                pass
    procs[key] = None
    remove_pid_file(key)
    if not stopped:
        return False, "Not running"
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
app.secret_key = os.getenv("SECRET_KEY", "monitoring-dashboard-dev-secret")
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")


ensure_auth_file()


@app.before_request
def refresh_session_state():
    if request.endpoint in {"static"}:
        return None
    username = session.get("username")
    if not username:
        return None

    if session.get("boot_id") != APP_BOOT_ID:
        clear_session()
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "msg": "Session expired. Please log in again."}), 401
        return redirect(url_for("login"))

    now_ts = int(time.time())
    last_seen = int(session.get("last_seen_ts", now_ts))
    if session.get("role") == "admin" and now_ts - last_seen > ADMIN_IDLE_TIMEOUT_SECONDS:
        clear_session()
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "msg": "Admin session timed out after 5 minutes of inactivity."}), 401
        return redirect(url_for("login"))

    session["last_seen_ts"] = now_ts
    session.modified = True
    return None


@app.route("/")
@login_required
def index():
    return render_template(
        "index.html",
        username=session.get("username", "guest"),
        role=session.get("role", "user"),
    )


@app.route("/dashboard")
@login_required
def dashboard():
    return index()


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("username"):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = authenticate(username, password)
        if user:
            clear_session()
            session["username"] = user.get("username")
            session["role"] = user.get("role", "user")
            session["display_name"] = user.get("display_name") or user.get("username")
            session["boot_id"] = APP_BOOT_ID
            session["last_seen_ts"] = int(time.time())
            return redirect(url_for("index"))
        error = "Invalid username or password"

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    clear_session()
    return redirect(url_for("login"))


# ---- status
@app.route("/api/status")
@login_required
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
@admin_required
def api_start(key):
    if key not in MONITORS:
        return jsonify({"ok": False, "msg": "Unknown monitor"}), 404
    ok, msg = start_monitor(key)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/stop/<key>", methods=["POST"])
@admin_required
def api_stop(key):
    if key not in MONITORS:
        return jsonify({"ok": False, "msg": "Unknown monitor"}), 404
    ok, msg = stop_monitor(key)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/restart/<key>", methods=["POST"])
@admin_required
def api_restart(key):
    if key not in MONITORS:
        return jsonify({"ok": False, "msg": "Unknown monitor"}), 404
    stop_monitor(key)
    ok, msg = start_monitor(key)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/start-all", methods=["POST"])
@admin_required
def api_start_all():
    results = {}
    for key in MONITORS:
        ok, msg = start_monitor(key)
        results[key] = {"ok": ok, "msg": msg}
    return jsonify(results)


@app.route("/api/stop-all", methods=["POST"])
@admin_required
def api_stop_all():
    results = {}
    for key in MONITORS:
        ok, msg = stop_monitor(key)
        results[key] = {"ok": ok, "msg": msg}
    return jsonify(results)


# ---- config
@app.route("/api/config/<key>", methods=["GET"])
@admin_required
def api_get_config(key):
    if key not in MONITORS:
        return jsonify({"error": "Unknown monitor"}), 404
    data = load_json(MONITORS[key]["config"])
    return jsonify(data)


@app.route("/api/config/<key>", methods=["POST"])
@admin_required
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
@login_required
def api_logs(key):
    if key not in MONITORS:
        return jsonify({"error": "Unknown monitor"}), 404
    path = os.path.join(RUNTIME_DIR, f"{key}.log")
    return jsonify({"log": read_tail(path)})


# ---- csv data
@app.route("/api/data/<key>")
@login_required
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
