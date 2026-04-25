import subprocess
import time
import csv
import os
import json
from datetime import datetime
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
import requests
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)

# -------------------- LOAD ENV --------------------
load_dotenv()
EMAIL_USERNAME = os.getenv("EMAIL_USERNAME") or os.getenv("SENDER_EMAIL")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD") or os.getenv("SMTP_PASSWORD") or os.getenv("ALERT_PASSWORD")
SMTP_USERNAME_ENV = os.getenv("SMTP_USERNAME") or EMAIL_USERNAME
SMTP_SERVER_ENV = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT_ENV = int(os.getenv("SMTP_PORT", 587))
GOOGLE_CHAT_WEBHOOK_ENV = os.getenv("GOOGLE_CHAT_WEBHOOK")

# -------------------- LOAD CONFIG --------------------
CONFIG_FILE = os.getenv("CAMERA_CONFIG") or os.path.join(ROOT_DIR, "config", "camera.config.json")

with open(CONFIG_FILE) as f:
    config = json.load(f)

CAMERA_LIST = config.get("cameras", [])
CHECK_INTERVAL = config.get("check_interval_seconds", 60)
OFFLINE_CONFIRM_SECONDS = config.get("offline_confirm_seconds", 5)
LOG_DIR = config.get("log_directory", os.path.join(ROOT_DIR, "logs"))
LATENCY_THRESHOLD = config.get("latency_threshold_ms", 100)
SAVE_CSV = config.get("save_csv", True)
SAVE_FRAME = config.get("save_frame", True)
EMAIL_ENABLED = config.get("email_alerts_enabled", False)
CHAT_ENABLED = config.get("google_chat_enabled", True)
CHAT_WEBHOOK = config.get("google_chat_webhook") or GOOGLE_CHAT_WEBHOOK_ENV
EMAIL_SETTINGS = config.get("email_settings", {})

# -------------------- SETUP --------------------
if not os.path.isabs(LOG_DIR):
    LOG_DIR = os.path.join(ROOT_DIR, LOG_DIR)

os.makedirs(LOG_DIR, exist_ok=True)
FRAME_DIR = os.path.join(LOG_DIR, "frames")
os.makedirs(FRAME_DIR, exist_ok=True)

# -------------------- STATE --------------------
last_status = {}
offline_candidate_since = {}  # ping fail start
offline_since = {}            # confirmed downtime start

import socket

# -------------------- HELPERS --------------------
def extract_ip(rtsp):
    try:
        return urlparse(rtsp).hostname or "Unknown"
    except:
        return "Unknown"

def check_rtsp_tcp(rtsp):
    try:
        parsed = urlparse(rtsp)
        host = parsed.hostname or "Unknown"
        port = parsed.port or 554
        if host == "Unknown":
            return False, None
            
        start = time.time()
        with socket.create_connection((host, port), timeout=3):
            pass
        latency = int((time.time() - start) * 1000)
        return True, latency
    except:
        return False, None

