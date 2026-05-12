import psutil
import time
import json
import csv
import requests
import subprocess
import glob
import math
import fcntl
from datetime import datetime, timedelta
import os
import platform
import re
import shutil
import smtplib
from email.message import EmailMessage
from dotenv import load_dotenv

try:
    import GPUtil
except Exception:
    GPUtil = None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)

load_dotenv()
ALERT_PASSWORD = os.getenv("ALERT_PASSWORD") or os.getenv("SMTP_PASSWORD")
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
SENDER_EMAIL = os.getenv("SENDER_EMAIL") or os.getenv("EMAIL_USERNAME")
SMTP_USERNAME = os.getenv("SMTP_USERNAME") or SENDER_EMAIL
GOOGLE_CHAT_WEBHOOK_ENV = os.getenv("GOOGLE_CHAT_WEBHOOK")

# Load config
CONFIG_FILE = os.getenv("HARDWARE_CONFIG") or os.path.join(ROOT_DIR, "config", "hardware.config.json")

with open(CONFIG_FILE) as f:
    config = json.load(f)

INTERVAL = config["interval_seconds"]
CSV_FILE = config.get("csv_file") or os.path.join(ROOT_DIR, "sample-data", "hardware_metrics.csv")
THRESHOLDS = config["thresholds"]
CHAT_CONFIG = config["google_chat"]
EMAIL_CONFIG = config.get("email", {"enabled": False, "from_email": "", "to_emails": [], "subject": "Hardware Alert"})
COOLDOWN_MINUTES = config["alert_cooldown_minutes"]
FILTERS = config["filters"]

if not os.path.isabs(CSV_FILE):
    CSV_FILE = os.path.join(ROOT_DIR, CSV_FILE)

last_alert_time = {}
_prev_net_sample = None
_lock_file = None

def safe_float(value, default=0.0):
    try:
        result = float(str(value).strip().replace("%", ""))
        if math.isnan(result) or math.isinf(result):
            return default
        return result
    except Exception:
        return default

def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read().strip().replace("\x00", " ")
    except Exception:
        return ""

def command_exists(command):
    return shutil.which(command) is not None

def now():
    return datetime.now()

def bytes_to_gb(b):
    return round(b / (1024 ** 3), 2)

def get_cpu_name():
    name = platform.processor()
    if not name:
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if "model name" in line:
                        return line.split(":")[1].strip()
        except:
            return "Unknown CPU"
    return name

def should_alert(key):
    if key not in last_alert_time:
        return True
    return (now() - last_alert_time[key]) > timedelta(minutes=COOLDOWN_MINUTES)

def update_alert_time(key):
    last_alert_time[key] = now()

def acquire_single_instance_lock():
    global _lock_file
    lock_path = os.path.join(ROOT_DIR, "runtime", "hardware.lock")
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    _lock_file = open(lock_path, "w", encoding="utf-8")
    try:
        fcntl.flock(_lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _lock_file.write(str(os.getpid()))
        _lock_file.flush()
        return True
    except BlockingIOError:
        print("Hardware monitor already running; exiting duplicate instance.")
        return False

def init_csv():
    os.makedirs(os.path.dirname(CSV_FILE), exist_ok=True)
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "date", "time", "cpu_name", "cpu_percent",
                "ram_used_gb", "ram_total_gb", "disk_used_gb", "disk_total_gb",
                "net_download_mbps", "net_upload_mbps",
                "gpu_id", "gpu_name", "gpu_util_percent", "vram_used_gb", "vram_total_gb"
            ])

def get_system_metrics():
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage('/')
    return {
        "cpu": psutil.cpu_percent(),
        "ram_used": bytes_to_gb(vm.used),
        "ram_total": bytes_to_gb(vm.total),
        "disk_used": bytes_to_gb(disk.used),
        "disk_total": bytes_to_gb(disk.total)
    }

def get_network_metrics():
    global _prev_net_sample
    counters = psutil.net_io_counters()
    now_ts = time.time()
    if _prev_net_sample is None:
        _prev_net_sample = (counters.bytes_recv, counters.bytes_sent, now_ts)
        return {"download_mbps": 0.0, "upload_mbps": 0.0}

    prev_recv, prev_sent, prev_ts = _prev_net_sample
    elapsed = max(now_ts - prev_ts, 1e-6)
    download_mbps = max(counters.bytes_recv - prev_recv, 0) * 8 / elapsed / 1_000_000
    upload_mbps = max(counters.bytes_sent - prev_sent, 0) * 8 / elapsed / 1_000_000
    _prev_net_sample = (counters.bytes_recv, counters.bytes_sent, now_ts)
    return {
        "download_mbps": round(download_mbps, 2),
        "upload_mbps": round(upload_mbps, 2),
    }

