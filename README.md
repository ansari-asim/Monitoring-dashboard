# 🖥️ Unified Monitoring Control Center

A modern, lightweight, and highly configurable monitoring dashboard built with Python and Flask. This project unifies three core monitoring systems—**IP Cameras (RTSP)**, **Hardware Utilization**, and **System Services**—into a single premium web interface. It actively monitors your infrastructure and sends instant notifications via **Email** and **Google Chat** whenever anomalies are detected.

---

## ✨ Key Features

- **Unified Dashboard:** A premium, dark-themed Single Page Application (SPA) with real-time status indicators.
- **Dynamic Charts:** Built-in `Chart.js` visualizations for CPU/RAM usage, Disk/GPU usage, Camera Latency, and Service status.
- **Auto-Refreshing Data Tables:** Paginated historical data logs that refresh automatically every 10 seconds.
- **Instant Alerts:** Get notified immediately via Email or Google Chat Webhooks if a camera drops, a server spikes in CPU, or a critical service crashes.
- **Web-Based Configuration:** Edit monitor thresholds, add new cameras, and configure alert settings directly from the UI without touching the code.
- **Cross-Platform:** Monitors Linux services (`systemctl`), Windows IIS sites, Python scripts, and .NET applications.

---

## 🏗️ Project Architecture

```text
Monitoring-dashboard/
├── app.py                    # Main Flask Web Server & API
├── requirements.txt          # Python dependencies
├── .env                      # Template for API keys and credentials
├── monitors/                 # Core monitoring logic
│   ├── camera.py             # RTSP stream TCP connection testing
│   ├── hardware.py           # CPU, RAM, Disk, and GPU telemetry
│   └── services.py           # Process and background service tracking
├── config/                   # JSON config files managed by the UI
├── web/                      # Frontend Application
│   ├── templates/index.html
│   └── static/
│       ├── css/style.css
│       └── js/app.js & charts.js
└── logs/                     # Auto-generated CSV data logs
```

---

## 🚀 Installation & Setup

### 1. Clone the repository
```bash
git clone https://github.com/ansari-asim/Monitoring-dashboard.git
cd Monitoring-dashboard
```

### 2. Set up Virtual Environment
```bash
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```
*(Requires `ffmpeg` installed on the host machine if you want camera snapshot functionality)*

### 3. Configure Environment Variables
Rename `.env.example` to `.env` and add your SMTP email credentials and Google Chat Webhook URL:
```bash
mv .env.example .env
```
Open `.env` and fill in:
```env
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-email@gmail.com
SMTP_PASSWORD=your-app-password
SENDER_EMAIL=your-email@gmail.com
GOOGLE_CHAT_WEBHOOK=https://chat.googleapis.com/v1/spaces/...
```

### 4. Start the Application
```bash
python3 app.py
```
Open your browser and navigate to **[http://localhost:5000](http://localhost:5000)**.

---

## 🛠️ How It Works

### 1. Camera Monitor (`monitors/camera.py`)
Instead of simply pinging the host IP (which can yield false positives if the server is up but the camera software crashed), this script attempts a direct **TCP Socket Connection** to the specific RTSP port.
- **Alerts:** Triggers if connection is refused or times out.
- **Metrics:** Logs TCP handshake latency.

### 2. Hardware Monitor (`monitors/hardware.py`)
Utilizes `psutil` and `GPUtil` to track system resources. 
- **Alerts:** Triggers when custom thresholds (e.g., CPU > 80%, RAM > 8GB) are exceeded.
- **Metrics:** Logs % usage across all cores, VRAM, and Disk Space.

### 3. Service Monitor (`monitors/services.py`)
Cross-platform service tracker.
- **Python / .NET:** Checks running processes via `psutil`.
- **Linux:** Validates service state via `systemctl is-active`.
- **Windows:** Validates IIS state via PowerShell `Get-Website`.
- **Alerts:** Triggers downtime and recovery notifications.

### 4. Flask API (`app.py`)
The Flask backend serves the static web files and acts as a control layer. When you click "Start" on the dashboard, Flask spawns the respective monitor script as a background subprocess, tracking its PID and status. Configuration saves from the UI are written to `config/` and dynamically picked up by the running monitors on their next tick.

---