def save_frame(rtsp, name):
    try:
        path = os.path.join(
            FRAME_DIR,
            f"{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"
        )
        subprocess.run(
            ["ffmpeg", "-rtsp_transport", "tcp", "-i", rtsp, "-frames:v", "1", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10
        )
    except:
        pass

def format_duration(seconds):
    if seconds < 1:
        seconds = 1
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    return f"{hrs}h {mins}m {secs}s"

def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# -------------------- ALERTS --------------------
def send_email_alert(alerts):
    if not EMAIL_ENABLED or not alerts:
        return

    sender = EMAIL_SETTINGS.get("sender") or EMAIL_USERNAME
    smtp_username = EMAIL_SETTINGS.get("smtp_username") or SMTP_USERNAME_ENV or sender
    smtp_password = EMAIL_SETTINGS.get("smtp_password") or EMAIL_PASSWORD
    receivers = EMAIL_SETTINGS.get("receiver") or ([EMAIL_USERNAME] if EMAIL_USERNAME else [])
    smtp_server = EMAIL_SETTINGS.get("smtp_server") or SMTP_SERVER_ENV
    smtp_port = int(EMAIL_SETTINGS.get("smtp_port") or SMTP_PORT_ENV)

    if not sender or not receivers or not smtp_password:
        print("[EMAIL SKIP] Missing sender/receiver/password")
        return

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = ", ".join(receivers)
    msg["Subject"] = EMAIL_SETTINGS.get("subject", "Camera Alerts")

    body = ""
    for a in alerts:
        if a["type"] == "offline":
            body += (
                f"Camera: {a['name']}\n"
                f"IP: {a['ip']}\n"
                f"Issue: Went Offline\n"
                f"Time: {a['time']}\n\n"
            )
        elif a["type"] == "online":
            body += (
                f"Camera: {a['name']}\n"
                f"IP: {a['ip']}\n"
                f"Downtime: {format_duration(a['downtime'])}\n"
                f"Time: {a['time']}\n\n"
            )

    msg.attach(MIMEText(body, "plain"))

    try:
        server = smtplib.SMTP(smtp_server, smtp_port)
        server.starttls()
        server.login(smtp_username, smtp_password)
        server.send_message(msg)
        server.quit()
        print("[EMAIL SENT]")
    except Exception as e:
        print("[EMAIL ERROR]", e)

def send_chat_alert(alerts):
    if not CHAT_ENABLED or not CHAT_WEBHOOK or not alerts:
        return

    offline_msgs = [a for a in alerts if a["type"] == "offline"]
    online_msgs = [a for a in alerts if a["type"] == "online"]

    final_msg = ""

    if offline_msgs:
        final_msg += "🔴 Camera Disconnect Alert\n\n"
        for a in offline_msgs:
            final_msg += (
                f"Camera: {a['name']}\n"
                f"IP: {a['ip']}\n"
                f"Issue: Went Offline\n"
                f"Time: {a['time']}\n\n"
            )

    if online_msgs:
        final_msg += "🟢 Camera Connect Alert\n\n"
        for a in online_msgs:
            final_msg += (
                f"Camera: {a['name']}\n"
                f"IP: {a['ip']}\n"
                f"Downtime: {format_duration(a['downtime'])}\n"
                f"Time: {a['time']}\n\n"
            )

    if final_msg:
        try:
            requests.post(CHAT_WEBHOOK, json={"text": final_msg})
            print("[CHAT SENT]")
        except Exception as e:
            print("[CHAT ERROR]", e)

# -------------------- CAMERA CHECK --------------------
def check_camera(cam):
    name = cam.get("name", "Unknown")
    url = cam.get("url", "")
    ip = extract_ip(url)

    ok, latency = check_rtsp_tcp(url)
    now = time.time()

    last_status.setdefault(name, "Connected")
    offline_candidate_since.setdefault(name, None)
    offline_since.setdefault(name, None)

    status = "Connected"

    if not ok:
        if offline_candidate_since[name] is None:
            offline_candidate_since[name] = now

        if now - offline_candidate_since[name] >= OFFLINE_CONFIRM_SECONDS:
            status = "Not Connected"
            if offline_since[name] is None:
                offline_since[name] = now
    else:
        offline_candidate_since[name] = None
        if latency and latency > LATENCY_THRESHOLD:
            status = "High Latency"
            if SAVE_FRAME:
                save_frame(url, name)
        else:
            status = "Connected"

    return {
        "name": name,
        "ip": ip,
        "status": status,
        "latency": latency,
        "time": now
    }

# -------------------- ALERT GENERATION --------------------
def generate_alert(res):
    name = res["name"]
    ip = res["ip"]
    status = res["status"]
    now = res["time"]

    prev = last_status.get(name, "Connected")
    alerts = []

    # Camera went offline
    if prev != "Not Connected" and status == "Not Connected":
        alerts.append({
            "name": name,
            "ip": ip,
            "type": "offline",
            "time": now_str()
        })

    # Camera came back online
    elif prev == "Not Connected" and status == "Connected":
        downtime = 0
        if offline_since.get(name):
            downtime = now - offline_since[name]

        alerts.append({
            "name": name,
            "ip": ip,
            "type": "online",
            "downtime": downtime,
            "time": now_str()
        })
        offline_since[name] = None

    last_status[name] = status
    return alerts

# -------------------- MAIN LOOP --------------------
def monitor():
    global CAMERA_LIST, CHECK_INTERVAL, OFFLINE_CONFIRM_SECONDS, LOG_DIR
    global LATENCY_THRESHOLD, SAVE_CSV, SAVE_FRAME, EMAIL_ENABLED, CHAT_ENABLED
    global CHAT_WEBHOOK, EMAIL_SETTINGS, FRAME_DIR

    while True:
        try:
            # Dynamically reload config to pick up UI changes without restart
            with open(CONFIG_FILE) as f:
                config = json.load(f)

            CAMERA_LIST = config.get("cameras", [])
            CHECK_INTERVAL = config.get("check_interval_seconds", 60)
            OFFLINE_CONFIRM_SECONDS = config.get("offline_confirm_seconds", 5)
            LATENCY_THRESHOLD = config.get("latency_threshold_ms", 100)
            SAVE_CSV = config.get("save_csv", True)
            SAVE_FRAME = config.get("save_frame", True)
            EMAIL_ENABLED = config.get("email_alerts_enabled", False)
            CHAT_ENABLED = config.get("google_chat_enabled", True)
            CHAT_WEBHOOK = config.get("google_chat_webhook") or GOOGLE_CHAT_WEBHOOK_ENV
            EMAIL_SETTINGS = config.get("email_settings", {})

            alerts = []
            camera_status_lines = []

            with ThreadPoolExecutor(max_workers=10) as executor:
                results = list(executor.map(check_camera, CAMERA_LIST))

            if SAVE_CSV:
                log_file = os.path.join(LOG_DIR, f"log_{datetime.now().strftime('%Y-%m-%d')}.csv")
                if not os.path.exists(log_file):
                    with open(log_file, "w", newline="") as f:
                        csv.writer(f).writerow(["Time", "Camera", "IP", "Status", "Latency"])
                f = open(log_file, "a", newline="")
                writer = csv.writer(f)

            for r in results:
                status_line = f"{r['name']} | {r['status']} | {r['latency']} ms"
                camera_status_lines.append(status_line)
                alerts.extend(generate_alert(r))

                if SAVE_CSV:
                    writer.writerow([now_str(), r["name"], r["ip"], r["status"], r["latency"] if r["latency"] else "N/A"])

            if SAVE_CSV:
                f.close()

            # Print all camera status
            print(f"[{now_str()}] Camera Status:")
            for line in camera_status_lines:
                print(" ", line)

            # Send combined alerts
            if alerts:
                if EMAIL_ENABLED:
                    send_email_alert(alerts)
                if CHAT_ENABLED:
                    send_chat_alert(alerts)

        except Exception as e:
            print(f"[ERROR] {e}")

        time.sleep(CHECK_INTERVAL)

# -------------------- START --------------------
if __name__ == "__main__":
    print("🚀 Camera Monitor Started...")
    monitor()