def detect_gpus_with_nvidia_smi():
    if not command_exists("nvidia-smi"):
        return []
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,gpu_name,utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        gpu_list = []
        for line in (result.stdout or "").splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) != 5:
                continue
            gpu_list.append({
                "id": int(safe_float(parts[0])),
                "name": parts[1],
                "util": round(safe_float(parts[2]), 2),
                "vram_used": round(safe_float(parts[3]) / 1024, 2),
                "vram_total": round(safe_float(parts[4]) / 1024, 2),
            })
        return gpu_list
    except Exception:
        return []

def get_jetson_name():
    model = read_text("/proc/device-tree/model")
    if model:
        return model
    if read_text("/etc/nv_tegra_release"):
        return "NVIDIA Jetson"
    return "Jetson GPU"

def is_jetson_platform():
    model = get_jetson_name().lower()
    return "jetson" in model or bool(read_text("/etc/nv_tegra_release"))

def parse_tegrastats(output):
    if not output:
        return None
    match = re.search(r"GR3D_FREQ\s+(\d+(?:\.\d+)?)%", output)
    if not match:
        return None
    ram_match = re.search(r"RAM\s+(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)MB", output)
    return {
        "id": 0,
        "name": get_jetson_name(),
        "util": round(safe_float(match.group(1)), 2),
        "vram_used": round(safe_float(ram_match.group(1)) / 1024, 2) if ram_match else 0.0,
        "vram_total": round(safe_float(ram_match.group(2)) / 1024, 2) if ram_match else 0.0,
    }

