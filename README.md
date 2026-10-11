# 📲 WiFi Photo Transfer

A fast, lightweight, and private local web server to wirelessly transfer photos and videos between your Android/iOS phone and your PC over your local Wi-Fi network — **without installing any apps on your phone**.

---

## ✨ Features

- **No Phone App Required:** Open the web interface in Chrome, Safari, Samsung Internet, or Firefox on your phone.
- **Two-Way Transfer:**
  - 📤 **Upload:** Send thousands of photos from your phone to your PC with multi-file drag-and-drop and progress tracking.
  - 📥 **Download:** Browse and download photos from your PC to a new phone with search and image thumbnails.
- **☑️ Select All & Batch ZIP:**
  - Select all photos at once with one tap.
  - Stream all or selected photos as a `.zip` archive on-the-fly (uses zero extra hard drive space on your PC and supports archives >4 GB via ZIP64).
- **100% Local & Private:** Your photos never leave your local Wi-Fi network. No cloud, no third-party tracking, no account required.
- **Smart Wi-Fi IP Detection:** Automatically filters out VPN interfaces (Radmin, Hamachi, Docker, VirtualBox) to display the correct local Wi-Fi IP address.
- **Mobile-Optimized Dark UI:** Fast and responsive, featuring client-side pagination to smoothly handle galleries with thousands of items.

---

## 🚀 Quick Start

### 1. Requirements
- [Node.js](https://nodejs.org/) (v16 or higher)

### 2. Installation
Clone the repository and install dependencies:

```bash
git clone https://github.com/nikship27/wifi-photo-transfer.git
cd wifi-photo-transfer
npm install
```

### 3. Start the Server
```bash
npm start
```
*(or run `node server.js`)*

The terminal will display your local IP and port:
```text
  ┌──────────────────────────────────────────────┐
  │                                              │
  │     📲  WiFi Photo Transfer is running!      │
  │                                              │
  │     Open on your phone:                      │
  │     👉  http://192.168.1.8:8080              │
  │                                              │
  │     Folder on PC:                            │
  │     📂  ./received_photos                    │
  │                                              │
  │     Press Ctrl+C to stop                     │
  │                                              │
  └──────────────────────────────────────────────┘
```

### 4. Connect from Your Phone
1. Ensure your phone is connected to the **same Wi-Fi network** as your PC.
2. Open your phone's browser and go to the URL shown in your console (e.g., `http://192.168.1.8:8080`).
3. **Upload** photos to your PC or **Download** them to your new phone!

---

## 🛠️ Windows Firewall Setup (If phone cannot connect)

If your phone cannot load the page, Windows Firewall might be blocking port 8080. You can allow it by running PowerShell as Administrator:

```powershell
netsh advfirewall firewall add rule name="WiFi Photo Transfer" dir=in action=allow protocol=TCP localport=8080
```

---

## 📁 File Structure

```text
wifi-photo-transfer/
├── received_photos/       # Default folder where photos are saved (auto-created)
├── server.js              # HTTP server, multipart parser, gallery UI, & ZIP streaming
├── package.json           # Dependencies and scripts
├── .gitignore             # Ignores photos and node_modules
├── LICENSE                # MIT License
└── README.md              # Documentation
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
