import psutil
import GPUtil
import time
import json
import csv
import requests
from datetime import datetime, timedelta
import os
import platform
import smtplib
from email.message import EmailMessage
from dotenv import load_dotenv

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

def init_csv():
    os.makedirs(os.path.dirname(CSV_FILE), exist_ok=True)
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "date", "time", "cpu_name", "cpu_percent",
                "ram_used_gb", "ram_total_gb", "disk_used_gb", "disk_total_gb",
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

def get_gpu_metrics():
    gpu_list = []
    allowed_names = FILTERS["gpu_names"]
    for gpu in GPUtil.getGPUs():
        name = gpu.name
        if allowed_names:
            if not any(n.lower() in name.lower() for n in allowed_names):
                continue
        gpu_list.append({
            "id": gpu.id, "name": name,
            "util": round(gpu.load * 100, 2),
            "vram_used": round(gpu.memoryUsed / 1024, 2),
            "vram_total": round(gpu.memoryTotal / 1024, 2)
        })
    return gpu_list

def log_to_csv(date_str, time_str, cpu_name, sys, gpus):
    with open(CSV_FILE, "a", newline="") as f:
        writer = csv.writer(f)
        if not gpus:
            writer.writerow([
                date_str, time_str, cpu_name, sys["cpu"],
                sys["ram_used"], sys["ram_total"], sys["disk_used"], sys["disk_total"],
                "NA", "NA", 0, 0, 0
            ])
        else:
            for g in gpus:
                writer.writerow([
                    date_str, time_str, cpu_name, sys["cpu"],
                    sys["ram_used"], sys["ram_total"], sys["disk_used"], sys["disk_total"],
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
                alerts.append(f"GPU {g['id']} Memory ({gpu_short}): {g['util']}%")
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
    print("Monitoring started...")
    init_csv()
    while True:
        current = now()
        date_str = current.strftime("%Y-%m-%d")
        time_str = current.strftime("%H:%M:%S")
        cpu_name = get_cpu_name()
        sys_metrics = get_system_metrics()
        gpu_metrics = get_gpu_metrics()
        log_to_csv(date_str, time_str, cpu_name, sys_metrics, gpu_metrics)
        check_thresholds(cpu_name, sys_metrics, gpu_metrics)
        print(f"{date_str} {time_str} | CPU:{sys_metrics['cpu']}% RAM:{sys_metrics['ram_used']}GB GPUs:{len(gpu_metrics)}")
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