def detect_jetson_with_tegrastats():
    if not command_exists("tegrastats"):
        return []
    try:
        result = subprocess.run(
            ["tegrastats", "--interval", "1000"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        parsed = parse_tegrastats(result.stdout or result.stderr or "")
        return [parsed] if parsed else []
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout or exc.stderr or ""
        if isinstance(output, bytes):
            output = output.decode("utf-8", "ignore")
        parsed = parse_tegrastats(output)
        return [parsed] if parsed else []
    except Exception:
        return []

def detect_jetson_with_sysfs():
    load_paths = [
        "/sys/devices/gpu.0/load",
        *glob.glob("/sys/devices/platform/*gpu*/load"),
        *glob.glob("/sys/devices/platform/*/gpu*/load"),
    ]
    for path in load_paths:
        raw = read_text(path)
        if not raw:
            continue
        util = safe_float(raw)
        if util > 100:
            util = util / 10
        return [{
            "id": 0,
            "name": get_jetson_name(),
            "util": round(max(0, min(util, 100)), 2),
            "vram_used": 0.0,
            "vram_total": 0.0,
        }]
    return []

def detect_gpus_with_gputil():
    if GPUtil is None:
        return []
    try:
        detected = GPUtil.getGPUs()
    except Exception:
        return []
    gpu_list = []
    for gpu in detected:
        gpu_list.append({
            "id": getattr(gpu, "id", 0),
            "name": getattr(gpu, "name", "Unknown GPU"),
            "util": round(safe_float(getattr(gpu, "load", 0)) * 100, 2),
            "vram_used": round(safe_float(getattr(gpu, "memoryUsed", 0)) / 1024, 2),
            "vram_total": round(safe_float(getattr(gpu, "memoryTotal", 0)) / 1024, 2),
        })
    return gpu_list

def get_gpu_metrics():
    allowed_names = [n for n in FILTERS.get("gpu_names", []) if n]
    if is_jetson_platform():
        detected = (
            detect_jetson_with_tegrastats()
            or detect_jetson_with_sysfs()
            or detect_gpus_with_nvidia_smi()
            or detect_gpus_with_gputil()
        )
    else:
        detected = (
            detect_gpus_with_nvidia_smi()
            or detect_gpus_with_gputil()
        )
    gpu_list = []
    for gpu in detected:
        name = gpu.get("name", "Unknown GPU")
        if allowed_names and not any(n.lower() in name.lower() for n in allowed_names):
            continue
        gpu_list.append({
            "id": gpu.get("id", 0),
            "name": name,
            "util": round(max(0, min(safe_float(gpu.get("util")), 100)), 2),
            "vram_used": safe_float(gpu.get("vram_used")),
            "vram_total": safe_float(gpu.get("vram_total")),
        })
    return gpu_list

def log_to_csv(date_str, time_str, cpu_name, sys, net, gpus):
    with open(CSV_FILE, "a", newline="") as f:
        writer = csv.writer(f)
        if not gpus:
            writer.writerow([
                date_str, time_str, cpu_name, sys["cpu"],
                sys["ram_used"], sys["ram_total"], sys["disk_used"], sys["disk_total"],
                net["download_mbps"], net["upload_mbps"],
                "NA", "NA", 0, 0, 0
            ])
        else:
            for g in gpus:
                writer.writerow([
                    date_str, time_str, cpu_name, sys["cpu"],
                    sys["ram_used"], sys["ram_total"], sys["disk_used"], sys["disk_total"],
                    net["download_mbps"], net["upload_mbps"],
                    g["id"], g["name"], g["util"], g["vram_used"], g["vram_total"]
                ])

def send_chat_alert(msg):
    if not CHAT_CONFIG.get("enabled", False):
        return
    webhook = CHAT_CONFIG.get("webhook_url") or GOOGLE_CHAT_WEBHOOK_ENV
    if not webhook:
        print("Chat alert skipped: no webhook URL")
        return
    try:
        requests.post(webhook, json={"text": msg})
    except Exception as e:
        print("Alert failed:", e)

def send_email_alert(msg):
    if not EMAIL_CONFIG.get("enabled", False):
        return
    sender = EMAIL_CONFIG.get("from_email") or SENDER_EMAIL
    receivers = EMAIL_CONFIG.get("to_emails", [])
    subject = EMAIL_CONFIG.get("subject", "Hardware Alert")
    smtp_server = EMAIL_CONFIG.get("smtp_server") or SMTP_SERVER
    smtp_port = int(EMAIL_CONFIG.get("smtp_port") or SMTP_PORT)
    smtp_username = EMAIL_CONFIG.get("smtp_username") or SMTP_USERNAME or sender
    smtp_password = EMAIL_CONFIG.get("smtp_password") or ALERT_PASSWORD
    if not sender or not receivers or not smtp_password:
        print("Email alert skipped: missing sender/receivers/password")
        return
    try:
        m = EmailMessage()
        m["Subject"] = subject
        m["From"] = sender
        m["To"] = ", ".join(receivers)
        m.set_content(msg)
        with smtplib.SMTP(smtp_server, smtp_port) as server:
            server.starttls()
            server.login(smtp_username, smtp_password)
            server.send_message(m)
    except Exception as e:
        print("Email alert failed:", e)

def check_thresholds(cpu_name, sys, gpus):
    alerts = []
    cpu_filter = FILTERS["cpu_name_contains"]
    if cpu_filter.lower() in cpu_name.lower():
        if sys["cpu"] > THRESHOLDS["cpu_percent"]:
            key = "cpu"
            if should_alert(key):
                alerts.append(f"CPU ({cpu_name}): {sys['cpu']}% used")
                update_alert_time(key)
    if sys["ram_used"] > THRESHOLDS["ram_gb"]:
        key = "ram"
        if should_alert(key):
            alerts.append(f"RAM: {sys['ram_used']} GB / {sys['ram_total']} GB used")
            update_alert_time(key)
    if sys["disk_used"] > THRESHOLDS["disk_gb"]:
        key = "disk"
        if should_alert(key):
            alerts.append(f"Disk: {sys['disk_used']} GB / {sys['disk_total']} GB used")
            update_alert_time(key)
    for g in gpus:
        gpu_short = g["name"].replace("NVIDIA GeForce ", "").strip()
        util_key = f"gpu_util_{g['id']}"
        if g["util"] > THRESHOLDS["gpu_util_percent"]:
            if should_alert(util_key):
                alerts.append(f"GPU {g['id']} Utilization ({gpu_short}): {g['util']}%")
                update_alert_time(util_key)
        vram_key = f"gpu_vram_{g['id']}"
        if g["vram_used"] > THRESHOLDS["vram_gb"]:
            if should_alert(vram_key):
                alerts.append(f"GPU {g['id']} VRAM ({gpu_short}): {g['vram_used']} GB / {g['vram_total']} GB used")
                update_alert_time(vram_key)
    if alerts:
        message = "\n".join(alerts)
        send_chat_alert(message)
        send_email_alert(message)

def main():
    if not acquire_single_instance_lock():
        return
    print("Monitoring started...")
    init_csv()
    while True:
        current = now()
        date_str = current.strftime("%Y-%m-%d")
        time_str = current.strftime("%H:%M:%S")
        cpu_name = get_cpu_name()
        sys_metrics = get_system_metrics()
        net_metrics = get_network_metrics()
        gpu_metrics = get_gpu_metrics()
        log_to_csv(date_str, time_str, cpu_name, sys_metrics, net_metrics, gpu_metrics)
        check_thresholds(cpu_name, sys_metrics, gpu_metrics)
        print(
            f"{date_str} {time_str} | CPU:{sys_metrics['cpu']}% RAM:{sys_metrics['ram_used']}GB "
            f"NET:{net_metrics['download_mbps']}/{net_metrics['upload_mbps']}Mbps GPUs:{len(gpu_metrics)}"
        )
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
