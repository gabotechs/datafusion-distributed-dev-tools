# Define the long-running PR benchmark controller service.
cat > /etc/systemd/system/datafusion-pr-bot.service <<'SERVICE'
[Unit]
Description=DataFusion PR benchmark bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=benchmark-bot
Group=benchmark-bot
UMask=0077
WorkingDirectory=/opt/datafusion-pr-bot/current
Environment=HOME=/var/lib/datafusion-pr-bot
EnvironmentFile=/var/lib/datafusion-pr-bot/controller.env
ExecStart=/usr/local/bin/node /opt/datafusion-pr-bot/current/src/main.js
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
SERVICE
